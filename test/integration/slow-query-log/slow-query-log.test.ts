import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';
import { createMemoryServerBootstrap } from '../../bootstrap/memory-server';

const MonSQLize = require('../../../dist/cjs/index.cjs');

describe('P4-C slow-query-log integration', () => {
    const bootstrap = createMemoryServerBootstrap({ dbName: 'monsqlize_p4c_slow' });
    let uri = '';

    before(async () => {
        const context = await bootstrap.setup();
        uri = context.uri;
    });

    after(async () => {
        await bootstrap.teardown();
    });

    it('AR05 closes a real late client and keeps a shared business connection usable', async () => {
        const client = new MongoClient(uri);
        let release!: () => void;
        let entered!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const started = new Promise<void>(resolve => { entered = resolve; });
        let closes = 0;
        const originalClose = client.close.bind(client);
        client.close = async () => { closes++; await originalClose(); };
        const storage = new MonSQLize.MongoDBSlowQueryLogStorage({ uri, useBusinessConnection: false }, null, null, async () => {
            await client.connect(); entered(); await gate; return client;
        }, { autoCreateIndexes: false });
        const initializing = storage.initialize();
        const rejected = assert.rejects(initializing, { code: 'CONNECTION_CLOSED' });
        try {
            await Promise.race([started, initializing]);
            const closing = storage.close();
            release();
            await rejected;
            await closing;
            assert.equal(closes, 1);
        } finally { release(); await initializing.catch(() => undefined); await storage.close(); await originalClose(); }
        const shared = new MongoClient(uri);
        await shared.connect();
        try {
            const sharedStorage = new MonSQLize.MongoDBSlowQueryLogStorage({}, shared, null, undefined, { autoCreateIndexes: false });
            await sharedStorage.initialize();
            await sharedStorage.close();
            assert.equal((await shared.db().command({ ping: 1 })).ok, 1);
        } finally { await shared.close(); }
    });

    it('records and queries slow query logs on a real Mongo connection', async () => {
        const runtime = new MonSQLize({
            type: 'mongodb',
            databaseName: 'app_db',
            config: { uri },
            slowQueryLog: {
                enabled: true,
                storage: {
                    type: 'memory',
                },
                batch: {
                    enabled: false,
                    size: 1,
                    interval: 50,
                    maxBufferSize: 10,
                },
            },
        });

        try {
            await runtime.connect();
            await runtime.recordSlowQuery({
                database: 'app_db',
                collection: 'users',
                operation: 'find',
                durationMs: 750,
                query: { email: 'ada@example.com' },
            });
            await runtime.recordSlowQuery({
                database: 'app_db',
                collection: 'users',
                operation: 'find',
                durationMs: 1250,
                query: { email: 'ada@example.com' },
            });

            const logs = await runtime.getSlowQueryLogs({ collection: 'users' }, { limit: 10 });
            assert.equal(logs.length, 1);
            assert.equal(logs[0].count, 2);
            assert.equal(logs[0].totalTimeMs, 2000);
            assert.equal(logs[0].avgTimeMs, 1000);
        } finally {
            await runtime.close();
        }
    });
});
