import { getUploadDirectories, getUploadLibraries } from '@immich/sdk';
import { queryOptions } from '@tanstack/svelte-query';

export const uploadSessionQueryKey = 'upload-sessions';

export const getUploadLibrariesQuery = () =>
  queryOptions({
    queryKey: [uploadSessionQueryKey, 'libraries'],
    queryFn: ({ signal }) => getUploadLibraries({ signal }),
    staleTime: 60_000,
  });

export const getUploadDirectoriesQuery = (libraryId: string, path: string) =>
  queryOptions({
    queryKey: [uploadSessionQueryKey, 'libraries', libraryId, 'directories', path],
    queryFn: ({ signal }) => getUploadDirectories({ id: libraryId, path }, { signal }),
    retry: false,
  });
