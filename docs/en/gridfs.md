# GridFS

Instance and Model helpers store and read MongoDB GridFS files. GridFS was introduced in monSQLize v3.5.0. This document describes the source checkout; verify the installed npm version and its changelog before relying on newer lifecycle behavior.

GridFS is a client convention on ordinary collections (`<bucket>.files` and `<bucket>.chunks`). It does not require a Search or Vector Search deployment. Integration coverage uses `mongodb-memory-server` 7.0.37. The formal server matrix remains MongoDB 7.x and 8.x. Older servers, including 4.x, are unverified.

## Open a bucket

```ts
const bucket = msq.gridfs(bucketName?: string, opts?: {
  db?: string;
  pool?: string;
  chunkSizeBytes?: number;
});

const modelBucket = model.gridfs(bucketName?: string, opts?: {
  chunkSizeBytes?: number;
});
```

`bucketName` defaults to `fs`. An empty string is rejected. `chunkSizeBytes` defaults to 261120 (255 KiB) and must be a positive integer.

`msq.gridfs()` uses the runtime connection unless `pool` names a configured pool. A named pool uses that pool's client and `client.db(db)`. `db` defaults to the runtime database. `model.gridfs()` always uses the Model `poolName` and `dbName`; it does not accept `pool` or `db`.

Calling either method before `connect()` throws `NOT_CONNECTED`.

## Files API

| Method | Result |
|--------|--------|
| `upload(filename, data, opts?)` | Promise of file info. `data` is a `Buffer`, `Uint8Array`, or `Readable`. |
| `uploadStream(filename, opts?)` | Synchronous `Writable` with `id` and `done`. Await `done` for file info or the mapped error. When the upload fails, the `Writable` is also destroyed with that error. An `id` that already has a file rejects with `GRIDFS_FILE_EXISTS` and writes nothing. |
| `download(idOrName)` | Promise of a `Buffer`. |
| `downloadStream(idOrName, range?)` | Synchronous `Readable`. Missing files and range errors arrive as `'error'` events. |
| `getFile(id)` | File info, or `null` when the id is absent. |
| `findFiles(filter?, opts?)` | File info documents. `limit` must be a positive integer. `skip` must be `>= 0`. Sort values are `1` or `-1`. |
| `delete(id, opts?)` | Removes the files document and its chunks. `ignoreMissing: true` resolves when the id is absent. |
| `rename(id, filename)` | Renames one visible file. |
| `drop()` | Drops `<bucket>.files`, `<bucket>.chunks`, and `<bucket>.uploads` when they exist. The next write or `ensureIndexes()` on the same bucket recreates the indexes. |
| `ensureIndexes()` | Creates the indexes below. Safe to call more than once. |

`idOrName` is an `ObjectId` or `{ filename, revision? }`. `revision` follows the driver: `0` is the oldest file with that name, and `-1` (the default) is the newest. `download({ filename })` therefore returns the latest file with that name.

### `ifExists` and sha256

`upload` defaults to `ifExists: 'error'`.

- When `sha256` is set, the conflict key is `metadata.sha256`. The digest must be 64 lowercase hex characters. `Buffer` and `Uint8Array` payloads are hashed before any GridFS write. A mismatch throws `GRIDFS_INTEGRITY_MISMATCH` and leaves no visible file.
- A `Readable` passed with `sha256` is buffered completely, then hashed, before any write. Large files should use the resumable API instead.
- `skip` with `sha256` returns the newest visible file with that digest. `skip` without `sha256` returns the newest visible file with the same filename. `duplicate` always creates another file.
- A `metadata.sha256` value supplied inside `metadata` is caller data and is not verified. To request byte verification with `upload()`, use the top-level `sha256` option.
- `uploadStream` stores its top-level `sha256` option in metadata only. It does not check the bytes and it does not accept `ifExists`.

`metadata.sha256` written by these helpers overwrites a caller-supplied `metadata.sha256`. A provided `contentType` is stored as `metadata.contentType` and overwrites a caller-supplied value of that field. `FileInfo.contentType` returns it. An older file that still has a top-level `contentType` is returned the same way.

### Ranges

