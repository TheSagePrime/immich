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
| `1795700000000-AddLoginAttemptTable`                    | security   | Adds the `login_attempt` table (failed password logins per email address and IP address)                        | Drops the table  |
| `1795800000000-AddFolderAlbums`                         | albums     | Adds `album.parentAlbumId`, `album.folderOwnerId`, `album.folderPath` and the `folder_album_sync` table         | See below        |

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

| Name                            | Where                                                       | Default  | Meaning                                                                        |
| ------------------------------- | ----------------------------------------------------------- | -------- | ------------------------------------------------------------------------------ |
| Library "writable"              | Administration > External Libraries > library > Edit        | off      | Lets fork features write files inside the library's first import path          |
| Start page                      | Account Settings > Features > Folders                       | Timeline | `navigation.startPage` preference: `timeline` or `folders`                     |
| Limit failed logins             | Administration > Settings > Authentication > Password Login | on       | `passwordLogin.rateLimit`, see "Security hardening"                            |
| `IMMICH_OUTBOUND_ALLOWED_HOSTS` | environment variable of `immich-server`                     | empty    | Private hosts and networks the server may still call, see "Security hardening" |
| Folder albums                   | Account Settings > Features > Albums                        | on       | `folderAlbums.enabled` preference: mirror every folder as an album             |

The foundation adds no environment variables. Folder uploads add none either; their limits are listed in
"Reliable folder uploads" below.

Privacy hardening adds these settings (see "Privacy hardening" below):

| Name                             | Where                                            | Default | Meaning                                                                |
| -------------------------------- | ------------------------------------------------ | ------- | ---------------------------------------------------------------------- |
| `map.enabled`                    | Administration > Settings > Map & GPS Settings   | off     | Map and map tiles in the web app (upstream default: on)                |
| `newVersionCheck.enabled`        | Administration > Settings > Version Check        | off     | Hourly check for new releases at `version.immich.cloud` (upstream: on) |
| `sharedLink.defaultExpiryDays`   | Administration > Settings > Shared Link Settings | 30      | Expiration preselected when a shared link is created in the web app    |
| `IMMICH_CONTENT_SECURITY_POLICY` | environment variable of `immich-server`          | `true`  | `false` serves the web app without the Content-Security-Policy header  |

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
  the newest asset as cover. Breadcrumbs show every folder name and every segment is a link (see "Friendly names").
- **Same layout as the rest of the app.** The Folders page keeps the main sidebar (with Folders highlighted) and shows
  folders as an album-style grid of cards; a folder shows its subfolders on top and its photos below. There is no
  separate folder tree panel.
- **Folder management in writable libraries.** Inside the first import path of a writable library, the owner of the
  library (or an admin) can create, rename, move and delete folders, rename files (the extension stays the same) and
  move or delete a selection of folders and files. Moves use a folder picker that only lists writable folders.
  These actions live in the page toolbar (New folder, Upload folder here, Select folders), in each card's menu
  (Rename, Move, Delete) and in the selection bar. Management controls are hidden everywhere else.

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

### Friendly names

- **Roots instead of server paths.** The top level of `/folders` shows one card per library that holds assets of the
  signed-in user (named after the library, for example "Media"), one per writable library the user manages (also
  when it is still empty), and "Phone uploads" for the assets uploaded to Immich itself (not in any library). Empty
  read-only libraries and an empty "Phone uploads" are not shown.
- **Only folder names.** Inside a root every card shows only the folder's own name and the breadcrumbs read like
  `Folders > Media > Trips > Goa`. The library import path and the upload location (`upload/<user id>`,
  `library/<storage label>`) are never shown; neither is the absolute path in the move picker.
- **Roots with several locations.** A library with several import paths, or uploads stored both in `upload/` and
  `library/`, first lists its locations as cards (last folder name, more segments only where names would clash).
