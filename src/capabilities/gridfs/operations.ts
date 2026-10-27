import { PassThrough, Readable, Writable } from 'node:stream';
import { ObjectId, type Sort } from 'mongodb';
import type {
    GridFSContext,
    GridFSDeleteOptions,
    GridFSDownloadRange,
    GridFSDriverStream,
    GridFSFileInfo,
    GridFSFindFilesFilter,
    GridFSFindFilesOptions,
    GridFSIdOrName,
    GridFSUploadOptions,
    GridFSUploadStreamOptions,
} from './types';
import { readReadable, releaseReadable } from './bytes';
import { fileExists, fileNotFound, integrityMismatch, invalidArgument, isNamespaceNotFound, mapDriverError, targetOf } from './errors';
import { chunksCollectionName, filesCollectionName, toFileInfo, uploadsCollectionName } from './normalize';
import {
    assertChunkSize,
    assertContentType,
    assertFilename,
    assertFindOptions,
    assertIfExists,
    assertObjectId,
    assertSha256,
    buildMetadata,
    isReadableStream,
    parseRangeShape,
    rangeBounds,
    sanitizeFilter,
    sha256Hex,
    toNodeBuffer,
} from './validate';

export async function uploadFile(
    ctx: GridFSContext,
    filename: string,
    data: Buffer | Uint8Array | Readable,
    opts?: GridFSUploadOptions,
): Promise<GridFSFileInfo> {
    assertFilename(filename, 'upload');
    const options = opts ?? {};
    if (options.ifExists !== undefined) assertIfExists(options.ifExists);
    const ifExists = options.ifExists ?? 'error';
    if (options.id) assertObjectId(options.id, 'upload', 'id');
    if (options.sha256 !== undefined) assertSha256(options.sha256, 'upload');
    assertContentType(options.contentType, 'upload');
    const chunkSizeBytes = options.chunkSizeBytes ?? ctx.chunkSizeBytes;
    assertChunkSize(chunkSizeBytes, 'upload');
    const metadata = buildMetadata(options.metadata, options.sha256, 'upload');

    let payload: Buffer | undefined;
    let source: Readable | undefined;
    if (Buffer.isBuffer(data) || data instanceof Uint8Array) payload = toNodeBuffer(data);
    else if (isReadableStream(data)) source = data;
    else throw invalidArgument('upload', 'data', 'data must be a Buffer, Uint8Array, or Readable');

    if (source && options.sha256 !== undefined) {
        payload = await readReadable(source);
        source = undefined;
    }
    if (payload && options.sha256 !== undefined) {
        const actual = sha256Hex(payload);
        if (actual !== options.sha256) {
            throw integrityMismatch('upload', ctx.bucketName, { expected: options.sha256, actual });
        }
    }

    await ctx.indexes.ensure();
    if (options.id && await getFile(ctx, options.id)) {
        throw fileExists('upload', ctx, { id: options.id, filename, sha256: options.sha256 });
    }
    if (ifExists !== 'duplicate') {
        const existing = await findConflict(ctx, filename, options.sha256);
        if (existing) {
            if (source) releaseReadable(source);
            if (ifExists === 'skip') return existing;
            throw fileExists('upload', ctx, { id: existing.id, filename, sha256: options.sha256 });
        }
    }

    const id = options.id ?? new ObjectId();
    const writeOptions = { chunkSizeBytes, metadata, contentType: options.contentType };
    if (payload) await writeBuffer(ctx, id, filename, payload, writeOptions);
    else if (source) await writeReadable(ctx, id, filename, source, writeOptions);
    const info = await getFile(ctx, id);
    if (!info) throw fileNotFound('upload', ctx, { id, filename });
    return info;
}

