import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRuntimeCacheWithLifecycle } from '../../../src/entry/runtime-cache-normalizer';
import { createBackfillFence } from '../../../src/capabilities/cache/multi-level-backfill-fence';
const { MemoryCache, MultiLevelCache } = require('../../../dist/cjs/index.cjs');

function gate() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    return { promise, release };
}

describe('remote TTL capabilities and backfill lifecycle', { timeout: 10000 }, () => {
    for (const prefix of ['', 'tenant:']) {
        for (const behavior of ['missing', 'undefined', 'null', 'positive', 'throw']) {
            it(`preserves ${behavior} single TTL behavior with ${prefix || 'default-TTL-only'} wrapping`, async () => {
                const local = new MemoryCache({ cleanupInterval: 0, defaultTtl: 40000 });
                const remote = new MemoryCache({ cleanupInterval: 0 });
                const physical = `${prefix}key`;
                Object.defineProperty(remote, 'getRemainingTtl', { configurable: true, value: behavior === 'missing' ? undefined : function (this: unknown, key: string) {
                    assert.equal(this, remote); assert.equal(key, physical);
                    if (behavior === 'throw') throw new Error('TTL unavailable');
                    return behavior === 'undefined' ? undefined : behavior === 'null' ? null : 20000;
                } });
                const normalized = normalizeRuntimeCacheWithLifecycle({ memory: local, redis: { cache: remote, prefix, defaultTtl: 60000 } });
                try {
                    await remote.set(physical, 'value', 0);
                    assert.equal(await normalized.cache.get('key'), 'value');
                    const value = await local.get('key'), ttl = await local.getRemainingTtl('key');
                    if (behavior === 'undefined') { assert.equal(value, undefined); assert.equal(ttl, undefined); }
                    else if (behavior === 'null') { assert.equal(value, 'value'); assert.equal(ttl, null); }
                    else {
                        assert.equal(value, 'value'); assert.equal(typeof ttl, 'number');
                        assert.ok(ttl > 0 && ttl <= (behavior === 'positive' ? 20000 : 40000));
                    }
                } finally { await normalized.close?.(); local.destroy(); remote.destroy(); }
            });
        }
        for (const behavior of ['missing', 'throw', 'empty', 'mixed']) {
            it(`preserves ${behavior} batch TTL behavior with ${prefix || 'default-TTL-only'} wrapping`, async () => {
                const local = new MemoryCache({ cleanupInterval: 0 }), remote = new MemoryCache({ cleanupInterval: 0 });
                const singleKeys: string[] = [], batchKeys: string[][] = [];
                remote.getRemainingTtl = function (key: string) { assert.equal(this, remote); singleKeys.push(key); return 20000; };
                Object.defineProperty(remote, 'getRemainingTtlMany', { configurable: true, value: behavior === 'missing' ? undefined : function (this: unknown, keys: string[]) {
                    assert.equal(this, remote); batchKeys.push(keys);
                    if (behavior === 'throw') throw new Error('Batch TTL unavailable');
                    return behavior === 'empty' ? {} : { [`${prefix}a`]: null, [`${prefix}b`]: 20000 };
                } });
                const normalized = normalizeRuntimeCacheWithLifecycle({ memory: local, redis: { cache: remote, prefix, defaultTtl: 60000 } });
                try {
                    for (const key of ['a', 'b', 'c']) await remote.set(`${prefix}${key}`, key, 0);
                    assert.deepEqual(await normalized.cache.getMany(['a', 'b', 'c']), { a: 'a', b: 'b', c: 'c' });
                    if (behavior === 'empty') {
                        assert.deepEqual(singleKeys, []); assert.deepEqual(await local.getMany(['a', 'b', 'c']), {});
                    } else if (behavior === 'mixed') {
                        assert.deepEqual(singleKeys, []); assert.equal(await local.getRemainingTtl('a'), null);
                        const ttl = await local.getRemainingTtl('b'); assert.equal(typeof ttl, 'number'); assert.ok(ttl > 0 && ttl <= 20000);
                        assert.equal(await local.get('c'), undefined);
                    } else {
                        assert.deepEqual(singleKeys, ['a', 'b', 'c'].map((key) => `${prefix}${key}`));
                        for (const key of ['a', 'b', 'c']) { const ttl = await local.getRemainingTtl(key); assert.equal(typeof ttl, 'number'); assert.ok(ttl > 0 && ttl <= 20000); }
                    }
                    if (behavior !== 'missing') assert.deepEqual(batchKeys, [['a', 'b', 'c'].map((key) => `${prefix}${key}`)]);
                } finally { await normalized.close?.(); local.destroy(); remote.destroy(); }
            });
        }
    }

    for (const batch of [false, true]) {
        it(`revokes a delayed ${batch ? 'batch' : 'single'} runtime read without closing shared adapters`, async () => {
            const local = new MemoryCache({ cleanupInterval: 0 }), remote = new MemoryCache({ cleanupInterval: 0 });
            const entered = gate(), release = gate();
            let closed = 0, localSets = 0;
            const localDestroy = local.destroy.bind(local), remoteDestroy = remote.destroy.bind(remote), set = local.set.bind(local);
            local.destroy = remote.destroy = () => { closed++; };
            local.set = (...args: unknown[]) => { localSets++; return set(...args); };
            remote.getRemainingTtl = () => null;
            remote.getRemainingTtlMany = (keys: string[]) => Object.fromEntries(keys.map((key) => [key, null]));
            const normalized = normalizeRuntimeCacheWithLifecycle({ memory: local, redis: { cache: remote, timeoutMs: 10000 } });
            const other = new MultiLevelCache({ local, remote });
            try {
                await remote.set('key', 'old', 0);
                const method = batch ? 'getMany' : 'get', get = remote[method].bind(remote);
                remote[method] = async (keys: unknown) => { const snapshot = await get(keys); entered.release(); await release.promise; return snapshot; };
                const reading = batch ? normalized.cache.getMany(['key']) : normalized.cache.get('key');
                await entered.promise; await normalized.close?.(); release.release();
                assert.deepEqual(await reading, batch ? { key: 'old' } : 'old');
                assert.equal(localSets, 0); assert.equal(closed, 0);
                await remote.set('fresh', 'new', 0);
                assert.equal(await other.get('fresh'), 'new'); assert.equal(await local.get('fresh'), 'new');
                assert.equal(closed, 0);
            } finally { release.release(); other.destroy(); localDestroy(); remoteDestroy(); }
        });
    }

    for (const setterFails of [false, true]) {
        it(`drains admitted local setters before cleanup even when setter rejection is ${setterFails}`, async () => {
            const local = new MemoryCache({ cleanupInterval: 0 }), fence = createBackfillFence(local, true);
            const entered = gate(), release = gate(); let cleaned = 0;
            const set = local.set.bind(local);
            local.set = async (...args: unknown[]) => { entered.release(); await release.promise; if (setterFails) throw new Error('setter failed'); return set(...args); };
            const reading = fence.read(async () => fence.local.set('key', 'old', 0)).then(() => undefined, (error) => error);
            try {
                await entered.promise;
                const closing = fence.cleanup(async () => { cleaned++; });
                assert.equal(fence.cleanup(async () => { cleaned++; }), closing);
                await Promise.resolve(); await Promise.resolve(); assert.equal(cleaned, 0);
                release.release(); const error = await reading; await closing;
                assert.equal(Boolean(error), setterFails); assert.equal(cleaned, 1);
            } finally { release.release(); await reading; local.destroy(); }
        });
    }

    it('bypasses local reads during failed cleanup and resumes only after a successful retry', async () => {
        const local = new MemoryCache({ cleanupInterval: 0 }), fence = createBackfillFence(local, true);
        const entered = gate(), release = gate();
        try {
            await local.set('old', 'value', 0);
            const closing = fence.cleanup(async () => { entered.release(); await release.promise; throw new Error('cleanup failed'); });
            const rejection = assert.rejects(closing, /cleanup failed/);
            await entered.promise;
            assert.equal(await fence.local.get('old'), undefined);
            await fence.read(async () => fence.local.set('during', 'blocked', 0));
            assert.equal(await local.get('during'), undefined);
            release.release(); await rejection;
            assert.equal(await fence.local.get('old'), undefined);
            await fence.read(async () => fence.local.set('failed', 'blocked', 0));
            assert.equal(await local.get('failed'), undefined);
            await fence.cleanup(async () => {});
            assert.equal(await fence.local.get('old'), 'value');
            await fence.read(async () => fence.local.set('fresh', 'new', 0));
            assert.equal(await local.get('fresh'), 'new');
        } finally { release.release(); local.destroy(); }
    });

    it('waits for tag invalidation admitted before cleanup', async () => {
        const local = new MemoryCache({ cleanupInterval: 0 }), fence = createBackfillFence(local, true);
        const entered = gate(), release = gate(); let cleaned = false;
        const clearing = fence.invalidate(async () => { entered.release(); await release.promise; });
        try {
            await entered.promise;
            const closing = fence.cleanup(async () => { cleaned = true; });
            await Promise.resolve(); await Promise.resolve(); assert.equal(cleaned, false);
            release.release(); await clearing; await closing; assert.equal(cleaned, true);
        } finally { release.release(); await clearing; local.destroy(); }
    });

    it('keeps synchronous destroy and remote ownership while revoking undispatched backfills', async () => {
        const local = new MemoryCache({ cleanupInterval: 0 }), remote = new MemoryCache({ cleanupInterval: 0 });
        const entered = gate(), release = gate(); let sets = 0, remoteClosed = 0;
        const set = local.set.bind(local), destroyRemote = remote.destroy.bind(remote);
        remote.destroy = () => { remoteClosed++; };
        local.set = (...args: unknown[]) => { sets++; return set(...args); };
        remote.getRemainingTtl = () => null;
        const cache = new MultiLevelCache({ local, remote, remoteTimeoutMs: 10000 });
        try {
            await remote.set('key', 'old', 0);
            const get = remote.get.bind(remote);
            remote.get = async (key: string) => { const snapshot = await get(key); entered.release(); await release.promise; return snapshot; };
            const reading = cache.get('key'); await entered.promise;
            assert.equal(cache.destroy(), undefined); release.release(); assert.equal(await reading, 'old');
            assert.equal(sets, 0); assert.equal(remoteClosed, 0);
        } finally { release.release(); cache.destroy(); destroyRemote(); }
    });
});
