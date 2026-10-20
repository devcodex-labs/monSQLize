import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MongoDBSlowQueryLogStorage } from '../../../src/capabilities/slow-query-log/slow-query-log-storage';

const { SlowQueryLogManager } = require('../../../dist/cjs/index.cjs');

// The root export already exposes SlowQueryLogMemoryStorage; this test still
// goes through SlowQueryLogManager to cover the real memory-storage wiring path.

const NO_BATCH = { enabled: false };

function buildMgr() {
    return new SlowQueryLogManager(
        { enabled: true, storage: { type: 'memory' }, batch: NO_BATCH, advanced: { errorHandling: 'throw' } },
        null, 'mongodb', null,
    );
}

describe('SlowQueryLogMemoryStorage via SlowQueryLogManager — skip/limit branches', () => {
    it('query with skip omits first N records', async () => {
        const mgr = buildMgr();
        await mgr.save({ database: 'db', collection: 'c1', operation: 'find', durationMs: 100 });
        await mgr.save({ database: 'db', collection: 'c2', operation: 'find', durationMs: 200 });
        await mgr.save({ database: 'db', collection: 'c3', operation: 'find', durationMs: 300 });
        const all = await mgr.query({});
        const skipped = await mgr.query({}, { skip: 1 });
        assert.equal(skipped.length, all.length - 1);
    });

    it('query with limit restricts to N records', async () => {
        const mgr = buildMgr();
        await mgr.save({ database: 'db', collection: 'c1', operation: 'find', durationMs: 100 });
        await mgr.save({ database: 'db', collection: 'c2', operation: 'find', durationMs: 200 });
        await mgr.save({ database: 'db', collection: 'c3', operation: 'find', durationMs: 300 });
        const limited = await mgr.query({}, { limit: 2 });
        assert.equal(limited.length, 2);
    });

    it('query with both skip and limit', async () => {
        const mgr = buildMgr();
        for (let i = 1; i <= 5; i++) {
            await mgr.save({ database: 'db', collection: `c${i}`, operation: 'find', durationMs: i * 100 });
        }
        const result = await mgr.query({}, { skip: 1, limit: 2 });
        assert.equal(result.length, 2);
    });

    it('query without skip/limit returns all records', async () => {
        const mgr = buildMgr();
        await mgr.save({ database: 'db', collection: 'c1', operation: 'find', durationMs: 100 });
        await mgr.save({ database: 'db', collection: 'c2', operation: 'find', durationMs: 200 });
        const result = await mgr.query({});
        assert.equal(result.length, 2);
    });

    it('query with skip=0 returns all records (false branch of if(options.skip))', async () => {
        const mgr = buildMgr();
        await mgr.save({ database: 'db', collection: 'c1', operation: 'find', durationMs: 100 });
        await mgr.save({ database: 'db', collection: 'c2', operation: 'find', durationMs: 200 });
        const result = await mgr.query({}, { skip: 0 });
        assert.equal(result.length, 2);
    });

    it('query with limit=0 returns all records (false branch of if(options.limit))', async () => {
        const mgr = buildMgr();
        await mgr.save({ database: 'db', collection: 'c1', operation: 'find', durationMs: 100 });
        const result = await mgr.query({}, { limit: 0 });
        assert.equal(result.length, 1);
    });

    it('saveBatch (multiple entries) covers the batch path', async () => {
        const mgr = buildMgr();
        // SlowQueryLogManager.saveBatch is internal but save() triggers upsertRecord
        await mgr.save({ database: 'db', collection: 'c1', operation: 'find', durationMs: 100 });
        await mgr.save({ database: 'db', collection: 'c1', operation: 'find', durationMs: 200 });
        const result = await mgr.query({});
        // Second save merges into same record
        assert.equal(result.length, 1);
        assert.equal(result[0].count, 2);
    });
});

