import type { Db } from 'mongodb';
import { mapDriverError, isNamespaceNotFound } from './errors';
import { chunksCollectionName, filesCollectionName, uploadsCollectionName } from './normalize';
import { UPLOADS_TTL_SECONDS } from './types';

/**
 * Idempotent GridFS indexes for one bucket instance.
 * A failed attempt can be retried; concurrent callers share one in-flight promise.
 */
export class GridFSIndexLatch {
    private inflight: Promise<void> | null = null;
    private ready = false;
    private generation = 0;

    constructor(private readonly db: Db, private readonly bucketName: string) {}

    ensure(): Promise<void> {
        if (this.ready) return Promise.resolve();
        if (!this.inflight) {
            const generation = this.generation;
            this.inflight = this.create().then(() => {
                // A reset() while this attempt was running means the collections may have been dropped since.
                if (generation === this.generation) this.ready = true;
            }).finally(() => {
                this.inflight = null;
            });
        }
        return this.inflight;
    }

    /** Forget a completed ensure, e.g. after the bucket collections were dropped, so the next call recreates indexes. */
    reset(): void {
        this.ready = false;
        this.generation += 1;
    }

    private async create(): Promise<void> {
        const files = this.db.collection(filesCollectionName(this.bucketName));
        const chunks = this.db.collection(chunksCollectionName(this.bucketName));
        const uploads = this.db.collection(uploadsCollectionName(this.bucketName));
        try {
            await files.createIndex({ filename: 1, uploadDate: 1 });
            await chunks.createIndex({ files_id: 1, n: 1 }, { unique: true });
            await files.createIndex({ 'metadata.sha256': 1 });
            // Legacy 3.5.3 sessions expired seven days after creation, even during active uploads.
            // Migrate pending sessions before removing the legacy TTL index. The new index
            // applies only to explicitly expiring pending sessions, not active ownership claims.
            await uploads.updateMany(
                { status: 'pending', activeAppend: { $exists: false }, createdAt: { $type: 'date' }, expiresAt: { $exists: false } },
                [{ $set: { expiresAt: { $add: [{ $ifNull: ['$updatedAt', '$createdAt'] }, UPLOADS_TTL_SECONDS * 1000] } } }],
            );
            try {
                await uploads.dropIndex('createdAt_1');
            } catch (error) {
                const code = (error as { code?: number }).code;
                if (code !== 27 && !isNamespaceNotFound(error)) throw error;
            }
            await uploads.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
        } catch (error) {
            throw mapDriverError(error, 'ensureIndexes', { bucketName: this.bucketName });
        }
    }
}
