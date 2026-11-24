const escapeLikePattern = (value: string) => value.replaceAll(/[\\%_]/g, String.raw`\$&`);

export const toFolderLikePattern = (folder: string): string => {
  const trimmed = folder.replaceAll(/^\/+|\/+$/g, '');
  return `${escapeLikePattern(trimmed ? `/${trimmed}/` : '/')}%`;
};
