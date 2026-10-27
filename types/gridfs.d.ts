/**
 * GridFS bucket types.
 * @since v3.5.0
 */

import type { ObjectId } from 'mongodb';
import type { Readable, Writable } from 'node:stream';

/** Normalized GridFS file metadata. Driver-private state is omitted. */
export interface GridFSFileInfo {
    /** `files._id`. */
    id: ObjectId;
    filename: string;
    /** Byte length. Always >= 0. */
    length: number;
    /** Chunk size in bytes. Always > 0. */
    chunkSize: number;
    uploadDate: Date;
    /** Present when the file was stored with a content type. */
    contentType?: string;
    metadata?: Record<string, unknown>;
}

/** Options for `msq.gridfs()`. `db` and `pool` select the native database. */
export interface GridFSBucketOpenOptions {
    /** Defaults to the runtime database. */
    db?: string;
    /** Defaults to the runtime connection. A named pool uses that pool's client. */
    pool?: string;
    /** Defaults to 261120 (255 KiB). Must be a positive integer. */
    chunkSizeBytes?: number;
}

/** Options for `model.gridfs()`. Pool and database come from the Model. */
export interface GridFSModelBucketOpenOptions {
    /** Defaults to 261120 (255 KiB). Must be a positive integer. */
    chunkSizeBytes?: number;
}

/** What to do when uploaded content matches an existing visible file. Default `error`. */
export type GridFSIfExists = 'error' | 'skip' | 'duplicate';

export interface GridFSUploadOptions {
    /** Custom `files._id`. An existing id rejects with `GRIDFS_FILE_EXISTS`. */
    id?: ObjectId;
    metadata?: Record<string, unknown>;
    contentType?: string;
    /**
     * Lowercase 64-character sha256 hex. Stored as `metadata.sha256` and used as the idempotency key.
     * When the bytes do not match, upload rejects with `GRIDFS_INTEGRITY_MISMATCH` before the file is visible.
     */
    sha256?: string;
    /** Default `error`. */
    ifExists?: GridFSIfExists;
    /** Overrides the bucket chunk size for this file only. */
    chunkSizeBytes?: number;
}

/** `uploadStream` writes `sha256` into metadata and does not support `ifExists`. */
export interface GridFSUploadStreamOptions extends Omit<GridFSUploadOptions, 'ifExists'> {}

/**
 * Download target. `revision` follows the driver: `0` is the oldest file with that name,
 * `-1` (default) is the newest.
 */
export type GridFSIdOrName = ObjectId | { filename: string; revision?: number };

/**
 * Inclusive `start` and exclusive `end`, matching `GridFSBucketReadStreamOptions`.
 * Omitted `start` means 0. Omitted `end` means the file length.
 */
export interface GridFSDownloadRange {
    start?: number;
    end?: number;
}

export interface GridFSFindFilesFilter {
    filename?: string;
    [key: string]: unknown;
}

export interface GridFSFindFilesOptions {
    /** Positive integer. Omit for no limit. */
    limit?: number;
    /** Non-negative integer. Default 0. */
    skip?: number;
    sort?: Record<string, 1 | -1>;
}

export interface GridFSDeleteOptions {
    /** Default false. When true, a missing file resolves instead of `GRIDFS_FILE_NOT_FOUND`. */
    ignoreMissing?: boolean;
}

export interface BeginResumableUploadOptions {
    /** Final byte length. Positive integer. */
    length: number;
    /** Final lowercase sha256 hex. Checked by `finalizeResumableUpload`. */
    sha256: string;
    chunkSizeBytes?: number;
    metadata?: Record<string, unknown>;
    contentType?: string;
    /** Also the id returned as `uploadId` and the final `files._id`. */
    id?: ObjectId;
}

export interface BeginResumableUploadResult {
    uploadId: ObjectId;
    /** Next chunk index to write. A new session returns 0. */
    nextChunk: number;
    chunkSizeBytes: number;
}

export interface AppendChunksResult {
    nextChunk: number;
    bytesAccepted: number;
}

/**
 * Bucket returned by `msq.gridfs()` and `model.gridfs()`.
 * Reads do not consult `writePathPolicy`. Writes use category `gridfs`.
 * `drop` uses category `management`.
 */
export interface MonSQLizeGridFSBucket {
    readonly bucketName: string;
    readonly dbName: string;
    readonly chunkSizeBytes: number;
    upload(filename: string, data: Buffer | Uint8Array | Readable, opts?: GridFSUploadOptions): Promise<GridFSFileInfo>;
    uploadStream(filename: string, opts?: GridFSUploadStreamOptions): Writable & { id: ObjectId; done: Promise<GridFSFileInfo> };
    download(idOrName: GridFSIdOrName): Promise<Buffer>;
    downloadStream(idOrName: GridFSIdOrName, range?: GridFSDownloadRange): Readable;
    /** Returns null when the id is absent. */
    getFile(id: ObjectId): Promise<GridFSFileInfo | null>;
    findFiles(filter?: GridFSFindFilesFilter, opts?: GridFSFindFilesOptions): Promise<GridFSFileInfo[]>;
    delete(id: ObjectId, opts?: GridFSDeleteOptions): Promise<void>;
    rename(id: ObjectId, filename: string): Promise<void>;
    /** Drops `<bucket>.files`, `<bucket>.chunks`, and `<bucket>.uploads` when present. */
    drop(): Promise<void>;
    beginResumableUpload(filename: string, opts: BeginResumableUploadOptions): Promise<BeginResumableUploadResult>;
    appendChunks(uploadId: ObjectId, fromChunk: number, data: Buffer | Uint8Array | Readable): Promise<AppendChunksResult>;
    finalizeResumableUpload(uploadId: ObjectId): Promise<GridFSFileInfo>;
    /** Deletes the session and any chunks. A missing or already aborted session resolves. */
    abortResumableUpload(uploadId: ObjectId): Promise<void>;
    /** Creates the standard files/chunks indexes, `metadata.sha256`, and the uploads TTL index. */
    ensureIndexes(): Promise<void>;
}
