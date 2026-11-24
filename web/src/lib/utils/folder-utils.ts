const utf8 = new TextEncoder();

export const isValidFolderEntryName = (input: string) => {
  const name = input.trim();
  return name.length > 0 && utf8.encode(name).length <= 255 && !/[/\\\0]/.test(name) && !name.startsWith('.');
};

export const splitFileName = (fileName: string) => {
  const index = fileName.lastIndexOf('.');
  if (index <= 0) {
    return { stem: fileName, extension: '' };
  }

  return { stem: fileName.slice(0, index), extension: fileName.slice(index) };
};

const withoutTrailingSlash = (path: string) => (path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path);

export const isSameOrInsidePath = (parent: string, candidate: string) => {
  const normalizedParent = withoutTrailingSlash(parent);
  const normalizedCandidate = withoutTrailingSlash(candidate);
  return (
    normalizedCandidate === normalizedParent ||
    normalizedCandidate.startsWith(normalizedParent === '/' ? '/' : `${normalizedParent}/`)
  );
};

export const getFolderParentPath = (path: string) => {
  const normalized = withoutTrailingSlash(path);
  const index = normalized.lastIndexOf('/');
  return index <= 0 ? '/' : normalized.slice(0, index);
};

export const getFolderName = (path: string) => {
  const normalized = withoutTrailingSlash(path);
  return normalized.slice(normalized.lastIndexOf('/') + 1) || '/';
};

export const getFolderCrumbs = (path: string) => {
  const segments = withoutTrailingSlash(path).split('/').filter(Boolean);
  return segments.map((name, index) => ({ name, path: '/' + segments.slice(0, index + 1).join('/') }));
};

export const canMoveFoldersTo = (destination: string | null | undefined, folderPaths: string[]) =>
  !!destination && folderPaths.every((source) => !isSameOrInsidePath(source, destination));

export const getRelativeFolderPath = (root: string, path: string) => {
  const normalizedRoot = withoutTrailingSlash(root);
  const normalizedPath = withoutTrailingSlash(path);
  if (normalizedRoot === normalizedPath || !isSameOrInsidePath(normalizedRoot, normalizedPath)) {
    return '';
  }

  return normalizedPath.slice(normalizedRoot === '/' ? 1 : normalizedRoot.length + 1);
};

export const findLibraryRootPath = async (
  path: string,
  getSummary: (path: string) => Promise<{ isLibraryRoot: boolean; writable: boolean }>,
) => {
  let current = withoutTrailingSlash(path);
  for (;;) {
    const { isLibraryRoot, writable } = await getSummary(current);
    if (isLibraryRoot) {
      return current;
    }

    if (!writable || current === '/') {
      return;
    }

    current = getFolderParentPath(current);
  }
};