- **URLs.** Folders are addressed as `/folders?root=<library id|uploads>&path=<relative path>`. Old links with an
  absolute `?path=` (bookmarks, the "open folder" link of the detail panel) redirect to the new form; a path outside
  every root still opens as before.

### File-manager actions

- **Context menu** on right-click, from the card's menu button and on long-press (touch) for folder cards and photos:
  Open, New folder, Rename, Move to folder, Delete, Upload folder here and Download (a folder downloads as a zip of
  all its assets including subfolders, a photo downloads its original). The menu is keyboard reachable (arrow keys,
  Home, End, Enter, Escape) and returns focus where it came from.
- **Read-only places.** Outside writable libraries (read-only libraries and "Phone uploads") the write items and the
  toolbar's New folder button stay visible but disabled with the hint "Read-only library"; Open and Download work.
- **Selection.** Ctrl/Cmd-click toggles a folder or a photo, Shift-click selects a range of folders in display order
  (the existing Shift range of photos keeps working), and bulk Move and Delete work on mixed selections.
- **Drag and drop.** Drag a folder or photo (or the whole selection when the dragged item is selected) onto a folder
  card or a breadcrumb to move it; the target is highlighted and the usual "moved" toast is shown.
- **Keyboard.** F2 renames the single selected folder or photo, Enter opens it, Delete or Backspace deletes the
  selection after the usual confirmation, Ctrl/Cmd+A selects all folders and photos and Escape clears the selection.
  Keys typed into inputs, dialogs and the open menu are left alone.

### Sorting

- The Sort menu in the toolbar orders the folder cards and the photos of the folder: Name (A-Z / Z-A), Date taken
  (newest / oldest), Date added (newest / oldest) and File size (largest / smallest). Folders always stay above the
  photos.
- Names sort naturally and ignore case ("Day 2" before "Day 10"), in the browser and for the server's folder list.
- Metrics of a subfolder, over every asset in it including its subfolders: date taken is the newest `fileCreatedAt`
  when sorting newest first and the oldest one when sorting oldest first; date added does the same with `createdAt`;
  file size is the total `fileSizeInByte`. Folders without assets go last, ties sort by name.
- Photos are sorted over the whole folder: `GET /view/folder` already returns every asset of the folder in one
  response, so no paging is involved.
- The choice is stored per user and per folder in the user preferences (`folders.sortOverrides`, at most 500 folders,
  the oldest is dropped). The last choice also becomes `folders.sortBy`/`folders.sortOrder`, the sort of folders that
  were never sorted. The default is Name A-Z. No migration is needed.

### API added for friendly names, actions and sorting (all additive)

| Endpoint or field                        | What it adds                                                                                             |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `GET /view/folder/roots` (`folder.read`) | Roots with `id`, `kind`, `name`, `writable`, `assetCount`, `coverAssetId`, and their top level `folders` |
| `FolderSummaryItemDto`                   | Optional `newestTakenAt`, `oldestTakenAt`, `newestAddedAt`, `oldestAddedAt`, `totalSize`                 |
| `DownloadInfoDto.folderPath`             | Optional; the assets of the signed-in user in that folder and its subfolders (refused for shared links)  |
| `FoldersResponse` / `FoldersUpdate`      | Optional `sortBy`, `sortOrder`, `sortOverrides`                                                          |

The paths in the roots response are the same absolute folder paths that `GET /view/folder/unique-paths` and the summary
already return to the same user; the web app only uses them to call the existing endpoints.

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
  browser's folder picker and then the upload dialog.
