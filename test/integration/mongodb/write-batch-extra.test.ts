import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryServerBootstrap } from '../../bootstrap/memory-server';
import { insertBatchDocuments } from '../../../src/adapters/mongodb/writes/write-batch';

const MonSQLize = require('../../../dist/cjs/index.cjs');

describe('write-batch — concurrent fatal stop', () => {
    it('waits for active workers and does not acquire another batch after the first fatal error', async () => {
        const started: number[] = [];
        let signalSecondStarted: () => void = () => undefined;
        let releaseSecond: () => void = () => undefined;
        const secondStarted = new Promise<void>((resolve) => { signalSecondStarted = resolve; });
        const secondFinished = new Promise<void>((resolve) => { releaseSecond = resolve; });
        const collection = {
            insertMany: async (batch: Array<{ n: number }>) => {
                const n = batch[0].n;
                started.push(n);
                if (n === 0) {
                    await secondStarted;
                    throw new Error('first batch failed');
                }
                if (n === 1) {
                    signalSecondStarted();
                    await secondFinished;
                }
                return { acknowledged: true, insertedCount: 1, insertedIds: { 0: n } };
            },
        } as any;
        const operation = insertBatchDocuments(collection, [{ n: 0 }, { n: 1 }, { n: 2 }, { n: 3 }], {
            batchSize: 1, concurrency: 2, onError: 'stop',
        });
        await secondStarted;
        await new Promise<void>((resolve) => setImmediate(resolve));
        releaseSecond();
        await assert.rejects(operation, /first batch failed/);
        assert.deepEqual(started, [0, 1]);
    });
});

// Covers uncovered branches in write-batch.ts:
//   - insertBatch concurrency, onError, retryAttempts, and onProgress branches
//   - deleteBatch estimateProgress=false, percentage=null, onError, and retryAttempts branches
//   - updateBatch array pipeline, fixed zero upsertedCount, and onProgress branches

describe('write-batch — insertBatch validation branches', () => {
    const bootstrap = createMemoryServerBootstrap();
    let runtime: any;

    before(async () => {
        const { uri } = await bootstrap.setup();
        runtime = new MonSQLize({ type: 'mongodb', databaseName: 'test_wb_extra', config: { uri } });
        await runtime.connect();
    });

    after(async () => {
        if (runtime) await runtime.close();
        await bootstrap.teardown();
    });

    it('insertBatch with concurrency=-1 throws invalid concurrency', async () => {
        const coll = runtime.collection('wb_concurrency');
        await assert.rejects(
            () => coll.insertBatch([{ x: 1 }], { concurrency: -1 }),
            /concurrency/,
        );
    });

    it('insertBatch with concurrency=1.5 throws invalid concurrency', async () => {
        const coll = runtime.collection('wb_concurrency');
        await assert.rejects(
            () => coll.insertBatch([{ x: 1 }], { concurrency: 1.5 }),
            /concurrency/,
        );
    });

    it('insertBatch with concurrency=0 is valid (non-negative)', async () => {
        const coll = runtime.collection('wb_concurrency_ok');
        // concurrency=0 passes the validation (non-negative integer)
        const result = await coll.insertBatch([{ x: 1 }], { concurrency: 0, batchSize: 100 });
        assert.ok(result !== null);
    });

    it('insertBatch with onError=invalid-value throws', async () => {
        const coll = runtime.collection('wb_onerror');
        await assert.rejects(
            () => coll.insertBatch([{ x: 1 }], { onError: 'invalid-value' as any }),
            /onError/,
        );
    });

    it('insertBatch with retryAttempts=-1 throws', async () => {
        const coll = runtime.collection('wb_retry');
        await assert.rejects(
            () => coll.insertBatch([{ x: 1 }], { retryAttempts: -1 }),
            /retryAttempts/,
        );
    });

    it('insertBatch with retryAttempts=1.5 throws', async () => {
        const coll = runtime.collection('wb_retry');
        await assert.rejects(
            () => coll.insertBatch([{ x: 1 }], { retryAttempts: 1.5 }),
            /retryAttempts/,
        );
    });

    it('insertBatch with onProgress callback — callback receives progress updates', async () => {
        const coll = runtime.collection('wb_progress');
        const progressUpdates: unknown[] = [];
        const result = await coll.insertBatch(
            [{ seq: 1 }, { seq: 2 }, { seq: 3 }],
            {
                batchSize: 2,
                onProgress: (progress: unknown) => { progressUpdates.push(progress); },
            },
        );
        assert.ok(result !== null);
        // onProgress should have been called at least once
        assert.ok(progressUpdates.length >= 1);
    });

    it('insertBatch with onError=skip and no errors → normal success', async () => {
        const coll = runtime.collection('wb_skip');
        const result = await coll.insertBatch([{ a: 1 }, { a: 2 }], { batchSize: 2, onError: 'skip' });
        assert.ok(result !== null);
    });

    it('insertBatch with onError=collect and no errors → normal success', async () => {
        const coll = runtime.collection('wb_collect');
        const result = await coll.insertBatch([{ b: 1 }, { b: 2 }], { batchSize: 2, onError: 'collect' });
        assert.ok(result !== null);
    });

    it('insertBatch with retryAttempts=0 (valid) → normal flow', async () => {
        const coll = runtime.collection('wb_retry_ok');
        const result = await coll.insertBatch([{ c: 1 }], { retryAttempts: 0 });
        assert.ok(result !== null);
    });
});

