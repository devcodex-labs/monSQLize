import { GridFSBucket, type Db, type Document, type GridFSBucketWriteStreamOptions, type ObjectId } from 'mongodb';
import type { GridFSDriver } from './types';
import { withContentType } from './validate';

/** Options passed to the driver. `contentType` is folded into `metadata` and is not a stream option. */
export function gridFSUploadStreamOptions(options: {
    chunkSizeBytes: number;
    metadata?: Document;
    contentType?: string;
}): GridFSBucketWriteStreamOptions {
    const streamOptions: GridFSBucketWriteStreamOptions = { chunkSizeBytes: options.chunkSizeBytes };
    const metadata = withContentType(options.metadata, options.contentType);
    if (metadata !== undefined) streamOptions.metadata = metadata;
    return streamOptions;
}

export function createGridFSDriver(db: Db, bucketName: string, chunkSizeBytes: number): GridFSDriver {
    const bucket = new GridFSBucket(db, { bucketName, chunkSizeBytes });
    return {
        openUploadStream(id, filename, options) {
            return bucket.openUploadStreamWithId(id, filename, gridFSUploadStreamOptions(options));
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
