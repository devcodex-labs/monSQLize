import { randomUUID } from 'node:crypto';
import type { ObjectId } from 'mongodb';
import type { GridFSContext } from './types';
import { fileExists, isDuplicateKey, mapDriverError, uploadBusy } from './errors';
import { chunksCollectionName, filesCollectionName, uploadsCollectionName } from './normalize';

/**
 * One cross-operation, per-file-ID ownership registry.
 * All writers, deleters and orphan cleaners must claim the same unique _id before
 * touching chunks. Do not auto-expire active owners: a paused writer could resume.
 */
export type GridFSOwnerKind = 'direct' | 'delete' | 'rename' | 'cleanup';
export interface GridFSOwner { id: ObjectId; token: string; kind: GridFSOwnerKind }

export async function claimOwner(
    ctx: GridFSContext, id: ObjectId, kind: GridFSOwnerKind, operation: string,
): Promise<GridFSOwner> {
    await ctx.indexes.ensure();
    const token = randomUUID();
    try {
        await ctx.db.collection(uploadsCollectionName(ctx.bucketName)).insertOne({
            _id: id, kind, status: kind === 'direct' ? 'uploading' : kind === 'delete' ? 'deleting' : kind === 'rename' ? 'renaming' : 'cleaning',
            ownerToken: token, createdAt: new Date(), updatedAt: new Date(),
        });
    } catch (error) {
        if (isDuplicateKey(error)) throw uploadBusy(operation, ctx, id);
        throw mapDriverError(error, operation, ctx, { uploadId: id });
    }
    return { id, token, kind };
}

export async function releaseOwner(ctx: GridFSContext, owner: GridFSOwner, operation: string): Promise<void> {
    const status = owner.kind === 'direct' ? 'uploading'
        : owner.kind === 'delete' ? 'deleting'
            : owner.kind === 'rename' ? 'renaming' : 'cleaning';
    try {
        const released = await ctx.db.collection(uploadsCollectionName(ctx.bucketName)).deleteOne({
            _id: owner.id, kind: owner.kind, ownerToken: owner.token, status,
        });
        // Recovery intentionally retains the original kind/ownerToken while
        // changing status to recovering. A late original writer must not be
        // able to remove that new recovery fence with its stale ownerToken.
        if (released.deletedCount !== 1) throw uploadBusy(operation, ctx, owner.id);
    } catch (error) {
        throw mapDriverError(error, operation, ctx, { uploadId: owner.id });
    }
}

/** Return an ID to the pool only after its chunks are known to have been cleaned. */
export async function cleanupFailedDirect(ctx: GridFSContext, owner: GridFSOwner): Promise<void> {
    try {
        const visible = await ctx.db.collection(filesCollectionName(ctx.bucketName))
            .findOne({ _id: owner.id }, { projection: { _id: 1 } });
        if (!visible) {
            await ctx.db.collection(chunksCollectionName(ctx.bucketName))
                .deleteMany({ files_id: owner.id });
        }
        await releaseOwner(ctx, owner, 'upload');
    } catch (error) {
        // Keep the durable reservation on failure: another upload must not reuse
        // the id while an earlier write or its cleanup is ambiguous.
        throw mapDriverError(error, 'upload', ctx, { uploadId: owner.id });
    }
}

/**
 * A known orphan may only be cleaned after claiming the same id that uploads use.
 * The visible-file check must happen while this claim excludes all new writers.
 */
export async function cleanupOrphanById(ctx: GridFSContext, id: ObjectId): Promise<void> {
    const owner = await claimOwner(ctx, id, 'cleanup', 'abortResumableUpload');
    let safeToRelease = false;
    try {
        const visible = await ctx.db.collection(filesCollectionName(ctx.bucketName))
            .findOne({ _id: id }, { projection: { _id: 1 } });
        if (!visible) await ctx.db.collection(chunksCollectionName(ctx.bucketName)).deleteMany({ files_id: id });
        safeToRelease = true;
    } catch (error) {
        throw mapDriverError(error, 'abortResumableUpload', ctx, { uploadId: id });
    } finally {
        if (safeToRelease) await releaseOwner(ctx, owner, 'abortResumableUpload');
    }
}
