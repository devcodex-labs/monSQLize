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
import { createBackfillFence, registerBackfillFence, type BackfillFence } from './multi-level-backfill-fence';
import { createCacheFacade } from './cache-facade';
import { getManyWithOwnKeys, needsOwnKeyBatch } from './multi-level-own-key-batch';

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

import type { CacheLike, CacheSetOptions, LockManager as CacheLockLike } from 'cache-hub';

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
    private readonly _backfillFence: BackfillFence;
    private readonly _localCompat: CacheLike;
    private readonly _remoteCompat: CacheLike | undefined;
    private readonly _publishRef: { current?: PublishFn };
    private readonly _compatBatchOptions: { backfill: boolean; timeoutMs: number };

    constructor(options: MultiLevelCacheOptions) {
        const publishRef: { current?: PublishFn } = { current: options.publish };
        const fence = createBackfillFence(options.local, !!options.remote && options.backfillOnRemoteHit !== false);
        super({
            ...options,
            local: fence.local,
            publish: (msg) => publishRef.current?.(msg),
        });
        this._backfillFence = fence;
        registerBackfillFence(this, fence);
        this._localCompat = options.local;
        this._remoteCompat = options.remote;
        this._publishRef = publishRef;
        this._compatBatchOptions = {
            backfill: options.backfillOnRemoteHit ?? true,
            timeoutMs: options.remoteTimeoutMs ?? 50,
        };
    }

    override get<T = any>(key: string): Promise<T | undefined> {
        return this._backfillFence.read(() => super.get<T>(key));
    }

    override getMany(keys: string[]): ReturnType<BaseMultiLevelCache['getMany']> {
        return this._backfillFence.read(() => needsOwnKeyBatch(keys)
            ? getManyWithOwnKeys(this._backfillFence.local, this._remoteCompat, keys, this._compatBatchOptions)
            : super.getMany(keys));
    }

    override set(key: string, value: unknown, ttl?: number, options?: CacheSetOptions): Promise<void> {
        return this._backfillFence.write(() => super.set(key, value, ttl, options));
    }

    override setMany(entries: Record<string, unknown>, ttl?: number): Promise<boolean> {
        return this._backfillFence.write(() => super.setMany(entries, ttl));
    }

    /** Deletes one key after revoking and draining older anonymous backfills. */
    override del(key: string): Promise<boolean> {
        return this._backfillFence.mutate(() => super.del(key));
    }

    /** Preserves the L1 deletion count and the empty-batch fast path. */
    override delMany(keys: string[]): Promise<number> {
        const selectedKeys = [...keys];
        return selectedKeys.length === 0 ? super.delMany(selectedKeys) : this._backfillFence.mutate(() => super.delMany(selectedKeys));
    }

    /** Deletes matching keys without clearing unrelated L1 entries. */
    override delPattern(pattern: string): Promise<number> {
        return this._backfillFence.mutate(() => super.delPattern(pattern));
    }

    /** Clears only L1 and prevents older remote reads from refilling it. */
    override clear(): Promise<void> {
        return this._backfillFence.mutate(() => super.clear(), true);
    }

    override invalidateByTag(tag: string): Promise<void> {
        return this._backfillFence.invalidate(() => super.invalidateByTag(tag));
    }

    override destroy(): void {
        this._backfillFence.revoke();
        super.destroy();
    }

    setPublish(publish: PublishFn): void {
        this._publishRef.current = publish;
    }

    setLockManager(lockManager: CacheLockLike): void {
        this._localCompat.setLockManager?.(lockManager);
        this._remoteCompat?.setLockManager?.(lockManager);
    }

    async invalidateFromRemote(kind: 'pattern' | 'key', value: string): Promise<void> {
        await this._backfillFence.mutate(async () => {
            if (kind === 'pattern') {
                await this._localCompat.delPattern(value);
                await this._remoteCompat?.delPattern(value);
            } else {
                await this._localCompat.del(value);
                await this._remoteCompat?.del(value);
            }
        });
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
    return createCacheFacade(v1Cache as CacheLike, {
        has(target, prop) { return prop === 'has' || Reflect.has(target, prop); },
        get(target, prop) {
            if (prop === 'has') {
                return (key: string) => target.exists(key);
            }
            const val = (target as unknown as Record<string | symbol, unknown>)[prop];
            return typeof val === 'function' ? val.bind(target) : val;
        },
    });
}
