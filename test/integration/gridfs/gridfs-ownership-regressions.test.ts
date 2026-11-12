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


/**
 * Deterministic regression tests for MZ-15 / MZ-16 / MZ-18.
 * Each test uses a collection-operation gate to force the previously unsafe
 * interleaving and asserts that a shared per-id ownership claim prevents damage.
 */
describe('GridFS MZ-15 / MZ-16 / MZ-18 ownership regressions', () => {
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

    it('MZ-16 blocks uploadStream claiming a pending resumable id and finalize trusting metadata SHA', { timeout: 30_000 }, async () => {
        await withRuntime('gridfs_mz16_stream_id', async (runtime, db) => {
            const bucket = runtime.gridfs('b', { chunkSizeBytes: 4 });
            const id = new ObjectId();
            const expected = Buffer.from('GOOD');
            const actual = Buffer.from('EVIL');
            const expectedSha = sha(expected);

            await bucket.beginResumableUpload('expected.bin', {
                id,
                length: expected.length,
                sha256: expectedSha,
            });

            const writable = bucket.uploadStream('actual.bin', { id, sha256: expectedSha });
            Readable.from([actual]).pipe(writable);
            await assert.rejects(writable.done, (error: unknown) =>
                (error as { code?: string }).code === 'GRIDFS_UPLOAD_BUSY');
            assert.equal(await bucket.getFile(id), null);
            assert.equal(await db.collection('b.uploads').countDocuments({ _id: id, status: 'pending' }), 1);

            await bucket.appendChunks(id, 0, expected);
            const finalized = await bucket.finalizeResumableUpload(id);
            assert.equal(finalized.metadata?.sha256, expectedSha);
            assert.deepEqual(await bucket.download(id), expected);
            assert.equal(await db.collection('b.uploads').countDocuments({ _id: id }), 0);
        });
    });

    it('MZ-16 blocks beginResumableUpload deleting chunks from an in-flight ordinary upload', { timeout: 30_000 }, async () => {
        await withRuntime('gridfs_mz16_begin_race', async (runtime, db) => {
            const bucket = runtime.gridfs('b', { chunkSizeBytes: 4 });
            const id = new ObjectId();
            const payload = Buffer.from('AAAABBBB');
            const digest = sha(payload);

            const original = Collection.prototype.insertOne;
            let release!: () => void;
            const gate = new Promise<void>((resolve) => { release = resolve; });
            let reached!: () => void;
            const hit = new Promise<void>((resolve) => { reached = resolve; });
            let armed = true;

            (Collection.prototype as any).insertOne = async function (this: Collection, ...args: unknown[]) {
                const document = args[0] as Record<string, unknown>;
                const filesId = document.files_id as ObjectId | undefined;
                if (armed && this.collectionName === 'b.chunks' && filesId?.equals(id) && document.n === 1) {
                    armed = false;
                    reached();
                    await gate;
                }
                return (original as any).apply(this, args);
            };

            let uploading: Promise<unknown> | undefined;
            try {
                // Chunk 0 is inserted; chunk 1 is held before its insert.
                uploading = bucket.upload('ordinary.bin', payload, { id, sha256: digest });
                await hit;

                // The direct upload holds the ID even before its files document is visible.
                await assert.rejects(bucket.beginResumableUpload('resumable.bin', {
                    id, length: payload.length, sha256: digest,
                }), (error: unknown) => (error as { code?: string }).code === 'GRIDFS_FILE_EXISTS');

                release();
                const uploaded = await uploading;
                assert.equal(String((uploaded as { id: ObjectId }).id), String(id));
                const chunks = await db.collection('b.chunks')
                    .find({ files_id: id }).sort({ n: 1 }).toArray();
                assert.deepEqual(chunks.map((chunk) => chunk.n), [0, 1]);
                assert.deepEqual(await bucket.download(id), payload);
                assert.equal(await db.collection('b.uploads').countDocuments({ _id: id }), 0);
            } finally {
                release();
                Collection.prototype.insertOne = original;
                if (uploading) await uploading.catch(() => undefined);
            }
        });
    });

    it('MZ-15 prevents abort deleting chunks while finalize is paused before files insert', { timeout: 30_000 }, async () => {
        await withRuntime('gridfs_mz15_finalize_abort_race', async (runtime, db) => {
            const bucket = runtime.gridfs('b', { chunkSizeBytes: 4 });
            const payload = Buffer.from('AAAABBBB');
            const session = await bucket.beginResumableUpload('race.bin', {
                length: payload.length,
                sha256: sha(payload),
            });
            await bucket.appendChunks(session.uploadId, 0, payload);

            const original = Collection.prototype.insertOne;
            let release!: () => void;
            const gate = new Promise<void>((resolve) => { release = resolve; });
            let reached!: () => void;
            const hit = new Promise<void>((resolve) => { reached = resolve; });
            let armed = true;

            (Collection.prototype as any).insertOne = async function (this: Collection, ...args: unknown[]) {
                const document = args[0] as Record<string, unknown>;
                const fileId = document._id as ObjectId | undefined;
                if (armed && this.collectionName === 'b.files' && fileId?.equals(session.uploadId)) {
                    armed = false;
                    reached();
                    await gate;
                }
                return (original as any).apply(this, args);
            };

            let finalizing: Promise<unknown> | undefined;
            try {
                // finalize has already read the session, validated every chunk, and
                // computed the expected SHA when it reaches this blocked files insert.
                finalizing = bucket.finalizeResumableUpload(session.uploadId);
                await hit;

                // Finalize has already atomically entered 'finalizing'. Abort must
                // reject rather than delete the chunks needed for the commit.
                await assert.rejects(bucket.abortResumableUpload(session.uploadId),
                    (error: unknown) => (error as { code?: string }).code === 'GRIDFS_UPLOAD_BUSY');

                release();
                const finalized = await finalizing as { id: ObjectId };
                assert.equal(String(finalized.id), String(session.uploadId));
                assert.equal(await db.collection('b.files').countDocuments({ _id: session.uploadId }), 1);
                assert.equal(await db.collection('b.uploads').countDocuments({ _id: session.uploadId }), 0);
                assert.equal(await db.collection('b.chunks').countDocuments({ files_id: session.uploadId }), 2);
                assert.deepEqual(await bucket.download(session.uploadId), payload);
            } finally {
                release();
                Collection.prototype.insertOne = original;
                if (finalizing) await finalizing.catch(() => undefined);
            }
        });
    });

    it('MZ-18 prevents delete removing chunks from a replacement upload with the same id', { timeout: 30_000 }, async () => {
        await withRuntime('gridfs_mz18_delete_upload_race', async (runtime, db) => {
            const bucket = runtime.gridfs('b', { chunkSizeBytes: 4 });
            const id = new ObjectId();

            // An empty file has no old chunks, so a replacement upload can write
            // its first chunk after delete removes the files document.
            const empty = await bucket.upload('empty.bin', Buffer.alloc(0), { id });
            assert.equal(empty.length, 0);
            assert.equal(await db.collection('b.chunks').countDocuments({ files_id: id }), 0);

            const original = Collection.prototype.deleteMany;
            let release!: () => void;
            const gate = new Promise<void>((resolve) => { release = resolve; });
            let reached!: () => void;
            const hit = new Promise<void>((resolve) => { reached = resolve; });
            let armed = true;

            (Collection.prototype as any).deleteMany = async function (this: Collection, ...args: unknown[]) {
                const filter = args[0] as Record<string, unknown>;
                const filesId = filter.files_id as ObjectId | undefined;
                if (armed && this.collectionName === 'b.chunks' && filesId?.equals(id)) {
                    armed = false;
                    reached();
                    await gate;
                }
                return (original as any).apply(this, args);
            };

            let deleting: Promise<void> | undefined;
            try {
                // GridFSBucket.delete removes files first, then deletes chunks.
                deleting = bucket.delete(id);
                await hit;
                assert.equal(await bucket.getFile(id), null);

                // The delete owns the ID until both files and chunks have gone.
                const payload = Buffer.from('NEW!');
                await assert.rejects(bucket.upload('replacement.bin', payload, {
                    id, sha256: sha(payload),
                }), (error: unknown) => (error as { code?: string }).code === 'GRIDFS_UPLOAD_BUSY');

                release();
                await deleting;

                // Reuse is safe only after delete has finished its chunk cleanup.
                const replacement = await bucket.upload('replacement.bin', payload, {
                    id, sha256: sha(payload),
                });
                assert.equal(String(replacement.id), String(id));
                assert.deepEqual(await bucket.download(id), payload);
                assert.equal(await db.collection('b.chunks').countDocuments({ files_id: id }), 1);
            } finally {
                release();
                Collection.prototype.deleteMany = original;
                if (deleting) await deleting.catch(() => undefined);
            }
        });
    });

});