`downloadStream` ranges use an inclusive `start` and an exclusive `end`. Omitted `start` means `0`. Omitted `end` means the file length. A legal range satisfies `0 <= start < end <= length`. Anything else, including `start === end` and `start === length`, emits `GRIDFS_RANGE_INVALID`. When the failure depends on the file length, `details[0].length` is that length. Shape errors that can be rejected before a lookup omit `length`. `download()` reads the whole file and does not accept a range.

## Resumable upload

Phase 1 resumable upload keeps a pending session in `<bucket>.uploads` until finalize. The file stays invisible until `finalizeResumableUpload` succeeds. `uploadId` is the future `files._id`.

```ts
const session = await bucket.beginResumableUpload(filename, {
  length,
  sha256,
  chunkSizeBytes?,
  metadata?,
  contentType?,
  id?,
});
const progress = await bucket.appendChunks(session.uploadId, fromChunk, data);
const info = await bucket.finalizeResumableUpload(session.uploadId);
await bucket.abortResumableUpload(session.uploadId);
```

`beginResumableUpload` requires `length` and `sha256`. An id that already exists in `files` or `uploads` throws `GRIDFS_FILE_EXISTS`.

Chunk bytes must follow the session size:

- Every chunk except the last has length `chunkSizeBytes`.
- The last chunk has length `length % chunkSizeBytes`, or `chunkSizeBytes` when the length divides evenly.
- A payload that does not split into those sizes throws `INVALID_ARGUMENT`. The whole payload is checked before any chunk is inserted.

`appendChunks` is addressed by `fromChunk`:

- `fromChunk` past the contiguous prefix throws `GRIDFS_RESUME_MISMATCH` with `expectedNextChunk`.
- Replaying already stored chunks with the same bytes is idempotent and does not move `nextChunk` backward.
- Concurrent appends to one uploadId are serialized by a durable session claim. A competing append, finalize, or abort fails with `GRIDFS_UPLOAD_BUSY` while another operation owns the session.
- Replaying an earlier chunk with different bytes throws `GRIDFS_RESUME_MISMATCH`.
- A payload that contains any new chunk must start at `nextChunk`. Starting earlier throws `GRIDFS_RESUME_MISMATCH` and writes nothing.
- A duplicate `{ files_id, n }` insert is accepted only when the stored bytes match.

`finalizeResumableUpload` requires a contiguous prefix, a total length equal to the session length, and a sha256 equal to the session digest. It then inserts the files document, sets `metadata.sha256`, and deletes the session. Missing chunk indexes throw `GRIDFS_UPLOAD_INCOMPLETE` with `details[0].missingChunks`. A bad digest or a chunk of the wrong size throws `GRIDFS_INTEGRITY_MISMATCH`. The files document is not inserted in those cases.

Retrying `finalizeResumableUpload` is idempotent while the session still exists: if a file with the same id is already visible and its `metadata.sha256` and length match the session, the call returns that file and deletes the session. A file with a different sha256 or length still throws `GRIDFS_FILE_EXISTS`. Once the session is gone (a finalize that fully succeeded, an abort, or the TTL), there is no digest to compare, so a retry throws `GRIDFS_FILE_NOT_FOUND`; use `getFile(uploadId)` to check the result.

`abortResumableUpload` atomically claims a pending session before deleting chunks. It fails with `GRIDFS_UPLOAD_BUSY` while append or finalize owns the session. It deletes the session and, when no files document is visible, that upload's chunks. A missing or already aborted session resolves, and any chunks left under that id without a visible file are still deleted. Aborting an id that already has a visible file does not delete that file's chunks.

`<bucket>.uploads` uses an `expiresAt` TTL index (`expireAfterSeconds: 0`). Pending resumable sessions expire after **7 days without a successful append**; a successful append refreshes their expiry. Active append/finalize/abort claims and direct upload/delete reservations have no TTL and must be recovered explicitly after a crash, otherwise a stale writer could resume after its lock expires. MongoDB TTL deletion is asynchronous and removes only the session document, not chunks. Known orphan chunks can be cleaned with `abortResumableUpload(uploadId)` after an exclusive cleanup claim, or by starting a new resumable upload with the same ID. Existing `createdAt` TTL indexes are migrated to `expiresAt`; legacy pending expiry is derived from their last update. The migration requires stopping/draining old GridFS writers; mixing old and new writer versions is unsafe.