export function openUploadStream(ctx: GridFSContext, filename: string, opts?: GridFSUploadStreamOptions): Writable & { id: ObjectId; done: Promise<GridFSFileInfo> } {
    assertFilename(filename, 'uploadStream');
    const options = opts ?? {};
    if ('ifExists' in options) throw invalidArgument('uploadStream', 'ifExists', 'uploadStream does not support ifExists');
    if (options.id) assertObjectId(options.id, 'uploadStream', 'id');
    if (options.sha256 !== undefined) assertSha256(options.sha256, 'uploadStream');
    assertContentType(options.contentType, 'uploadStream');
    const chunkSizeBytes = options.chunkSizeBytes ?? ctx.chunkSizeBytes;
    assertChunkSize(chunkSizeBytes, 'uploadStream');
    const metadata = buildMetadata(options.metadata, options.sha256, 'uploadStream');
    const id = options.id ?? new ObjectId();
    const input = new PassThrough();
    input.on('error', () => undefined);
    const done = (async (): Promise<GridFSFileInfo> => {
        let target: GridFSDriverStream | undefined;
        try {
            await ctx.indexes.ensure();
            target = ctx.driver.openUploadStream(id, filename, {
                chunkSizeBytes,
                metadata,
                contentType: options.contentType,
            });
            const { pipeline } = await import('node:stream/promises');
            await pipeline(input, target);
            const info = await getFile(ctx, id);
            if (!info) throw fileNotFound('uploadStream', ctx, { id, filename });
            return info;
        } catch (error) {
            if (target) await cleanupFailedWrite(ctx, id, target);
            throw mapDriverError(error, 'uploadStream', ctx, { id, filename });
        }
    })();
    void done.catch(() => undefined);
    return Object.assign(input, { id, done });
}

export async function downloadFile(ctx: GridFSContext, idOrName: GridFSIdOrName): Promise<Buffer> {
    const file = await resolveFile(ctx, idOrName, 'download');
    if (!file) throw fileNotFound('download', ctx, targetOf(idOrName));
    const source = ctx.driver.openDownloadStream(file.id);
    try {
        return await readReadable(source);
    } catch (error) {
        throw mapDriverError(error, 'download', ctx, { id: file.id, filename: file.filename });
    }
}

export function openDownloadStream(ctx: GridFSContext, idOrName: GridFSIdOrName, range?: GridFSDownloadRange): Readable {
    const output = new PassThrough();
    queueMicrotask(() => {
        void (async () => {
            try {
                const shape = parseRangeShape(range, 'downloadStream', ctx.bucketName);
                const file = await resolveFile(ctx, idOrName, 'downloadStream');
                if (!file) throw fileNotFound('downloadStream', ctx, targetOf(idOrName));
                const bounds = rangeBounds(shape, file.length, 'downloadStream', ctx.bucketName);
                const source = ctx.driver.openDownloadStream(file.id, bounds);
                source.on('error', (error) => output.destroy(mapDriverError(error, 'downloadStream', ctx, { id: file.id, filename: file.filename })));
                source.pipe(output);
            } catch (error) {
                output.destroy(mapDriverError(error, 'downloadStream', ctx, targetOf(idOrName)));
            }
        })();
    });
    return output;
}

export async function getFile(ctx: GridFSContext, id: ObjectId): Promise<GridFSFileInfo | null> {
    assertObjectId(id, 'getFile', 'id');
    try {
        const doc = await ctx.db.collection(filesCollectionName(ctx.bucketName)).findOne({ _id: id });
        return doc ? toFileInfo(doc as Record<string, unknown>) : null;
    } catch (error) {
        throw mapDriverError(error, 'getFile', ctx, { id });
    }
}

export async function findFiles(ctx: GridFSContext, filter?: GridFSFindFilesFilter, opts?: GridFSFindFilesOptions): Promise<GridFSFileInfo[]> {
    const query = sanitizeFilter(filter, 'findFiles');
    assertFindOptions(opts);
    try {
        let cursor = ctx.db.collection(filesCollectionName(ctx.bucketName)).find(query);
        if (opts?.sort) cursor = cursor.sort(opts.sort as Sort);
        if (opts?.skip) cursor = cursor.skip(opts.skip);
        if (opts?.limit) cursor = cursor.limit(opts.limit);
        const docs = await cursor.toArray();
        return docs.map((doc) => toFileInfo(doc as Record<string, unknown>));
    } catch (error) {
        throw mapDriverError(error, 'findFiles', ctx);
    }
}

export async function deleteFile(ctx: GridFSContext, id: ObjectId, opts?: GridFSDeleteOptions): Promise<void> {
    assertObjectId(id, 'delete', 'id');
    const existing = await getFile(ctx, id);
    if (!existing) {
        if (opts?.ignoreMissing) return;
        throw fileNotFound('delete', ctx, { id });
    }
    try {
        await ctx.driver.delete(id);
    } catch (error) {
        throw mapDriverError(error, 'delete', ctx, { id, filename: existing.filename });
    }
}

