import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { ObjectId } from 'mongodb';
import type { AppendChunksResult, BeginResumableUploadOptions, BeginResumableUploadResult, GridFSContext, GridFSFileInfo, GridFSUploadSession } from './types';
import { fileExists, fileNotFound, integrityMismatch, invalidArgument, isDuplicateKey, mapDriverError, resumeMismatch, uploadIncomplete } from './errors';
import { binaryToBuffer, chunksCollectionName, filesCollectionName, sameBytes, toFileInfo, uploadsCollectionName } from './normalize';
import {
    assertChunkSize,
    assertContentType,
    assertFilename,
    assertNonNegativeInteger,
    assertObjectId,
    assertPositiveLength,
    assertSha256,
    buildMetadata,
    chunkCount,
    chunkLengthAt,
    isReadableStream,
    toNodeBuffer,
} from './validate';
import { readReadable } from './bytes';

export async function beginResumableUpload(ctx: GridFSContext, filename: string, opts: BeginResumableUploadOptions): Promise<BeginResumableUploadResult> {
    assertFilename(filename, 'beginResumableUpload');
    if (!opts || typeof opts !== 'object') {
        throw invalidArgument('beginResumableUpload', 'options', 'length and sha256 are required');
    }
    assertPositiveLength(opts.length, 'beginResumableUpload');
    assertSha256(opts.sha256, 'beginResumableUpload');
    assertContentType(opts.contentType, 'beginResumableUpload');
    if (opts.id) assertObjectId(opts.id, 'beginResumableUpload', 'id');
    const chunkSizeBytes = opts.chunkSizeBytes ?? ctx.chunkSizeBytes;
    assertChunkSize(chunkSizeBytes, 'beginResumableUpload');
    const metadata = buildMetadata(opts.metadata, undefined, 'beginResumableUpload');
    await ctx.indexes.ensure();

    const uploadId = opts.id ?? new ObjectId();
    const files = ctx.db.collection(filesCollectionName(ctx.bucketName));
    const uploads = ctx.db.collection(uploadsCollectionName(ctx.bucketName));
    if (await files.findOne({ _id: uploadId }, { projection: { _id: 1 } })) {
        throw fileExists('beginResumableUpload', ctx, { id: uploadId, filename, sha256: opts.sha256 });
    }
    if (await uploads.findOne({ _id: uploadId }, { projection: { _id: 1 } })) {
        throw fileExists('beginResumableUpload', ctx, { id: uploadId, filename, sha256: opts.sha256 });
    }

    const now = new Date();
    try {
        await uploads.insertOne({
            _id: uploadId,
            filename,
            length: opts.length,
            sha256: opts.sha256,
            chunkSizeBytes,
            ...(metadata ? { metadata } : {}),
            ...(opts.contentType !== undefined ? { contentType: opts.contentType } : {}),
            status: 'pending',
            nextChunk: 0,
            createdAt: now,
            updatedAt: now,
        });
    } catch (error) {
        throw mapDriverError(error, 'beginResumableUpload', ctx, { uploadId, filename });
    }
    return { uploadId, nextChunk: 0, chunkSizeBytes };
}

export async function appendChunks(
    ctx: GridFSContext,
    uploadId: ObjectId,
    fromChunk: number,
    data: Buffer | Uint8Array | Readable,
): Promise<AppendChunksResult> {
    assertObjectId(uploadId, 'appendChunks', 'uploadId');
    assertNonNegativeInteger(fromChunk, 'appendChunks', 'fromChunk');
    const payload = await payloadBytes(data);
    if (payload.length === 0) throw badChunkSize();
    const session = await requirePending(ctx, uploadId, 'appendChunks');
    const nextChunk = await contiguousNext(ctx, uploadId);
    if (fromChunk > nextChunk) {
        throw resumeMismatch('appendChunks', ctx.bucketName, { uploadId, fromChunk, expectedNextChunk: nextChunk });
    }

    const total = chunkCount(session.length, session.chunkSizeBytes);
    let offset = 0;
    let index = fromChunk;
    while (offset < payload.length) {
        if (index >= total) throw badChunkSize();
        const expected = chunkLengthAt(index, session.length, session.chunkSizeBytes);
        if (offset + expected > payload.length) throw badChunkSize();
        const slice = payload.subarray(offset, offset + expected);
        if (index < nextChunk) await assertStoredChunk(ctx, uploadId, index, slice);
        else await writeChunk(ctx, uploadId, index, slice);
        offset += expected;
        index += 1;
    }

    const advanced = await contiguousNext(ctx, uploadId);
    await ctx.db.collection(uploadsCollectionName(ctx.bucketName)).updateOne(
        { _id: uploadId },
        { $set: { nextChunk: advanced, updatedAt: new Date() } },
    );
    return { nextChunk: advanced, bytesAccepted: payload.length };
}

