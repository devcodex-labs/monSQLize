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
    withContentType,
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
    // Chunks can outlive an expired session (the TTL only removes the session document). This call now owns
    // the id and no file is visible, so leftovers would only break the new upload; remove them.
    try {
        await ctx.db.collection(chunksCollectionName(ctx.bucketName)).deleteMany({ files_id: uploadId });
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
    const nextChunk = await contiguousNext(ctx, uploadId, session.nextChunk);
    if (fromChunk > nextChunk) {
        throw resumeMismatch('appendChunks', ctx.bucketName, { uploadId, fromChunk, expectedNextChunk: nextChunk });
    }

    const slices = planChunkSlices(payload, fromChunk, session.length, session.chunkSizeBytes);
    const lastIndex = slices[slices.length - 1].index;
    if (lastIndex >= nextChunk && fromChunk !== nextChunk) {
        throw resumeMismatch('appendChunks', ctx.bucketName, { uploadId, fromChunk, expectedNextChunk: nextChunk });
    }
    for (const slice of slices) {
        if (slice.index < nextChunk) await assertStoredChunk(ctx, uploadId, slice.index, slice.bytes, nextChunk);
        else await writeChunk(ctx, uploadId, slice.index, slice.bytes, nextChunk);
    }

    const advanced = await contiguousNext(ctx, uploadId, nextChunk);
    let matched: number;
    try {
        const updated = await ctx.db.collection(uploadsCollectionName(ctx.bucketName)).updateOne(
            { _id: uploadId, status: 'pending' },
            { $max: { nextChunk: advanced }, $set: { updatedAt: new Date() } },
        );
        matched = updated.matchedCount;
    } catch (error) {
        throw mapDriverError(error, 'appendChunks', ctx, { uploadId });
    }
    if (matched === 0) {
        // The session was aborted (or expired) while this call was writing; do not leave its chunks behind.
        await removeInvisibleChunks(ctx, uploadId, 'appendChunks');
        throw fileNotFound('appendChunks', ctx, { id: uploadId });
    }
    return { nextChunk: advanced, bytesAccepted: payload.length };
}

export async function finalizeResumableUpload(ctx: GridFSContext, uploadId: ObjectId): Promise<GridFSFileInfo> {
    assertObjectId(uploadId, 'finalizeResumableUpload', 'uploadId');
    const session = await requirePending(ctx, uploadId, 'finalizeResumableUpload');
    const files = ctx.db.collection(filesCollectionName(ctx.bucketName));
    const committed = await committedFile(ctx, uploadId, session);
    if (committed) return committed;

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

    const metadata = withContentType(
        buildMetadata(session.metadata, session.sha256, 'finalizeResumableUpload'),
        session.contentType,
    );
    try {
        await files.insertOne({
            _id: uploadId,
            length: session.length,
            chunkSize: session.chunkSizeBytes,
            uploadDate: new Date(),
            filename: session.filename,
            ...(metadata ? { metadata } : {}),
        });
    } catch (error) {
        if (isDuplicateKey(error)) {
            const raced = await committedFile(ctx, uploadId, session);
            if (raced) return raced;
        }
        throw mapDriverError(error, 'finalizeResumableUpload', ctx, { uploadId, filename: session.filename });
    }
    try {
        await ctx.db.collection(uploadsCollectionName(ctx.bucketName)).deleteOne({ _id: uploadId });
    } catch (error) {
        // The files document is committed, so the upload succeeded. A leftover session cannot add chunks past
        // the file length, abort keeps a visible file's chunks, and the TTL index removes it later.
        ctx.logger?.warn?.('[gridfs] finalizeResumableUpload could not delete the upload session', { bucket: ctx.bucketName, uploadId: String(uploadId), error });
    }
    let info;
    try {
        info = await files.findOne({ _id: uploadId });
    } catch (error) {
        throw mapDriverError(error, 'finalizeResumableUpload', ctx, { uploadId, filename: session.filename });
    }
    if (!info) throw fileNotFound('finalizeResumableUpload', ctx, { id: uploadId, filename: session.filename });
    return toFileInfo(info as Record<string, unknown>);
}

export async function abortResumableUpload(ctx: GridFSContext, uploadId: ObjectId): Promise<void> {
    assertObjectId(uploadId, 'abortResumableUpload', 'uploadId');
    try {
        const uploads = ctx.db.collection(uploadsCollectionName(ctx.bucketName));
        const session = await uploads.findOne({ _id: uploadId });
        if (session?.status === 'finalized') return;
        // A missing session (expired by the TTL, or aborted while an append was in flight) can still leave
        // chunks; clear them as long as no file is visible under this id.
        await removeInvisibleChunks(ctx, uploadId, 'abortResumableUpload');
        if (session) await uploads.deleteOne({ _id: uploadId });
    } catch (error) {
        throw mapDriverError(error, 'abortResumableUpload', ctx, { uploadId });
    }
}

/**
 * Resolve a finalize retry against an already visible file under `uploadId`.
 * Returns null when no file exists. A file whose stored sha256 and length match the session is this upload's own
 * earlier commit: delete the leftover session and return it. Any other file is a real conflict (GRIDFS_FILE_EXISTS).
 */
