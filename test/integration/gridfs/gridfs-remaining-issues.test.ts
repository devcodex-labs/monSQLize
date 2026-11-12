import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Collection, MongoClient, ObjectId, type Db } from 'mongodb';
import { createMemoryServerBootstrap } from '../../bootstrap/memory-server';

const MonSQLize = require('../../../dist/cjs/index.cjs');

function sha(data: Buffer): string {
    return createHash('sha256').update(data).digest('hex');
}

describe('GridFS remaining-issue regressions (begin race, finalize rollback, streaming append)', () => {
    const bootstrap = createMemoryServerBootstrap();
    let uri = '';
    let raw: MongoClient;

    before(async () => {
        uri = (await bootstrap.setup()).uri;
        raw = new MongoClient(uri);
        await raw.connect();
    });

    after(async () => {
        await raw.close();
        await bootstrap.teardown();
        MonSQLize.Model._clear();
    });

    async function withRuntime(databaseName: string, fn: (runtime: any, db: Db) => Promise<void>): Promise<void> {
        const runtime = new MonSQLize({ type: 'mongodb', databaseName, config: { uri } });
        await runtime.connect();
        try {
            await fn(runtime, raw.db(databaseName));
        } finally {
            await runtime.close();
            await raw.db(databaseName).dropDatabase();
        }
    }

    it('beginResumableUpload does not delete chunks of a file that became visible after precheck', { timeout: 30_000 }, async () => {
        await withRuntime('gridfs_begin_precheck_race', async (runtime, db) => {
            const bucket = runtime.gridfs('b', { chunkSizeBytes: 4 });
            const id = new ObjectId();
            const payload = Buffer.from('ABCD');
            const original = Collection.prototype.insertOne;
            (Collection.prototype as any).insertOne = async function (this: Collection, ...args: unknown[]) {
                const document = args[0] as Record<string, unknown>;
                if (this.collectionName === 'b.uploads' && document.kind === 'resumable' && (document._id as ObjectId).equals(id)) {
                    await original.call(db.collection('b.files'), {
                        _id: id,
                        filename: 'visible.bin',
                        length: 4,
                        chunkSize: 4,
                        uploadDate: new Date(),
                        metadata: { sha256: sha(payload) },
                    });
                    await original.call(db.collection('b.chunks'), { files_id: id, n: 0, data: payload });
                }
                return (original as any).apply(this, args);
            };
            try {
                await assert.rejects(
                    bucket.beginResumableUpload('raced.bin', { id, length: 4, sha256: sha(payload) }),
                    (error: unknown) => (error as { code?: string }).code === 'GRIDFS_FILE_EXISTS',
                );
                assert.equal(await db.collection('b.chunks').countDocuments({ files_id: id }), 1);
                assert.deepEqual(await bucket.download(id), payload);
                assert.equal(await db.collection('b.uploads').countDocuments({ _id: id }), 0);
            } finally {
                Collection.prototype.insertOne = original;
            }
        });
    });

    it('finalize FILE_EXISTS rolls back to pending so public abort works and visible chunks stay', { timeout: 30_000 }, async () => {
        await withRuntime('gridfs_finalize_rollback', async (runtime, db) => {
            const bucket = runtime.gridfs('b', { chunkSizeBytes: 4 });
            const payload = Buffer.from('GOOD');
            const session = await bucket.beginResumableUpload('conflict.bin', {
                length: 4, sha256: sha(payload),
            });
            await bucket.appendChunks(session.uploadId, 0, payload);
            await db.collection('b.files').insertOne({
                _id: session.uploadId,
                filename: 'other.bin',
                length: 4,
                chunkSize: 4,
                uploadDate: new Date(),
                metadata: { sha256: 'a'.repeat(64) },
            });
            await assert.rejects(
                bucket.finalizeResumableUpload(session.uploadId),
                (error: unknown) => (error as { code?: string }).code === 'GRIDFS_FILE_EXISTS',
            );
            assert.equal((await db.collection('b.uploads').findOne({ _id: session.uploadId }))?.status, 'pending');
            await bucket.abortResumableUpload(session.uploadId);
            assert.equal(await db.collection('b.uploads').countDocuments({ _id: session.uploadId }), 0);
            assert.ok(await db.collection('b.files').findOne({ _id: session.uploadId }));
            assert.equal(await db.collection('b.chunks').countDocuments({ files_id: session.uploadId }), 1);
        });
    });

    it('streams a Readable append with ownership, idempotent replay, and recoverable partial failure', { timeout: 30_000 }, async () => {
        await withRuntime('gridfs_stream_append', async (runtime, db) => {
            const bucket = runtime.gridfs('b', { chunkSizeBytes: 4 });
            const payload = Buffer.from('aaaabbbbcccc');
            const otherId = new ObjectId();
            await db.collection('b.chunks').insertOne({ files_id: otherId, n: 0, data: Buffer.from('KEEP') });

            const session = await bucket.beginResumableUpload('stream.bin', {
                length: payload.length, sha256: sha(payload),
            });
            const first = await bucket.appendChunks(
                session.uploadId,
                0,
                Readable.from([payload.subarray(0, 4), payload.subarray(4, 8)]),
            );
            assert.equal(first.nextChunk, 2);
            await assert.rejects(
                bucket.appendChunks(session.uploadId, 2, Readable.from([Buffer.from('cc')])),
                (error: unknown) => (error as { code?: string }).code === 'INVALID_ARGUMENT',
            );
            assert.deepEqual(
                (await db.collection('b.chunks').find({ files_id: session.uploadId }).sort({ n: 1 }).toArray()).map((chunk) => chunk.n),
                [0, 1],
            );
            const rest = await bucket.appendChunks(session.uploadId, 2, Readable.from([payload.subarray(8)]));
            assert.equal(rest.nextChunk, 3);
            const replay = await bucket.appendChunks(session.uploadId, 0, Readable.from([payload]));
            assert.equal(replay.nextChunk, 3);
            const info = await bucket.finalizeResumableUpload(session.uploadId);
            assert.deepEqual(await bucket.download(info.id), payload);
            assert.equal(await db.collection('b.chunks').countDocuments({ files_id: otherId }), 1);
        });
    });
});