export async function renameFile(ctx: GridFSContext, id: ObjectId, filename: string): Promise<void> {
    assertObjectId(id, 'rename', 'id');
    assertFilename(filename, 'rename');
    const existing = await getFile(ctx, id);
    if (!existing) throw fileNotFound('rename', ctx, { id, filename });
    try {
        await ctx.driver.rename(id, filename);
    } catch (error) {
        throw mapDriverError(error, 'rename', ctx, { id, filename });
    }
}

export async function dropBucket(ctx: GridFSContext): Promise<void> {
    try {
        await ctx.driver.drop();
    } catch (error) {
        if (!isNamespaceNotFound(error)) throw mapDriverError(error, 'drop', ctx);
    }
    await dropIfExists(ctx, chunksCollectionName(ctx.bucketName));
    await dropIfExists(ctx, filesCollectionName(ctx.bucketName));
    await dropIfExists(ctx, uploadsCollectionName(ctx.bucketName));
}

async function dropIfExists(ctx: GridFSContext, name: string): Promise<void> {
    try {
        await ctx.db.collection(name).drop();
    } catch (error) {
        if (!isNamespaceNotFound(error)) throw mapDriverError(error, 'drop', ctx);
    }
}

async function findConflict(ctx: GridFSContext, filename: string, sha256: string | undefined): Promise<GridFSFileInfo | null> {
    const files = ctx.db.collection(filesCollectionName(ctx.bucketName));
    const filter = sha256 !== undefined ? { 'metadata.sha256': sha256 } : { filename };
    const docs = await files.find(filter).sort({ uploadDate: -1 }).limit(1).toArray();
    return docs[0] ? toFileInfo(docs[0] as Record<string, unknown>) : null;
}

async function resolveFile(ctx: GridFSContext, idOrName: GridFSIdOrName, operation: string): Promise<GridFSFileInfo | null> {
    if (idOrName instanceof ObjectId) return getFile(ctx, idOrName);
    if (!idOrName || typeof idOrName !== 'object' || typeof idOrName.filename !== 'string') {
        throw invalidArgument(operation, 'idOrName', 'idOrName must be an ObjectId or { filename, revision? }');
    }
    assertFilename(idOrName.filename, operation);
    const revision = idOrName.revision ?? -1;
    if (idOrName.revision !== undefined && (typeof revision !== 'number' || !Number.isInteger(revision))) {
        throw invalidArgument(operation, 'revision', 'revision must be an integer');
    }
    const files = ctx.db.collection(filesCollectionName(ctx.bucketName));
    const cursor = revision >= 0
        ? files.find({ filename: idOrName.filename }).sort({ uploadDate: 1 }).skip(revision).limit(1)
        : files.find({ filename: idOrName.filename }).sort({ uploadDate: -1 }).skip(-revision - 1).limit(1);
    const docs = await cursor.toArray();
    return docs[0] ? toFileInfo(docs[0] as Record<string, unknown>) : null;
}

async function writeBuffer(ctx: GridFSContext, id: ObjectId, filename: string, payload: Buffer, options: { chunkSizeBytes: number; metadata?: import('mongodb').Document; contentType?: string }): Promise<void> {
    const stream = ctx.driver.openUploadStream(id, filename, options);
    try {
        await endWritable(stream, payload);
    } catch (error) {
        await cleanupFailedWrite(ctx, id, stream);
        throw mapDriverError(error, 'upload', ctx, { id, filename });
    }
}

async function writeReadable(ctx: GridFSContext, id: ObjectId, filename: string, source: Readable, options: { chunkSizeBytes: number; metadata?: import('mongodb').Document; contentType?: string }): Promise<void> {
    const stream = ctx.driver.openUploadStream(id, filename, options);
    try {
        const { pipeline } = await import('node:stream/promises');
        await pipeline(source, stream);
    } catch (error) {
        await cleanupFailedWrite(ctx, id, stream);
        throw mapDriverError(error, 'upload', ctx, { id, filename });
    }
}

function endWritable(stream: Writable, payload: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
        const fail = (error: Error) => reject(error);
        stream.once('error', fail);
        stream.once('finish', () => {
            stream.removeListener('error', fail);
            resolve();
        });
        stream.end(payload);
    });
}

async function cleanupFailedWrite(ctx: GridFSContext, id: ObjectId, stream: GridFSDriverStream): Promise<void> {
    try {
        if (typeof stream.abort === 'function') await stream.abort();
    } catch { /* A finished driver stream refuses abort; delete the visible file below. */ }
    try {
        if (await getFile(ctx, id)) await ctx.driver.delete(id);
    } catch { /* The caller still receives the original write error. */ }
}
