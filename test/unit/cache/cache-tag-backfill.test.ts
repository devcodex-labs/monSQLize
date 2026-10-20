import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MonSQLize = require('../../../dist/cjs/index.cjs');
const { MemoryCache, MultiLevelCache } = MonSQLize;

function gate() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    return { promise, release };
}

function caches() {
    const local = new MemoryCache({ enableTags: true, cleanupInterval: 0 });
    const remote = new MemoryCache({ enableTags: true, cleanupInterval: 0 });
    const cache = new MultiLevelCache({ local, remote, remoteTimeoutMs: 10000 });
    return { local, remote, cache, destroy: () => { cache.destroy(); remote.destroy(); } };
}

function retainSnapshotTtl(remote: any): void {
    // Keep the remote hit eligible for a backfill even after its tagged entry is deleted.
    remote.getRemainingTtl = () => null;
    remote.getRemainingTtlMany = (keys: string[]) => Object.fromEntries(keys.map((key) => [key, null]));
}

describe('tag invalidation across anonymous local backfills', { timeout: 10000 }, () => {
    it('clears backfilled tags locally while retaining unrelated remote entries', async () => {
        const { local, remote, cache, destroy } = caches();
        try {
            await cache.set('tagged', 'old', 0, { tags: ['group'] });
            await cache.set('unrelated', 'keep', 0, { tags: ['other'] });
            await local.clear();
            assert.equal(await cache.get('tagged'), 'old');
            assert.equal(await local.get('tagged'), 'old');
            await cache.invalidateByTag('group');
            assert.equal(await local.get('tagged'), undefined);
            assert.equal(await cache.get('tagged'), undefined);
            assert.equal(await remote.get('unrelated'), 'keep');
            assert.equal(await cache.get('unrelated'), 'keep');
            assert.equal(await local.get('unrelated'), 'keep');
        } finally { destroy(); }
    });

    for (const batch of [false, true]) {
        it(`does not backfill a delayed ${batch ? 'batch' : 'single'} snapshot after invalidation`, async () => {
            const { local, remote, cache, destroy } = caches();
            const entered = gate(), release = gate();
            try {
                await cache.set('key', 'old', 0, { tags: ['group'] });
                await local.clear();
                retainSnapshotTtl(remote);
                const method = batch ? 'getMany' : 'get';
                const original = remote[method].bind(remote);
                remote[method] = async (key: unknown) => {
                    const snapshot = await original(key);
                    entered.release(); await release.promise;
                    return snapshot;
                };
                const reading = batch ? cache.getMany(['key']) : cache.get('key');
                await entered.promise;
                await cache.invalidateByTag('group');
                release.release();
                assert.deepEqual(await reading, batch ? { key: 'old' } : 'old');
                assert.equal(await local.get('key'), undefined);
                assert.equal(await cache.get('key'), undefined);
            } finally { release.release(); destroy(); }
        });

        it(`keeps ${batch ? 'batch' : 'single'} reads begun inside the invalidation window ineligible`, async () => {
            const { local, remote, cache, destroy } = caches();
            const invalidating = gate(), finishInvalidation = gate(), reading = gate(), finishRead = gate();
            try {
                await cache.set('key', 'old', 0, { tags: ['group'] });
                await local.clear();
                retainSnapshotTtl(remote);
                const invalidate = remote.invalidateByTag.bind(remote);
                remote.invalidateByTag = async (tag: string) => {
                    invalidating.release(); await finishInvalidation.promise; await invalidate(tag);
                };
                const method = batch ? 'getMany' : 'get', get = remote[method].bind(remote);
                remote[method] = async (key: unknown) => {
                    const snapshot = await get(key); reading.release(); await finishRead.promise; return snapshot;
                };
                const clearing = cache.invalidateByTag('group');
                await invalidating.promise;
                const result = batch ? cache.getMany(['key']) : cache.get('key');
                await reading.promise;
                finishInvalidation.release(); await clearing;
                finishRead.release();
                assert.deepEqual(await result, batch ? { key: 'old' } : 'old');
                assert.equal(await local.get('key'), undefined);
            } finally { finishInvalidation.release(); finishRead.release(); destroy(); }
        });
    }

    it('drains an already dispatched local setter before clearing', async () => {
        const { local, cache, destroy } = caches();
        const entered = gate(), release = gate();
        try {
            await cache.set('key', 'old', 0, { tags: ['group'] }); await local.clear();
            const set = local.set.bind(local);
            local.set = async (...args: unknown[]) => { entered.release(); await release.promise; return set(...args); };
            const reading = cache.get('key'); await entered.promise;
            let completed = false;
            const clearing = cache.invalidateByTag('group').then(() => { completed = true; });
            await Promise.resolve(); await Promise.resolve();
            assert.equal(completed, false);
            release.release();
            assert.equal(await reading, 'old'); await clearing;
            assert.equal(await local.get('key'), undefined);
        } finally { release.release(); destroy(); }
    });

    for (const otherKind of ['normal', 'no-backfill', 'no-remote', 'esm']) {
        it(`coordinates a shared L1 through a ${otherKind} wrapper`, async () => {
            const { local, remote, cache, destroy } = caches();
            const entered = gate(), release = gate();
            try {
                const Constructor = otherKind === 'esm'
                    ? (await import(pathToFileURL(path.resolve(__dirname, '../../../dist/esm/index.mjs')).href)).MultiLevelCache
                    : MultiLevelCache;
                const other = new Constructor({ local,
                    ...(otherKind === 'no-remote' ? {} : { remote }),
                    backfillOnRemoteHit: otherKind !== 'no-backfill',
                });
                await cache.set('key', 'old', 0, { tags: ['group'] }); await local.clear();
                retainSnapshotTtl(remote);
                const get = remote.get.bind(remote);
                remote.get = async (key: string) => { const snapshot = await get(key); entered.release(); await release.promise; return snapshot; };
                const reading = cache.get('key'); await entered.promise;
                await other.invalidateByTag('group'); release.release();
                assert.equal(await reading, 'old');
                assert.equal(await local.get('key'), undefined);
            } finally { release.release(); destroy(); }
        });
    }

    it('bypasses dirty local reads after clear failure and reopens only after successful cleanup', async () => {
        const { local, remote, cache, destroy } = caches();
        try {
            await cache.set('key', 'old', 0, { tags: ['group'] }); await local.clear();
            await cache.get('key');
            const clear = local.clear.bind(local); let fail = true;
            local.clear = async () => { if (fail) throw new Error('local cleanup failed'); await clear(); };
            await assert.rejects(cache.invalidateByTag('group'), /local cleanup failed/);
            assert.equal(await local.get('key'), 'old');
            assert.equal(await cache.get('key'), undefined);
            assert.deepEqual(await cache.getMany(['key']), {});
            assert.equal(await cache.exists('key'), false);
            assert.equal(await cache.has('key'), false);
            await remote.set('fresh', 'new', 0);
            assert.equal(await cache.get('fresh'), 'new');
            assert.equal(await local.get('fresh'), undefined);
            fail = false; await cache.invalidateByTag('group');
            assert.equal(await cache.get('fresh'), 'new');
            assert.equal(await local.get('fresh'), 'new');
        } finally { destroy(); }
    });

    it('does not suppress explicit writes made inside an obsolete read context', async () => {
        const { local, remote, cache, destroy } = caches();
        const entered = gate(), release = gate();
        try {
            await cache.set('key', 'old', 0, { tags: ['group'] }); await local.clear();
            const get = remote.get.bind(remote);
            remote.get = async (key: string) => {
                const snapshot = await get(key); entered.release(); await release.promise;
                await cache.set('business', 'single', 0);
                await cache.setMany({ another: 'batch' }, 0);
                return snapshot;
            };
            const reading = cache.get('key'); await entered.promise;
            await cache.invalidateByTag('group'); release.release(); await reading;
            assert.equal(await local.get('key'), undefined);
            assert.equal(await local.get('business'), 'single');
            assert.equal(await local.get('another'), 'batch');
        } finally { release.release(); destroy(); }
    });

    it('rejects self-waiting setter reentry but allows a detached callback after dispatch settles', async () => {
        const { local, cache, destroy } = caches();
        const detached = gate(); let detachedError: unknown;
        try {
            await cache.set('key', 'old', 0, { tags: ['group'] }); await local.clear();
            const set = local.set.bind(local);
            local.set = async (...args: unknown[]) => {
                await assert.rejects(cache.invalidateByTag('group'), { code: 'INVALID_OPERATION' });
                setImmediate(async () => {
                    try { await cache.invalidateByTag('group'); } catch (error) { detachedError = error; }
                    finally { detached.release(); }
                });
                return set(...args);
            };
            assert.equal(await cache.get('key'), 'old'); await detached.promise;
            assert.equal(detachedError, undefined);
            assert.equal(await local.get('key'), undefined);
        } finally { destroy(); }
    });

    it('detects active ancestors across nested caches without leaving either read pending', async () => {
        const first = caches(), second = caches(); let rejected = false;
        try {
            await first.cache.set('a', 'first', 0, { tags: ['group'] });
            await second.cache.set('b', 'second', 0);
            await first.local.clear(); await second.local.clear();
            const firstSet = first.local.set.bind(first.local), secondSet = second.local.set.bind(second.local);
            first.local.set = async (...args: unknown[]) => { await second.cache.get('b'); return firstSet(...args); };
            second.local.set = async (...args: unknown[]) => {
                await assert.rejects(first.cache.invalidateByTag('group'), { code: 'INVALID_OPERATION' });
                rejected = true;
                return secondSet(...args);
            };
            assert.equal(await first.cache.get('a'), 'first');
            assert.equal(rejected, true);
            await first.cache.invalidateByTag('group');
            assert.equal(await first.local.get('a'), undefined);
        } finally { first.destroy(); second.destroy(); }
    });

    it('preserves remote failure policy and publication behavior', async () => {
        for (const policy of ['ignore', 'throw']) {
            const local = new MemoryCache({ cleanupInterval: 0 }), remote = new MemoryCache({ cleanupInterval: 0 });
            const messages: unknown[] = [];
            const cache = new MultiLevelCache({ local, remote, remoteInvalidationErrors: policy, publish: (message: unknown) => messages.push(message) });
            try {
                await local.set('anonymous', 'old', 0);
                remote.invalidateByTag = async () => { throw new Error('remote unavailable'); };
                if (policy === 'throw') await assert.rejects(cache.invalidateByTag('group'), /remote unavailable/);
                else await cache.invalidateByTag('group');
                assert.equal(await local.get('anonymous'), undefined);
                assert.equal(messages.length, policy === 'throw' ? 0 : 1);
            } finally { cache.destroy(); remote.destroy(); }
        }
    });
});

