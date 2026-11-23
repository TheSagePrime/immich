# SagePrime fork of Immich

This fork is based on the official Immich `v3.4.2` release (branch `sageprime`). It is meant for a private,
single-admin server that keeps using the official Immich mobile apps. Every change is additive:

- existing API endpoints and response fields keep their shape and behaviour, new fields are only added;
- every database migration has a working `down()` so the database can be returned to the official `v3.4.2` schema;
- the machine-learning image stays the official one.

Each feature group appends its own section to this file.

## Deploying the fork

Build the server image from the repository root (the same Dockerfile the official release uses):

```bash
docker build -f server/Dockerfile -t immich-server:sageprime .
```

Then point the `immich-server` service of your `docker-compose.yml` at that image and keep everything else official:

```yaml
services:
  immich-server:
    image: immich-server:sageprime
  immich-machine-learning:
    image: ghcr.io/immich-app/immich-machine-learning:v3.4.2
```

Start it as usual (`docker compose up -d`). The fork's database migrations run automatically when the server starts.

Before every upgrade of the fork, take a database backup (Administration > Maintenance, or `pg_dump`).

## Migrations added by the fork

All fork migrations are newer than the last official `v3.4.2` migration,
`1792568637987-AddAssetOwnerIdUpdateIdIndex`. They live in `server/src/schema/migrations/` and are listed in its
`ORDER` file.

| Migration                                               | Group      | What it does                                                                                                    | Revert           |
| ------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------- | ---------------- |
| `1795470129477-AddLibraryWritable`                      | foundation | Adds `library.writable boolean NOT NULL DEFAULT false`                                                          | Drops the column |
| `1795560000000-AddAssetOwnerIdOriginalPathPatternIndex` | folders    | Adds the index `asset_ownerId_originalPath_pattern_idx` on `asset ("ownerId", "originalPath" text_pattern_ops)` | Drops the index  |

## Rolling back to the official v3.4.2 images

The official server refuses to start on a database that contains migrations it does not know. On startup it fails with
`Migration "<name>" was already applied to this database but is not in this version of Immich (3.4.2) ... Downgrades
are not supported.` So the fork migrations must be reverted **while the fork image is still in use**, and only then can
the image be switched back.

1. Take a database backup (Administration > Maintenance > create backup, or `pg_dump`).
2. Stop the fork server so nothing writes to the database while it is being reverted:

   ```bash
   docker compose stop immich-server
   ```

3. See what would be reverted (the database container must be running):

   ```bash
   docker compose run --rm --no-deps immich-server "immich-admin revert-fork-migrations --dry-run"
   ```

4. Revert every fork migration down to `1792568637987-AddAssetOwnerIdUpdateIdIndex`:

   ```bash
   docker compose run --rm --no-deps immich-server "immich-admin revert-fork-migrations"
   ```

   The command runs the `down()` of each fork migration, newest first, in one transaction, and prints the reverted
   migrations. Running it again prints `Nothing to revert`. If the fork server container is still running, the same
   commands work through `docker exec -it immich_server immich-admin revert-fork-migrations`, but stop the container
   right afterwards: a restarted fork server applies its migrations again.

5. Switch the `immich-server` image back to the official one, for example
   `image: ghcr.io/immich-app/immich-server:v3.4.2`, and start it:

   ```bash
   docker compose up -d
   ```

Data stored only in fork columns or tables (for example the `writable` flag of a library) is dropped by the revert.
Files written to disk by fork features stay on disk.

## Settings and environment variables

| Name               | Where                                                | Default  | Meaning                                                               |
| ------------------ | ---------------------------------------------------- | -------- | --------------------------------------------------------------------- |
| Library "writable" | Administration > External Libraries > library > Edit | off      | Lets fork features write files inside the library's first import path |
| Start page         | Account Settings > Features > Folders                | Timeline | `navigation.startPage` preference: `timeline` or `folders`            |

The foundation adds no environment variables.

## Foundation

### Writable external libraries

External libraries have a new `writable` flag (API: `writable` on `LibraryResponseDto`, optional on
`CreateLibraryDto` and `UpdateLibraryDto`; web: the "Allow writing files" switch in the library edit dialog, and a
"Writable" badge on the library page).

A writable library is an external library whose **first** import path is mounted read-write into the server
container. Turning the flag on (or changing the import paths of a writable library) is rejected unless the first import
path exists, is a directory outside the upload location, and is readable and writable by the server. Features that
write files (folder upload, folder management) only ever operate inside a writable library's import paths. Libraries
are read-only by default, exactly like upstream.

To use it, mount the folder read-write (no `:ro`) in `docker-compose.yml`, add it as the first import path of the
library, and enable "Allow writing files".

### Safe paths

`server/src/utils/safe-path.ts` is the single place where a path supplied by a user is turned into a file-system path:

- `parseRelativePath(input)` rejects absolute paths, `..` segments, NUL bytes and backslashes, and returns the
  segments;
- `parseSafeName(input)` accepts exactly one path segment (a file or folder name);
- `resolveSafePath(root, input)` resolves `input` inside `root`, following symbolic links of the deepest existing
  ancestor with `realpath` and rejecting anything that ends up outside `realpath(root)`, including broken symbolic
  links that a later write would follow;
