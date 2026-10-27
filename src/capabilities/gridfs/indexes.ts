import type { Db } from 'mongodb';
import { mapDriverError } from './errors';
import { chunksCollectionName, filesCollectionName, uploadsCollectionName } from './normalize';
import { UPLOADS_TTL_SECONDS } from './types';

/**
 * Idempotent GridFS indexes for one bucket instance.
 * A failed attempt can be retried; concurrent callers share one in-flight promise.
 */
export class GridFSIndexLatch {
    private inflight: Promise<void> | null = null;
    private ready = false;

    constructor(private readonly db: Db, private readonly bucketName: string) {}

    ensure(): Promise<void> {
        if (this.ready) return Promise.resolve();
        if (!this.inflight) {
            this.inflight = this.create().then(() => {
                this.ready = true;
            }).finally(() => {
                this.inflight = null;
            });
        }
        return this.inflight;
    }

    private async create(): Promise<void> {
        const files = this.db.collection(filesCollectionName(this.bucketName));
        const chunks = this.db.collection(chunksCollectionName(this.bucketName));
        const uploads = this.db.collection(uploadsCollectionName(this.bucketName));
        try {
            await files.createIndex({ filename: 1, uploadDate: 1 });
            await chunks.createIndex({ files_id: 1, n: 1 }, { unique: true });
            await files.createIndex({ 'metadata.sha256': 1 });
            await uploads.createIndex({ createdAt: 1 }, { expireAfterSeconds: UPLOADS_TTL_SECONDS });
        } catch (error) {
            throw mapDriverError(error, 'ensureIndexes', { bucketName: this.bucketName });
        }
    }
}
