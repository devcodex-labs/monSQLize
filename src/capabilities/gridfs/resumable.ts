import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { ObjectId } from 'mongodb';
import type { AppendChunksResult, BeginResumableUploadOptions, BeginResumableUploadResult, GridFSContext, GridFSFileInfo, GridFSUploadSession } from './types';
import { fileExists, fileNotFound, integrityMismatch, invalidArgument, isDuplicateKey, isGridFSDomainError, mapDriverError, resumeMismatch, uploadBusy, uploadIncomplete } from './errors';
import { cleanupOrphanById } from './ownership';
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
import { consumeReadableChunks } from './stream-chunks';

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
            kind: 'resumable',
            status: 'pending',
            nextChunk: 0,
            createdAt: now,
            updatedAt: now,
            expiresAt: new Date(now.getTime() + 604800 * 1000),
        });
    } catch (error) {
        throw mapDriverError(error, 'beginResumableUpload', ctx, { uploadId, filename });
    }
    // The insert is the atomic id claim. A concurrent upload can still make a
    // files document visible after the prechecks and even after this insert.
    // Re-check files and fail closed: never delete chunks of a visible file.
    try {
        if (await files.findOne({ _id: uploadId }, { projection: { _id: 1 } })) {
            try {
                await uploads.deleteOne({ _id: uploadId, kind: 'resumable', status: 'pending' });
            } catch { /* Best-effort session cleanup; chunks of the visible file stay. */ }
            throw fileExists('beginResumableUpload', ctx, { id: uploadId, filename, sha256: opts.sha256 });
        }
        // Chunks can outlive an expired session (the TTL only removes the session document).
        // This call now owns the id and no file is visible, so leftovers would only break the new upload.
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
    const isStream = isReadableStream(data);
    if (!isStream && !Buffer.isBuffer(data) && !(data instanceof Uint8Array)) {
        throw invalidArgument('appendChunks', 'data', 'data must be a Buffer, Uint8Array, or Readable');
    }
    let payload: Buffer | undefined;
    if (!isStream) {
        payload = toNodeBuffer(data as Buffer | Uint8Array);
        if (payload.length === 0) throw badChunkSize();
    }
    const uploads = ctx.db.collection(uploadsCollectionName(ctx.bucketName));
    const token = randomUUID();
    // A durable single-append claim excludes finalize, abort, and concurrent
    // appenders. Remove the expiry while this process is actively writing.
    let claimed: number;
    try {
        const update = await uploads.updateOne(
            { _id: uploadId, status: 'pending', activeAppend: { $exists: false } },
            { $set: { activeAppend: { token, startedAt: new Date() }, updatedAt: new Date() }, $unset: { expiresAt: '' } },
        );
        claimed = update.matchedCount;
    } catch (error) {
        throw mapDriverError(error, 'appendChunks', ctx, { uploadId });
    }
    if (!claimed) {
        const existing = await uploads.findOne({ _id: uploadId });
        if (!existing) throw fileNotFound('appendChunks', ctx, { id: uploadId });
        throw uploadBusy('appendChunks', ctx, uploadId);
    }
    try {
        const session = await requireSession(ctx, uploadId, 'appendChunks');
        const nextChunk = await contiguousNext(ctx, uploadId, session.nextChunk);
        if (fromChunk > nextChunk) {
            throw resumeMismatch('appendChunks', ctx.bucketName, { uploadId, fromChunk, expectedNextChunk: nextChunk });
        }
        const writeSlice = async (slice: { index: number; bytes: Buffer }): Promise<void> => {
            if (slice.index < nextChunk) {
                await assertStoredChunk(ctx, uploadId, slice.index, slice.bytes, nextChunk);
                return;
            }
            if (fromChunk !== nextChunk) {
                throw resumeMismatch('appendChunks', ctx.bucketName, { uploadId, fromChunk, expectedNextChunk: nextChunk });
            }
            await writeChunk(ctx, uploadId, slice.index, slice.bytes, nextChunk);
        };
        let bytesAccepted: number;
        if (isStream) {
            const streamed = await consumeReadableChunks(
                data as Readable,
                fromChunk,
                session.length,
                session.chunkSizeBytes,
                writeSlice,
            );
            bytesAccepted = streamed.bytesAccepted;
        } else {
            const slices = planChunkSlices(payload as Buffer, fromChunk, session.length, session.chunkSizeBytes);
            const lastIndex = slices[slices.length - 1].index;
            if (lastIndex >= nextChunk && fromChunk !== nextChunk) {
                throw resumeMismatch('appendChunks', ctx.bucketName, { uploadId, fromChunk, expectedNextChunk: nextChunk });
            }
            for (const slice of slices) await writeSlice(slice);
            bytesAccepted = (payload as Buffer).length;
        }
        const advanced = await contiguousNext(ctx, uploadId, nextChunk);
        const completed = await uploads.updateOne(
            { _id: uploadId, status: 'pending', 'activeAppend.token': token },
            {
                $max: { nextChunk: advanced },
                $set: { updatedAt: new Date(), expiresAt: new Date(Date.now() + 604800 * 1000) },
                $unset: { activeAppend: '' },
            },
        );
        if (!completed.matchedCount) throw uploadBusy('appendChunks', ctx, uploadId);
        return { nextChunk: advanced, bytesAccepted };
    } catch (error) {
        // The worker has stopped writing. Releasing only its own token allows
        // the next append to reconcile partial chunks idempotently. If release
        // itself fails the persistent claim remains for explicit recovery.
        try {
            await uploads.updateOne(
                { _id: uploadId, status: 'pending', 'activeAppend.token': token },
                { $unset: { activeAppend: '' }, $set: { updatedAt: new Date(), expiresAt: new Date(Date.now() + 604800 * 1000) } },
            );
        } catch { /* Preserve the original failure; do not remove ownership by ID alone. */ }
        throw error;
    }
}

