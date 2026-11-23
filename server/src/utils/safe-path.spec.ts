import { BadRequestException } from '@nestjs/common';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isPathInside, parseRelativePath, parseSafeName, resolveSafePath } from 'src/utils/safe-path.js';

describe('isPathInside', () => {
  it.each([
    ['/data/library', '/data/library'],
    ['/data/library', '/data/library/a'],
    ['/data/library', '/data/library/a/b/c.jpg'],
    ['/data/library/', '/data/library/a'],
    ['/data/library', '/data/library/./a'],
    ['/data/library', '/data/library/..foo'],
  ])('should accept %s containing %s', (root, candidate) => {
    expect(isPathInside(root, candidate)).toBe(true);
  });

  it.each([
    ['/data/library', '/data'],
    ['/data/library', '/data/library-other'],
    ['/data/library', '/data/libraryx/a'],
    ['/data/library', '/data/library/../other'],
    ['/data/library', '/etc/passwd'],
    ['/data/library', '/'],
  ])('should reject %s containing %s', (root, candidate) => {
    expect(isPathInside(root, candidate)).toBe(false);
  });
});

describe('parseRelativePath', () => {
  it('should split a relative path into segments', () => {
    expect(parseRelativePath('a/b/c.jpg')).toEqual(['a', 'b', 'c.jpg']);
  });

  it('should drop empty and dot segments', () => {
    expect(parseRelativePath('./a//b/./c/')).toEqual(['a', 'b', 'c']);
  });

  it('should treat an empty path as the root', () => {
    expect(parseRelativePath('')).toEqual([]);
  });

  it('should keep names that merely start with dots', () => {
    expect(parseRelativePath('..a/.b/...')).toEqual(['..a', '.b', '...']);
  });

  it.each(['/etc/passwd', '/', '//double'])('should reject absolute path %s', (input) => {
    expect(() => parseRelativePath(input)).toThrow(BadRequestException);
  });

  it.each(['..', '../x', 'a/../../x', 'a/..', 'a/b/../c'])('should reject traversal %s', (input) => {
    expect(() => parseRelativePath(input)).toThrow(BadRequestException);
  });

  it.each(['a\0b', 'a/\0/b', '\0'])('should reject NUL bytes in %j', (input) => {
    expect(() => parseRelativePath(input)).toThrow(BadRequestException);
  });

  it.each([String.raw`..\x`, String.raw`a\..\..\x`, String.raw`C:\Windows`, String.raw`a\b`])(
    'should reject backslashes in %s',
    (input) => {
      expect(() => parseRelativePath(input)).toThrow(BadRequestException);
    },
  );

  it('should reject non-string input', () => {
    expect(() => parseRelativePath(42 as unknown as string)).toThrow(BadRequestException);
  });
});

describe('parseSafeName', () => {
  it('should accept a plain name', () => {
    expect(parseSafeName('Holiday 2024')).toBe('Holiday 2024');
  });

  it.each(['', '.', '..', 'a/b', '/a', 'a/', String.raw`a\b`, 'a\0'])('should reject %j', (input) => {
    expect(() => parseSafeName(input)).toThrow(BadRequestException);
  });
});

describe('resolveSafePath', () => {
  let base: string;
  let root: string;
  let outside: string;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'immich-safe-path-')));
    root = join(base, 'root');
    outside = join(base, 'outside');
    await mkdir(join(root, 'existing', 'nested'), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(root, 'existing', 'file.jpg'), 'x');
    await writeFile(join(outside, 'secret.txt'), 'x');
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('should resolve the root itself for an empty path', async () => {
    await expect(resolveSafePath(root, '')).resolves.toBe(root);
  });

  it('should resolve an existing file', async () => {
    await expect(resolveSafePath(root, 'existing/file.jpg')).resolves.toBe(join(root, 'existing', 'file.jpg'));
  });

  it('should resolve a non-existent nested target under existing directories', async () => {
    await expect(resolveSafePath(root, 'existing/nested/new/deeper/file.jpg')).resolves.toBe(
      join(root, 'existing', 'nested', 'new', 'deeper', 'file.jpg'),
    );
  });

  it('should resolve a non-existent target directly under the root', async () => {
    await expect(resolveSafePath(root, 'brand-new')).resolves.toBe(join(root, 'brand-new'));
  });

  it('should work when the root itself is reached through a symlink', async () => {
    const linkedRoot = join(base, 'linked-root');
    await symlink(root, linkedRoot);
    await expect(resolveSafePath(linkedRoot, 'existing/file.jpg')).resolves.toBe(join(root, 'existing', 'file.jpg'));
  });

  it('should reject a root that does not exist', async () => {
    await expect(resolveSafePath(join(base, 'missing'), 'a')).rejects.toThrow(BadRequestException);
  });

  it.each(['../outside/secret.txt', 'existing/../../outside', '/etc/passwd', 'a\0b', String.raw`..\outside`])(
    'should reject unsafe input %j',
    async (input) => {
      await expect(resolveSafePath(root, input)).rejects.toThrow(BadRequestException);
    },
  );

  it('should reject a symlinked directory that points outside the root', async () => {
    await symlink(outside, join(root, 'escape'));
    await expect(resolveSafePath(root, 'escape/secret.txt')).rejects.toThrow(BadRequestException);
    await expect(resolveSafePath(root, 'escape/new-file.jpg')).rejects.toThrow(BadRequestException);
    await expect(resolveSafePath(root, 'escape')).rejects.toThrow(BadRequestException);
  });

  it('should reject a symlinked file that points outside the root', async () => {
    await symlink(join(outside, 'secret.txt'), join(root, 'existing', 'link.txt'));
    await expect(resolveSafePath(root, 'existing/link.txt')).rejects.toThrow(BadRequestException);
  });

  it('should reject a dangling symlink that would be followed on write', async () => {
    await symlink(join(outside, 'not-yet-created.txt'), join(root, 'dangling.txt'));
    await expect(resolveSafePath(root, 'dangling.txt')).rejects.toThrow(BadRequestException);
    await expect(resolveSafePath(root, 'dangling.txt/child')).rejects.toThrow(BadRequestException);
  });

  it('should reject a symlink to the parent of the root', async () => {
    await symlink(base, join(root, 'up'));
    await expect(resolveSafePath(root, 'up/outside/secret.txt')).rejects.toThrow(BadRequestException);
  });

  it('should allow a symlink that stays inside the root', async () => {
    await symlink(join(root, 'existing', 'nested'), join(root, 'shortcut'));
    await expect(resolveSafePath(root, 'shortcut')).resolves.toBe(join(root, 'existing', 'nested'));
    await expect(resolveSafePath(root, 'shortcut/new.jpg')).resolves.toBe(join(root, 'existing', 'nested', 'new.jpg'));
  });

  it('should reject a path that continues below a regular file', async () => {
    await expect(resolveSafePath(root, 'existing/file.jpg/child')).rejects.toThrow(BadRequestException);
  });
});
