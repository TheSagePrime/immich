import { BadRequestException } from '@nestjs/common';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const isErrorCode = (error: unknown, code: string) => (error as NodeJS.ErrnoException)?.code === code;

const entryExists = (path: string) =>
  lstat(path)
    .then(() => true)
    .catch(() => false);

export const isPathInside = (root: string, candidate: string): boolean => {
  const relativePath = relative(resolve(root), resolve(candidate));
  return (
    relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
};

export const parseRelativePath = (input: string): string[] => {
  if (typeof input !== 'string') {
    throw new BadRequestException('Path must be a string');
  }

  if (input.includes('\0')) {
    throw new BadRequestException('Path must not contain NUL bytes');
  }

  if (input.includes('\\')) {
    throw new BadRequestException('Path must use forward slashes');
  }

  if (isAbsolute(input)) {
    throw new BadRequestException('Path must be relative');
  }

  const segments = input.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.includes('..')) {
    throw new BadRequestException('Path must not contain ".." segments');
  }

  return segments;
};

const resolveDeepestExistingAncestor = async (realRoot: string, segments: string[]) => {
  for (let depth = segments.length; depth >= 0; depth--) {
    const lexicalPath = join(realRoot, ...segments.slice(0, depth));
    try {
      const realPath = await realpath(lexicalPath);
      return { realPath, remaining: segments.slice(depth) };
    } catch (error) {
      if (!isErrorCode(error, 'ENOENT')) {
        throw new BadRequestException('Path is not accessible');
      }
    }

    if (await entryExists(lexicalPath)) {
      throw new BadRequestException('Path must not contain broken symbolic links');
    }
  }

  throw new BadRequestException('Root path does not exist');
};

export const resolveSafePath = async (root: string, input: string): Promise<string> => {
  const segments = parseRelativePath(input);

  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    throw new BadRequestException('Root path does not exist');
  }

  const { realPath, remaining } = await resolveDeepestExistingAncestor(realRoot, segments);
  if (!isPathInside(realRoot, realPath)) {
    throw new BadRequestException('Path must stay inside the root');
  }

  const resolved = join(realPath, ...remaining);
  if (!isPathInside(realRoot, resolved)) {
    throw new BadRequestException('Path must stay inside the root');
  }

  return resolved;
};

export const parseSafeName = (input: string): string => {
  const segments = parseRelativePath(input);
  if (segments.length !== 1 || input !== segments[0]) {
    throw new BadRequestException('Name must be a single path segment');
  }

  return segments[0];
};
