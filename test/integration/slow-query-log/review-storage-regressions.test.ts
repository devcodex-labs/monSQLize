import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';
import { createMemoryServerBootstrap } from '../../bootstrap/memory-server';
const MonSQLize = require('../../../dist/cjs/index.cjs');

describe('persistent slow-query aggregation regression contracts', () => {
    const bootstrap = createMemoryServerBootstrap();
    let client: MongoClient;
    before(async () => { const { uri } = await bootstrap.setup(); client = await new MongoClient(uri).connect(); });
    after(async () => { try { if (client) await client.close(); } finally { await bootstrap.teardown(); } });

    it('keeps event-time bounds across separate storage owners and sorts derived averages before paging', async () => {
        const config = { database: 'repair_slow_logs', collection: 'records', ttl: 0 };
        const first = new MonSQLize.MongoDBSlowQueryLogStorage(config, client);
        const second = new MonSQLize.MongoDBSlowQueryLogStorage(config, client);
        const raw = client.db(config.database).collection(config.collection);
        const entry = (queryHash: string, timestamp: number, durationMs: number) => ({
            queryHash, timestamp: new Date(timestamp), durationMs, database: 'app', collection: 'items', operation: 'find',
        });
        try {
            await first.initialize(); await second.initialize(); await raw.deleteMany({});
            await first.save(entry('a', 300, 100)); await second.save(entry('a', 100, 10));
            await first.saveBatch([entry('a', 500, 20), entry('a', 200, 5)]);
            await second.save(entry('b', 400, 50));
            const [record] = await first.query({ queryHash: 'a' });
            assert.equal(record.firstSeen.getTime(), 100); assert.equal(record.lastSeen.getTime(), 500);
            assert.equal(record.count, 4); assert.equal(record.totalTimeMs, 135); assert.equal(record.avgTimeMs, 33.75);
            assert.equal(record.minTimeMs, 5); assert.equal(record.maxTimeMs, 100);
            await raw.insertMany([
                { ...record, _id: undefined, queryHash: 'c', count: 100, totalTimeMs: 1000, avgTimeMs: 99999 },
                { ...record, _id: undefined, queryHash: 'zero', count: 0, totalTimeMs: 999, avgTimeMs: 99999 },
            ]);
            assert.equal((await second.query({}, { sort: { avgTimeMs: -1, queryHash: 1 }, limit: 1 }))[0].queryHash, 'b');
            assert.equal((await second.query({}, { sort: { avgTimeMs: 1, queryHash: 1 }, skip: 1, limit: 1 }))[0].queryHash, 'c');
            assert.equal((await second.query({ queryHash: 'zero' }))[0].avgTimeMs, 0);
            assert.equal((await raw.findOne({ queryHash: 'c' }))!.avgTimeMs, 99999);
        } finally { await first.close(); await second.close(); }
        assert.equal((await client.db(config.database).command({ ping: 1 })).ok, 1);
    });
});