- **Drag and drop works like a file manager and never asks for a destination.** While files or folders are dragged
  over the window, the overlay names the target ("Drop to upload to: Goa"), and the progress panel shows it too
  ("Uploading to: Goa"). Sub-folders of a dropped folder are kept.
  - On an open folder of a writable library, the drop goes into that folder.
  - On a folder card, the drop goes into that folder; the card is highlighted while dragging over it.
  - Anywhere else (the Photos timeline, the Folders home, other pages) the drop goes into the root of the first
    writable library.
  - On a read-only folder or card the overlay turns red, says the folder is read-only and the drop is refused.
  - Files that already exist at the target are skipped (the dialog's default). Unsupported files are left out and
    counted in a short message; hidden files such as `.DS_Store` are left out silently.
  - Album pages, the locked folder and shared links keep the official upload behaviour, and so does every page when
    the user owns no writable library.
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
- If the server stops while a file is being completed, the session stays "completing". After one hour the next
  complete call (the web app sends one when it resumes the file) takes it over and finishes it; a hard link that was
  already made is recognised, so no numbered copy is created.
- An existing file or symbolic link at the target name is never written through: it counts as an existing file for the
  duplicate choice. If a file was stored but importing it as an asset failed (for example a database error), the file
  is kept, reported as uploaded, and imported by the next library scan.
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

## Privacy hardening

### No third-party calls by default

- **Version check off.** `newVersionCheck.enabled` now defaults to `false`, so the server no longer contacts
  `version.immich.cloud` every hour. Turn it on in Administration > Settings > Version Check.
- **Map off.** `map.enabled` now defaults to `false`. The web app hides the map page, the map in the asset info panel
  and the map commands, and the browser does not load tiles. Turn it on in Administration > Settings > Map & GPS
  Settings; the style URLs (`https://tiles.immich.cloud/v1/style/light.json` and `.../dark.json`) are unchanged and
  can point to a self-hosted tile server. Reverse geocoding (place names) keeps working: it uses the local GeoNames
  data shipped in the image.
- **Fonts and scripts are self-hosted.** The web build only loads files from the Immich server itself (checked: the
  only external URLs in the built bundle are links the user clicks, the opt-in Google Cast script and the map tiles).
- **Which value wins.** Immich only stores settings that differ from the defaults. A server that never changed these
  settings gets the new defaults (both off) after the upgrade. A setting that was saved explicitly (for example map
  turned off and on again, or set in a config file with `IMMICH_CONFIG_FILE`) keeps its saved value. After deploying,
  check both settings once in the admin UI.

### Content-Security-Policy and safe media responses

Every response gets `X-Content-Type-Options: nosniff`.

- **Web app** (`/`, `/photos`, `/index.html`, ...):
  `default-src 'self'; script-src 'self' 'wasm-unsafe-eval' <sha256 hashes>; script-src-attr 'none'; style-src 'self'
<sha256 hashes>; style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src
'self' data:; connect-src 'self' blob: https://pay.futo.org; worker-src 'self' blob:; manifest-src 'self'; frame-src
'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`.
  No `'unsafe-inline'` or `'unsafe-eval'` for scripts: the two inline scripts and inline styles of `index.html` are
  allowed by hash. The hashes come from `.csp.json`, which the web build writes next to `index.html` (upstream
  build step). Inline `style="..."` attributes stay allowed because Svelte and the UI library set them at runtime.
  `https://pay.futo.org` is only contacted when an admin enters a license key.
- **Map.** When the map is enabled, the origins of the two map style URLs are added to `connect-src` and `img-src`
  (for the official tiles also `https://static.immich.cloud`, which serves fonts and sprites). The header follows
  config changes without a restart. A custom style that loads tiles, fonts or sprites from another host needs that
  host in a custom policy (see below).
- **API** (`/api/...`, including asset originals, thumbnails, video playback, downloads and profile images):
  `default-src 'none'; img-src 'self' data: blob:; media-src 'self' data: blob:; style-src 'unsafe-inline';
frame-ancestors 'none'; base-uri 'none'; form-action 'none'; sandbox`. An SVG or HTML file opened directly from
  the API runs in a sandbox without scripts and cannot be framed.
- **API documentation** (`/doc`): only `frame-ancestors 'none'; object-src 'none'; base-uri 'self'`, because
  Swagger UI needs inline code.
- **Not affected:** the official mobile apps ignore these headers.
- **Google Cast** loads a script from `www.gstatic.com`, which the strict policy blocks. Casting from the web app
  therefore does not work in the fork unless the policy is replaced.
- **Replacing the policy.** `IMMICH_HELMET_FILE` works like upstream (`true` uses `server/helmet.json`, or a path to
  your own helmet options); when it sets a `contentSecurityPolicy`, that policy is used for the web app instead of
  the fork's. `IMMICH_CONTENT_SECURITY_POLICY=false` turns the web app policy off. The API sandbox and `nosniff`
  headers stay in both cases.

### External libraries and symbolic links

Library scans already skip symbolic links (upstream). The fork also refuses files that are reached through a
symbolic link that leads outside the import path:

- a file found by a scan or reported by the library watcher whose folder or file resolves (`realpath`) outside the
  import path is not imported;
- an existing asset whose file, or one of whose folders, was replaced by such a link is treated as missing on the
  next scan and goes offline (like a deleted file); it comes back online when the link is removed again;
- links that stay inside the import path, and an import path that is itself a link (for example a mount point), keep
  working.

The check costs one `lstat` per file and one `realpath` per folder during a scan.

### Shared links

- **Default expiration.** New links created in the web app have their expiration preselected to
  `sharedLink.defaultExpiryDays` (30 days by default; `0` preselects "Never"). The user can still pick another date
  or "Never". The server does not change requests: links created by the mobile app or the API without `expiresAt`
  still never expire, exactly like upstream, so the official app keeps working.
- **Revoke all links.** `DELETE /api/shared-links` (permission `sharedLink.delete`, not available to shared-link
  sessions) deletes every shared link of the calling user and returns `{ "count": <number> }`. Links of other users
  are not touched. In the web app: Sharing > Shared links > "Revoke all links" (with confirmation). Albums and assets
  stay; only the links are removed and stop working immediately.

### API (all additive)

| Endpoint               | Permission          | What it does                          |
| ---------------------- | ------------------- | ------------------------------------- |
| `DELETE /shared-links` | `sharedLink.delete` | Delete all shared links of the caller |

`AdminConfigDto` and `UserConfigDto` gain `sharedLink.defaultExpiryDays`. No existing endpoint or field changed. The
defaults returned by `GET /system-config/defaults` changed for `map.enabled` and `newVersionCheck.enabled`.

### Migrations

None.

## Security hardening

### Outbound requests are guarded against SSRF

Every URL the server fetches on its own goes through `server/src/utils/safe-fetch.ts` instead of the global `fetch`:

- OAuth: discovery, token, userinfo and JWKS requests of the configured issuer (through the `customFetch` hooks of
  `openid-client` and `jose`), and the download of the `picture` claim when a user logs in with OAuth. A picture
  embedded as a `data:` URL is still decoded locally.
- Workflow plugins: the `httpRequest` host function, in addition to the existing `allowedHosts` check of the plugin
  manifest.
- The version check (`https://version.immich.cloud`).

The guard resolves the host name once, refuses the request when **any** resolved address is loopback, private
(RFC 1918), unique local (`fc00::/7`), link local, carrier-grade NAT (`100.64.0.0/10`), unspecified, multicast,
reserved, documentation or benchmarking space, including IPv4 addresses hidden in IPv4-mapped, NAT64 and 6to4 IPv6
addresses, and then connects to exactly the address it checked, so a DNS answer that changes between the check and the
connection (DNS rebinding) cannot redirect it. Redirects are followed by hand (at most 5), every hop is checked again,
only `http` and `https` are allowed, URLs with credentials are refused and `Authorization` and `Cookie` headers are
dropped when a redirect leaves the origin. Response bodies are limited to 50 MiB after decompression (10 MiB for
workflow plugins), so a huge or compressed "bomb" response cannot exhaust memory. For workflow plugins every redirect
hop must also match the plugin manifest's `allowedHosts`, so a redirect cannot leave the hosts the plugin declared.

An OAuth provider (or a plugin target) on the local network needs an explicit allowlist:

```yaml
services:
  immich-server:
    environment:
      IMMICH_OUTBOUND_ALLOWED_HOSTS: auth.example.lan,10.0.20.0/24
```

Entries are comma separated: exact host names (`auth.example.lan`), sub-domain wildcards (`*.example.lan`, which does
not match `example.lan` itself), IP addresses and CIDR ranges. A private address is allowed when the host name or the
address is listed. The cloud metadata addresses (`169.254.169.254`, `fd00:ec2::254`), unspecified and multicast
addresses are refused even when they are listed. An invalid entry stops the server at start-up.

Not guarded on purpose, because they are internal services an administrator configures: the machine-learning URLs,
the SMTP server, the database, Redis and the maintenance health check on localhost.

### Media endpoints and shared links

- `server/src/controllers/index.spec.ts` now also pins the complete list of routes reachable without any credentials
  (`PUBLIC_ROUTES`) and checks that every media route (thumbnail, preview, original, video playback, HLS playlists and
  segments, downloads, asset files, person thumbnails, profile images) needs a session, an API key or a shared link.
- `e2e/src/specs/server/api/media-auth.e2e-spec.ts` runs every media endpoint against: no credentials, invalid
  token, invalid shared-link key, another user, the owner, an API key without the permission, a shared link for a
  different asset, a shared link of another user, a password protected link without its password, an album link
  inside and outside its album, and a link without download permission (originals and downloads are refused,
  thumbnails stay visible). It also covers asset-file downloads, person thumbnails, profile images and album or
  timeline download info.
- Gaps found and fixed:
  - the password of a password protected shared link only guarded `GET /shared-links/me`: anyone with the link's
    key could load the thumbnails, originals, videos and downloads of that link without the password. Every
    shared-link route now answers `401 Password required` for a password protected link unless the request carries
    the `immich_shared_link_token` cookie that `POST /shared-links/login` sets after the right password (the web
    share page already sends it). Only `POST /shared-links/login` itself works without it. Casting a password
    protected share to a Chromecast does not work any more, because the cast device does not have the cookie;
  - an asset that was shared with an individual shared link and later moved to the locked folder was still served to
    that link (thumbnail, original, metadata, and listed in `GET /shared-links/me`). Locked assets are now excluded
    from shared-link access and from the assets of a link;
  - `GET /assets/:id/video/stream/:sessionId/...` did not check that the streaming session belongs to the asset in
    the URL, so someone with access to one asset could ask for the segments of another streaming session of the same
    owner if they knew its random id. The session must now belong to that asset (also for ending a session).
- File routes keep the upstream behaviour of answering `404` instead of `400` when access is denied, so they do not
  reveal whether an asset exists.
- By design (unchanged): any signed-in user can load any user's profile image, and a shared link key in the request
  replaces the session of a signed-in user for that request.

### Login rate limiting

`POST /auth/login` (password login, used by the web and the mobile apps) is limited per email address and per client
IP address. The state is stored in the `login_attempt` table, so it is shared by all API workers and survives
restarts. Settings: Administration > Settings > Authentication > Password Login (`passwordLogin.rateLimit`):

| Setting              | Default | Meaning                                                                               |
| -------------------- | ------- | ------------------------------------------------------------------------------------- |
| `enabled`            | `true`  | Turns the limit on or off                                                             |
| `accountMaxFailures` | `5`     | Failed logins for one email address before it is locked                               |
| `ipMaxFailures`      | `30`    | Failed logins from one IP address (IPv6: per `/64`) before it is locked; `0` disables |
| `windowMinutes`      | `15`    | The count starts over when nothing failed for this long after the last failure/lock   |
| `lockoutMinutes`     | `1`     | First lockout                                                                         |
| `maxLockoutMinutes`  | `60`    | The lockout doubles with every further failure up to this                             |

- While locked, the server answers `429 Too Many Requests` with a `Retry-After` header (seconds) without checking the
  password, so even the correct password is refused until the lockout ends. The failure that reaches the limit is
  already answered with 429.
- Unknown email addresses are counted exactly like existing ones, so the answers do not reveal whether an account
  exists. Email addresses and IP addresses are stored only as SHA-256 hashes.
- A successful login resets the count of the email address (not of the IP address).
- Already signed-in apps are not affected: the mobile app's auto-backup uses its session token and never calls the
  login endpoint. OAuth, passkey and API-key logins are not limited.
- Expired rows are removed by the nightly session cleanup job.
- An attacker who knows an email address can keep that account locked for password logins. With the defaults a
  lockout lasts at most an hour and OAuth or passkey login still work.
- **Behind a reverse proxy**, Immich only sees the real client address when the proxy is trusted. The default trusts
  loopback, link-local and private addresses (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`), which
  covers a proxy on a Docker bridge network. A proxy on a public address must be added with `IMMICH_TRUSTED_PROXIES`.
  Otherwise every request seems to come from the proxy and the IP limit applies to all clients together (set
  `ipMaxFailures` to `0` in that case). For more protection, also rate limit `/api/auth/login` in the reverse proxy.

There was no per-IP limit before. There is still no general request rate limit; use the reverse proxy for that.

### Rollback

`immich-admin revert-fork-migrations` also reverts `1795700000000-AddLoginAttemptTable`. The `passwordLogin.rateLimit`
and `IMMICH_OUTBOUND_ALLOWED_HOSTS` settings are ignored by the official image.

## Folder albums

### What it adds

- **Every folder is an album.** Each folder that contains photos or videos becomes an album, and every sub-folder
  becomes a child album inside the album of its parent folder, as deep as the folders go. A folder that only contains
  sub-folders also gets an album, so the tree has no gaps. Empty folders get no album until something is in them.
- **Albums page.** The Albums page shows hand-made albums and the top-level folder albums only. Opening a folder album
  shows breadcrumbs (Albums > parent folders > this folder) with a "go to parent" button, the child albums as cards
  (cover and number of items, like the Folders view) and then the photos that are directly in that folder.
- **Marked as folder albums.** Folder albums carry a folder badge ("Folder album") on the album card, in the list
  view and on the album page, with the number of child albums and the folder path.
- **Hand-made albums** keep working exactly as before.

### Which folders become albums

A folder is the directory of an asset's original file, the same notion as the Folders view. Folder albums are per
owner: everyone only gets albums for their own assets. The top-level folder albums ("roots") are:

- every import path of the user's external libraries (writable or read-only), named after the last folder of the
  path. An asset of a library belongs to the longest import path of that library that contains it; library assets
  outside every import path are ignored;
- for uploaded assets (web upload, folder upload, phone backup): the storage template folder
  `<media>/library/<storage label or user id>`, named after the storage label (or `Library` when the user has none).

Assets in the upload hash folders (`<media>/upload/<user id>/xx/yy`, used when the storage template is off) are not
mirrored, because these folders are random. **Phone backups show up as folder albums only when the storage template is
enabled** (Administration > Settings > Storage Template).

An album holds exactly the assets that are directly in its folder and are on the timeline or archived. Trashed,
hidden (for example the video part of a live photo) and locked assets are not in folder albums; restoring an asset
from the trash puts it back.

### How they stay in sync

There is nothing to do by hand. A background job (`FolderAlbumSync`, in the background task queue) updates the folder
albums of a user:

- after uploads (mobile backup, web upload, folder upload, resumable uploads), library scans (new, changed, offline
  and removed files), metadata extraction and storage template moves, folder management (create, rename, move,
  delete, file rename), trashing, restoring and deleting assets, and visibility changes. These triggers are batched:
  at most one run per user every 10 seconds, so a library scan of thousands of files causes a handful of runs, not
  one job per file;
- right away when an import path of a library changes, a library is deleted or the user turns folder albums on or off;
- once when the server starts (this is the one-time backfill for existing photos), nightly with the database
  cleanup tasks (a full re-check that repairs anything a trigger missed), and on demand: Administration > Jobs >
  Create job > "Sync folder albums".

Runs are incremental: they only look at assets changed since the previous run (with a 10-minute overlap), plus one
quick check per folder album. Every run is idempotent and safe to repeat; it never rewrites an album that did not
change. A folder album whose folder (including all sub-folders) became empty is removed. Renaming or moving a folder
with folder management keeps the album ids (the album paths are rewritten in the same database transaction as the
assets), so shares and descriptions survive a rename or move.

### What can be changed on a folder album

- **Managed by the folder (read-only):** the name, the photos in it and its place in the tree. Renaming a folder
  album (`PATCH /albums/:id` with a different `albumName`) answers `400 Folder albums are named after their folder`,
  deleting it answers `400`, and adding or removing assets answers `200` with `success: false` and
  `error: "no_permission"` for every asset (the same shape as for any asset the user may not change, so the mobile app
  handles it). Folder albums are not offered in the "Add to album" picker of the web app.
  Files dropped onto a folder album page are uploaded like files dropped anywhere else (to the timeline, or into a
  writable library with the folder upload dialog) and are not added to that album; they show up in a folder album once
  their folder is mirrored.
- **Editable like any album:** the description, the cover photo, the sort order and the activity setting.
- **Sharing:** a folder album can be shared with users (any role) and with shared links exactly like a hand-made
  album. A share covers that one album only, not its child albums. A shared album whose parent is not shared with you
  shows up at the top of your Albums page. If a folder becomes empty its album is removed, and with it its shares; a
  new album (new id) is created when photos arrive in that folder again.

### Settings

- Account Settings > Features > Albums > **Folder albums** (`folderAlbums.enabled` preference, on by default).
  Turning it off deletes all folder albums of that user (hand-made albums are kept); turning it on again rebuilds them.
- No environment variables.

### API (all additive)

| Endpoint / field                           | What it is                                                                                                                                            |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /albums?topLevel=true`                | Only albums whose parent album is not available to the user. Without the parameter the list is flat and unchanged (the mobile app uses it like that). |
| `GET /albums/:id/folder`                   | `{ isFolderAlbum, path?, ancestors: [{ id, albumName }], children: AlbumResponseDto[] }`, permission `album.read`, no shared links                    |
| `AlbumResponseDto.isFolderAlbum`           | optional boolean                                                                                                                                      |
| `AlbumResponseDto.parentAlbumId`           | optional, nullable album id (not returned to shared links)                                                                                            |
| `AlbumResponseDto.childAlbumCount`         | optional number of child albums the user can see                                                                                                      |
| `UserPreferences*Dto.folderAlbums.enabled` | optional preference                                                                                                                                   |
| `ManualJobName` `folder-album-sync`        | admin job "Sync folder albums"                                                                                                                        |

No existing field or endpoint changed. The absolute folder path is never sent to clients; `path` in the folder
response is relative to the parent of the root folder (for example `photos/2024/Trip`) and only returned to the owner.

### Official iPhone app

- Folder albums are ordinary albums for the app: they come through `GET /albums` and the sync stream (albums, album
  users, album assets) with exactly the same fields as hand-made albums, and deletions arrive as normal album deletes.
  The app shows them as one flat list (no nesting); intermediate folders show 0 items.
- The first sync after enabling the feature sends one album-to-asset entry per mirrored photo to every phone, once.
  On a large library this first phone sync takes longer. Turn the preference off if you do not want folder albums on
  the phone at all.
- Auto-backup is not affected: uploads are unchanged and folder albums are updated afterwards in the background.
- The app's "sync albums" backup option links a device album to a server album with the same name. If such a name
  belongs to a folder album, assets the app tries to add are refused (`no_permission`) and are not added; rename the
  device album or the folder to avoid this.
- Renaming or deleting a folder album in the app is refused with an error message.

### Performance

- Incremental runs read only changed assets (index `asset (ownerId, updateId)`) and do one index probe per folder
  album; they take milliseconds. Runs are serialised with the database lock `FolderAlbumSync`.
- Full runs (backfill, nightly, manual, import path changes) group the user's assets by folder once and insert or
  remove memberships with one statement each: expect a few seconds for 500k assets, and on the very first run about one
  `album_asset` row per mirrored asset.
- `GET /albums` without `topLevel` (the mobile app) also counts the assets of every folder album, about half a second
  to a second and a half at 500k assets. The web app uses `topLevel=true`.

### Migration and rollback

`1795800000000-AddFolderAlbums` adds the nullable columns `album.parentAlbumId` (foreign key to `album`, `ON DELETE SET
NULL`, indexed), `album.folderOwnerId` (foreign key to `user`) and `album.folderPath`, the partial unique index
`album_folderOwnerId_folderPath_uq`, the check `album_folder_chk` and the table `folder_album_sync` (sync checkpoint per
user). Its `down()` (run by `immich-admin revert-fork-migrations`) deletes all folder albums (they are derived from the
folders and can be rebuilt; the mobile app removes them on its next sync), then drops the table, indexes, constraints
and columns. Hand-made albums, their photos and their shares are kept, so the official v3.4.2 server starts on an
unchanged album table.

## Outbound network calls

The fork must not add hidden network traffic. Every group lists the outbound calls its features make here.

- Foundation: none. Writable libraries, safe paths and the rollback command only touch the local file system and the
  database.
- Folders first: none. Folder summaries and folder management only read the database and the library folders.
- Reliable folder uploads: none. The browser only talks to the Immich server, and the server only writes to the
  library's import path and the database.
- Privacy hardening: none added; it removes calls. With the default settings the server and the web app make these
  outbound calls only:
  - **Machine learning models:** the official machine-learning container downloads models from Hugging Face
    (`huggingface.co`) the first time a model is used, unless they are already in its cache volume.
  - **OAuth:** only when OAuth is configured, the server talks to the configured issuer.
  - **Email:** only when SMTP is enabled. The email templates reference images on `immich.app` and a font on
    `fonts.gstatic.com`, which the recipient's mail client may load.
  - **Version check:** only when turned on (`version.immich.cloud`).
  - **Map tiles:** in the web app only when the map is turned on (browser to `tiles.immich.cloud` and
    `static.immich.cloud`, or your own style URLs). The official mobile app does not check the map setting: when a
    user opens its map, the app loads tiles from the style URLs in `GET /server/config` (unchanged, still
    `tiles.immich.cloud` unless you change them).
  - **License activation:** only when an admin enters a license key (browser to `pay.futo.org`).
  - **Google Cast:** only when a user turns casting on; blocked by the strict policy (see above).
  - **Workflow plugins:** only when an installed workflow plugin makes HTTP requests; the server only allows the
    hosts listed in that plugin's manifest (`allowedHosts`). No plugin makes requests by default.
  - **Reverse geocoding** needs no network at runtime: the GeoNames data is downloaded when the image is built.
  - **Mobile app:** the official app talks to the Immich server, and to the map tile host as described above.
- Security hardening: none new. The SSRF guard only restricts the existing calls listed in "Outbound requests are
  guarded against SSRF" (OAuth provider, OAuth profile picture, workflow plugin `httpRequest`, version check).
- Folder albums: none. The sync job only reads and writes the database.