- `isPathInside(root, candidate)` is the lexical containment check.

Invalid paths raise `BadRequestException` (HTTP 400).

### Rollback command

`immich-admin revert-fork-migrations [--dry-run]` reverts every applied migration newer than the official baseline
`1792568637987-AddAssetOwnerIdUpdateIdIndex`. It refuses to run when the baseline migration is not present in the
database. See "Rolling back to the official v3.4.2 images" above.

## Folders first

### What it adds

- **Folder home.** The folder view is on by default (`folders.enabled` and `folders.sidebarWeb` now default to `true`
  for users who never changed them) and can be the start page: Account Settings > Features > Folders > Start page
  (`navigation.startPage`, `timeline` by default). The root URL, the logo and the end of onboarding open the start
  page; after login, an explicit `continue` URL still wins.
- **Covers, counts and breadcrumbs.** Every child folder shows the number of assets in it (including subfolders) and
  the newest asset as cover. Breadcrumbs show every path segment and every segment is a link.
- **Folder management in writable libraries.** Inside the first import path of a writable library, the owner of the
  library (or an admin) can create, rename, move and delete folders, rename files (the extension stays the same) and
  move or delete a selection of folders and files. Moves use a folder picker that only lists writable folders.
  Management controls are hidden everywhere else.

### API (all additive)

| Endpoint                         | Permission     | What it does                                                                       |
| -------------------------------- | -------------- | ---------------------------------------------------------------------------------- |
| `GET /view/folder/summary?path=` | `folder.read`  | Child folders with `assetCount` and `coverAssetId`, `directAssetCount`, `writable` |
| `GET /folders/browse?path=`      | `folder.read`  | Child folders on disk of a writable folder, or the writable library roots          |
| `POST /folders`                  | `asset.upload` | Create an empty folder (`409` if the name exists)                                  |
| `PUT /folders/rename`            | `asset.update` | Rename a folder                                                                    |
| `PUT /folders/assets/:id/rename` | `asset.update` | Rename the file of an asset, same extension                                        |
| `PUT /folders/move`              | `asset.update` | Move up to 1000 folders and 1000 assets into a folder of the same library          |
| `DELETE /folders`                | `asset.delete` | Trash (or with `force` delete) up to 1000 folders and 1000 assets                  |

`GET /view/folder/unique-paths` and `GET /view/folder`, which the mobile app uses, are unchanged.
`UserPreferencesResponseDto` gains an optional `navigation` object; no existing field changed.

### How the file operations stay safe

- Every path is resolved with `resolveSafePath` inside the first import path of a writable library the caller owns
  (admins: any writable library). `..`, NUL bytes, backslashes and any symbolic link on the way are refused, so a
  link inside the library cannot be used to reach a folder outside it. The library folder itself cannot be renamed,
  moved or deleted. New names must not start with a dot or match an exclusion pattern of the library (a scan would
  hide them otherwise).
- Nothing is overwritten: folders are renamed only after checking the target does not exist, files are moved with a
  hard link plus unlink (a copy with `COPYFILE_EXCL` when hard links are not possible) and a target that still has
  assets in the database is refused with `409`.
- The database is updated in the same transaction as the file operation: `originalPath`, the path checksum of
  external assets, `originalFileName` for renamed files and sidecar paths in `asset_file`, for every asset under the
  folder including trashed and offline ones. If the database update fails, the files are moved back. Asset ids do not
  change, so albums, faces, favourites and the mobile app's sync keep working. Sidecars next to a moved file
  (`photo.jpg.xmp`, `photo.xmp`) and the video of a live photo in the same folder move with it.
- Uploaded assets (not in a library) are never moved or renamed.
- Folder operations run one at a time (database advisory lock `FolderManagement`). The library watcher's unlink
  handler takes the same lock, so a watcher event caused by a move cannot delete the moved asset, and the watcher's
  import job now skips paths that already belong to an asset of the library.

### Deleting

- **Default: trash.** The assets of the selected folders and files go to the Immich trash. Their files stay on disk
  and can be restored from the trash. Empty folders (no files at all) are removed from disk right away; a folder that
  still contains files, including files Immich does not know, stays.
- **Delete permanently (`force`).** The assets are deleted like `DELETE /assets` with `force`, and the background
  deletion job removes their files from disk. Folders that end up empty are left on disk until they are deleted again.
- **Emptying the trash deletes files.** This is upstream behaviour, but it matters more now: when the trash of a
  writable library asset is emptied or expires, Immich deletes its original file and sidecar from the library folder.
- Nothing is ever deleted recursively (`rm -rf`) and nothing outside a writable library is touched.

### Known limitations

- A library scan that runs between the file rename and the database commit can mark a moved asset offline; the next
  scan brings it back.
- `GET /view/folder` still returns every asset of a folder in one response (unchanged upstream behaviour).
- Summaries of the root folder scan all assets of the user once (about a second for 500k assets); the web app caches
  them for a minute.
- File rename is available from the selection bar when exactly one asset of a writable folder is selected.

## Outbound network calls

The fork must not add hidden network traffic. Every group lists the outbound calls its features make here.

- Foundation: none. Writable libraries, safe paths and the rollback command only touch the local file system and the
  database.
- Folders first: none. Folder summaries and folder management only read the database and the library folders.
