import { expectError, expectType } from 'tsd';
import { ObjectId } from 'mongodb';
import { Readable, type Writable } from 'node:stream';
import MonSQLize, {
    ErrorCodes,
    type BeginResumableUploadResult,
    type GridFSFileInfo,
    type MonSQLizeGridFSBucket,
} from 'monsqlize';

const runtime = new MonSQLize({
    type: 'mongodb',
    databaseName: 'app',
    config: { uri: 'mongodb://localhost:27017' },
    writePathPolicy: { default: { mode: 'model-only', gridfs: 'allow' } },
});

const bucket: MonSQLizeGridFSBucket = runtime.gridfs('artifacts', { db: 'app', pool: 'archive', chunkSizeBytes: 1024 });
const fileId = new ObjectId();
const payload = Buffer.from('gridfs');

expectType<Promise<GridFSFileInfo>>(bucket.upload('report.bin', payload, {
    id: fileId,
    sha256: 'a'.repeat(64),
    metadata: { tenantId: 't1' },
    contentType: 'application/octet-stream',
    ifExists: 'skip',
    chunkSizeBytes: 1024,
}));
expectType<Promise<GridFSFileInfo>>(bucket.upload('report.bin', Readable.from([payload])));

const upload = bucket.uploadStream('report.bin', { sha256: 'b'.repeat(64) });
expectType<ObjectId>(upload.id);
expectType<Writable & { id: ObjectId; done: Promise<GridFSFileInfo> }>(upload);
expectType<Promise<GridFSFileInfo>>(upload.done);
expectError(bucket.uploadStream('report.bin', { ifExists: 'skip' }));

expectType<Promise<Buffer>>(bucket.download(fileId));
expectType<Promise<Buffer>>(bucket.download({ filename: 'report.bin', revision: -1 }));
expectType<Readable>(bucket.downloadStream(fileId, { start: 0, end: 4 }));
expectType<Promise<GridFSFileInfo | null>>(bucket.getFile(fileId));
expectType<Promise<GridFSFileInfo[]>>(bucket.findFiles({ filename: 'report.bin', 'metadata.sha256': 'a'.repeat(64) }, { limit: 10, skip: 0, sort: { uploadDate: -1 } }));
expectType<Promise<void>>(bucket.delete(fileId, { ignoreMissing: true }));
expectType<Promise<void>>(bucket.rename(fileId, 'renamed.bin'));
expectType<Promise<void>>(bucket.drop());
expectType<Promise<void>>(bucket.ensureIndexes());

declare const resumed: BeginResumableUploadResult;
expectType<Promise<BeginResumableUploadResult>>(bucket.beginResumableUpload('big.bin', { length: 4, sha256: 'c'.repeat(64) }));
expectType<Promise<{ nextChunk: number; bytesAccepted: number }>>(bucket.appendChunks(resumed.uploadId, resumed.nextChunk, payload));
expectType<Promise<GridFSFileInfo>>(bucket.finalizeResumableUpload(resumed.uploadId));
expectType<Promise<void>>(bucket.abortResumableUpload(resumed.uploadId));

expectType<string>(bucket.bucketName);
expectType<string>(bucket.dbName);
expectType<number>(bucket.chunkSizeBytes);
expectType<ErrorCodes.GRIDFS_FILE_NOT_FOUND>(ErrorCodes.GRIDFS_FILE_NOT_FOUND);
expectType<ErrorCodes.GRIDFS_FILE_EXISTS>(ErrorCodes.GRIDFS_FILE_EXISTS);
expectType<ErrorCodes.GRIDFS_INTEGRITY_MISMATCH>(ErrorCodes.GRIDFS_INTEGRITY_MISMATCH);
expectType<ErrorCodes.GRIDFS_UPLOAD_INCOMPLETE>(ErrorCodes.GRIDFS_UPLOAD_INCOMPLETE);
expectType<ErrorCodes.GRIDFS_RESUME_MISMATCH>(ErrorCodes.GRIDFS_RESUME_MISMATCH);
expectType<ErrorCodes.GRIDFS_RANGE_INVALID>(ErrorCodes.GRIDFS_RANGE_INVALID);

expectError(new MonSQLize({
    type: 'mongodb',
    databaseName: 'app',
    writePathPolicy: { default: { gridfs: 'sometimes' } },
}));

const model = runtime.model('files');
expectType<MonSQLizeGridFSBucket>(model.gridfs());
expectType<MonSQLizeGridFSBucket>(model.gridfs('artifacts', { chunkSizeBytes: 255 * 1024 }));
expectError(model.gridfs('artifacts', { pool: 'archive' }));
expectError(model.gridfs('artifacts', { db: 'other' }));
