import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { normalizeRuntimeCacheWithLifecycle } from '../../../src/entry/runtime-cache-normalizer';
import { createCacheFacade } from '../../../src/capabilities/cache/cache-facade';
const CJS = require('../../../dist/cjs/index.cjs');
const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

const specialKeys = ['ordinary', 'toString', 'constructor', 'hasOwnProperty', 'valueOf', '__proto__'];
const entries = Object.fromEntries(specialKeys.map((key, index) => [key, [{ n: 1 }, null, false, 0, '', 'proto'][index]]));
function gate() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    return { promise, release };
}
function adapterView(base: any, frozen = true): any {
    const adapter: any = {};
    for (const name of ['get', 'getMany', 'set', 'setMany', 'del', 'delMany', 'delPattern', 'exists', 'has', 'clear', 'keys', 'getStats', 'invalidateByTag']) {
        adapter[name] = function (...args: any[]) { assert.equal(this, adapter); return base[name](...args); };
    }
    Object.defineProperty(adapter, 'marker', { enumerable: true, configurable: true, get() { assert.equal(this, adapter); return 7; } });
    return frozen ? Object.freeze(adapter) : adapter;
}

describe('review cache adapter and own-key contracts', { timeout: 10000 }, () => {
    for (const remoteEnabled of [false, true]) {
        for (const backfill of [false, true]) {
            it(`accepts frozen own-method L1 adapters (remote=${remoteEnabled}, backfill=${backfill})`, async () => {
                const local = new CJS.MemoryCache({ cleanupInterval: 0 });
                const remote = new CJS.MemoryCache({ cleanupInterval: 0 });
                const raw = adapterView(local);
                const descriptor = Object.getOwnPropertyDescriptor(raw, 'get');
                const cache = new CJS.MultiLevelCache({ local: raw, remote: remoteEnabled ? remote : undefined, backfillOnRemoteHit: backfill });
                try {
                    await cache.set('own', 'value');
                    assert.equal(await cache.get('own'), 'value');
                    assert.deepEqual(await cache.getMany(['own']), { own: 'value' });
                    await remote.set('remote', 'hit', 0);
                    assert.equal(await cache.get('remote'), remoteEnabled ? 'hit' : undefined);
                    assert.equal(local.get('remote'), remoteEnabled && backfill ? 'hit' : undefined);
                    await cache.del('own'); await cache.clear();
                    assert.equal(raw.marker, 7);
                    assert.deepEqual(Object.getOwnPropertyDescriptor(raw, 'get'), descriptor);
                } finally { cache.destroy(); local.destroy(); remote.destroy(); }
            });
        }
    }

    it('preserves private receivers, configurable writes, reflection and absent optional methods', async () => {
        class Raw {
            #value = 5;
            get value() { return this.#value; }
            get() { return this.#value; }
        }
        const raw = new Raw();
        const view = createCacheFacade(raw, {});
        assert.equal(view.value, 5); assert.equal(view.get(), 5);
        Object.defineProperty(view, 'label', { value: 'x', configurable: true, enumerable: true });
        assert.deepEqual(Object.keys(view), ['label']);
        assert.throws(() => Object.defineProperty(view, 'blocked', { value: 1 }));
        assert.equal(hasOwn(raw, 'blocked'), false);
        const base = new CJS.MemoryCache({ cleanupInterval: 0 });
        const legacy = adapterView(base, false); delete legacy.has;
        const adapted = CJS.adaptLegacyCacheLike(Object.freeze(legacy));
        try {
            await adapted.set('legacy', 1);
            assert.equal(await adapted.has('legacy'), true); assert.equal('has' in adapted, true);
            assert.equal(adapted.getRemainingTtl, undefined);
        } finally { base.destroy(); }
    });

    for (const prefix of ['', 'tenant:']) {
        it(`wraps a frozen remote without inventing TTL or close ownership (${prefix || 'default TTL'})`, async () => {
            const local = new CJS.MemoryCache({ cleanupInterval: 0 });
            const remote = new CJS.MemoryCache({ cleanupInterval: 0 });
            const raw = adapterView(remote);
            const normalized = normalizeRuntimeCacheWithLifecycle({ memory: local, redis: { cache: raw, prefix, defaultTtl: 40000 } });
            try {
                await normalized.cache.set('key', 4, undefined, { tags: ['group'] });
                assert.equal(remote.get(`${prefix}key`), 4);
                await local.clear();
                assert.deepEqual(await normalized.cache.getMany(['key']), { key: 4 });
                await normalized.close?.();
                assert.equal(remote.get(`${prefix}key`), 4);
            } finally { await normalized.close?.(); local.destroy(); remote.destroy(); }
        });
    }

    for (const multi of [false, true]) {
        it(`returns only own hits for prototype keys (multi=${multi})`, async () => {
            const local = new CJS.MemoryCache({ cleanupInterval: 0 });
            const remote = new CJS.MemoryCache({ cleanupInterval: 0 });
            const cache = multi ? new CJS.MultiLevelCache({ local, remote }) : local;
            try {
                assert.equal(await cache.setMany(entries, 20000), true);
                if (multi) local.clear();
                const result = await cache.getMany(specialKeys);
                assert.equal(Object.getPrototypeOf(result), Object.prototype);
                for (const key of specialKeys) {
                    assert.equal(hasOwn(result, key), true);
                    assert.deepEqual(result[key], await cache.get(key));
                    assert.ok(hasOwn(local.getRemainingTtlMany([key]), key));
                }
                await cache.clear(); if (multi) remote.clear();
                const misses = await cache.getMany(specialKeys);
                for (const key of specialKeys) assert.equal(hasOwn(misses, key), false);
            } finally { if (multi) cache.destroy(); local.destroy(); remote.destroy(); }
        });
    }

    it('preserves MemoryCache validation, duplicate statistics and input-order LRU', () => {
        const cache = new CJS.MemoryCache({ cleanupInterval: 0, maxEntries: 2 });
        try {
            cache.set('__proto__', 'p'); cache.set('a', 'a'); cache.resetStats();
            assert.deepEqual(cache.getMany(['__proto__', '__proto__']), Object.fromEntries([['__proto__', 'p']]));
            assert.equal(cache.getStats().hits, 2);
            const hits = cache.getStats().hits;
            assert.throws(() => cache.getMany(['__proto__', '']), TypeError);
            assert.equal(cache.getStats().hits, hits);
            cache.getMany(['__proto__', 'a']); cache.set('c', 'c');
            assert.equal(cache.has('__proto__'), false); assert.equal(cache.has('a'), true);
        } finally { cache.destroy(); }
    });

    it('retains Redis own-key values, TTLs and the original injected client', async () => {
        const state = new Map<string, string>(), ttl = new Map<string, number>();
        const redis = {
            get: async (key: string) => state.get(key) ?? null,
            mget: async (...keys: string[]) => keys.map((key) => state.get(key) ?? null),
            pttl: async (key: string) => ttl.get(key) ?? -2,
            set: async (key: string, value: string) => { state.set(key, value); ttl.set(key, -1); },
            pipeline() {
                const tasks: Array<() => unknown> = [];
                const pipeline = {
                    set(key: string, value: string, _mode?: string, milliseconds?: number) {
                        tasks.push(() => { state.set(key, value); ttl.set(key, milliseconds ?? -1); return [null, 'OK']; }); return pipeline;
                    },
                    pttl(key: string) { tasks.push(() => [null, ttl.get(key) ?? -2]); return pipeline; },
                    async exec() { return tasks.map((task) => task()); },
                };
                return pipeline;
            },
        };
        const cache = CJS.createRedisCacheAdapter(redis);
        await cache.setMany(entries, 20000);
        const values = await cache.getMany(specialKeys), ttls = await cache.getRemainingTtlMany(specialKeys);
        assert.equal(Object.getPrototypeOf(values), Object.prototype);
        for (const key of specialKeys) {
            assert.equal(hasOwn(values, key), true); assert.deepEqual(values[key], await cache.get(key));
            assert.equal(hasOwn(ttls, key), true); assert.equal(ttls[key], 20000);
        }
        ttl.set('__proto__', -1);
        assert.equal((await cache.getRemainingTtlMany(['__proto__'])).__proto__, null);
        state.delete('__proto__'); ttl.delete('__proto__');
        assert.equal(hasOwn(await cache.getMany(['__proto__']), '__proto__'), false);
        assert.equal(hasOwn(await cache.getRemainingTtlMany(['__proto__']), '__proto__'), false);
        assert.equal(cache.getRedisInstance(), redis);
        await cache.close();
    });

    for (const behavior of ['empty', 'mixed', 'throw', 'missing']) {
        it(`keeps special-batch TTL semantics (${behavior})`, async () => {
            const local = new CJS.MemoryCache({ cleanupInterval: 0, defaultTtl: 40000 });
            const remote = new CJS.MemoryCache({ cleanupInterval: 0 });
            let batches = 0, singles = 0, reads = 0;
            const read = remote.getMany.bind(remote);
            remote.getMany = (keys: string[]) => { reads++; return read(keys); };
            remote.getRemainingTtlMany = behavior === 'missing' ? undefined : () => {
                batches++; if (behavior === 'throw') throw new Error('batch TTL failed');
                return behavior === 'empty' ? {} : Object.fromEntries([['__proto__', null]]);
            };
            remote.getRemainingTtl = () => { singles++; return 20000; };
            const cache = new CJS.MultiLevelCache({ local, remote });
            try {
                remote.setMany(Object.fromEntries([['__proto__', 'p'], ['toString', 's']]));
                const result = await cache.getMany(['__proto__', 'toString']);
                assert.equal(reads, 1); assert.equal(result.__proto__, 'p'); assert.equal(result.toString, 's');
                assert.equal(batches, behavior === 'missing' ? 0 : 1);
                assert.equal(singles, behavior === 'throw' || behavior === 'missing' ? 2 : 0);
                assert.equal(local.has('__proto__'), behavior !== 'empty');
                assert.equal(local.has('toString'), behavior === 'throw' || behavior === 'missing');
                if (behavior === 'mixed') assert.equal(local.getRemainingTtl('__proto__'), null);
            } finally { cache.destroy(); local.destroy(); remote.destroy(); }
        });
    }

    for (const phase of ['value', 'ttl']) {
        it(`shares frozen L1 revocation between CJS and ESM during special-key ${phase} reads`, async () => {
            const ESM = await import(pathToFileURL(path.join(process.cwd(), 'dist/esm/index.mjs')).href);
            const local = new CJS.MemoryCache({ cleanupInterval: 0 });
            const raw = adapterView(local);
            const remote = new CJS.MemoryCache({ cleanupInterval: 0 });
            const entered = gate(), finish = gate();
            const read = remote.getMany.bind(remote);
            remote.getMany = async (keys: string[]) => {
                const result = read(keys);
                if (phase === 'value') { entered.release(); await finish.promise; }
                return result;
            };
            remote.getRemainingTtlMany = async (keys: string[]) => {
                if (phase === 'ttl') { entered.release(); await finish.promise; }
                return Object.fromEntries(keys.map((key) => [key, 20000]));
            };
            const first = new CJS.MultiLevelCache({ local: raw, remote });
            const second = new ESM.MultiLevelCache({ local: raw, remote });
            try {
                remote.setMany(Object.fromEntries([['__proto__', 'old'], ['toString', 'old']]));
                const reading = first.getMany(['__proto__', 'toString']); await entered.promise;
                await second.delMany(['__proto__', 'toString']);
                finish.release(); const result = await reading;
                assert.equal(result.__proto__, 'old'); assert.equal(result.toString, 'old');
                assert.equal(local.has('__proto__'), false); assert.equal(local.has('toString'), false);
            } finally { finish.release(); first.destroy(); second.destroy(); local.destroy(); remote.destroy(); }
        });
    }

    for (const failure of ['reject', 'timeout', 'setter']) {
        it(`preserves special-batch degradation and stops failed backfills (${failure})`, async () => {
            const local = new CJS.MemoryCache({ cleanupInterval: 0 });
            const remote = new CJS.MemoryCache({ cleanupInterval: 0 });
            const read = remote.getMany.bind(remote);
            let pending: Promise<void> | undefined, sets = 0;
            if (failure === 'reject') remote.getMany = () => { throw new Error('read failure'); };
            if (failure === 'timeout') remote.getMany = async (keys: string[]) => {
                pending = new Promise((resolve) => setTimeout(resolve, 30)); await pending; return read(keys);
            };
            if (failure === 'setter') local.set = () => { sets++; throw new Error('set failure'); };
            remote.setMany(Object.fromEntries([['__proto__', 'p'], ['toString', 's']]));
            const cache = new CJS.MultiLevelCache({ local, remote, remoteTimeoutMs: 5 });
            try {
                const result = await cache.getMany(['__proto__', 'toString']);
                assert.equal(hasOwn(result, '__proto__'), failure === 'setter');
                assert.equal(sets, failure === 'setter' ? 1 : 0);
                await pending;
            } finally { cache.destroy(); local.destroy(); remote.destroy(); }
        });
    }
});