export async function finalizeResumableUpload(ctx: GridFSContext, uploadId: ObjectId): Promise<GridFSFileInfo> {
    assertObjectId(uploadId, 'finalizeResumableUpload', 'uploadId');
    const uploads = ctx.db.collection(uploadsCollectionName(ctx.bucketName));
    let session = await uploads.findOne({ _id: uploadId }) as unknown as GridFSUploadSession | null;
    if (!session || (session.kind && session.kind !== 'resumable')) {
        throw fileNotFound('finalizeResumableUpload', ctx, { id: uploadId });
    }
    // An interrupted finalize can be retried when its file is already visible.
    // A second in-flight finalize is not allowed to race the first.
    if (session.status === 'finalizing') {
        const committed = await committedFile(ctx, uploadId, session);
        if (committed) return committed;
        throw uploadBusy('finalizeResumableUpload', ctx, uploadId);
    }
    if (session.status !== 'pending') throw uploadBusy('finalizeResumableUpload', ctx, uploadId);
    const transitioned = await uploads.updateOne(
        { _id: uploadId, status: 'pending', activeAppend: { $exists: false } },
        { $set: { status: 'finalizing', updatedAt: new Date() }, $unset: { expiresAt: '' } },
    );
    if (!transitioned.matchedCount) throw uploadBusy('finalizeResumableUpload', ctx, uploadId);
    // Only the winner of this CAS may inspect/commit files. Abort will now
    // fail its pending -> aborting CAS instead of deleting validated chunks.
    session = await requireSession(ctx, uploadId, 'finalizeResumableUpload');
    const files = ctx.db.collection(filesCollectionName(ctx.bucketName));

    const restorePendingAfterClosedFailure = async (error: unknown): Promise<void> => {
        if (!isClosedFinalizeFailure(error)) return;
        try {
            await uploads.updateOne(
                { _id: uploadId, status: 'finalizing' },
                { $set: { status: 'pending', updatedAt: new Date(), expiresAt: new Date(Date.now() + 604800 * 1000) } },
            );
        } catch { /* The retained finalizing state must be recovered explicitly. */ }
    };

    try {
        const already = await committedFile(ctx, uploadId, session);
        if (already) return already;
    } catch (error) {
        await restorePendingAfterClosedFailure(error);
        throw error;
    }

    try {
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
                throw integrityMismatch('finalizeResumableUpload', ctx.bucketName, { uploadId, expected: want, actual: bytes.length });
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
    } catch (error) {
        // Validation failed before any files insert. Return to pending so the
        // caller can supply missing/correct chunks; do not erase those chunks.
        try {
            await uploads.updateOne(
                { _id: uploadId, status: 'finalizing' },
                { $set: { status: 'pending', updatedAt: new Date(), expiresAt: new Date(Date.now() + 604800 * 1000) } },
            );
        } catch { /* The retained finalizing state must be recovered explicitly. */ }
        throw error;
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
            try {
                const raced = await committedFile(ctx, uploadId, session);
                if (raced) return raced;
            } catch (conflict) {
                await restorePendingAfterClosedFailure(conflict);
                throw conflict;
            }
        }
        const mapped = mapDriverError(error, 'finalizeResumableUpload', ctx, { uploadId, filename: session.filename });
        if (isClosedFinalizeFailure(mapped)) {
            await restorePendingAfterClosedFailure(mapped);
        }
        // Ambiguous commit outcomes keep finalizing ownership rather than
        // allowing an abort or another writer to delete/reuse the same chunks.
        throw mapped;
    }
    try {
        await uploads.deleteOne({ _id: uploadId, status: 'finalizing' });
    } catch (error) {
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
    const uploads = ctx.db.collection(uploadsCollectionName(ctx.bucketName));
    let session: GridFSUploadSession | null;
    try {
        session = await uploads.findOne({ _id: uploadId }) as unknown as GridFSUploadSession | null;
    } catch (error) {
        throw mapDriverError(error, 'abortResumableUpload', ctx, { uploadId });
    }
    if (!session) {
        // A TTL-expired session can leave chunks. Take the same exclusive ID
        // claim as all writers before deleting an orphan.
        await cleanupOrphanById(ctx, uploadId);
        return;
    }
    if (session.kind && session.kind !== 'resumable') throw uploadBusy('abortResumableUpload', ctx, uploadId);
    if (session.status === 'finalized') return;
    if (session.status !== 'pending') throw uploadBusy('abortResumableUpload', ctx, uploadId);
    const transitioned = await uploads.updateOne(
        { _id: uploadId, status: 'pending', activeAppend: { $exists: false } },
        { $set: { status: 'aborting', updatedAt: new Date() }, $unset: { expiresAt: '' } },
    );
    if (!transitioned.matchedCount) throw uploadBusy('abortResumableUpload', ctx, uploadId);
    // Keep the ID locked during both cleanup steps. A failed delete leaves an
    // aborting record that prevents a second writer from claiming this ID.
    try {
        await removeInvisibleChunks(ctx, uploadId, 'abortResumableUpload');
        await uploads.deleteOne({ _id: uploadId, status: 'aborting' });
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
        // Metadata-only SHA can be forged by uploadStream(). Never treat it as
        // proof of a previous resumable commit without verifying actual chunks.
        const hash = createHash('sha256');
        let total = 0;
        let index = 0;
        for await (const chunk of ctx.db.collection(chunksCollectionName(ctx.bucketName))
            .find({ files_id: uploadId }).sort({ n: 1 })) {
            const bytes = binaryToBuffer(chunk.data, 'finalizeResumableUpload');
            const expectedSize = chunkLengthAt(index, session.length, session.chunkSizeBytes);
            if (chunk.n !== index || bytes.length !== expectedSize) {
                throw integrityMismatch('finalizeResumableUpload', ctx.bucketName, { uploadId, expected: expectedSize, actual: bytes.length });
            }
            hash.update(bytes);
            total += bytes.length;
            index += 1;
        }
        if (index !== chunkCount(session.length, session.chunkSizeBytes) || total !== session.length || hash.digest('hex') !== session.sha256) {
            throw integrityMismatch('finalizeResumableUpload', ctx.bucketName, { uploadId, expected: session.sha256, actual: 'committed chunks do not match' });
        }
        await ctx.db.collection(uploadsCollectionName(ctx.bucketName)).deleteOne({ _id: uploadId, status: 'finalizing' });
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

function isClosedFinalizeFailure(error: unknown): boolean {
    return isGridFSDomainError(error)
        && (error.code === 'GRIDFS_FILE_EXISTS' || error.code === 'GRIDFS_INTEGRITY_MISMATCH');
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

async function requireSession(ctx: GridFSContext, uploadId: ObjectId, operation: string): Promise<GridFSUploadSession> {
    const doc = await ctx.db.collection(uploadsCollectionName(ctx.bucketName)).findOne({ _id: uploadId });
    if (!doc || (doc.kind && doc.kind !== 'resumable')) throw fileNotFound(operation, ctx, { id: uploadId });
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
