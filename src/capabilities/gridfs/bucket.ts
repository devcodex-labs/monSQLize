import type { Readable, Writable } from 'node:stream';
import type { ObjectId } from 'mongodb';
import { assertWritePathAllowed } from '../write-path-policy';
import type {
    AppendChunksResult,
    BeginResumableUploadOptions,
    BeginResumableUploadResult,
    GridFSContext,
    GridFSDeleteOptions,
    GridFSDownloadRange,
    GridFSFileInfo,
    GridFSFindFilesFilter,
    GridFSFindFilesOptions,
    GridFSIdOrName,
    GridFSUploadOptions,
    GridFSUploadStreamOptions,
} from './types';
import { deleteFile, downloadFile, dropBucket, findFiles, getFile, openDownloadStream, openUploadStream, renameFile, uploadFile } from './operations';
import { abortResumableUpload, appendChunks, beginResumableUpload, finalizeResumableUpload } from './resumable';

export class MonSQLizeGridFSBucketImpl {
    constructor(private readonly ctx: GridFSContext) {}

    get bucketName(): string { return this.ctx.bucketName; }
    get dbName(): string { return this.ctx.dbName; }
    get chunkSizeBytes(): number { return this.ctx.chunkSizeBytes; }

    upload(filename: string, data: Buffer | Uint8Array | Readable, opts?: GridFSUploadOptions): Promise<GridFSFileInfo> {
        this.assertGridfs('upload');
        return uploadFile(this.ctx, filename, data, opts);
    }

    uploadStream(filename: string, opts?: GridFSUploadStreamOptions): Writable & { id: ObjectId; done: Promise<GridFSFileInfo> } {
        this.assertGridfs('uploadStream');
        return openUploadStream(this.ctx, filename, opts);
    }

    download(idOrName: GridFSIdOrName): Promise<Buffer> {
        return downloadFile(this.ctx, idOrName);
    }

    downloadStream(idOrName: GridFSIdOrName, range?: GridFSDownloadRange): Readable {
        return openDownloadStream(this.ctx, idOrName, range);
    }

    getFile(id: ObjectId): Promise<GridFSFileInfo | null> {
        return getFile(this.ctx, id);
    }

    findFiles(filter?: GridFSFindFilesFilter, opts?: GridFSFindFilesOptions): Promise<GridFSFileInfo[]> {
        return findFiles(this.ctx, filter, opts);
    }

    delete(id: ObjectId, opts?: GridFSDeleteOptions): Promise<void> {
        this.assertGridfs('delete');
        return deleteFile(this.ctx, id, opts);
    }

    rename(id: ObjectId, filename: string): Promise<void> {
        this.assertGridfs('rename');
        return renameFile(this.ctx, id, filename);
    }

    drop(): Promise<void> {
        this.assertAllowed('drop', 'management');
        return dropBucket(this.ctx);
    }

    beginResumableUpload(filename: string, opts: BeginResumableUploadOptions): Promise<BeginResumableUploadResult> {
        this.assertGridfs('beginResumableUpload');
        return beginResumableUpload(this.ctx, filename, opts);
    }

    appendChunks(uploadId: ObjectId, fromChunk: number, data: Buffer | Uint8Array | Readable): Promise<AppendChunksResult> {
        this.assertGridfs('appendChunks');
        return appendChunks(this.ctx, uploadId, fromChunk, data);
    }

    finalizeResumableUpload(uploadId: ObjectId): Promise<GridFSFileInfo> {
        this.assertGridfs('finalizeResumableUpload');
        return finalizeResumableUpload(this.ctx, uploadId);
    }

    abortResumableUpload(uploadId: ObjectId): Promise<void> {
        this.assertGridfs('abortResumableUpload');
        return abortResumableUpload(this.ctx, uploadId);
    }

    ensureIndexes(): Promise<void> {
        this.assertGridfs('ensureIndexes');
        return this.ctx.indexes.ensure();
    }

    private assertGridfs(operation: string): void {
        this.assertAllowed(operation, 'gridfs');
    }

    private assertAllowed(operation: string, category: 'gridfs' | 'management'): void {
        assertWritePathAllowed({
            policy: this.ctx.policy,
            namespace: {
                ...(this.ctx.poolName ? { pool: this.ctx.poolName } : {}),
                db: this.ctx.dbName,
                collection: `${this.ctx.bucketName}.files`,
            },
            source: this.ctx.source,
            operation,
            category,
            logger: this.ctx.logger,
        });
    }
}
