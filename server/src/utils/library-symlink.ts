import { dirname } from 'node:path';
import { isPathInside } from 'src/utils/safe-path.js';

type SymlinkFileSystem = {
  lstat(path: string): Promise<{ isSymbolicLink(): boolean }>;
  realpath(path: string): Promise<string>;
};

const attempt = <T>(operation: () => Promise<T>): Promise<T | undefined> =>
  Promise.resolve()
    .then(operation)
    .catch(() => undefined);

export type SymlinkEscapeChecker = (filePath: string) => Promise<boolean>;

export const createSymlinkEscapeChecker = (
  fileSystem: SymlinkFileSystem,
  importPaths: string[],
): SymlinkEscapeChecker => {
  const realRoots = new Map<string, Promise<string | undefined>>();
  const realDirectories = new Map<string, Promise<string | undefined>>();

  const resolveCached = (cache: Map<string, Promise<string | undefined>>, path: string) => {
    let result = cache.get(path);
    if (!result) {
      result = attempt(() => fileSystem.realpath(path)).then((realPath) => realPath || undefined);
      cache.set(path, result);
    }
    return result;
  };

  return async (filePath: string) => {
    const importPath = importPaths.find((root) => isPathInside(root, filePath));
    if (!importPath) {
      return false;
    }

    const realRoot = await resolveCached(realRoots, importPath);
    if (!realRoot) {
      return false;
    }

    const realDirectory = await resolveCached(realDirectories, dirname(filePath));
    if (realDirectory && !isPathInside(realRoot, realDirectory)) {
      return true;
    }

    const stats = await attempt(() => fileSystem.lstat(filePath));
    if (!stats?.isSymbolicLink()) {
      return false;
    }

    const realFile = await attempt(() => fileSystem.realpath(filePath));
    return !realFile || !isPathInside(realRoot, realFile);
  };
};
