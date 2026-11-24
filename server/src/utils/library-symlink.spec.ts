import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSymlinkEscapeChecker } from 'src/utils/library-symlink.js';

const fileSystem = { lstat, realpath };

describe(createSymlinkEscapeChecker.name, () => {
  let tempDir: string;
  let root: string;
  let outside: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'immich-symlink-'));
    root = join(tempDir, 'library');
    outside = join(tempDir, 'outside');
    await mkdir(join(root, 'album'), { recursive: true });
    await mkdir(join(outside, 'folder'), { recursive: true });
    await writeFile(join(root, 'album/photo.jpg'), 'a');
    await writeFile(join(outside, 'secret.jpg'), 'b');
    await writeFile(join(outside, 'folder/nested.jpg'), 'c');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should accept a regular file', async () => {
    const isEscaping = createSymlinkEscapeChecker(fileSystem, [root]);
    await expect(isEscaping(join(root, 'album/photo.jpg'))).resolves.toBe(false);
  });

  it('should reject a file link that leads outside the root', async () => {
    await symlink(join(outside, 'secret.jpg'), join(root, 'link.jpg'));
    const isEscaping = createSymlinkEscapeChecker(fileSystem, [root]);
    await expect(isEscaping(join(root, 'link.jpg'))).resolves.toBe(true);
  });

  it('should reject a relative file link that leads outside the root', async () => {
    await symlink('../../outside/secret.jpg', join(root, 'album/relative.jpg'));
    const isEscaping = createSymlinkEscapeChecker(fileSystem, [root]);
    await expect(isEscaping(join(root, 'album/relative.jpg'))).resolves.toBe(true);
  });

  it('should reject a file inside a directory link that leads outside the root', async () => {
    await symlink(join(outside, 'folder'), join(root, 'folder'));
    const isEscaping = createSymlinkEscapeChecker(fileSystem, [root]);
    await expect(isEscaping(join(root, 'folder/nested.jpg'))).resolves.toBe(true);
  });

  it('should reject a broken file link', async () => {
    await symlink(join(outside, 'missing.jpg'), join(root, 'broken.jpg'));
    const isEscaping = createSymlinkEscapeChecker(fileSystem, [root]);
    await expect(isEscaping(join(root, 'broken.jpg'))).resolves.toBe(true);
  });

  it('should accept links that stay inside the root', async () => {
    await symlink(join(root, 'album/photo.jpg'), join(root, 'inside.jpg'));
    await symlink(join(root, 'album'), join(root, 'album-link'));
    const isEscaping = createSymlinkEscapeChecker(fileSystem, [root]);
    await expect(isEscaping(join(root, 'inside.jpg'))).resolves.toBe(false);
    await expect(isEscaping(join(root, 'album-link/photo.jpg'))).resolves.toBe(false);
  });

  it('should accept a root that is itself a link', async () => {
    const linkedRoot = join(tempDir, 'linked-library');
    await symlink(root, linkedRoot);
    const isEscaping = createSymlinkEscapeChecker(fileSystem, [linkedRoot]);
    await expect(isEscaping(join(linkedRoot, 'album/photo.jpg'))).resolves.toBe(false);
  });

  it('should ignore missing files and paths outside every root', async () => {
    const isEscaping = createSymlinkEscapeChecker(fileSystem, [root]);
    await expect(isEscaping(join(root, 'album/missing.jpg'))).resolves.toBe(false);
    await expect(isEscaping(join(outside, 'secret.jpg'))).resolves.toBe(false);
  });

  it('should resolve each directory only once', async () => {
    const counting = {
      lstat: vi.fn((path: string) => lstat(path)),
      realpath: vi.fn((path: string) => realpath(path)),
    };
    const isEscaping = createSymlinkEscapeChecker(counting, [root]);
    await writeFile(join(root, 'album/second.jpg'), 'd');

    await isEscaping(join(root, 'album/photo.jpg'));
    await isEscaping(join(root, 'album/second.jpg'));

    expect(counting.realpath).toHaveBeenCalledTimes(2);
    expect(counting.lstat).toHaveBeenCalledTimes(2);
  });
});
