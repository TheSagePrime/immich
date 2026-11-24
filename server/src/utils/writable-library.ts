import { posix } from 'node:path';
import picomatch from 'picomatch';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { isPathInside } from 'src/utils/safe-path.js';

type LibraryLike = {
  id: string;
  ownerId: string;
  importPaths: string[];
  exclusionPatterns: string[];
  writable: boolean;
  deletedAt: Date | string | null;
};

export const normalizeFolderPath = (input: string) => {
  const normalized = posix.normalize(`/${input.trim()}`);
  return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
};

export const getWritableRoot = (library: LibraryLike): string | null => {
  if (!library.writable || library.deletedAt || library.importPaths.length === 0) {
    return null;
  }

  return normalizeFolderPath(library.importPaths[0]);
};

export const canManageLibrary = (auth: AuthDto, library: LibraryLike) =>
  library.ownerId === auth.user.id || auth.user.isAdmin;

export const findWritableLibrary = <T extends LibraryLike>(libraries: T[], path: string) => {
  let match: { library: T; root: string } | undefined;
  for (const library of libraries) {
    const root = getWritableRoot(library);
    if (!root || !isPathInside(root, path)) {
      continue;
    }

    if (!match || root.length > match.root.length) {
      match = { library, root };
    }
  }

  return match;
};

export const createExclusionMatcher = (patterns: string[]) => {
  if (patterns.length === 0) {
    return () => false;
  }

  const matcher = picomatch(patterns, { dot: true });
  return (path: string, isDirectory: boolean) => matcher(path) || (isDirectory && matcher(`${path}/_`));
};