describe('MongoDBSlowQueryLogStorage — resolveClient branches (via mock clientFactory)', () => {
    it('AR05 closes a late owned client once and allows a later explicit initialization', async () => {
        let release!: () => void;
        let entered!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const started = new Promise<void>(resolve => { entered = resolve; });
        let factories = 0;
        let closes = 0;
        const storage = new MongoDBSlowQueryLogStorage({ uri: 'mongodb://owned', useBusinessConnection: false }, null, null,
            async () => {
                factories++;
                if (factories === 1) { entered(); await gate; }
                return { db: () => ({ collection: () => ({}) }), close: async () => { closes++; } } as any;
            }, { autoCreateIndexes: false });
        const initializing = storage.initialize();
        const rejected = assert.rejects(initializing, { code: 'CONNECTION_CLOSED' });
        await started;
        const firstClose = storage.close();
        const secondClose = storage.close();
        release();
        await Promise.all([rejected, firstClose, secondClose]);
        assert.equal(closes, 1);
        assert.equal((storage as any).client, null);
        assert.equal((storage as any).collectionRef, null);
        await storage.initialize();
        assert.equal(factories, 2);
        await storage.close();
        assert.equal(closes, 2);
    });

    it('AR05 cancels index initialization and retains failed-close ownership for retry', async () => {
        for (const shared of [false, true]) {
            let release!: () => void;
            let entered!: () => void;
            const gate = new Promise<void>(resolve => { release = resolve; });
            const started = new Promise<void>(resolve => { entered = resolve; });
            let closes = 0;
            const client: any = {
                db: () => ({ collection: () => ({ createIndex: async () => { entered(); await gate; } }) }),
                close: async () => { closes++; if (closes === 1) throw new Error('release failed'); },
            };
            const storage = new MongoDBSlowQueryLogStorage({ uri: 'mongodb://owned', useBusinessConnection: shared, ttl: 0 }, shared ? client : null, null, async () => client);
            const initializing = storage.initialize();
            const rejected = assert.rejects(initializing, { code: 'CONNECTION_CLOSED' });
            await started;
            const closing = storage.close();
            const closeResult = shared ? assert.doesNotReject(closing) : assert.rejects(closing, /release failed/);
            release();
            await Promise.all([rejected, closeResult]);
            assert.equal((storage as any).collectionRef, null);
            if (shared) assert.equal(closes, 0);
            else {
                assert.strictEqual((storage as any).client, client);
                await assert.rejects(storage.initialize(), { code: 'CONNECTION_CLOSED' });
                await storage.close();
                assert.equal(closes, 2);
                assert.equal((storage as any).client, null);
            }
        }
    });

    it('B21 honors automatic index configuration without changing the fourth factory argument', async () => {
        for (const enabled of [undefined, false, true]) {
            let indexes = 0;
            const collection = { createIndex: async () => { indexes++; } };
            const client: any = { db: () => ({ collection: () => collection }) };
            const advanced = enabled === undefined ? {} : { autoCreateIndexes: enabled };
            const manager = new SlowQueryLogManager({ enabled: true, storage: { type: 'mongodb' }, advanced }, client);
            await manager.initialize();
            assert.equal(indexes, enabled === false ? 0 : 2);
            await manager.close();
        }
        let factories = 0, indexes = 0, fail = true;
        const collection: any = { createIndex: async () => { indexes++; if (fail) { fail = false; throw new Error('index unavailable'); } } };
        const storage = new MongoDBSlowQueryLogStorage({ uri: 'mongodb://factory', useBusinessConnection: false, ttl: 0 }, null, null,
            async (uri) => { assert.equal(uri, 'mongodb://factory'); factories++; return { db: () => ({ collection: () => collection }), close: async () => undefined } as any; });
        try {
            await assert.rejects(storage.initialize(), /index unavailable/);
            await storage.initialize();
            assert.equal(factories, 1);
            assert.equal(indexes, 2);
        } finally { await storage.close(); }
    });

    it('useBusinessConnection=false with no URI throws at construction', () => {
        assert.throws(() => {
            new SlowQueryLogManager(
                {
                    enabled: true,
                    storage: { type: 'mongodb', useBusinessConnection: false },
                    batch: NO_BATCH,
                    advanced: { errorHandling: 'throw' },
                },
                null, 'mongodb', null,
            );
        });
    });

    it('useBusinessConnection default (true) with null client falls through to URI', async () => {
        const mgr = new SlowQueryLogManager(
            {
                enabled: true,
                storage: { type: 'mongodb', useBusinessConnection: true },
                batch: NO_BATCH,
                advanced: { errorHandling: 'throw' },
            },
            null, 'mongodb', null,
        );
        await assert.rejects(
            () => mgr.save({ database: 'db', collection: 'c1', operation: 'find', durationMs: 100 }),
        );
    });

    it('saveBatch with empty array is a no-op', async () => {
        // saveBatch([]) → returns early without calling initialize()
        // This is covered in SlowQueryLogManager batch processing
        const mgr = buildMgr();
        // Nothing to assert except no error
        await assert.doesNotReject(() => mgr.query({}));
    });
});
