import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { withMultiLevelBackfillCleanup } from '../../../src/capabilities/cache/multi-level-backfill-fence';

const { MemoryCache, MultiLevelCache } = require('../../../dist/cjs/index.cjs');
const kinds = ['del', 'delMany', 'delPattern', 'clear', 'remote-key', 'remote-pattern'] as const;
type Kind = typeof kinds[number];

function gate() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    return { promise, release };
}

function caches() {
    const local = new MemoryCache({ cleanupInterval: 0 });
    const remote = new MemoryCache({ cleanupInterval: 0 });
    // Preserve the TTL snapshot even when invalidation deletes the remote entry.
    remote.getRemainingTtl = () => null;
    remote.getRemainingTtlMany = (keys: string[]) => Object.fromEntries(keys.map((key) => [key, null]));
    const messages: any[] = [];
    const cache = new MultiLevelCache({ local, remote, remoteTimeoutMs: 10000, publish: (message: unknown) => messages.push(message) });
    return { local, remote, cache, messages, destroy: () => { cache.destroy(); remote.destroy(); } };
}

function remove(cache: any, kind: Kind) {
    if (kind === 'del') return cache.del('key');
    if (kind === 'delMany') return cache.delMany(['key']);
    if (kind === 'delPattern') return cache.delPattern('ke*');
    if (kind === 'clear') return cache.clear();
    return cache.invalidateFromRemote(kind === 'remote-key' ? 'key' : 'pattern', kind === 'remote-key' ? 'key' : 'ke*');
}

