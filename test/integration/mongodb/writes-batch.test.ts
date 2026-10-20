import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryServerBootstrap } from '../../bootstrap/memory-server';

const MonSQLize = require('../../../dist/cjs/index.cjs');

function hasErrorCode(error: unknown, code: string): boolean {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}

describe('insertBatch() / updateBatch() / deleteBatch()', () => {
    const bootstrap = createMemoryServerBootstrap();
    let uri = '';
    let runtime: any;
    let col: any;

    before(async () => {
        const ctx = await bootstrap.setup();
        uri = ctx.uri;
        runtime = new MonSQLize({
            type: 'mongodb',
            databaseName: 'test_writes_batch',
            config: { uri },
        });
        await runtime.connect();
        col = runtime.collection('items');
    });

    after(async () => {
        if (runtime) await runtime.close();
        await bootstrap.teardown();
    });

    beforeEach(async () => {
        const db = runtime._adapter.db;
        await db.collection('items').deleteMany({});
    });

    it('B11 reports confirmed partial inserts for collect skip and retry without double counting', async () => {
        for (const onError of ['collect', 'skip', 'retry']) {
            await col.raw().deleteMany({});
            await col.raw().insertOne({ _id: 'duplicate' });
            const result = await col.insertBatch([{ _id: 'one' }, { _id: 'two' }, { _id: 'three' }, { _id: 'duplicate' }, { _id: 'four' }], {
                batchSize: 3, ordered: false, onError, retryAttempts: 1, retryDelay: 0,
            });
            assert.equal(result.insertedCount, 4);
            assert.deepEqual(Object.keys(result.insertedIds).map(Number).sort((a, b) => a - b), [0, 1, 2, 4]);
            assert.equal(await col.raw().countDocuments({ _id: { $ne: 'duplicate' } }), 4);
            assert.equal(result.errors.length, 1);
        }
        await col.raw().deleteMany({});
        await col.raw().insertOne({ _id: 'duplicate' });
        const ordered = await col.insertBatch([{ _id: 'first' }, { _id: 'duplicate' }, { _id: 'not-run' }], { ordered: true, onError: 'collect' });
        assert.equal(ordered.insertedCount, 1);
        assert.deepEqual(Object.keys(ordered.insertedIds), ['0']);
        assert.equal(await col.raw().findOne({ _id: 'not-run' }), null);
    });

    // ── insertBatch() basic results ───────────────────────────────────────────

    describe('insertBatch() basic results', () => {
        it('batchCount reflects number of batches', async () => {
            const docs = Array.from({ length: 6 }, (_, i) => ({ name: `Item ${i}`, seq: i }));
            const result = await col.insertBatch(docs, { batchSize: 2 });
            assert.equal(result.batchCount, 3);
        });

        it('insertedCount matches document count', async () => {
            const docs = Array.from({ length: 5 }, (_, i) => ({ name: `Doc ${i}` }));
            const result = await col.insertBatch(docs, { batchSize: 3 });
            assert.equal(result.insertedCount, 5);
        });

        it('totalCount matches input document length', async () => {
            const docs = Array.from({ length: 4 }, (_, i) => ({ n: i }));
            const result = await col.insertBatch(docs, { batchSize: 10 });
            assert.equal(result.totalCount, 4);
        });

        it('insertedIds has sequential numeric keys', async () => {
            const result = await col.insertBatch([{ a: 1 }, { a: 2 }, { a: 3 }], { batchSize: 10 });
            const keys = Object.keys(result.insertedIds).map(Number).sort((a, b) => a - b);
            assert.deepEqual(keys, [0, 1, 2]);
        });

        it('partial last batch counted in batchCount', async () => {
            const docs = Array.from({ length: 5 }, (_, i) => ({ i }));
            const result = await col.insertBatch(docs, { batchSize: 2 });
            assert.equal(result.batchCount, 3);
            assert.equal(result.insertedCount, 5);
        });

        it('acknowledged is true', async () => {
            const result = await col.insertBatch([{ x: 1 }]);
            assert.equal(result.acknowledged, true);
        });
    });

    // ── insertBatch() onProgress callback ────────────────────────────────────

    describe('insertBatch() onProgress callback', () => {
        it('onProgress called once per batch', async () => {
            const calls: unknown[] = [];
            const docs = Array.from({ length: 6 }, (_, i) => ({ i }));
            await col.insertBatch(docs, { batchSize: 2, onProgress: (p: unknown) => calls.push(p) });
            assert.equal(calls.length, 3);
        });

        it('final onProgress reports 100 percent', async () => {
            const calls: any[] = [];
            const docs = Array.from({ length: 4 }, (_, i) => ({ i }));
            await col.insertBatch(docs, { batchSize: 2, onProgress: (p: any) => calls.push(p) });
            assert.ok(calls.every((c) => typeof c.percentage === 'number'));
            assert.equal(calls[calls.length - 1].percentage, 100);
        });
    });

    // ── insertBatch() argument validation ────────────────────────────────────

    describe('insertBatch() argument validation', () => {
        it('throws INVALID_ARGUMENT for empty array', async () => {
            await assert.rejects(
                () => col.insertBatch([]),
                (e: unknown) => hasErrorCode(e, 'INVALID_ARGUMENT'),
            );
        });

        it('throws INVALID_ARGUMENT for non-array documents', async () => {
            await assert.rejects(
                () => col.insertBatch({ a: 1 }),
                (e: unknown) => hasErrorCode(e, 'INVALID_ARGUMENT'),
            );
        });

        it('throws INVALID_ARGUMENT for null documents', async () => {
            await assert.rejects(
                () => col.insertBatch(null),
                (e: unknown) => hasErrorCode(e, 'INVALID_ARGUMENT'),
            );
        });
    });

    // ── updateBatch() basic results ───────────────────────────────────────────

    describe('updateBatch() basic results', () => {
        beforeEach(async () => {
            const db = runtime._adapter.db;
            await db.collection('items').insertMany([
                { name: 'A', status: 'active',   group: 1 },
                { name: 'B', status: 'active',   group: 1 },
                { name: 'C', status: 'active',   group: 2 },
                { name: 'D', status: 'inactive', group: 2 },
                { name: 'E', status: 'inactive', group: 1 },
                { name: 'F', status: 'active',   group: 2 },
            ]);
        });

        it('modifiedCount matches number of updated documents', async () => {
            const result = await col.updateBatch({ status: 'active' }, { $set: { status: 'done' } });
            assert.equal(result.modifiedCount, 4);
        });

        it('totalCount reflects all matched IDs', async () => {
            const result = await col.updateBatch({ status: 'active' }, { $set: { flag: true } });
            assert.equal(result.totalCount, 4);
        });

        it('batchCount reflects document count divided by batchSize', async () => {
            const result = await col.updateBatch({ status: 'active' }, { $set: { tag: 'x' } }, { batchSize: 2 });
            assert.equal(result.batchCount, 2);
        });

        it('returns zero counts when no document matches filter', async () => {
            const result = await col.updateBatch({ status: 'cancelled' }, { $set: { status: 'done' } });
            assert.equal(result.modifiedCount, 0);
            assert.equal(result.totalCount, 0);
            assert.equal(result.batchCount, 0);
        });

        it('updates are persisted to the database', async () => {
            await col.updateBatch({ group: 1 }, { $set: { group: 99 } });
            const docs = await col.find({ group: 99 });
            assert.equal(docs.length, 3);
        });
    });

    // ── updateBatch() argument validation ────────────────────────────────────

    describe('updateBatch() argument validation', () => {
        it('throws for null filter', async () => {
            await assert.rejects(
                () => col.updateBatch(null, { $set: { x: 1 } }),
                /filter/i,
            );
        });

        it('throws for array filter', async () => {
            await assert.rejects(
                () => col.updateBatch([], { $set: { x: 1 } }),
                /filter/i,
            );
        });

        it('throws for update without $ operators', async () => {
            await assert.rejects(
                () => col.updateBatch({}, { status: 'done' }),
                /operator|update/i,
            );
        });
    });

    // ── deleteBatch() basic results ───────────────────────────────────────────

    describe('deleteBatch() basic results', () => {
        beforeEach(async () => {
            const db = runtime._adapter.db;
            await db.collection('items').insertMany([
                { name: 'A', tag: 'remove', seq: 1 },
                { name: 'B', tag: 'remove', seq: 2 },
                { name: 'C', tag: 'keep',   seq: 3 },
                { name: 'D', tag: 'remove', seq: 4 },
                { name: 'E', tag: 'keep',   seq: 5 },
                { name: 'F', tag: 'remove', seq: 6 },
            ]);
        });

        it('deletedCount matches number of removed documents', async () => {
            const result = await col.deleteBatch({ tag: 'remove' });
            assert.equal(result.deletedCount, 4);
        });

        it('totalCount matches matched IDs when estimateProgress is true', async () => {
            const result = await col.deleteBatch({ tag: 'remove' });
            assert.equal(result.totalCount, 4);
        });

        it('totalCount is null when estimateProgress is false', async () => {
            const result = await col.deleteBatch({ tag: 'remove' }, { estimateProgress: false });
            assert.equal(result.totalCount, null);
        });

        it('batchCount reflects batchSize splitting', async () => {
            const result = await col.deleteBatch({ tag: 'remove' }, { batchSize: 2 });
            assert.equal(result.batchCount, 2);
        });

        it('returns zero counts when no document matches', async () => {
            const result = await col.deleteBatch({ tag: 'nonexistent' });
            assert.equal(result.deletedCount, 0);
            assert.equal(result.totalCount, 0);
            assert.equal(result.batchCount, 0);
        });

        it('documents are removed from the database', async () => {
            await col.deleteBatch({ tag: 'remove' });
            const remaining = await col.find({});
            assert.equal(remaining.length, 2);
            assert.ok(remaining.every((d: any) => d.tag === 'keep'));
        });
    });

    // ── deleteBatch() argument validation ────────────────────────────────────

    describe('deleteBatch() argument validation', () => {
        it('throws for null filter', async () => {
            await assert.rejects(
                () => col.deleteBatch(null),
                /filter/i,
            );
        });

        it('throws for array filter', async () => {
            await assert.rejects(
                () => col.deleteBatch([]),
                /filter/i,
            );
        });
    });
});
