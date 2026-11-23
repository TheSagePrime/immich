import {
  UploadDuplicatePolicy,
  UploadOutcome,
  UploadSessionStatus,
  type CreateUploadSessionDto,
  type LibraryResponseDto,
  type UploadSessionCheckDto,
  type UploadSessionResponseDto,
} from '@immich/sdk';

type StoredSession = UploadSessionResponseDto & { checksum: string };

const conflict = (offset: number) => ({ status: 409, json: { message: 'Upload-Offset mismatch', offset } });
const notFound = { status: 404, json: { message: 'Upload session not found', statusCode: 404 } };

const numberedName = (path: string, n: number) => {
  const slash = path.lastIndexOf('/');
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  return `${path.slice(0, slash + 1)}${stem} (${n})${extension}`;
};

export class MockUploadSessions {
  chunkSize = 8 * 1024 * 1024;
  private readonly sessions = new Map<string, StoredSession>();
  private readonly existing = new Set<string>();
  private readonly directories = new Map<string, string[]>();
  private readonly chunkFailures: number[] = [];
  private nextId = 1;

  constructor(private readonly getLibraries: () => LibraryResponseDto[]) {}

  libraryList() {
    return this.getLibraries()
      .filter((library) => library.writable)
      .map(({ id, name }) => ({ id, name }));
  }

  addExisting(libraryId: string, ...relativePaths: string[]) {
    for (const relativePath of relativePaths) {
      this.existing.add(`${libraryId}|${relativePath}`);
    }
  }

  hasFile(libraryId: string, relativePath: string) {
    return this.existing.has(`${libraryId}|${relativePath}`);
  }

  setDirectories(libraryId: string, path: string, directories: string[]) {
    this.directories.set(`${libraryId}|${path}`, directories);
  }

  getDirectories(libraryId: string, path = '') {
    return { path, directories: this.directories.get(`${libraryId}|${path}`) ?? [], truncated: false };
  }

  failNextChunks(...statuses: number[]) {
    this.chunkFailures.push(...statuses);
  }

  check({ libraryId, items }: UploadSessionCheckDto) {
    return {
      results: items.map(({ id, relativePath }) => ({ id, exists: this.hasFile(libraryId, relativePath) })),
    };
  }

  create(dto: CreateUploadSessionDto) {
    const id = `00000000-0000-4000-8000-${String(this.nextId++).padStart(12, '0')}`;
    const base: StoredSession = {
      id,
      libraryId: dto.libraryId,
      batchId: dto.batchId,
      relativePath: dto.relativePath,
      size: dto.size,
      offset: 0,
      chunkSize: this.chunkSize,
      maxChunkSize: 32 * 1024 * 1024,
      status: UploadSessionStatus.Active,
      duplicatePolicy: dto.duplicatePolicy,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      checksum: dto.checksum,
    };

    if (dto.duplicatePolicy !== UploadDuplicatePolicy.KeepBoth && this.hasFile(dto.libraryId, dto.relativePath)) {
      const skipped = dto.duplicatePolicy === UploadDuplicatePolicy.Skip;
      base.status = skipped ? UploadSessionStatus.Completed : UploadSessionStatus.Failed;
      base.result = {
        outcome: skipped ? UploadOutcome.Skipped : UploadOutcome.Failed,
        relativePath: dto.relativePath,
        message: 'exists',
      };
    }

    this.sessions.set(id, base);
    return this.toResponse(base);
  }

  get(id: string) {
    const session = this.sessions.get(id);
    return session ? { json: this.toResponse(session) } : notFound;
  }

  writeChunk(id: string, offset: number, length: number) {
    const session = this.sessions.get(id);
    if (!session) {
      return notFound;
    }

    const failure = this.chunkFailures.shift();
    if (failure !== undefined) {
      return { status: failure, json: { message: `Mock chunk failure ${failure}`, statusCode: failure } };
    }

    if (session.status !== UploadSessionStatus.Active) {
      return { status: 409, json: { message: `Upload session is ${session.status}` } };
    }

    if (offset !== session.offset) {
      return conflict(session.offset);
    }

    session.offset += length;
    return { json: this.toResponse(session) };
  }

  complete(id: string) {
    const session = this.sessions.get(id);
    if (!session) {
      return notFound;
    }

    if (session.status !== UploadSessionStatus.Active) {
      return { json: this.toResponse(session) };
    }

    if (session.offset !== session.size) {
      return conflict(session.offset);
    }

    let relativePath = session.relativePath;
    let outcome = UploadOutcome.Created;
    if (this.hasFile(session.libraryId, relativePath)) {
      if (session.duplicatePolicy === UploadDuplicatePolicy.KeepBoth) {
        let n = 1;
        while (this.hasFile(session.libraryId, numberedName(session.relativePath, n))) {
          n++;
        }
        relativePath = numberedName(session.relativePath, n);
        outcome = UploadOutcome.Renamed;
      } else {
        outcome = session.duplicatePolicy === UploadDuplicatePolicy.Skip ? UploadOutcome.Skipped : UploadOutcome.Failed;
      }
    }

    if (outcome === UploadOutcome.Created || outcome === UploadOutcome.Renamed) {
      this.addExisting(session.libraryId, relativePath);
    }

    session.status = outcome === UploadOutcome.Failed ? UploadSessionStatus.Failed : UploadSessionStatus.Completed;
    session.result = { outcome, relativePath, assetId: `asset-${session.id}` };
    return { json: this.toResponse(session) };
  }

  cancel(id: string) {
    const session = this.sessions.get(id);
    if (!session) {
      return notFound;
    }
    if (session.status === UploadSessionStatus.Active) {
      session.status = UploadSessionStatus.Cancelled;
    }
    return { status: 204 };
  }

  list() {
    return [...this.sessions.values()].map((session) => this.toResponse(session));
  }

  private toResponse({ checksum: _, ...session }: StoredSession): UploadSessionResponseDto {
    return { ...session };
  }
}