describe('deletion across anonymous local backfills', { timeout: 10000 }, () => {
    for (const kind of kinds) {
        for (const batch of [false, true]) {
            it(`revokes a delayed ${batch ? 'batch' : 'single'} snapshot on ${kind}`, async () => {
                const { local, remote, cache, messages, destroy } = caches();
                const entered = gate(), release = gate();
                try {
                    await remote.set('key', 'old', 0);
                    await cache.set('other', 'keep', 0);
                    const method = batch ? 'getMany' : 'get', original = remote[method].bind(remote);
                    remote[method] = async (keys: unknown) => {
                        const snapshot = await original(keys); entered.release(); await release.promise; return snapshot;
                    };
                    const reading = batch ? cache.getMany(['key']) : cache.get('key');
                    await entered.promise;
                    const result = await remove(cache, kind);
                    assert.equal(result, kind === 'del' ? false : kind === 'delMany' || kind === 'delPattern' ? 0 : undefined);
                    release.release();
                    assert.deepEqual(await reading, batch ? { key: 'old' } : 'old');
                    assert.equal(await local.get('key'), undefined);
                    assert.equal(await local.get('other'), kind === 'clear' ? undefined : 'keep');
                    assert.equal(await remote.get('other'), 'keep');
                    assert.equal(await remote.get('key'), kind === 'clear' ? 'old' : undefined);
                    assert.equal(messages.length, kind === 'delPattern' ? 1 : 0);
                } finally { release.release(); destroy(); }
            });
        }

        it(`drains an already entered setter before ${kind}`, async () => {
            const { local, remote, cache, destroy } = caches();
            const entered = gate(), release = gate();
            try {
                await remote.set('key', 'old', 0);
                const set = local.set.bind(local);
                local.set = async (...args: unknown[]) => { entered.release(); await release.promise; return set(...args); };
                const reading = cache.get('key'); await entered.promise;
                let completed = false;
                const deleting = remove(cache, kind).then((result: unknown) => { completed = true; return result; });
                await Promise.resolve(); await Promise.resolve(); assert.equal(completed, false);
                release.release(); assert.equal(await reading, 'old');
                assert.equal(await deleting, kind === 'del' ? true : kind === 'delMany' || kind === 'delPattern' ? 1 : undefined);
                assert.equal(await local.get('key'), undefined);
            } finally { release.release(); destroy(); }
        });
    }

    it('keeps reads begun inside a key deletion window ineligible', async () => {
        const { local, remote, cache, destroy } = caches();
        const deleting = gate(), finishDelete = gate(), entered = gate(), finishRead = gate();
        try {
            await remote.set('key', 'old', 0);
            const del = remote.del.bind(remote), get = remote.get.bind(remote);
            remote.del = async (key: string) => { deleting.release(); await finishDelete.promise; return del(key); };
            remote.get = async (key: string) => { const value = await get(key); entered.release(); await finishRead.promise; return value; };
            const clearing = cache.del('key'); await deleting.promise;
            const reading = cache.get('key'); await entered.promise;
            finishDelete.release(); await clearing; finishRead.release();
            assert.equal(await reading, 'old'); assert.equal(await local.get('key'), undefined);
        } finally { finishDelete.release(); finishRead.release(); destroy(); }
    });

    it('does not revoke another pending fill for an empty deletion batch', async () => {
        const { local, remote, cache, destroy } = caches();
        const entered = gate(), release = gate();
        try {
            await remote.set('key', 'old', 0);
            const get = remote.get.bind(remote);
            remote.get = async (key: string) => { const value = await get(key); entered.release(); await release.promise; return value; };
            const reading = cache.get('key'); await entered.promise;
            assert.equal(await cache.delMany([]), 0); release.release(); await reading;
            assert.equal(await local.get('key'), 'old');
        } finally { release.release(); destroy(); }
    });

    it('captures deletion keys before the caller can mutate its array', async () => {
        const { local, remote, cache, destroy } = caches();
        try {
            await cache.setMany({ one: 1, two: 2 }, 0);
            const keys = ['one'];
            const deleting = cache.delMany(keys);
            keys[0] = 'two'; keys.push('other');
            assert.equal(await deleting, 1);
            assert.equal(await local.get('one'), undefined); assert.equal(await remote.get('one'), undefined);
            assert.equal(await local.get('two'), 2); assert.equal(await remote.get('two'), 2);
        } finally { destroy(); }
    });

    it('retains L1 return values, remote error policies and publication counts', async () => {
        const { local, remote, cache, messages, destroy } = caches();
        try {
            remote.del = remote.delMany = remote.delPattern = async () => { throw new Error('remote offline'); };
            await local.set('key', 'old', 0); assert.equal(await cache.del('key'), true);
            assert.equal(await cache.del('key'), false);
            await local.setMany({ one: 1, two: 2 }, 0); assert.equal(await cache.delMany(['one', 'two', 'absent']), 2);
            await local.set('key', 'old', 0); assert.equal(await cache.delPattern('ke*'), 1);
            assert.deepEqual(messages.map((message) => message.type), ['delPattern']);
            await assert.rejects(cache.invalidateFromRemote('key', 'key'), /remote offline/);
            await assert.rejects(cache.invalidateFromRemote('pattern', 'ke*'), /remote offline/);
            assert.equal(messages.length, 1);
            local.del = async () => { throw new Error('local offline'); };
            await assert.rejects(cache.del('key'), /local offline/);
        } finally { destroy(); }
    });

    it('bypasses failed full clears until a successful clear and preserves L2', async () => {
        const { local, remote, cache, destroy } = caches();
        try {
            await local.set('key', 'stale', 0); await remote.set('key', 'fresh', 0);
            const clear = local.clear.bind(local);
            local.clear = async () => { throw new Error('clear failed'); };
            await assert.rejects(cache.clear(), /clear failed/);
            assert.equal(await cache.get('key'), 'fresh'); assert.equal(await local.get('key'), 'stale');
            local.clear = clear; await cache.clear();
            assert.equal(await cache.get('key'), 'fresh'); assert.equal(await local.get('key'), 'fresh');
        } finally { destroy(); }
    });

    it('rejects self-waiting deletion from a backfill and allows a later independent deletion', async () => {
        const { local, remote, cache, destroy } = caches();
        try {
            await remote.set('key', 'old', 0);
            const set = local.set.bind(local);
            local.set = async (...args: unknown[]) => {
                for (const kind of kinds) await assert.rejects(remove(cache, kind), { code: 'INVALID_OPERATION' });
                assert.equal(await cache.delMany([]), 0);
                return set(...args);
            };
            assert.equal(await cache.get('key'), 'old');
            assert.equal(await cache.del('key'), true); assert.equal(await local.get('key'), undefined);
        } finally { destroy(); }
    });

    it('drains pending key mutations before lifecycle cleanup', async () => {
        const { local, cache, destroy } = caches();
        const entered = gate(), release = gate();
        try {
            const del = local.del.bind(local);
            local.del = async (key: string) => { entered.release(); await release.promise; return del(key); };
            const deleting = cache.del('key'); await entered.promise;
            let cleaned = false;
            const cleanup = withMultiLevelBackfillCleanup(cache, async () => { cleaned = true; });
            await Promise.resolve(); await Promise.resolve(); assert.equal(cleaned, false);
            release.release(); await deleting; await cleanup; assert.equal(cleaned, true);
        } finally { release.release(); destroy(); }
    });

    for (const otherKind of ['no-remote', 'no-backfill', 'esm']) {
        it(`revokes shared-L1 tickets through a ${otherKind} deleting wrapper`, async () => {
            const { local, remote, cache, destroy } = caches();
            const entered = gate(), release = gate();
            try {
                const Constructor = otherKind === 'esm'
                    ? (await import(pathToFileURL(path.resolve(__dirname, '../../../dist/esm/index.mjs')).href)).MultiLevelCache
                    : MultiLevelCache;
                const other = new Constructor({ local, ...(otherKind === 'no-remote' ? {} : { remote }), backfillOnRemoteHit: false });
                await remote.set('key', 'old', 0);
                const get = remote.get.bind(remote);
                remote.get = async (key: string) => { const value = await get(key); entered.release(); await release.promise; return value; };
                const reading = cache.get('key'); await entered.promise;
                await other.del('key'); release.release(); await reading;
                assert.equal(await local.get('key'), undefined);
            } finally { release.release(); destroy(); }
        });
    }
});
