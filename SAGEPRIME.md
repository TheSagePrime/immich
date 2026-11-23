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

| Migration                          | Group      | What it does                                           | Revert           |
| ---------------------------------- | ---------- | ------------------------------------------------------ | ---------------- |
| `1795470129477-AddLibraryWritable` | foundation | Adds `library.writable boolean NOT NULL DEFAULT false` | Drops the column |

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

| Name               | Where                                                | Default | Meaning                                                               |
| ------------------ | ---------------------------------------------------- | ------- | --------------------------------------------------------------------- |
| Library "writable" | Administration > External Libraries > library > Edit | off     | Lets fork features write files inside the library's first import path |

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

## Outbound network calls

The fork must not add hidden network traffic. Every group lists the outbound calls its features make here.

- Foundation: none. Writable libraries, safe paths and the rollback command only touch the local file system and the
  database.