**Crash and migration recovery:** see [the operator runbook](./gridfs-recovery.md). Recovery is dry-run by default and requires verified process quiescence, an exact state/token check and an audit record; do not delete stale-looking reservations manually.

## Indexes

`upload`, `uploadStream` (before the driver stream is opened), `beginResumableUpload`, and `ensureIndexes` create:

| Collection | Key | Options |
|------------|-----|---------|
| `<bucket>.files` | `{ filename: 1, uploadDate: 1 }` | |
| `<bucket>.files` | `{ 'metadata.sha256': 1 }` | not unique |
| `<bucket>.chunks` | `{ files_id: 1, n: 1 }` | unique |
| `<bucket>.uploads` | `{ expiresAt: 1 }` | `expireAfterSeconds: 0`; pending resumable sessions set expiry for seven idle days |

Reads do not create indexes. A write rejected by `writePathPolicy` does not create them either. Every file ID is reserved atomically in `<bucket>.uploads` during upload, uploadStream, rename, and delete. A different operation using the same ID receives `GRIDFS_UPLOAD_BUSY`. `drop()` remains a bucket-wide destructive maintenance operation: stop/drain writers before calling it; the per-ID reservations do not coordinate bucket-wide drop.

## writePathPolicy

GridFS writes are category `gridfs`. The namespace is `<bucket>.files`, matched with the usual order: instance id, `pool:db.collection`, `db.collection`, collection name, then `default`.

| `gridfs` | `mode` | `msq.gridfs()` writes | `model.gridfs()` writes |
|----------|--------|----------------------|-------------------------|
| `inherit` (default) | `allow-both` | allowed | allowed |
| `inherit` | `model-only` | blocked | blocked |
| `allow` | either | allowed | allowed |
| `block` | either | blocked | blocked |

`inherit` does not follow the management rule. Management `inherit` still allows Model management and blocks direct management. GridFS `inherit` under `model-only` blocks both sources. `model.gridfs().drop()` stays a management operation, so Model drop remains allowed under `model-only` while `msq.gridfs().drop()` is blocked.

A blocked call throws `INVALID_OPERATION` before any GridFS write. `details[0]` includes `category: 'gridfs'` (or `'management'` for `drop`) and `reason: 'WRITE_PATH_POLICY'`. `onViolation: 'warn'` logs that detail and allows the call. `getFile`, `findFiles`, `download`, and `downloadStream` are not governed.

## Errors

| Code | When |
|------|------|
| `GRIDFS_FILE_NOT_FOUND` | Download, delete, rename, or resumable session target is missing |
| `GRIDFS_FILE_EXISTS` | `ifExists: 'error'` finds a conflict, or the chosen id is already present |
| `GRIDFS_INTEGRITY_MISMATCH` | Bytes do not match `sha256`, or a finalized chunk has the wrong size |
| `GRIDFS_UPLOAD_INCOMPLETE` | Finalize found gaps. `details[0].missingChunks` lists them |
| `GRIDFS_RESUME_MISMATCH` | `fromChunk` is ahead of the contiguous prefix, or a replayed chunk differs |
| `GRIDFS_UPLOAD_BUSY` | Another append/finalize/abort/upload/delete operation owns the ID; do not retry until it finishes or is explicitly recovered |
| `GRIDFS_RANGE_INVALID` | `start` / `end` is not a legal half-open range |
| `INVALID_ARGUMENT` | Filename, bucket name, chunk size, digest, metadata key, or chunk payload is invalid |
| `INVALID_OPERATION` | `writePathPolicy` blocked the call |
| `NOT_CONNECTED` | The runtime is not connected, or the selected pool client is missing |
| `MONGODB_ERROR` | Other driver or server failures. `cause` is the original error |

`downloadStream` delivers `GRIDFS_FILE_NOT_FOUND` and `GRIDFS_RANGE_INVALID` on the stream. The method itself does not throw those errors.
