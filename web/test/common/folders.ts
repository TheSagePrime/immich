import type { Handlers } from '#test/common/types.ts';
import {
  FolderRootKind,
  type AssetResponseDto,
  type FolderBrowseResponseDto,
  type FolderRootDto,
  type FolderSummaryResponseDto,
} from '@immich/sdk';

const normalize = (path: string) => {
  const trimmed = path.trim().replaceAll(/\/+$/g, '');
  if (!trimmed) {
    return '/';
  }
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
};

const parentOf = (path: string) => {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
};

const isInside = (parent: string, path: string) =>
  path === parent || path.startsWith(parent === '/' ? '/' : `${parent}/`);

export class MockFolders {
  private readonly folders = new Map<string, AssetResponseDto[]>();
  private readonly writableRoots = new Set<string>();
  private libraryId = '00000000-0000-4000-a000-000000000001';
  private readonly rootNames = new Map<string, string>();
  private uploadsPath?: string;

  addFolder(path: string, assets: AssetResponseDto[] = []) {
    let current = normalize(path);
    this.folders.set(current, [...(this.folders.get(current) ?? []), ...assets]);
    while (current !== '/') {
      current = parentOf(current);
      if (!this.folders.has(current)) {
        this.folders.set(current, []);
      }
    }
    return this;
  }

  addWritableRoot(path: string, libraryId?: string) {
    this.writableRoots.add(normalize(path));
    this.addFolder(path);
    if (libraryId) {
      this.libraryId = libraryId;
    }
    return this;
  }

  setRootName(path: string, name: string) {
    this.rootNames.set(normalize(path), name);
    return this;
  }

  setUploadsPath(path: string) {
    this.uploadsPath = normalize(path);
    this.addFolder(path);
    return this;
  }

  roots(): FolderRootDto[] {
    const libraries = this.children('/')
      .filter((path) => path !== this.uploadsPath && !(this.uploadsPath && isInside(path, this.uploadsPath)))
      .map((path) => this.toRoot(path, FolderRootKind.Library))
      .filter((root) => root.assetCount > 0 || root.writable);
    const uploads = this.uploadsPath && this.toRoot(this.uploadsPath, FolderRootKind.Uploads, 'uploads');
    return uploads && uploads.assetCount > 0 ? [...libraries, uploads] : libraries;
  }

  private toRoot(path: string, kind: FolderRootKind, id?: string): FolderRootDto {
    const assets = [...this.folders].filter(([candidate]) => isInside(path, candidate)).flatMap(([, items]) => items);
    const name = path.slice(path.lastIndexOf('/') + 1);
    const writable = !!this.rootOf(path);
    return {
      id: id ?? `library-${name}`,
      kind,
      name: kind === FolderRootKind.Uploads ? 'Uploads' : (this.rootNames.get(path) ?? name),
      writable,
      assetCount: assets.length,
      coverAssetId: assets[0]?.id ?? null,
      folders: [{ name, path, writable }],
    };
  }

  has(path: string) {
    return this.folders.has(normalize(path));
  }

  uniquePaths() {
    return [...this.folders]
      .filter(([, assets]) => assets.length > 0)
      .map(([path]) => path)
      .sort();
  }

  assets(path: string) {
    return this.folders.get(normalize(path)) ?? [];
  }

  private children(path: string) {
    return [...this.folders.keys()].filter((candidate) => candidate !== '/' && parentOf(candidate) === path).sort();
  }

  private rootOf(path: string) {
    return [...this.writableRoots].find((root) => isInside(root, path));
  }

  summary(input = '/'): FolderSummaryResponseDto {
    const path = normalize(input);
    const root = this.rootOf(path);
    return {
      path,
      directAssetCount: this.assets(path).length,
      children: this.children(path).map((child) => {
        const assets = [...this.folders]
          .filter(([candidate]) => isInside(child, candidate))
          .flatMap(([, items]) => items);
        return {
          name: child.slice(child.lastIndexOf('/') + 1),
          path: child,
          assetCount: assets.length,
          coverAssetId: assets[0]?.id ?? null,
        };
      }),
      writable: !!root,
      libraryId: root ? this.libraryId : undefined,
      isLibraryRoot: root === path,
    };
  }

  browse(input?: string): FolderBrowseResponseDto {
    if (!input) {
      return {
        path: null,
        parentPath: null,
        entries: [...this.writableRoots].map((root) => ({ name: root, path: root })),
      };
    }

    const path = normalize(input);
    return {
      path,
      parentPath: this.writableRoots.has(path) ? null : parentOf(path),
      entries: this.children(path).map((child) => ({ name: child.slice(child.lastIndexOf('/') + 1), path: child })),
    };
  }

  move(source: string, destination: string) {
    const entries = [...this.folders];
    for (const [path, assets] of entries) {
      if (!isInside(source, path)) {
        continue;
      }

      this.folders.delete(path);
      this.folders.set(destination + path.slice(source.length), assets);
    }
  }

  remove(path: string) {
    for (const candidate of this.folders.keys()) {
      if (isInside(path, candidate)) {
        this.folders.delete(candidate);
      }
    }
  }
}

export const createFolderHandlers = (folders: MockFolders): Handlers => ({
  getFolderRoots: () => ({ json: folders.roots() }),
  getUniqueOriginalPaths: () => ({ json: folders.uniquePaths() }),
  getAssetsByOriginalPath: ({ params }) => ({ json: folders.assets(params.path) }),
  getFolderSummary: ({ params = {} }) => ({ json: folders.summary(params.path) }),
  browseFolders: ({ params = {} }) => ({ json: folders.browse(params.path) }),
  createFolder: ({ body }) => {
    const path = `${normalize(body.parentPath)}/${body.name}`.replace('//', '/');
    if (folders.has(path)) {
      return { status: 409, json: { message: 'A file or folder with this name already exists', statusCode: 409 } };
    }
    folders.addFolder(path);
    return { status: 201, json: { path } };
  },
  renameFolder: ({ body }) => {
    const source = normalize(body.path);
    const target = `${parentOf(source)}/${body.name}`.replace('//', '/');
    folders.move(source, target);
    return { json: { path: target } };
  },
  renameFolderAsset: ({ params, body }) => ({
    json: { id: params.id, originalPath: `/${body.name}`, originalFileName: body.name },
  }),
  moveFolderItems: ({ body }) => {
    for (const path of body.folderPaths ?? []) {
      const source = normalize(path);
      folders.move(source, `${normalize(body.destination)}/${source.slice(source.lastIndexOf('/') + 1)}`);
    }
    return { json: { moved: (body.folderPaths?.length ?? 0) + (body.assetIds?.length ?? 0), failed: [] } };
  },
  deleteFolderItems: ({ body }) => {
    for (const path of body.folderPaths ?? []) {
      folders.remove(normalize(path));
    }
    const count = (body.assetIds?.length ?? 0) + (body.folderPaths?.length ?? 0);
    return {
      json: {
        trashed: body.force ? 0 : count,
        deleted: body.force ? count : 0,
        removedFolders: body.folderPaths?.length ?? 0,
        failed: [],
      },
    };
  },
});
