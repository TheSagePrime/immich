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
| `1795600000000-AddUploadSessionTable`                   | uploads    | Adds the `upload_session` table (resumable folder uploads)                                                      | Drops the table  |

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

The foundation adds no environment variables. Folder uploads add none either; their limits are listed in
"Reliable folder uploads" below.

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
  (`photo.jpg.xmp`, and the recorded sidecar such as `photo.xmp`) and the video of a live photo in the same folder
  move with it. A sidecar named after the file stem (`photo.xmp`) stays where it is when another file of the folder
  has the same stem (for example a RAW and JPEG pair), so the other file keeps its sidecar.
- A folder that contains the import path of any library (also read-only libraries of other users) cannot be renamed,
  moved or deleted, so a folder operation never takes the files of another library away.
- Uploaded assets (not in a library) are never moved or renamed.
- Folder operations run one at a time (database advisory lock `FolderManagement`). The library watcher's unlink
  handler takes the same lock, so a watcher event caused by a move cannot delete the moved asset, and the watcher's
  import job now skips paths that already belong to an asset of the library.

### Deleting

- **Default: trash.** The assets of the selected folders and files go to the Immich trash. Their files stay on disk
  and can be restored from the trash. Empty folders (no files at all) are removed from disk right away; a folder that
  still contains files, including files Immich does not know, stays.
- **Delete permanently (`force`).** The assets, including those already in the trash, are deleted like
  `DELETE /assets` with `force`, and the background deletion job removes their files from disk. Folders that end up empty are left on disk until they are deleted again.
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

## Reliable folder uploads

Whole folders can be uploaded from the browser into a folder of a writable library, keeping the folder structure. The
existing upload (`POST /assets`, used by the mobile apps) is unchanged.

### Using it

- **Upload folder** in the top bar (shown only when the signed-in user owns at least one writable library) opens the
  browser's folder picker. Dropping a folder anywhere on the page does the same; the drop overlay now covers the whole
  window. Dropping plain files keeps the old behaviour.
- The dialog asks for the destination (library, then a folder inside it; new sub-folders can be added) and what to do
  when a file already exists: **skip** the new file, **keep both** (the new file is stored as `name (1).ext`,
  `name (2).ext`, ...) or **mark it as failed**. Before starting it shows how many files already exist there.
- The folder upload panel (bottom left) shows overall and per-file progress, speed and time remaining, and the outcome
  of every file (uploaded, renamed, skipped, failed, cancelled). Single files or all files can be cancelled; failed
  files can be retried one by one or with **Retry all failed**.
- Files are sent in 8 MB chunks, three files at a time. A dropped connection or a server error is retried with
  backoff (up to 8 times per chunk); the browser asks the server how many bytes it already has and continues from there.
  After a page reload, select the same folder again to resume unfinished files without sending their data again.
- Files are stored byte for byte: no conversion of HEIC/HEIF, MOV or anything else. Only the modification time is set to
  the one of the original file. Each stored file is imported as a normal external library asset and goes through the
  usual metadata, thumbnail and machine-learning jobs.

### Requirements

- The library must be writable (see "Writable external libraries"), and the server container user must be allowed to
  create files and folders in its first import path.
- Only files with a supported photo or video extension are accepted. Hidden files and folders (names starting with
  `.`), paths matching the library's exclusion patterns, absolute paths, `..`, backslashes, control characters and
  symbolic links that lead outside the import path are refused (HTTP 400).
- Reverse proxy: allow request bodies of at least 32 MB and the `PATCH` and `HEAD` methods for `/api/upload-sessions/`.

### How it works

- Partial data is written to `<first import path>/.immich-upload-tmp/<session id>.part` (if the destination folder is
  on a different mount inside the import path, to a `.immich-upload-tmp` folder on that mount), never to the final path.
  The folder is hidden, so library scans and the library watcher ignore it.
- When all bytes are there, the server checks the size and the SHA-1 checksum the browser sent, then hard-links the file
  to its final name, which never overwrites an existing file (where hard links are not supported, it checks and
  renames). A checksum mismatch fails the file and deletes the partial data.
- Sessions expire 24 hours after the last received chunk. The `UploadSessionCleanup` job (nightly with the database
  cleanup tasks, and once when the microservices worker starts) deletes expired partial files, finished session rows
  older than 7 days, and `.part` files in `.immich-upload-tmp` of writable libraries that no session knows about.
- Limits: 32 MB per chunk, 1000 unfinished uploads per user, and at least the file size plus 1 GB of free space in the
  library's file system when an upload starts.
- The library scan now skips paths that are already imported, so a watcher event for an uploaded file is a no-op.

### API

All endpoints need the `asset.upload` permission and only work for libraries the caller owns.

| Method and path                                      | Purpose                                                                                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/upload-sessions/libraries`                 | Writable libraries of the caller                                                                                                           |
| `GET /api/upload-sessions/libraries/:id/directories` | Sub-folders of `?path=` inside a writable library                                                                                          |
| `POST /api/upload-sessions/check`                    | Which of up to 1000 paths already exist                                                                                                    |
| `POST /api/upload-sessions`                          | Start an upload (library, relative path, size, SHA-1, policy)                                                                              |
| `GET /api/upload-sessions`                           | List sessions (filter by library, batch or status)                                                                                         |
| `GET` / `HEAD /api/upload-sessions/:id`              | Session with the number of stored bytes (`Upload-Offset`)                                                                                  |
| `PATCH /api/upload-sessions/:id`                     | Append a chunk: `Content-Type: application/offset+octet-stream`, `Upload-Offset` header; a wrong offset answers 409 with the stored offset |
| `POST /api/upload-sessions/:id/complete`             | Verify and store the file; calling it again returns the result                                                                             |
| `DELETE /api/upload-sessions/:id`                    | Cancel and delete the partial data                                                                                                         |

`PATCH` and `HEAD` are not part of the OpenAPI spec, so the generated SDKs only contain the JSON endpoints.

### Rollback

`immich-admin revert-fork-migrations` also reverts `1795600000000-AddUploadSessionTable`, which drops unfinished upload
sessions. Delete the `.immich-upload-tmp` folders in the import paths of writable libraries afterwards; files that were
already uploaded stay where they are and remain normal library files.

## Outbound network calls

The fork must not add hidden network traffic. Every group lists the outbound calls its features make here.

- Foundation: none. Writable libraries, safe paths and the rollback command only touch the local file system and the
  database.
- Folders first: none. Folder summaries and folder management only read the database and the library folders.

- Reliable folder uploads: none. The browser only talks to the Immich server, and the server only writes to the
  library's import path and the database.
