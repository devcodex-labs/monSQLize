import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryServerBootstrap } from '../../bootstrap/memory-server';

const MonSQLize = require('../../../dist/cjs/index.cjs');

describe('cache hit / miss / invalidation behavior', () => {
    const bootstrap = createMemoryServerBootstrap();
    let uri = '';
    let runtime: any;
    let col: any;

    before(async () => {
        const ctx = await bootstrap.setup();
        uri = ctx.uri;
        runtime = new MonSQLize({
            type: 'mongodb',
            databaseName: 'test_cache_behavior',
            config: { uri },
            cache: { maxEntries: 500 },
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

    // ── find() read-through cache ────────────────────���────────────────────────

    describe('find() read-through cache', () => {
        it('caches result and serves it on second call', async () => {
            const db = runtime._adapter.db;
            await db.collection('items').insertMany([
                { tag: 'a', name: 'X' },
                { tag: 'a', name: 'Y' },
            ]);

            const first = await col.find({ tag: 'a' }, { cache: 10000 });
            assert.equal(first.length, 2);

            // Insert via raw DB — bypasses accessor cache invalidation
            await db.collection('items').insertOne({ tag: 'a', name: 'Z' });

            const second = await col.find({ tag: 'a' }, { cache: 10000 });
            assert.equal(second.length, 2);
        });

        it('does not cache when no cache option is provided', async () => {
            const db = runtime._adapter.db;
            await db.collection('items').insertMany([{ tag: 'b', name: 'P' }]);

            const first = await col.find({ tag: 'b' });
            assert.equal(first.length, 1);

            await db.collection('items').insertOne({ tag: 'b', name: 'Q' });

            const second = await col.find({ tag: 'b' });
            assert.equal(second.length, 2);
        });

        it('insertOne does not invalidate the cache by default', async () => {
            const db = runtime._adapter.db;
            await db.collection('items').insertMany([{ tag: 'c', name: 'A' }]);

            await col.find({ tag: 'c' }, { cache: 10000 });

            await col.insertOne({ tag: 'c', name: 'B' });

            const result = await col.find({ tag: 'c' }, { cache: 10000 });
            assert.equal(result.length, 1);
        });

        it('insertOne broadly invalidates the cache when autoInvalidate is enabled', async () => {
            const db = runtime._adapter.db;
            await db.collection('items').insertMany([{ tag: 'c-auto', name: 'A' }]);

            await col.find({ tag: 'c-auto' }, { cache: 10000 });
            await col.insertOne({ tag: 'c-auto', name: 'B' }, { autoInvalidate: true });

            const result = await col.find({ tag: 'c-auto' }, { cache: 10000 });
            assert.equal(result.length, 2);
        });

        it('deleteOne invalidates the cache', async () => {
            const db = runtime._adapter.db;
            await db.collection('items').insertMany([
                { tag: 'd', name: 'M' },
                { tag: 'd', name: 'N' },
            ]);

            await col.find({ tag: 'd' }, { cache: 10000 });
            await col.deleteOne({ tag: 'd', name: 'M' }, { autoInvalidate: true });

            const result = await col.find({ tag: 'd' }, { cache: 10000 });
            assert.equal(result.length, 1);
        });

        it('updateOne invalidates the cache', async () => {
            const db = runtime._adapter.db;
            await db.collection('items').insertMany([{ tag: 'e', value: 1 }]);

            await col.find({ tag: 'e' }, { cache: 10000 });
            await col.updateOne(
                { tag: 'e' },
                { $set: { value: 99 } },
                {
                    cache: {
                        invalidate: [{
                            operation: 'find',
                            query: { tag: 'e' },
                            options: { cache: 10000 },
                        }],
                    },
                },
            );

            const result = await col.find({ tag: 'e' }, { cache: 10000 });
            assert.equal(result[0].value, 99);
        });
    });

    // ── findOne() read-through cache ─��────────────────────────────────────────

    describe('findOne() read-through cache', () => {
        it('caches result and serves it on second call', async () => {
            const db = runtime._adapter.db;
            await db.collection('items').insertOne({ tag: 'f', value: 10 });

            const first = await col.findOne({ tag: 'f' }, { cache: 10000 });
            assert.ok(first !== null);
            assert.equal(first.value, 10);

            await db.collection('items').updateOne({ tag: 'f' }, { $set: { value: 99 } });

            const second = await col.findOne({ tag: 'f' }, { cache: 10000 });
            assert.equal(second.value, 10);
        });

        it('insertOne invalidates findOne cache', async () => {
            const db = runtime._adapter.db;
            await db.collection('items').insertOne({ tag: 'g', value: 1 });

            await col.findOne({ tag: 'g' }, { cache: 10000 });
            await col.updateOne({ tag: 'g' }, { $set: { value: 50 } }, { autoInvalidate: true });

            const result = await col.findOne({ tag: 'g' }, { cache: 10000 });
            assert.equal(result.value, 50);
        });
    });

    // ── count() read-through cache ──────���───────────────────────��─────────────

    describe('count() read-through cache', () => {
        it('caches count and serves it on second call', async () => {
            const db = runtime._adapter.db;
            await db.collection('items').insertMany([
                { tag: 'h' },
                { tag: 'h' },
            ]);

            const first = await col.count({ tag: 'h' }, { cache: 10000 });
            assert.equal(first, 2);

            await db.collection('items').insertOne({ tag: 'h' });

            const second = await col.count({ tag: 'h' }, { cache: 10000 });
            assert.equal(second, 2);
        });

        it('deleteOne invalidates count cache', async () => {
            const db = runtime._adapter.db;
            await db.collection('items').insertMany([{ tag: 'i' }, { tag: 'i' }]);

            await col.count({ tag: 'i' }, { cache: 10000 });
            await col.deleteOne({ tag: 'i' }, { autoInvalidate: true });

            const result = await col.count({ tag: 'i' }, { cache: 10000 });
            assert.equal(result, 1);
        });
    });

    // ── normalizeRuntimeCache branches ───────────────────────────────────────

    describe('normalizeRuntimeCache: multiLevel cache config', () => {
        it('creates a usable cache when config uses local/remote shape', async () => {
            const rt = new MonSQLize({
                type: 'mongodb',
                databaseName: 'cache_normalizer_test',
                config: { uri },
                cache: {
                    local: { maxEntries: 100 },
                    remote: { maxEntries: 100 },
                },
            });
            await rt.connect();
            const cache = rt.getCache();
            cache.set('k', 'v', 5000);
            assert.equal(await Promise.resolve(cache.get('k')), 'v');
            await rt.close();
        });

        it('creates a usable cache when multiLevel: true is set', async () => {
            const rt = new MonSQLize({
                type: 'mongodb',
                databaseName: 'cache_normalizer_multilevel',
                config: { uri },
                cache: {
                    multiLevel: true,
                    local: { maxEntries: 50 },
                },
            });
            await rt.connect();
            const cache = rt.getCache();
            cache.set('x', 42, 5000);
            const result = await Promise.resolve(cache.get('x'));
            assert.ok(result !== undefined);
            await rt.close();
        });

        it('accepts a MemoryCache instance directly', async () => {
            const mc = new MonSQLize.MemoryCache({ maxEntries: 20 });
            const rt = new MonSQLize({
                type: 'mongodb',
                databaseName: 'cache_normalizer_instance',
                config: { uri },
                cache: mc,
            });
            await rt.connect();
            const cache = rt.getCache();
            assert.strictEqual(cache, mc);
            await rt.close();
        });
    });

    // ── getStats() size alias ────────��─────────────────────────────────────────

    describe('MemoryCache getStats() size alias', () => {
        it('getStats().size equals getStats().entries', () => {
            const cache = new MonSQLize.MemoryCache({ maxEntries: 10 });
            cache.set('a', 1, 5000);
            cache.set('b', 2, 5000);
            const stats = cache.getStats();
            assert.equal(stats.size, stats.entries);
            assert.equal(stats.size, 2);
        });
    });
});

describe('distributed cache invalidation over Redis', () => {
    it('converges between two instances without re-publishing an inbound message', {
        skip: !process.env.MONSQLIZE_TEST_REDIS_URL,
    }, async () => {
        const Redis = require('ioredis');
        const channel = `monsqlize:test:invalidate:${process.pid}:${Date.now()}`;
        const connectionA = new Redis(process.env.MONSQLIZE_TEST_REDIS_URL);
        const connectionB = new Redis(process.env.MONSQLIZE_TEST_REDIS_URL);
        const localA = new MonSQLize.MemoryCache();
        const localB = new MonSQLize.MemoryCache();
        const cacheA = new MonSQLize.MultiLevelCache({ local: localA });
        const cacheB = new MonSQLize.MultiLevelCache({ local: localB });
        let invalidatorA: any;
        let invalidatorB: any;
        try {
            invalidatorA = new MonSQLize.DistributedCacheInvalidator({ cache: cacheA, redis: connectionA, channel, instanceId: 'instance-a' });
            invalidatorB = new MonSQLize.DistributedCacheInvalidator({ cache: cacheB, redis: connectionB, channel, instanceId: 'instance-b' });
            cacheA.setPublish((message: any) => {
                if (message.type === 'delPattern') void invalidatorA.invalidate(message.pattern);
                else if (message.key) void invalidatorA.invalidateKey(message.key);
            });
            cacheB.setPublish((message: any) => {
                if (message.type === 'delPattern') void invalidatorB.invalidate(message.pattern);
                else if (message.key) void invalidatorB.invalidateKey(message.key);
            });
            const subscriptionDeadline = Date.now() + 3000;
            let subscribersReady = false;
            while (Date.now() < subscriptionDeadline) {
                const subscribers = await connectionA.pubsub('NUMSUB', channel);
                if (Number(subscribers[1]) >= 2) { subscribersReady = true; break; }
                await new Promise<void>((resolve) => setTimeout(resolve, 25));
            }
            assert.equal(subscribersReady, true, 'both Redis subscribers must be ready');
            await localA.set('shared:key', 'a');
            await localB.set('shared:key', 'b');
            await cacheA.delPattern('shared:*');
            const invalidationDeadline = Date.now() + 3000;
            while (Date.now() < invalidationDeadline && await localB.get('shared:key') !== undefined) {
                await new Promise<void>((resolve) => setTimeout(resolve, 25));
            }
            assert.equal(await localB.get('shared:key'), undefined);
            assert.equal(invalidatorA.getStats().messagesSent, 1);
            assert.equal(invalidatorB.getStats().messagesReceived, 1);
            assert.equal(invalidatorB.getStats().messagesSent, 0);
        } finally {
            await invalidatorA?.close();
            await invalidatorB?.close();
            await localA.close?.();
            await localB.close?.();
        }
    });
});
