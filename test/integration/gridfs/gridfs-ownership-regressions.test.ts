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
 * GridFS Driver 6 deletes chunks with { files_id: id }, while Driver 7.8+
 * uses { files_id: { $eq: id } } for an exact ID match. Match both without
 * interpreting arbitrary filter objects as valid IDs.
 */
function matchesDeletedFileId(value: unknown, expected: ObjectId): boolean {
    const candidate = value && typeof value === 'object' && '$eq' in value
        ? (value as { $eq: unknown }).$eq
        : value;
    return candidate instanceof ObjectId && candidate.equals(expected);
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

    it('recognizes Driver 6 bare and Driver 7.8 exact-$eq chunk deletion filters', () => {
        const id = new ObjectId();
        const other = new ObjectId();
        assert.equal(matchesDeletedFileId(id, id), true);
        assert.equal(matchesDeletedFileId({ $eq: id }, id), true);
        assert.equal(matchesDeletedFileId(other, id), false);
        assert.equal(matchesDeletedFileId({ $eq: other }, id), false);
        assert.equal(matchesDeletedFileId({ $in: [id] }, id), false);
        assert.equal(matchesDeletedFileId(undefined, id), false);
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
                if (armed && this.collectionName === 'b.chunks' &&
                    matchesDeletedFileId(filter.files_id, id)) {
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
                // Fail immediately if the driver completes without reaching the
                // chunk-delete barrier. Never await a gate that cannot fire.
                await Promise.race([
                    hit,
                    deleting.then(() => {
                        throw new Error('GridFS delete completed without reaching the exact-ID chunks barrier');
                    }),
                ]);
                assert.equal(armed, false, 'the delete must be paused at the chunk-delete barrier');
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


    it('MZ-04 migrates legacy createdAt TTL to seven-day idle expiresAt', { timeout: 30_000 }, async () => {
        await withRuntime('gridfs_mz04_migrate', async (runtime, db) => {
            const id = new ObjectId();
            const createdAt = new Date(Date.now() - 2 * 86400_000);
            const updatedAt = new Date(Date.now() - 30 * 60_000);
            await db.collection('b.uploads').insertOne({
                _id: id, filename: 'legacy.bin', length: 4,
                sha256: sha(Buffer.from('GOOD')), chunkSizeBytes: 4,
                status: 'pending', nextChunk: 0, createdAt, updatedAt,
            });
            await db.collection('b.uploads').createIndex({ createdAt: 1 }, { expireAfterSeconds: 604800 });
            const bucket = runtime.gridfs('b', { chunkSizeBytes: 4 });
            await bucket.ensureIndexes();
            const indexes = await db.collection('b.uploads').indexes();
            assert.equal(indexes.some((i) => i.name === 'createdAt_1'), false);
            assert.equal(indexes.find((i) => i.name === 'expiresAt_1')?.expireAfterSeconds, 0);
            const migrated = await db.collection('b.uploads').findOne({ _id: id });
            assert.ok(migrated?.expiresAt instanceof Date);
            assert.ok(Math.abs(migrated.expiresAt.getTime() - (updatedAt.getTime() + 604800_000)) < 1000);
            await bucket.abortResumableUpload(id);
        });
    });

    it('MZ-04 does not reinstall TTL while an append is actively writing', { timeout: 30_000 }, async () => {
        await withRuntime('gridfs_mz04_active_append', async (runtime, db) => {
            const bucket = runtime.gridfs('b', { chunkSizeBytes: 4 });
            const id = (await bucket.beginResumableUpload('active.bin', {
                length: 4, sha256: sha(Buffer.from('GOOD')),
            })).uploadId;
            const original = Collection.prototype.insertOne;
            let release!: () => void;
            const gate = new Promise<void>((resolve) => { release = resolve; });
            let reached!: () => void;
            const hit = new Promise<void>((resolve) => { reached = resolve; });
            let armed = true;
            (Collection.prototype as any).insertOne = async function (this: Collection, ...args: unknown[]) {
                const doc = args[0] as { files_id?: ObjectId };
                if (armed && this.collectionName === 'b.chunks' && doc.files_id?.equals(id)) {
                    armed = false;
                    reached();
                    await gate;
                }
                return (original as any).apply(this, args);
            };
            let appending: Promise<unknown> | undefined;
            try {
                appending = bucket.appendChunks(id, 0, Buffer.from('GOOD'));
                await hit;
                const active = await db.collection('b.uploads').findOne({ _id: id });
                assert.ok(active?.activeAppend);
                assert.equal(active?.expiresAt, undefined);
                await runtime.gridfs('b').ensureIndexes();
                const during = await db.collection('b.uploads').findOne({ _id: id });
                assert.equal(during?.expiresAt, undefined, 'index initialization must not re-arm expiry during append');
                release();
                await appending;
                const finished = await db.collection('b.uploads').findOne({ _id: id });
                assert.equal(finished?.activeAppend, undefined);
                assert.ok(finished?.expiresAt instanceof Date);
                await bucket.abortResumableUpload(id);
            } finally {
                release();
                Collection.prototype.insertOne = original;
                if (appending) await appending.catch(() => undefined);
            }
        });
    });

    it('MZ-15 blocks finalize while append owns the session', { timeout: 30_000 }, async () => {
        await withRuntime('gridfs_mz15_append_finalize', async (runtime) => {
            const bucket = runtime.gridfs('b', { chunkSizeBytes: 4 });
            const payload = Buffer.from('AAAABBBB');
            const id = (await bucket.beginResumableUpload('append.bin', {
                length: payload.length, sha256: sha(payload),
            })).uploadId;
            const original = Collection.prototype.insertOne;
            let release!: () => void;
            const gate = new Promise<void>((resolve) => { release = resolve; });
            let reached!: () => void;
            const hit = new Promise<void>((resolve) => { reached = resolve; });
            let armed = true;
            (Collection.prototype as any).insertOne = async function (this: Collection, ...args: unknown[]) {
                const doc = args[0] as { files_id?: ObjectId };
                if (armed && this.collectionName === 'b.chunks' && doc.files_id?.equals(id)) {
                    armed = false;
                    reached();
                    await gate;
                }
                return (original as any).apply(this, args);
            };
            let appending: Promise<unknown> | undefined;
            try {
                appending = bucket.appendChunks(id, 0, payload);
                await hit;
                await assert.rejects(bucket.finalizeResumableUpload(id),
                    (error: unknown) => (error as { code?: string }).code === 'GRIDFS_UPLOAD_BUSY');
                release();
                await appending;
                await bucket.finalizeResumableUpload(id);
                assert.deepEqual(await bucket.download(id), payload);
            } finally {
                release();
                Collection.prototype.insertOne = original;
                if (appending) await appending.catch(() => undefined);
            }
        });
    });

    it('MZ-16 rechecks stored chunk bytes before accepting an ambiguous legacy finalize retry', { timeout: 30_000 }, async () => {
        await withRuntime('gridfs_mz16_bad_legacy_hash', async (runtime, db) => {
            const bucket = runtime.gridfs('b', { chunkSizeBytes: 4 });
            const id = new ObjectId();
            const actual = Buffer.from('EVIL');
            const expected = Buffer.from('GOOD');
            await bucket.upload('actual.bin', actual, { id, sha256: sha(actual) });
            await db.collection('b.files').updateOne({ _id: id }, { $set: { 'metadata.sha256': sha(expected) } });
            await db.collection('b.uploads').insertOne({
                _id: id, filename: 'expected.bin', length: expected.length,
                sha256: sha(expected), chunkSizeBytes: 4,
                status: 'pending', nextChunk: 1,
                createdAt: new Date(), updatedAt: new Date(),
            });
            await assert.rejects(bucket.finalizeResumableUpload(id),
                (error: unknown) => (error as { code?: string }).code === 'GRIDFS_INTEGRITY_MISMATCH');
            assert.deepEqual(await bucket.download(id), actual);
        });
    });

});
