import { expectAssignable, expectType } from 'tsd';
import MonSQLize, {
    type CachedFunction,
    type CacheLike,
    type CacheSetOptions,
    type DistributedCacheInvalidatorStats,
    type MultiLevelInvalidationMessage,
    type RedisCacheAdapterOptions,
    type WithCacheOptions,
} from '../..';

const options: WithCacheOptions<(userId: string) => Promise<{ userId: string }>> = {
    ttl: 5_000,
    namespace: 'typed-cache',
    cache: new MonSQLize.MemoryCache(),
    keyBuilder: (...args: unknown[]) => `user:${String(args[0])}`,
    condition: (result) => result !== null,
    enableStats: true,
};

const cachedUser = MonSQLize.withCache(async (userId: string) => ({ userId }), options);
expectType<CachedFunction<[string], { userId: string }>>(cachedUser);
expectType<Promise<{ userId: string }>>(cachedUser('u1'));
expectType<Promise<void>>(cachedUser.invalidate('u1'));
expectType<Promise<void>>(cachedUser.invalidateAll());
expectAssignable<{ hits: number; misses: number; errors: number; hitRate: number }>(cachedUser.stats());

const runtime = new MonSQLize({
    type: 'mongodb',
    databaseName: 'typed-function-cache',
    cursorValueNormalizer: (_field, value) => value,
    cursorValueNormalizerVersion: 'identity:v1',
});
runtime.collection('events').findPage({ cursorValueNormalizerVersion: 'identity:v2' });
runtime.collection('events').prewarmBookmarks({ cursorValueNormalizer: (_field: string, value: unknown) => value, cursorValueNormalizerVersion: 'identity:v3' }, [2]);
expectType<DistributedCacheInvalidatorStats | null>(runtime.getDistributedCacheInvalidatorStats());

const functionCache = new MonSQLize.FunctionCache(runtime, {
    namespace: 'svc',
    ttl: 10_000,
});

expectType<Promise<void>>(functionCache.register('double', async (...args: unknown[]) => Number(args[0]) * 2, {
    ttl: 1_000,
    keyBuilder: (...args: unknown[]) => `double:${String(args[0])}`,
}));

expectType<Promise<unknown>>(functionCache.execute('double', 2));
expectType<Promise<void>>(functionCache.invalidate('double', 2));
expectType<Promise<number>>(functionCache.invalidatePattern('double:*'));
expectAssignable<
    | { hits: number; misses: number; errors: number; calls: number; totalTime: number; avgTime: number; hitRate: number }
    | Record<string, { hits: number; misses: number; errors: number; calls: number; totalTime: number; avgTime: number; hitRate: number }>
    | null
>(functionCache.getStats());
expectType<string[]>(functionCache.list());
functionCache.resetStats();
functionCache.clear();

const memoryCache = new MonSQLize.MemoryCache();
const taggedSetOptions: CacheSetOptions = { tags: ['typed'] };
memoryCache.set('typed:key', { ok: true }, 1000, taggedSetOptions);
expectType<number | null | undefined>(memoryCache.getRemainingTtl('typed:key'));
expectAssignable<Record<string, number | null>>(memoryCache.getRemainingTtlMany(['typed:key']));
const lockManager = { isLocked: (_key: string) => false };
memoryCache.setLockManager(lockManager);
expectType<typeof lockManager | null>(memoryCache.getLockManager());

const multiLevelCache = new MonSQLize.MultiLevelCache({ local: memoryCache });
multiLevelCache.setPublish((msg: MultiLevelInvalidationMessage) => {
    if (msg.type === 'invalidateTag') {
        expectType<string>(msg.tag);
    } else if (msg.type === 'delPattern') {
        expectType<string>(msg.pattern);
    } else {
        expectType<string>(msg.key);
    }
});
multiLevelCache.setLockManager(lockManager);

const redisOptions: RedisCacheAdapterOptions = { scanCount: 50, deleteCommand: 'unlink' };
const redisCache = MonSQLize.createRedisCacheAdapter({ scan: () => ['0', []] }, redisOptions);
expectAssignable<CacheLike>(redisCache);