describe('runtime remote cache wrappers', () => {
    for (const prefix of ['', 'tenant:']) {
        for (const batch of [false, true]) {
            it(`uses physical TTL keys and preserves tags (${prefix || 'default TTL'}, ${batch ? 'many' : 'one'})`, async () => {
                const local = new MemoryCache({ cleanupInterval: 0 }), remote = new MemoryCache({ enableTags: true, cleanupInterval: 0 });
                const ttlKeys: string[] = [];
                const physical = `${prefix}key`;
                remote.getRemainingTtl = function (key: string) { assert.equal(this, remote); ttlKeys.push(key); return key === physical ? 20000 : 120000; };
                remote.getRemainingTtlMany = async function (keys: string[]) { assert.equal(this, remote); ttlKeys.push(...keys); return Object.fromEntries(keys.map((key) => [key, key === physical ? 20000 : 120000])); };
                const runtime = new MonSQLize({ type: 'mongodb', databaseName: 'cache_unit', cache: { memory: local, redis: { cache: remote, prefix, defaultTtl: 60000 } } });
                try {
                    const cache = runtime.getCache();
                    await cache.set('key', 'own', 0, { tags: ['group'] });
                    await local.clear();
                    assert.deepEqual(await (batch ? cache.getMany(['key']) : cache.get('key')), batch ? { key: 'own' } : 'own');
                    assert.deepEqual(ttlKeys, [physical]);
                    const ttl = await local.getRemainingTtl('key');
                    assert.equal(typeof ttl, 'number');
                    assert.ok(ttl > 0 && ttl <= 20000);
                    await cache.invalidateByTag('group');
                    assert.equal(await remote.get(physical), undefined);
                } finally { await runtime.close(); local.destroy(); remote.destroy(); }
            });
        }
    }
});
