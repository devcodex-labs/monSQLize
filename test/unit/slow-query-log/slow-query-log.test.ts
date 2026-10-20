import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const MonSQLize = require('../../../dist/cjs/index.cjs');

describe('P4-C slow-query-log', () => {
    it('B20 applies each error policy to initialization direct writes and batch writes', async () => {
        const log = { database: 'app', collection: 'items', operation: 'find', durationMs: 600 };
        for (const policy of ['throw', 'silent', 'log']) {
            for (const failurePoint of ['initialize', 'write']) {
                let writes = 0, batches = 0, errors = 0;
                const failure = new Error('storage ' + failurePoint);
                const storage = {
                    initialize: async () => { if (failurePoint === 'initialize') throw failure; },
                    save: async () => { writes++; throw failure; },
                    saveBatch: async () => { batches++; throw failure; },
                    query: async () => [], close: async () => undefined,
                };
                const manager = new MonSQLize.SlowQueryLogManager({
                    enabled: true, storage: { type: 'memory' },
                    batch: { enabled: true, size: 1 }, advanced: { errorHandling: policy },
                }, null, 'mongodb', { error: () => { errors++; } }, { storage });
                try {
                    if (policy === 'throw') await assert.rejects(manager.save(log), (error: unknown) => error === failure);
                    else await manager.save(log);
                    assert.equal(errors, policy === 'log' ? 1 : 0);
                    assert.equal(writes, failurePoint === 'write' && policy === 'throw' ? 1 : 0);
                    assert.equal(batches, failurePoint === 'write' && policy !== 'throw' ? 1 : 0);
                } finally { await manager.close(); }
            }
        }
    });

    it('B20 throw mode waits for durable direct storage even with batching enabled', async () => {
        let release!: () => void;
        let entered!: () => void;
        const started = new Promise<void>((resolve) => { entered = resolve; });
        const gate = new Promise<void>((resolve) => { release = resolve; });
        let batchCalls = 0, finished = false;
        const manager = new MonSQLize.SlowQueryLogManager({
            enabled: true, storage: { type: 'memory' }, batch: { enabled: true, size: 20 },
            advanced: { errorHandling: 'throw' },
        }, null, 'mongodb', null, { storage: {
            initialize: async () => undefined,
            save: async () => { entered(); await gate; },
            saveBatch: async () => { batchCalls++; },
            query: async () => [], close: async () => undefined,
        } });
        try {
            const saving = manager.save({ database: 'db', collection: 'items', operation: 'find', durationMs: 600 }).then(() => { finished = true; });
            await started;
            assert.equal(finished, false);
            release(); await saving;
            assert.equal(batchCalls, 0);
        } finally { release(); await manager.close(); }
    });

    it('supports BatchQueue and memory store aggregation round trip', async () => {
        const manager = new MonSQLize.SlowQueryLogManager({
            enabled: true,
            storage: { type: 'memory' },
            batch: {
                enabled: true,
                size: 2,
                interval: 50,
                maxBufferSize: 10,
            },
        });

        await manager.save({
            database: 'app',
            collection: 'users',
            operation: 'find',
            durationMs: 600,
            query: { status: 'active' },
        });
        await manager.save({
            database: 'app',
            collection: 'users',
            operation: 'find',
            durationMs: 800,
            query: { status: 'active' },
        });
        await manager.close();

        const records = await manager.query({ collection: 'users' }, { limit: 10 });
        assert.equal(records.length, 1);
        assert.equal(records[0].count, 2);
        assert.equal(records[0].totalTimeMs, 1400);
        assert.equal(records[0].avgTimeMs, 700);
        assert.equal(records[0].maxTimeMs, 800);
        assert.equal(records[0].minTimeMs, 600);
    });

    it('supports runtime facade recordSlowQuery / getSlowQueryLogs', async () => {
        const runtime = new MonSQLize({
            type: 'mongodb',
            databaseName: 'slow_query_memory',
            slowQueryLog: {
                enabled: true,
                storage: { type: 'memory' },
                batch: { enabled: false, size: 1, interval: 50, maxBufferSize: 10 },
            },
        });

        runtime.connect = () => Promise.resolve({
            collection: runtime.collection.bind(runtime),
            db: runtime.db.bind(runtime),
            use: runtime.use.bind(runtime),
            instance: runtime,
        });
        runtime._connected = true;
        runtime._client = {
            close() {
                return Promise.resolve(true);
            },
        };

        await runtime.recordSlowQuery({
            database: 'slow_query_memory',
            collection: 'orders',
            operation: 'aggregate',
            durationMs: 1200,
            query: [{ $match: { status: 'pending' } }],
        });

        const logs = await runtime.getSlowQueryLogs({ collection: 'orders' });
        assert.equal(logs.length, 1);
        assert.equal(logs[0].operation, 'aggregate');
        assert.equal(typeof logs[0].queryHash, 'string');

        await runtime.close();
    });
});
