import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const MonSQLize = require('../../../dist/cjs/index.cjs');

type CachePayload = {
    id: number;
    skip: boolean;
};

describe('P3-B function-cache', () => {
    it('B22 delegates exact and complete invalidation to the same customized wrapper', async () => {
        for (const enableStats of [true, false]) {
            let calls = 0;
            const cache = new MonSQLize.MemoryCache();
            cache.set('b22:external', 'keep');
            const cached = MonSQLize.withCache(async (id: number) => ({ id, call: ++calls }), {
                namespace: 'b22', keyBuilder: (id: number) => 'custom:' + id, cache, enableStats,
            });
            const one = await cached(1), two = await cached(2);
            assert.deepEqual(await cached(1), one);
            await cached.invalidate(1);
            assert.notDeepEqual(await cached(1), one);
            assert.deepEqual(await cached(2), two);
            await cached.invalidateAll();
            assert.notDeepEqual(await cached(2), two);
            assert.equal(cache.get('b22:external'), 'keep');
            assert.deepEqual(cached.getCacheStats(), cached.stats());
            if (!enableStats) assert.equal(cached.stats().calls, 0);
        }
    });

    it('withCache caches results and returns hit stats', async () => {
        let calls = 0;
        const cache = new MonSQLize.MemoryCache();
        const cached = MonSQLize.withCache((userId: string) => Promise.resolve().then(() => {
            calls += 1;
            return { userId, calls };
        }), {
            cache,
            namespace: 'user-profile',
            ttl: 1_000,
            enableStats: true,
        });

        const first = await cached('u1');
        const second = await cached('u1');
        const third = await cached('u2');
        const stats = cached.stats();

        assert.deepEqual(first, { userId: 'u1', calls: 1 });
        assert.deepEqual(second, { userId: 'u1', calls: 1 });
        assert.deepEqual(third, { userId: 'u2', calls: 2 });
        assert.equal(calls, 2);
        assert.equal(stats.hits >= 1, true);
        assert.equal(typeof stats.hitRate, 'number');
    });

    it('withCache supports keyBuilder / condition / concurrent dedupe', async () => {
        let calls = 0;
        const cached = MonSQLize.withCache(async (payload: CachePayload) => {
            calls += 1;
            await new Promise((resolve) => setTimeout(resolve, 20));
            return payload.skip ? null : { id: payload.id, calls };
        }, {
            namespace: 'custom',
            keyBuilder: (payload: CachePayload) => `id:${payload.id}`,
            condition: (result: unknown) => result !== null,
        });

        const [first, second] = await Promise.all([
            cached({ id: 1, skip: false }),
            cached({ id: 1, skip: false }),
        ]);
        const missOne = await cached({ id: 2, skip: true });
        const missTwo = await cached({ id: 2, skip: true });

        assert.deepEqual(first, { id: 1, calls: 1 });
        assert.deepEqual(second, { id: 1, calls: 1 });
        assert.equal(missOne, null);
        assert.equal(missTwo, null);
        assert.equal(calls, 3);
    });

    it('FunctionCache supports register/execute/invalidate/invalidatePattern/list/clear', async () => {
        const runtime = new MonSQLize({ type: 'mongodb', databaseName: 'function_cache_unit' });
        const functionCache = new MonSQLize.FunctionCache(runtime, {
            namespace: 'svc',
            ttl: 1_000,
        });

        let calls = 0;
        functionCache.register('getUser', (userId: string) => Promise.resolve().then(() => {
            calls += 1;
            return { userId, calls };
        }));

        const first = await functionCache.execute('getUser', 'u1');
        const second = await functionCache.execute('getUser', 'u1');
        await functionCache.invalidate('getUser', 'u1');
        const third = await functionCache.execute('getUser', 'u1');
        const stats = functionCache.getStats('getUser');

        assert.deepEqual(first, { userId: 'u1', calls: 1 });
        assert.deepEqual(second, { userId: 'u1', calls: 1 });
        assert.deepEqual(third, { userId: 'u1', calls: 2 });
        assert.deepEqual(functionCache.list(), ['getUser']);
        assert.equal(typeof stats.hitRate, 'number');

        await functionCache.invalidatePattern('getUser:*');
        functionCache.clear();
        assert.deepEqual(functionCache.list(), []);
    });
});
