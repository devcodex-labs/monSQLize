/**
 * Cache capability barrel file.
 *
 * Public cache capabilities are backed by `cache-hub`; selected root-entry
 * shims preserve published v1/v1.3 compatibility at the package boundary.
 */

export { MemoryCache } from './memory-cache';
export { createRedisCacheAdapter } from './redis-cache-adapter';
export { DistributedCacheInvalidator } from './distributed-cache-invalidator';
import { MultiLevelCache as BaseMultiLevelCache } from 'cache-hub';

export type {
    CacheLike,
    CacheSetOptions,
    CacheStats,
    LockManager as CacheLockLike,
    MemoryCacheOptions,
} from 'cache-hub';


export type {
    DistributedCacheInvalidatorOptions,
    DistributedCacheLike,
    DistributedLoggerLike,
    RedisPubSubLike,
} from './distributed-cache-invalidator';

import type { CacheLike, LockManager as CacheLockLike } from 'cache-hub';

type PublishMessage =
    | { type: 'del' | 'delete' | 'invalidateKey'; key: string; ts: number }
    | { type: 'delPattern'; pattern: string; ts: number }
    | { type: 'invalidateTag'; tag: string; ts: number };
type PublishFn = (msg: PublishMessage) => void;
type HubMultiLevelCacheOptions = ConstructorParameters<typeof BaseMultiLevelCache>[0];
type MultiLevelCacheOptions = Omit<HubMultiLevelCacheOptions, 'publish'> & {
    publish?: PublishFn;
};

export class MultiLevelCache extends BaseMultiLevelCache {
    private readonly _localCompat: CacheLike;
    private readonly _remoteCompat: CacheLike | undefined;
    private readonly _publishRef: { current?: PublishFn };

    constructor(options: MultiLevelCacheOptions) {
        const publishRef: { current?: PublishFn } = { current: options.publish };
        super({
            ...options,
            publish: (msg) => publishRef.current?.(msg),
        });
        this._localCompat = options.local;
        this._remoteCompat = options.remote;
        this._publishRef = publishRef;
    }

    setPublish(publish: PublishFn): void {
        this._publishRef.current = publish;
    }

    setLockManager(lockManager: CacheLockLike): void {
        this._localCompat.setLockManager?.(lockManager);
        this._remoteCompat?.setLockManager?.(lockManager);
    }

    async invalidateFromRemote(kind: 'pattern' | 'key', value: string): Promise<void> {
        if (kind === 'pattern') {
            await this._localCompat.delPattern(value);
            await this._remoteCompat?.delPattern(value);
        } else {
            await this._localCompat.del(value);
            await this._remoteCompat?.del(value);
        }
    }
}

/**
 * Adapts a v1-style CacheLike object to the v2 CacheLike interface.
 *
 * v2 requires a `has()` method (missing from v1 implementations).
 * This helper adds `has()` by delegating to the existing `exists()`.
 * All other methods are forwarded as-is.
 *
 * @example
 * ```ts
 * const v2Cache = adaptLegacyCacheLike(myV1Cache);
 * const msq = new MonSQLize({ cache: v2Cache });
 * ```
 */
export function adaptLegacyCacheLike(v1Cache: Omit<CacheLike, 'has'>): CacheLike {
    if ('has' in v1Cache && typeof (v1Cache as CacheLike).has === 'function') {
        return v1Cache as CacheLike;
    }
    return new Proxy(v1Cache as CacheLike, {
        get(target, prop) {
            if (prop === 'has') {
                return (key: string) => target.exists(key);
            }
            const val = (target as unknown as Record<string | symbol, unknown>)[prop];
            return typeof val === 'function' ? val.bind(target) : val;
        },
    });
}
