import { LoginResponseDto, UploadDuplicatePolicy, UploadOutcome, UploadSessionStatus } from '@immich/sdk';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app, asBearerAuth, testAssetDir, testAssetDirInternal, utils } from 'src/utils.js';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CHUNK_TYPE = 'application/offset+octet-stream';
const CHUNK_SIZE = 8 * 1024 * 1024;

const sha1 = (data: Buffer) => createHash('sha1').update(data).digest('hex');

const makeMov = () => {
  const directory = mkdtempSync(join(tmpdir(), 'upload-session-e2e-'));
  const output = join(directory, 'clip.mov');
  try {
    execFileSync(
      'ffmpeg',
      [
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=c=blue:s=32x32:d=0.2',
        '-pix_fmt',
        'yuv420p',
        '-f',
        'mov',
        output,
      ],
      { stdio: 'ignore' },
    );
    return readFileSync(output);
  } catch {
    return Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypqt  '), randomBytes(4096)]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const makeHeic = () =>
  Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.from('mif1heic'), randomBytes(4096)]);

describe('/upload-sessions', () => {
  let admin: LoginResponseDto;
  let user: LoginResponseDto;
  let libraryId: string;
  let hostRoot: string;

  const createSession = (relativePath: string, data: Buffer, duplicatePolicy = UploadDuplicatePolicy.Fail) =>
    request(app)
      .post('/upload-sessions')
      .set(asBearerAuth(admin.accessToken))
      .send({ libraryId, relativePath, size: data.length, checksum: sha1(data), duplicatePolicy });

  const sendChunk = (id: string, offset: number, chunk: Buffer) =>
    request(app)
      .patch(`/upload-sessions/${id}`)
      .set(asBearerAuth(admin.accessToken))
      .set('Content-Type', CHUNK_TYPE)
      .set('Upload-Offset', String(offset))
      .send(chunk);

  const complete = (id: string) =>
    request(app).post(`/upload-sessions/${id}/complete`).set(asBearerAuth(admin.accessToken));

  const upload = async (relativePath: string, data: Buffer, duplicatePolicy = UploadDuplicatePolicy.Fail) => {
    const { status, body } = await createSession(relativePath, data, duplicatePolicy);
    expect(status).toBe(201);
    if (body.status !== UploadSessionStatus.Active) {
      return body;
    }

    for (let offset = 0; offset < data.length; offset += body.chunkSize) {
      const chunk = data.subarray(offset, offset + body.chunkSize);
      const response = await sendChunk(body.id, offset, chunk);
      expect(response.status).toBe(200);
      expect(response.body.offset).toBe(offset + chunk.length);
    }

    const { status: completeStatus, body: result } = await complete(body.id);
    expect(completeStatus).toBe(200);
    return result;
  };

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    user = await utils.userSetup(admin.accessToken, {
      email: 'upload-user@immich.cloud',
      name: 'Upload User',
      password: 'password',
    });

    const name = `writable-${randomUUID()}`;
    hostRoot = `${testAssetDir}/temp/${name}`;
    mkdirSync(hostRoot, { recursive: true });
    const library = await utils.createLibrary(admin.accessToken, {
      ownerId: admin.userId,
      importPaths: [`${testAssetDirInternal}/temp/${name}`],
      writable: true,
    });
    libraryId = library.id;
  });

  afterAll(() => {
    utils.resetTempFolder();
  });

  it('should list the writable library as an upload destination', async () => {
    const { status, body } = await request(app).get('/upload-sessions/libraries').set(asBearerAuth(admin.accessToken));
    expect(status).toBe(200);
    expect(body).toEqual([expect.objectContaining({ id: libraryId })]);
  });

  it('should upload a large file in 8 MB chunks and import it', async () => {
    const data = randomBytes(20 * 1024 * 1024 + 123);
    const result = await upload('Big/random.jpg', data);

    expect(result.status).toBe(UploadSessionStatus.Completed);
    expect(result.result).toEqual(
      expect.objectContaining({ outcome: UploadOutcome.Created, relativePath: 'Big/random.jpg' }),
    );
    expect(result.chunkSize).toBe(CHUNK_SIZE);
    expect(sha1(readFileSync(`${hostRoot}/Big/random.jpg`))).toBe(sha1(data));
    expect(readdirSync(`${hostRoot}/.immich-upload-tmp`)).toEqual([]);

    const { status, body: asset } = await request(app)
      .get(`/assets/${result.result.assetId}`)
      .set(asBearerAuth(admin.accessToken));
    expect(status).toBe(200);
    expect(asset).toEqual(
      expect.objectContaining({
        originalPath: `${testAssetDirInternal}/temp/${hostRoot.split('/').at(-1)}/Big/random.jpg`,
        libraryId,
        isOffline: false,
      }),
    );
  });

  it('should resume after the connection drops in the middle of a chunk', async () => {
    const data = randomBytes(3 * 1024 * 1024);
    const { body: session } = await createSession('resume.jpg', data);

    await new Promise<void>((resolve) => {
      const url = new URL(`${app}/upload-sessions/${session.id}`);
      const req = httpRequest(url, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${admin.accessToken}`,
          'Content-Type': CHUNK_TYPE,
          'Upload-Offset': '0',
          'Content-Length': String(data.length),
        },
      });
      req.on('error', () => resolve());
      req.on('close', () => resolve());
      req.write(data.subarray(0, 1024 * 1024));
      setTimeout(() => req.destroy(), 500);
    });

    let offset = 0;
    for (let attempt = 0; attempt < 20; attempt++) {
      const { body } = await request(app).get(`/upload-sessions/${session.id}`).set(asBearerAuth(admin.accessToken));
      offset = body.offset;
      if (offset > 0) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(offset).toBeGreaterThan(0);
    expect(offset).toBeLessThanOrEqual(1024 * 1024);

    const { status: headStatus, headers } = await request(app)
      .head(`/upload-sessions/${session.id}`)
      .set(asBearerAuth(admin.accessToken));
    expect(headStatus).toBe(200);
    expect(headers['upload-offset']).toBe(String(offset));

    const conflict = await sendChunk(session.id, 0, data.subarray(0, 10));
    expect(conflict.status).toBe(409);
    expect(conflict.body.offset).toBe(offset);

    const rest = await sendChunk(session.id, offset, data.subarray(offset));
    expect(rest.status).toBe(200);
    const { body: result } = await complete(session.id);
    expect(result.result.outcome).toBe(UploadOutcome.Created);
    expect(sha1(readFileSync(`${hostRoot}/resume.jpg`))).toBe(sha1(data));
  });

  it('should apply the duplicate policies', async () => {
    const original = randomBytes(1000);
    await upload('dupes/photo.jpg', original);

    const skipped = await upload('dupes/photo.jpg', randomBytes(1000), UploadDuplicatePolicy.Skip);
    const failed = await upload('dupes/photo.jpg', randomBytes(1000), UploadDuplicatePolicy.Fail);
    const kept = randomBytes(1000);
    const renamed = await upload('dupes/photo.jpg', kept, UploadDuplicatePolicy.KeepBoth);

    expect(skipped.result).toEqual(
      expect.objectContaining({ outcome: UploadOutcome.Skipped, relativePath: 'dupes/photo.jpg' }),
    );
    expect(skipped.result.assetId).toBeDefined();
    expect(failed.result).toEqual(expect.objectContaining({ outcome: UploadOutcome.Failed, message: 'exists' }));
    expect(renamed.result).toEqual(
      expect.objectContaining({ outcome: UploadOutcome.Renamed, relativePath: 'dupes/photo (1).jpg' }),
    );
    expect(sha1(readFileSync(`${hostRoot}/dupes/photo.jpg`))).toBe(sha1(original));
    expect(sha1(readFileSync(`${hostRoot}/dupes/photo (1).jpg`))).toBe(sha1(kept));

    const { body: check } = await request(app)
      .post('/upload-sessions/check')
      .set(asBearerAuth(admin.accessToken))
      .send({
        libraryId,
        items: [
          { id: 'a', relativePath: 'dupes/photo.jpg' },
          { id: 'b', relativePath: 'dupes/other.jpg' },
        ],
      });
    expect(check.results).toEqual([
      expect.objectContaining({ id: 'a', exists: true, suggestedRelativePath: 'dupes/photo (2).jpg' }),
      expect.objectContaining({ id: 'b', exists: false }),
    ]);
  });

  it('should refuse paths outside the library', async () => {
    symlinkSync('/etc', `${hostRoot}/etc-link`);
    for (const relativePath of [
      '../escape.jpg',
      '/etc/escape.jpg',
      'a/../../escape.jpg',
      'etc-link/escape.jpg',
      '.hidden/x.jpg',
      String.raw`a\..\b.jpg`,
    ]) {
      const { status } = await createSession(relativePath, Buffer.from('x'));
      expect(status, relativePath).toBe(400);
    }

    const { status } = await request(app)
      .get(`/upload-sessions/libraries/${libraryId}/directories?path=%2e%2e`)
      .set(asBearerAuth(admin.accessToken));
    expect(status).toBe(400);

    const literal = await upload('%2e%2e/literal.jpg', Buffer.from('literal'));
    expect(literal.result.outcome).toBe(UploadOutcome.Created);
    expect(existsSync(`${hostRoot}/%2e%2e/literal.jpg`)).toBe(true);
    expect(existsSync(`${testAssetDir}/temp/literal.jpg`)).toBe(false);
  });

  it('should refuse other users', async () => {
    const { status } = await request(app)
      .post('/upload-sessions')
      .set(asBearerAuth(user.accessToken))
      .send({ libraryId, relativePath: 'x.jpg', size: 1, checksum: sha1(Buffer.from('x')), duplicatePolicy: 'fail' });
    expect(status).toBe(403);

    const { body: libraries } = await request(app)
      .get('/upload-sessions/libraries')
      .set(asBearerAuth(user.accessToken));
    expect(libraries).toEqual([]);

    const { body: session } = await createSession('private.jpg', Buffer.from('x'));
    const { status: getStatus } = await request(app)
      .get(`/upload-sessions/${session.id}`)
      .set(asBearerAuth(user.accessToken));
    expect(getStatus).toBe(404);
  });

  it('should require authentication', async () => {
    const { status } = await request(app).get('/upload-sessions/libraries');
    expect(status).toBe(401);
  });

  it('should keep HEIC and MOV originals byte for byte', async () => {
    const heic = makeHeic();
    const mov = makeMov();

    const heicResult = await upload('originals/IMG_0001.HEIC', heic);
    const movResult = await upload('originals/IMG_0001.MOV', mov);

    expect(sha1(readFileSync(`${hostRoot}/originals/IMG_0001.HEIC`))).toBe(sha1(heic));
    expect(sha1(readFileSync(`${hostRoot}/originals/IMG_0001.MOV`))).toBe(sha1(mov));

    for (const [result, data] of [
      [heicResult, heic],
      [movResult, mov],
    ] as const) {
      const { status, body } = await request(app)
        .get(`/assets/${result.result.assetId}/original`)
        .set(asBearerAuth(admin.accessToken))
        .buffer(true)
        .parse((response, callback) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
          });
          response.on('end', () => callback(null, Buffer.concat(chunks)));
        });
      expect(status).toBe(200);
      expect(sha1(body as Buffer)).toBe(sha1(data));
    }
  });

  it('should cancel a session and delete the partial data', async () => {
    const data = randomBytes(2000);
    const { body: session } = await createSession('cancel.jpg', data);
    await sendChunk(session.id, 0, data.subarray(0, 1000));

    const { status } = await request(app).delete(`/upload-sessions/${session.id}`).set(asBearerAuth(admin.accessToken));
    expect(status).toBe(204);
    expect(readdirSync(`${hostRoot}/.immich-upload-tmp`)).toEqual([]);
    expect(existsSync(`${hostRoot}/cancel.jpg`)).toBe(false);

    const { body } = await request(app).get(`/upload-sessions/${session.id}`).set(asBearerAuth(admin.accessToken));
    expect(body.status).toBe(UploadSessionStatus.Cancelled);
  });

  it('should keep the regular asset upload working', async () => {
    const asset = await utils.createAsset(admin.accessToken);
    expect(asset.id).toBeDefined();
    expect(asset.status).toBe('created');
  });
});
