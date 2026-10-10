import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coordinateInvalidation, readThroughCache, withCacheReads } from '../../../src/core/cache-coordination';
import { scopedCacheDefaults, cacheNamespace, relatedCacheNamespaces } from '../../../src/core/cache-scope';
import { Transaction } from '../../../src/capabilities/transaction';
import { MemoryCache } from '../../../src/capabilities/cache';
import { DistributedCacheInvalidator } from '../../../src/capabilities/cache/distributed-cache-invalidator';
import { DistributedCacheLockManager } from '../../../src/capabilities/lock';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(r => { resolve = r; });
    return { promise, resolve };
}
function memory() {
    const values = new Map<string, unknown>();
    return {
        get: (key: string) => values.get(key),
        set: (key: string, value: unknown, _ttl: number) => { values.set(key, value); },
        del: (key: string) => values.delete(key),
    };
}

test('Nested cache reads share coordination without waiting on their own set', { timeout: 1000 }, async () => {
    const cache = memory();
    const result = await withCacheReads(cache, guarded => readThroughCache(guarded, 'totals', 1000, async () => 5));
    assert.equal(result, 5);
    assert.equal(cache.get('totals'), 5);
});

test('Invalidation revokes a query still fetching its old snapshot', async () => {
    const cache = memory();
    const fetched = deferred<number>();
    const started = deferred<void>();
    const reading = readThroughCache(cache, 'find:db.users:old', 1000, () => {
        started.resolve();
        return fetched.promise;
    });
    await started.promise;
    await coordinateInvalidation(cache, [{ type: 'pattern', value: 'find:db.users:*' }], async () => { cache.del('find:db.users:old'); });
    fetched.resolve(1);
    assert.equal(await reading, 1);
    assert.equal(cache.get('find:db.users:old'), undefined);
    assert.equal(await readThroughCache(cache, 'find:db.users:old', 1000, async () => 2), 2);
});

test('Exact invalidation preserves unrelated in-flight query fills', async () => {
    const cache = memory();
    const fetched = deferred<number>();
    const started = deferred<void>();
    const read = readThroughCache(cache, 'keep', 1000, () => { started.resolve(); return fetched.promise; });
    await started.promise;
    await coordinateInvalidation(cache, [{ type: 'key', value: 'other' }], async () => { cache.del('other'); });
    fetched.resolve(3);
    await read;
    assert.equal(cache.get('keep'), 3);
});

test('Read failure releases its ticket and a later query can fill', async () => {
    const cache = memory();
    await assert.rejects(readThroughCache(cache, 'key', 1000, async () => { throw new Error('query failed'); }));
    await coordinateInvalidation(cache, [{ type: 'key', value: 'key' }], async () => undefined);
    assert.equal(await readThroughCache(cache, 'key', 1000, async () => 4), 4);
});

test('Transaction cache flush revokes a pre-commit read', async () => {
    const cache = new MemoryCache();
    const fetched = deferred<number>();
    const started = deferred<void>();
    const read = readThroughCache(cache, 'key', 1000, () => { started.resolve(); return fetched.promise; });
    await started.promise;
    const session = {
        id: 'cache-test-session', inTransaction: () => true,
        startTransaction() {}, commitTransaction: async () => {}, abortTransaction: async () => {}, endSession: async () => {},
    };
    const tx = new Transaction(session, { cache });
    await tx.start();
    await tx.recordCacheInvalidation({ type: 'key', value: 'key' });
    await tx.commit();
    fetched.resolve(1);
    await read;
    assert.equal(cache.get('key'), undefined);
    await tx.end();
});

