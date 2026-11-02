import { createHash } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Collection, MongoClient, ObjectId, type Db } from 'mongodb';
import { createMemoryServerBootstrap } from '../../bootstrap/memory-server';

const MonSQLize = require('../../../dist/cjs/index.cjs');

function sha(data: Buffer): string {
    return createHash('sha256').update(data).digest('hex');
}

function codeOf(error: unknown): string | undefined {
    return error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : undefined;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Regressions for the 2026-11-02 weekly scan (BUG-20261102-gridfs-defects). */
describe('gridfs scan regressions (2026-11-02)', () => {
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
        }
    }

    async function indexNames(db: Db, name: string): Promise<string[]> {
        try {
            return (await db.collection(name).indexes()).map((index) => String(index.name)).sort();
        } catch {
            return [];
        }
    }

    it('uploadStream with an existing id rejects without deleting the original file', { timeout: 30_000 }, async () => {
        await withRuntime('gridfs_scan_overwrite', async (runtime) => {
            const bucket = runtime.gridfs('b');
            const id = new ObjectId();
            await bucket.upload('keep.txt', Buffer.from('important data'), { id });
            const writable = bucket.uploadStream('other.txt', { id });
            Readable.from([Buffer.from('new data')]).pipe(writable);
            await assert.rejects(writable.done, (error: unknown) => codeOf(error) === 'GRIDFS_FILE_EXISTS');
            assert.equal((await bucket.download(id)).toString(), 'important data');
        });
    });

    it('closes the server cursor when a downloadStream is destroyed early', { timeout: 30_000 }, async () => {
        await withRuntime('gridfs_scan_cursor', async (runtime) => {
            const openCursors = async () => Number((await raw.db('admin').command({ serverStatus: 1 })).metrics.cursor.open.total);
            const bucket = runtime.gridfs('b', { chunkSizeBytes: 1024 });
            const info = await bucket.upload('big.bin', Buffer.alloc(1024 * 2000, 3));
            const baseline = await openCursors();
            for (let i = 0; i < 5; i += 1) {
                const stream = bucket.downloadStream(info.id);
                await new Promise<void>((resolve) => stream.once('data', () => { stream.destroy(); resolve(); }));
            }
            await sleep(500);
            assert.equal(await openCursors(), baseline);
        });
    });

    it('appendChunks racing abort rejects and leaves no chunks behind', { timeout: 30_000 }, async () => {
        await withRuntime('gridfs_scan_race', async (runtime, db) => {
            const bucket = runtime.gridfs('b', { chunkSizeBytes: 4 });
            const data = Buffer.from('AAAABBBB');
            const session = await bucket.beginResumableUpload('f.bin', { length: 8, sha256: sha(data) });
            const original = Collection.prototype.insertOne;
            let release!: () => void;
            const gate = new Promise<void>((resolve) => { release = resolve; });
            let reached!: () => void;
            const hit = new Promise<void>((resolve) => { reached = resolve; });
            (Collection.prototype as any).insertOne = async function (this: Collection, ...args: unknown[]) {
                if (this.collectionName === 'b.chunks') { reached(); await gate; }
                return (original as any).apply(this, args);
            };
            try {
                const appending = bucket.appendChunks(session.uploadId, 0, data);
                await hit;
                await bucket.abortResumableUpload(session.uploadId);
                release();
                await assert.rejects(appending, (error: unknown) => codeOf(error) === 'GRIDFS_FILE_NOT_FOUND');
            } finally {
                Collection.prototype.insertOne = original;
            }
            assert.equal(await db.collection('b.chunks').countDocuments({ files_id: session.uploadId }), 0);
            assert.equal(await db.collection('b.uploads').countDocuments({ _id: session.uploadId }), 0);
        });
    });

    it('ensureIndexes recreates indexes after drop() on the same bucket object', { timeout: 30_000 }, async () => {
        await withRuntime('gridfs_scan_drop', async (runtime, db) => {
            const bucket = runtime.gridfs('b');
            await bucket.ensureIndexes();
            await bucket.drop();
            await bucket.ensureIndexes();
            assert.deepEqual(await indexNames(db, 'b.chunks'), ['_id_', 'files_id_1_n_1']);
            assert.deepEqual(await indexNames(db, 'b.uploads'), ['_id_', 'createdAt_1']);
        });
    });

    it('fails the uploadStream Writable when it fails before the driver stream opens', { timeout: 30_000 }, async () => {
        await withRuntime('gridfs_scan_preopen', async (runtime, db) => {
            // A conflicting TTL index makes ensureIndexes fail before any driver stream exists.
            await db.collection('b.uploads').createIndex({ createdAt: 1 }, { expireAfterSeconds: 60 });
            const bucket = runtime.gridfs('b');
            const writable = bucket.uploadStream('x.bin');
            const errored = new Promise<unknown>((resolve) => writable.once('error', resolve));
            const source = new PassThrough();
            source.pipe(writable);
            source.write(Buffer.alloc(1024));
            await assert.rejects(writable.done, (error: unknown) => codeOf(error) === 'MONGODB_ERROR');
            assert.equal(codeOf(await errored), 'MONGODB_ERROR');
            assert.equal(writable.destroyed, true);
        });
    });

    it('upload with an existing id releases the source Readable', { timeout: 30_000 }, async () => {
        await withRuntime('gridfs_scan_release', async (runtime) => {
            const bucket = runtime.gridfs('c');
            const id = new ObjectId();
            await bucket.upload('a.txt', Buffer.from('a'), { id });
            const source = Readable.from([Buffer.from('b')]);
            await assert.rejects(bucket.upload('b.txt', source, { id }), (error: unknown) => codeOf(error) === 'GRIDFS_FILE_EXISTS');
            assert.equal(source.destroyed, true);
        });
    });

    it('finalize succeeds when only the post-insert session cleanup fails', { timeout: 30_000 }, async () => {
        await withRuntime('gridfs_scan_finalize', async (runtime) => {
            const bucket = runtime.gridfs('b', { chunkSizeBytes: 4 });
            const data = Buffer.from('AAAABB');
            const session = await bucket.beginResumableUpload('f.bin', { length: 6, sha256: sha(data) });
            await bucket.appendChunks(session.uploadId, 0, data);
            const original = Collection.prototype.deleteOne;
            let armed = true;
            (Collection.prototype as any).deleteOne = function (this: Collection, ...args: unknown[]) {
                if (armed && this.collectionName === 'b.uploads') {
                    armed = false;
                    const error = new Error('simulated network error');
                    error.name = 'MongoNetworkError';
                    return Promise.reject(error);
                }
                return (original as any).apply(this, args);
            };
            try {
                const info = await bucket.finalizeResumableUpload(session.uploadId);
                assert.equal(String(info.id), String(session.uploadId));
            } finally {
                Collection.prototype.deleteOne = original;
            }
            assert.equal(armed, false);
            assert.deepEqual(await bucket.download(session.uploadId), data);
        });
    });

    it('abort removes orphan chunks after the session expired', { timeout: 30_000 }, async () => {
        await withRuntime('gridfs_scan_orphan', async (runtime, db) => {
            const bucket = runtime.gridfs('b', { chunkSizeBytes: 4 });
            const data = Buffer.from('AAAABBBBCC');
            const session = await bucket.beginResumableUpload('f.bin', { length: data.length, sha256: sha(data) });
            await bucket.appendChunks(session.uploadId, 0, data.subarray(0, 8));
            await db.collection('b.uploads').deleteOne({ _id: session.uploadId });
            await bucket.abortResumableUpload(session.uploadId);
            assert.equal(await db.collection('b.chunks').countDocuments({ files_id: session.uploadId }), 0);
        });
    });

    it('re-beginning an expired explicit id starts from clean chunks', { timeout: 30_000 }, async () => {
        await withRuntime('gridfs_scan_stale', async (runtime, db) => {
            const bucket = runtime.gridfs('b', { chunkSizeBytes: 4 });
            const id = new ObjectId();
            const oldData = Buffer.from('AAAABBBBCC');
            await bucket.beginResumableUpload('f.bin', { id, length: oldData.length, sha256: sha(oldData) });
            await bucket.appendChunks(id, 0, oldData.subarray(0, 8));
            await db.collection('b.uploads').deleteOne({ _id: id });
            const newData = Buffer.from('XXXXYYYYZZ');
            const again = await bucket.beginResumableUpload('f.bin', { id, length: newData.length, sha256: sha(newData) });
            assert.equal(again.nextChunk, 0);
            assert.equal((await bucket.appendChunks(id, 0, newData)).nextChunk, 3);
            await bucket.finalizeResumableUpload(id);
            assert.deepEqual(await bucket.download(id), newData);
        });
    });
});
