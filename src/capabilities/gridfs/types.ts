import type { Readable, Writable } from 'node:stream';
import type { Db, Document, ObjectId } from 'mongodb';
import type { Logger } from '../../core/logger';
import type { NormalizedWritePathPolicy, WritePathSource } from '../write-path-policy';

/** Driver default: 255 KiB. */
export const DEFAULT_CHUNK_SIZE_BYTES = 255 * 1024;

/** `<bucket>.uploads` session TTL. MongoDB deletes the session document only. */
export const UPLOADS_TTL_SECONDS = 604800;

export interface GridFSFileInfo {
    id: ObjectId;
    filename: string;
    length: number;
    chunkSize: number;
    uploadDate: Date;
    contentType?: string;
    metadata?: Record<string, unknown>;
}

export type GridFSIfExists = 'error' | 'skip' | 'duplicate';

export interface GridFSUploadOptions {
    id?: ObjectId;
    metadata?: Record<string, unknown>;
    contentType?: string;
    sha256?: string;
    ifExists?: GridFSIfExists;
    chunkSizeBytes?: number;
}

export type GridFSUploadStreamOptions = Omit<GridFSUploadOptions, 'ifExists'>;

export type GridFSIdOrName = ObjectId | { filename: string; revision?: number };

export interface GridFSDownloadRange {
    start?: number;
    end?: number;
}

export interface GridFSFindFilesFilter {
    filename?: string;
    [key: string]: unknown;
}

export interface GridFSFindFilesOptions {
    limit?: number;
    skip?: number;
    sort?: Record<string, 1 | -1>;
}

export interface GridFSDeleteOptions {
    ignoreMissing?: boolean;
}

export interface BeginResumableUploadOptions {
    length: number;
    sha256: string;
    chunkSizeBytes?: number;
    metadata?: Record<string, unknown>;
    contentType?: string;
    id?: ObjectId;
}

export interface BeginResumableUploadResult {
    uploadId: ObjectId;
    nextChunk: number;
    chunkSizeBytes: number;
}

export interface AppendChunksResult {
    nextChunk: number;
    bytesAccepted: number;
}

export interface GridFSUploadSession {
    _id: ObjectId;
    filename: string;
    length: number;
    sha256: string;
    chunkSizeBytes: number;
    metadata?: Record<string, unknown>;
    contentType?: string;
    status: 'pending' | 'aborted';
    nextChunk: number;
    createdAt: Date;
    updatedAt: Date;
}

export interface GridFSDriverStream extends Writable {
    abort?: () => Promise<void>;
}

export interface GridFSDriver {
    openUploadStream(id: ObjectId, filename: string, options: {
        chunkSizeBytes: number;
        metadata?: Document;
        contentType?: string;
    }): GridFSDriverStream;
    openDownloadStream(id: ObjectId, range?: { start?: number; end?: number }): Readable;
    delete(id: ObjectId): Promise<void>;
    rename(id: ObjectId, filename: string): Promise<void>;
    drop(): Promise<void>;
}

export interface GridFSIndexLatch {
    ensure(): Promise<void>;
}

export interface GridFSContext {
    db: Db;
    driver: GridFSDriver;
    bucketName: string;
    dbName: string;
    poolName?: string;
    /** Configured namespace instance id. The write-path iid is derived the same way as collection writes. */
    instanceId?: string;
    chunkSizeBytes: number;
    source: Extract<WritePathSource, 'db' | 'model'>;
    policy?: NormalizedWritePathPolicy;
    logger?: Pick<Logger, 'warn'>;
    indexes: GridFSIndexLatch;
}

export interface ParsedRange {
    start?: number;
    end?: number;
}