test('Source and pool identities are stable, private and linked for invalidation', () => {
    const cache = memory();
    const client = (host: string, user = 'reader') => ({ options: { hosts: [host], credentials: { username: user, password: 'private-password' } } });
    const a = scopedCacheDefaults({}, client('a:27017'), cache, 'primary');
    const alias = scopedCacheDefaults({}, client('a:27017', 'writer'), cache, 'secondary');
    const b = scopedCacheDefaults({}, client('b:27017'), cache, 'primary');
    const again = scopedCacheDefaults({}, client('a:27017'), cache, 'primary');
    assert.equal(cacheNamespace('db.users', a), cacheNamespace('db.users', again));
    assert.notEqual(cacheNamespace('db.users', a), cacheNamespace('db.users', alias));
    assert.notEqual(cacheNamespace('db.users', a), cacheNamespace('db.users', b));
    assert.ok(relatedCacheNamespaces('db.users', a).includes(cacheNamespace('db.users', alias)));
    assert.ok(!relatedCacheNamespaces('db.users', a).includes(cacheNamespace('db.users', b)));
    assert.ok(!cacheNamespace('db.users', a).includes('private-password'));
    const unknown = scopedCacheDefaults({}, {}, cache, 'custom');
    assert.ok(relatedCacheNamespaces('db.users', unknown).includes(cacheNamespace('db.users', a)));
    assert.ok(relatedCacheNamespaces('db.users', unknown).includes(cacheNamespace('db.users', b)));
    assert.ok(relatedCacheNamespaces('db.users', a).includes(cacheNamespace('db.users', unknown)));
});

test('Redis invalidation revokes an in-flight local read without re-publishing', { skip: !process.env.MONSQLIZE_TEST_REDIS_URL }, async () => {
    const Redis = require('ioredis');
    const connection = new Redis(process.env.MONSQLIZE_TEST_REDIS_URL);
    const publisher = new Redis(process.env.MONSQLIZE_TEST_REDIS_URL);
    const cache = new MemoryCache();
    const channel = `review:invalidate:${process.pid}:${Date.now()}`;
    const receiver = new DistributedCacheInvalidator({ cache, redis: connection, channel, instanceId: 'receiver' });
    try {
        const deadline = Date.now() + 3000;
        while (Number((await publisher.pubsub('NUMSUB', channel))[1]) < 1 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(Number((await publisher.pubsub('NUMSUB', channel))[1]), 1);
        const fetched = deferred<number>(), started = deferred<void>();
        const reading = readThroughCache(cache, 'remote:key', 1000, () => { started.resolve(); return fetched.promise; });
        await started.promise;
        await publisher.publish(channel, JSON.stringify({ type: 'invalidateKey', key: 'remote:key', instanceId: 'sender' }));
        while (receiver.getStats().invalidationsTriggered < 1 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(receiver.getStats().invalidationsTriggered, 1);
        fetched.resolve(1);
        await reading;
        assert.equal(cache.get('remote:key'), undefined);
        assert.equal(receiver.getStats().messagesSent, 0);
    } finally { await receiver.close(); await publisher.quit(); cache.clear(); }
});

test('Redis lease renewal and expiry update lock handle state', { skip: !process.env.MONSQLIZE_TEST_REDIS_URL }, async () => {
    const Redis = require('ioredis');
    const redis = new Redis(process.env.MONSQLIZE_TEST_REDIS_URL);
    const manager = new DistributedCacheLockManager({ redis, lockKeyPrefix: `review:lock:${process.pid}:` });
    try {
        const lock = await manager.tryAcquireLock('lease', { ttl: 100 });
        assert.ok(lock);
        assert.equal(await lock.renew(250), true);
        await new Promise(resolve => setTimeout(resolve, 130));
        assert.equal(lock.isHeld(), true);
        await new Promise(resolve => setTimeout(resolve, 160));
        assert.equal(lock.isHeld(), false);
        assert.equal(await lock.renew(100), false);
        const successor = await manager.tryAcquireLock('lease', { ttl: 1000 });
        assert.ok(successor);
        assert.equal(await lock.release(), false);
        assert.equal(successor.isHeld(), true);
        await successor.release();
    } finally { await redis.quit(); }
});
