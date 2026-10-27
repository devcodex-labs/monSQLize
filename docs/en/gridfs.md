# GridFS

Instance and Model helpers store and read MongoDB GridFS files. The published npm package is still 3.4.0; this API is staged in the source after that release and is not a published 3.5.0 package.

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
| `uploadStream(filename, opts?)` | Synchronous `Writable` with `id` and `done`. Await `done` for file info or the mapped error. |
| `download(idOrName)` | Promise of a `Buffer`. |
| `downloadStream(idOrName, range?)` | Synchronous `Readable`. Missing files and range errors arrive as `'error'` events. |
| `getFile(id)` | File info, or `null` when the id is absent. |
| `findFiles(filter?, opts?)` | File info documents. `limit` must be a positive integer. `skip` must be `>= 0`. Sort values are `1` or `-1`. |
| `delete(id, opts?)` | Removes the files document and its chunks. `ignoreMissing: true` resolves when the id is absent. |
| `rename(id, filename)` | Renames one visible file. |
| `drop()` | Drops `<bucket>.files`, `<bucket>.chunks`, and `<bucket>.uploads` when they exist. |
| `ensureIndexes()` | Creates the indexes below. Safe to call more than once. |

`idOrName` is an `ObjectId` or `{ filename, revision? }`. `revision` follows the driver: `0` is the oldest file with that name, and `-1` (the default) is the newest. `download({ filename })` therefore returns the latest file with that name.

### `ifExists` and sha256

`upload` defaults to `ifExists: 'error'`.

- When `sha256` is set, the conflict key is `metadata.sha256`. The digest must be 64 lowercase hex characters. `Buffer` and `Uint8Array` payloads are hashed before any GridFS write. A mismatch throws `GRIDFS_INTEGRITY_MISMATCH` and leaves no visible file.
- A `Readable` passed with `sha256` is buffered completely, then hashed, before any write. Large files should use the resumable API instead.
- `skip` with `sha256` returns the newest visible file with that digest. `skip` without `sha256` returns the newest visible file with the same filename. `duplicate` always creates another file.
- `uploadStream` stores `sha256` in metadata only. It does not check the bytes and it does not accept `ifExists`.

`metadata.sha256` written by these helpers overwrites a caller-supplied `metadata.sha256`.

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
- Replaying an earlier chunk with different bytes throws `GRIDFS_RESUME_MISMATCH`.
- A payload that contains any new chunk must start at `nextChunk`. Starting earlier throws `GRIDFS_RESUME_MISMATCH` and writes nothing.
- A duplicate `{ files_id, n }` insert is accepted only when the stored bytes match.

`finalizeResumableUpload` requires a contiguous prefix, a total length equal to the session length, and a sha256 equal to the session digest. It then inserts the files document, sets `metadata.sha256`, and deletes the session. Missing chunk indexes throw `GRIDFS_UPLOAD_INCOMPLETE` with `details[0].missingChunks`. A bad digest or a chunk of the wrong size throws `GRIDFS_INTEGRITY_MISMATCH`. The files document is not inserted in those cases.

`abortResumableUpload` deletes the session and, when no files document is visible, that upload's chunks. A missing or already aborted session resolves. Aborting an id that already has a visible file does not delete that file's chunks.

`<bucket>.uploads` has a TTL index on `createdAt` with `expireAfterSeconds: 604800` (7 days). The TTL deletes upload session documents only. It does not delete chunks. Abort or finalize sessions that are no longer needed.

## Indexes

`upload`, `uploadStream` (before the driver stream is opened), `beginResumableUpload`, and `ensureIndexes` create:

| Collection | Key | Options |
|------------|-----|---------|
| `<bucket>.files` | `{ filename: 1, uploadDate: 1 }` | |
| `<bucket>.files` | `{ 'metadata.sha256': 1 }` | not unique |
| `<bucket>.chunks` | `{ files_id: 1, n: 1 }` | unique |
| `<bucket>.uploads` | `{ createdAt: 1 }` | `expireAfterSeconds: 604800` |

Reads do not create indexes. A write rejected by `writePathPolicy` does not create them either.

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
| `GRIDFS_RANGE_INVALID` | `start` / `end` is not a legal half-open range |
| `INVALID_ARGUMENT` | Filename, bucket name, chunk size, digest, metadata key, or chunk payload is invalid |
| `INVALID_OPERATION` | `writePathPolicy` blocked the call |
| `NOT_CONNECTED` | The runtime is not connected, or the selected pool client is missing |
| `MONGODB_ERROR` | Other driver or server failures. `cause` is the original error |

`downloadStream` delivers `GRIDFS_FILE_NOT_FOUND` and `GRIDFS_RANGE_INVALID` on the stream. The method itself does not throw those errors.