async function committedFile(ctx: GridFSContext, uploadId: ObjectId, session: GridFSUploadSession): Promise<GridFSFileInfo | null> {
    const target = { uploadId, filename: session.filename };
    try {
        const doc = await ctx.db.collection(filesCollectionName(ctx.bucketName)).findOne({ _id: uploadId });
        if (!doc) return null;
        const info = toFileInfo(doc as Record<string, unknown>);
        if (info.metadata?.sha256 !== session.sha256 || info.length !== session.length) {
            throw fileExists('finalizeResumableUpload', ctx, { id: uploadId, filename: session.filename, sha256: session.sha256 });
        }
        await ctx.db.collection(uploadsCollectionName(ctx.bucketName)).deleteOne({ _id: uploadId, status: 'pending' });
        return info;
    } catch (error) {
        // GridFS domain errors (the conflict above) pass through unchanged.
        throw mapDriverError(error, 'finalizeResumableUpload', ctx, target);
    }
}

/** Delete chunks stored under `uploadId` unless a visible files document owns them. */
async function removeInvisibleChunks(ctx: GridFSContext, uploadId: ObjectId, operation: string): Promise<void> {
    try {
        const visible = await ctx.db.collection(filesCollectionName(ctx.bucketName)).findOne(
            { _id: uploadId },
            { projection: { _id: 1 } },
        );
        if (!visible) await ctx.db.collection(chunksCollectionName(ctx.bucketName)).deleteMany({ files_id: uploadId });
    } catch (error) {
        throw mapDriverError(error, operation, ctx, { uploadId });
    }
}

async function payloadBytes(data: Buffer | Uint8Array | Readable): Promise<Buffer> {
    if (Buffer.isBuffer(data) || data instanceof Uint8Array) return toNodeBuffer(data);
    if (isReadableStream(data)) return readReadable(data);
    throw invalidArgument('appendChunks', 'data', 'data must be a Buffer, Uint8Array, or Readable');
}

function badChunkSize() {
    return invalidArgument('appendChunks', 'data', 'chunk payload must match the session chunk size');
}

function planChunkSlices(payload: Buffer, fromChunk: number, length: number, chunkSizeBytes: number): Array<{ index: number; bytes: Buffer }> {
    const total = chunkCount(length, chunkSizeBytes);
    const slices: Array<{ index: number; bytes: Buffer }> = [];
    let offset = 0;
    let index = fromChunk;
    while (offset < payload.length) {
        if (index >= total) throw badChunkSize();
        const expected = chunkLengthAt(index, length, chunkSizeBytes);
        if (offset + expected > payload.length) throw badChunkSize();
        slices.push({ index, bytes: payload.subarray(offset, offset + expected) });
        offset += expected;
        index += 1;
    }
    return slices;
}

async function requirePending(ctx: GridFSContext, uploadId: ObjectId, operation: string): Promise<GridFSUploadSession> {
    const doc = await ctx.db.collection(uploadsCollectionName(ctx.bucketName)).findOne({ _id: uploadId });
    if (!doc || doc.status !== 'pending') throw fileNotFound(operation, ctx, { id: uploadId });
    return doc as unknown as GridFSUploadSession;
}

/**
 * Length of the contiguous chunk prefix. Chunks below the session's recorded `nextChunk` are already known to be
 * contiguous, so only chunks at or after `from` are read; this keeps each append independent of the upload size.
 */
async function contiguousNext(ctx: GridFSContext, uploadId: ObjectId, from: number): Promise<number> {
    const start = Number.isInteger(from) && from > 0 ? from : 0;
    let docs;
    try {
        docs = await ctx.db.collection(chunksCollectionName(ctx.bucketName))
            .find({ files_id: uploadId, n: { $gte: start } })
            .sort({ n: 1 })
            .project({ n: 1 })
            .toArray();
    } catch (error) {
        throw mapDriverError(error, 'appendChunks', ctx, { uploadId });
    }
    let expected = start;
    for (const doc of docs) {
        if (doc.n !== expected) break;
        expected += 1;
    }
    return expected;
}

async function assertStoredChunk(ctx: GridFSContext, uploadId: ObjectId, n: number, slice: Buffer, expectedNextChunk: number): Promise<void> {
    const existing = await ctx.db.collection(chunksCollectionName(ctx.bucketName)).findOne({ files_id: uploadId, n });
    if (!existing || !sameBytes(binaryToBuffer(existing.data, 'appendChunks'), slice)) {
        throw resumeMismatch('appendChunks', ctx.bucketName, { uploadId, fromChunk: n, expectedNextChunk });
    }
}

async function writeChunk(ctx: GridFSContext, uploadId: ObjectId, n: number, slice: Buffer, expectedNextChunk: number): Promise<void> {
    try {
        await ctx.db.collection(chunksCollectionName(ctx.bucketName)).insertOne({ files_id: uploadId, n, data: slice });
    } catch (error) {
        if (!isDuplicateKey(error)) throw mapDriverError(error, 'appendChunks', ctx, { uploadId });
        await assertStoredChunk(ctx, uploadId, n, slice, expectedNextChunk);
    }
}
