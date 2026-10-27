import { GridFSBucket, type Db, type ObjectId } from 'mongodb';
import type { GridFSDriver } from './types';

export function createGridFSDriver(db: Db, bucketName: string, chunkSizeBytes: number): GridFSDriver {
    const bucket = new GridFSBucket(db, { bucketName, chunkSizeBytes });
    return {
        openUploadStream(id, filename, options) {
            return bucket.openUploadStreamWithId(id, filename, {
                chunkSizeBytes: options.chunkSizeBytes,
                metadata: options.metadata,
                contentType: options.contentType,
            });
        },
        openDownloadStream(id: ObjectId, range) {
            return bucket.openDownloadStream(id, range);
        },
        delete(id) {
            return bucket.delete(id);
        },
        rename(id, filename) {
            return bucket.rename(id, filename);
        },
        drop() {
            return bucket.drop();
        },
    };
}