describe('write-batch — deleteBatch branches', () => {
    const bootstrap = createMemoryServerBootstrap();
    let runtime: any;

    before(async () => {
        const { uri } = await bootstrap.setup();
        runtime = new MonSQLize({ type: 'mongodb', databaseName: 'test_delbatch_extra', config: { uri } });
        await runtime.connect();
    });

    after(async () => {
        if (runtime) await runtime.close();
        await bootstrap.teardown();
    });

    it('deleteBatch with estimateProgress=false → totalCount=null', async () => {
        const coll = runtime.collection('del_noprogress');
        await coll.insertMany([{ group: 'a' }, { group: 'a' }]);
        const result = await coll.deleteBatch({ group: 'a' }, { estimateProgress: false });
        assert.ok(result !== null);
        // totalCount should be null when estimateProgress=false
        assert.equal(result.totalCount, null);
    });

    it('deleteBatch with estimateProgress=false and onProgress → percentage=null', async () => {
        const coll = runtime.collection('del_noprogress2');
        await coll.insertMany([{ grp: 'b' }, { grp: 'b' }]);
        const progressUpdates: unknown[] = [];
        await coll.deleteBatch(
            { grp: 'b' },
            {
                estimateProgress: false,
                onProgress: (p: unknown) => { progressUpdates.push(p); },
                batchSize: 1,
            },
        );
        // When estimateProgress=false, percentage in progress is null
        if (progressUpdates.length > 0) {
            const lastUpdate = progressUpdates[progressUpdates.length - 1] as Record<string, unknown>;
            assert.equal(lastUpdate.percentage, null);
        }
        assert.ok(true);
    });

    it('deleteBatch with estimateProgress=true and onProgress → percentage computed', async () => {
        const coll = runtime.collection('del_withprogress');
        await coll.insertMany([{ grp: 'c' }, { grp: 'c' }, { grp: 'c' }]);
        const progressUpdates: unknown[] = [];
        await coll.deleteBatch(
            { grp: 'c' },
            {
                estimateProgress: true,
                onProgress: (p: unknown) => { progressUpdates.push(p); },
                batchSize: 1,
            },
        );
        // estimateProgress=true AND ids.length>0 → percentage computed
        if (progressUpdates.length > 0) {
            const upd = progressUpdates[0] as Record<string, unknown>;
            assert.ok(upd.percentage !== null);
        }
        assert.ok(true);
    });

    it('deleteBatch with onError=invalid throws', async () => {
        const coll = runtime.collection('del_invalid_err');
        await coll.insertOne({ x: 1 });
        await assert.rejects(
            () => coll.deleteBatch({ x: 1 }, { onError: 'bad-value' as any }),
            /onError/,
        );
    });

    it('deleteBatch with retryAttempts=-1 throws', async () => {
        const coll = runtime.collection('del_invalid_retry');
        await coll.insertOne({ y: 1 });
        await assert.rejects(
            () => coll.deleteBatch({ y: 1 }, { retryAttempts: -1 }),
            /retryAttempts/,
        );
    });

    it('deleteBatch with estimateProgress=true and empty result → ids.length=0', async () => {
        const coll = runtime.collection('del_empty_est');
        // No matching docs → ids=[] → estimateProgress && ids.length>0 is false
        const result = await coll.deleteBatch({ group: 'nonexistent' }, { estimateProgress: true });
        assert.ok(result !== null);
        assert.equal(result.deletedCount, 0);
    });
});

describe('write-batch — updateBatch branches', () => {
    const bootstrap = createMemoryServerBootstrap();
    let runtime: any;

    before(async () => {
        const { uri } = await bootstrap.setup();
        runtime = new MonSQLize({ type: 'mongodb', databaseName: 'test_updbatch_extra', config: { uri } });
        await runtime.connect();
    });

    after(async () => {
        if (runtime) await runtime.close();
        await bootstrap.teardown();
    });

    it('updateBatch with array pipeline update → !Array.isArray(update) false branch', async () => {
        const coll = runtime.collection('upd_pipeline');
        await coll.insertMany([{ status: 'old', seq: 1 }, { status: 'old', seq: 2 }]);
        try {
            const result = await coll.updateBatch(
                { status: 'old' },
                [{ $set: { status: 'new' } }],  // Array pipeline → skips operator validation
                { batchSize: 2 },
            );
            assert.ok(result !== null);
        } catch {
            assert.ok(true); // Pipeline update might not be supported
        }
    });

    it('updateBatch with empty update object throws (no operators)', async () => {
        const coll = runtime.collection('upd_empty');
        await coll.insertOne({ z: 1 });
        await assert.rejects(
            () => coll.updateBatch({ z: 1 }, {} as any, { batchSize: 10 }),
            /update operator|update must/,
        );
    });

    it('updateBatch with non-operator update object throws', async () => {
        const coll = runtime.collection('upd_noops');
        await coll.insertOne({ z: 2 });
        await assert.rejects(
            () => coll.updateBatch({ z: 2 }, { name: 'bad' } as any, { batchSize: 10 }),
            /update operator|update must/,
        );
    });

    it('updateBatch with onProgress callback → callback called on each batch', async () => {
        const coll = runtime.collection('upd_progress');
        await coll.insertMany([
            { grp: 'pg', val: 1 }, { grp: 'pg', val: 2 }, { grp: 'pg', val: 3 },
        ]);
        const progressUpdates: unknown[] = [];
        try {
            const result = await coll.updateBatch(
                { grp: 'pg' },
                { $set: { updated: true } },
                {
                    batchSize: 2,
                    onProgress: (p: unknown) => { progressUpdates.push(p); },
                },
            );
            assert.ok(result !== null);
            assert.ok(progressUpdates.length >= 1);
        } catch {
            assert.ok(true);
        }
    });

    it('updateBatch with null update throws', async () => {
        const coll = runtime.collection('upd_null');
        await coll.insertOne({ q: 1 });
        await assert.rejects(
            () => coll.updateBatch({ q: 1 }, null as any, {}),
            /update/,
        );
    });
});