export async function finalizeResumableUpload(ctx: GridFSContext, uploadId: ObjectId): Promise<GridFSFileInfo> {
    assertObjectId(uploadId, 'finalizeResumableUpload', 'uploadId');
    const session = await requirePending(ctx, uploadId, 'finalizeResumableUpload');
    const files = ctx.db.collection(filesCollectionName(ctx.bucketName));
    if (await files.findOne({ _id: uploadId }, { projection: { _id: 1 } })) {
        throw fileExists('finalizeResumableUpload', ctx, { id: uploadId, filename: session.filename, sha256: session.sha256 });
    }

    const expected = chunkCount(session.length, session.chunkSizeBytes);
    const hash = createHash('sha256');
    let total = 0;
    const missing: number[] = [];
    const cursor = ctx.db.collection(chunksCollectionName(ctx.bucketName)).find({ files_id: uploadId }).sort({ n: 1 });
    let seen = 0;
    for await (const doc of cursor) {
        const n = typeof doc.n === 'number' ? doc.n : -1;
        while (seen < n && seen < expected) {
            missing.push(seen);
            seen += 1;
        }
        if (n !== seen || n < 0 || n >= expected) {
            if (n >= 0) missing.push(n);
            continue;
        }
        const bytes = binaryToBuffer(doc.data, 'finalizeResumableUpload');
        const want = chunkLengthAt(n, session.length, session.chunkSizeBytes);
        if (bytes.length !== want) {
            throw integrityMismatch('finalizeResumableUpload', ctx.bucketName, {
                uploadId,
                expected: want,
                actual: bytes.length,
            });
        }
        hash.update(bytes);
        total += bytes.length;
        seen += 1;
    }
    while (seen < expected) {
        missing.push(seen);
        seen += 1;
    }
    if (missing.length > 0) throw uploadIncomplete(ctx.bucketName, uploadId, missing);
    if (total !== session.length) {
        throw integrityMismatch('finalizeResumableUpload', ctx.bucketName, { uploadId, expected: session.length, actual: total });
    }
    const actual = hash.digest('hex');
    if (actual !== session.sha256) {
        throw integrityMismatch('finalizeResumableUpload', ctx.bucketName, { uploadId, expected: session.sha256, actual });
    }

    const metadata = buildMetadata(session.metadata, session.sha256, 'finalizeResumableUpload');
    try {
        await files.insertOne({
            _id: uploadId,
            length: session.length,
            chunkSize: session.chunkSizeBytes,
            uploadDate: new Date(),
            filename: session.filename,
            ...(session.contentType !== undefined ? { contentType: session.contentType } : {}),
            ...(metadata ? { metadata } : {}),
        });
    } catch (error) {
        if (isDuplicateKey(error)) {
            throw fileExists('finalizeResumableUpload', ctx, { id: uploadId, filename: session.filename, sha256: session.sha256 });
        }
        throw mapDriverError(error, 'finalizeResumableUpload', ctx, { uploadId, filename: session.filename });
    }
    await ctx.db.collection(uploadsCollectionName(ctx.bucketName)).deleteOne({ _id: uploadId });
    const info = await files.findOne({ _id: uploadId });
    if (!info) throw fileNotFound('finalizeResumableUpload', ctx, { id: uploadId, filename: session.filename });
    return toFileInfo(info as Record<string, unknown>);
}

export async function abortResumableUpload(ctx: GridFSContext, uploadId: ObjectId): Promise<void> {
    assertObjectId(uploadId, 'abortResumableUpload', 'uploadId');
    const uploads = ctx.db.collection(uploadsCollectionName(ctx.bucketName));
    const session = await uploads.findOne({ _id: uploadId });
    if (!session || session.status === 'aborted' || session.status === 'finalized') return;
    const visible = await ctx.db.collection(filesCollectionName(ctx.bucketName)).findOne(
        { _id: uploadId },
        { projection: { _id: 1 } },
    );
    if (!visible) {
        await ctx.db.collection(chunksCollectionName(ctx.bucketName)).deleteMany({ files_id: uploadId });
    }
    await uploads.deleteOne({ _id: uploadId });
}

async function payloadBytes(data: Buffer | Uint8Array | Readable): Promise<Buffer> {
    if (Buffer.isBuffer(data) || data instanceof Uint8Array) return toNodeBuffer(data);
    if (isReadableStream(data)) return readReadable(data);
    throw invalidArgument('appendChunks', 'data', 'data must be a Buffer, Uint8Array, or Readable');
}

function badChunkSize() {
    return invalidArgument('appendChunks', 'data', 'chunk payload must match the session chunk size');
}

async function requirePending(ctx: GridFSContext, uploadId: ObjectId, operation: string): Promise<GridFSUploadSession> {
    const doc = await ctx.db.collection(uploadsCollectionName(ctx.bucketName)).findOne({ _id: uploadId });
    if (!doc || doc.status !== 'pending') throw fileNotFound(operation, ctx, { id: uploadId });
    return doc as unknown as GridFSUploadSession;
}

async function contiguousNext(ctx: GridFSContext, uploadId: ObjectId): Promise<number> {
    const docs = await ctx.db.collection(chunksCollectionName(ctx.bucketName))
        .find({ files_id: uploadId })
        .sort({ n: 1 })
        .project({ n: 1 })
        .toArray();
    let expected = 0;
    for (const doc of docs) {
        if (doc.n !== expected) break;
        expected += 1;
    }
    return expected;
}

async function assertStoredChunk(ctx: GridFSContext, uploadId: ObjectId, n: number, slice: Buffer): Promise<void> {
    const existing = await ctx.db.collection(chunksCollectionName(ctx.bucketName)).findOne({ files_id: uploadId, n });
    if (!existing || !sameBytes(binaryToBuffer(existing.data, 'appendChunks'), slice)) {
        throw resumeMismatch('appendChunks', ctx.bucketName, { uploadId, fromChunk: n, expectedNextChunk: n });
    }
}

async function writeChunk(ctx: GridFSContext, uploadId: ObjectId, n: number, slice: Buffer): Promise<void> {
    try {
        await ctx.db.collection(chunksCollectionName(ctx.bucketName)).insertOne({ files_id: uploadId, n, data: slice });
    } catch (error) {
        if (!isDuplicateKey(error)) throw mapDriverError(error, 'appendChunks', ctx, { uploadId });
        await assertStoredChunk(ctx, uploadId, n, slice);
    }
}
