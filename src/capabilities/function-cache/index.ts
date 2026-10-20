/**
 * Function cache capability.
 *
 * Full v1-compatible implementation that uses cache-hub's MemoryCache as the
 * default storage and stableStringify for deterministic key generation.
 *
 * Behaviors added over cache-hub's withCache/FunctionCache:
 *   - Strict param validation (fn, ttl, keyBuilder, condition, cache)
 *   - Graceful degradation when keyBuilder or cache.get throws
 *   - Undefined-safe value wrapping ({ v: result })
 *   - Stats.calls/totalTime/avgTime fields for v1 response parity
 *   - getCacheStats() v1 backward-compat alias for stats()
 *   - FunctionCache param validation (constructor, register, invalidate, invalidatePattern)
 *   - FunctionCache.enableStats option
 *   - FunctionCache.defaultTTL constructor alias
 */

import { MemoryCache } from 'cache-hub';
import type { CacheLike } from 'cache-hub';
import {
    FunctionCache as HubFunctionCache,
    withCache as hubWithCache,
    type FunctionCacheStats as HubFunctionCacheStats,
    type WithCacheStats as HubWithCacheStats,
    type WrappedFunction as HubWrappedFunction,
} from 'cache-hub/function-cache';
import { createError, ErrorCodes } from '../../core/errors';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface WithCacheStats {
    hits: number;
    misses: number;
    errors: number;
    calls: number;
    totalTime: number;
    avgTime: number;
    hitRate: number;
}

export interface FunctionCacheStats {
    hits: number;
    misses: number;
    errors: number;
    calls: number;
    totalTime: number;
    avgTime: number;
    hitRate: number;
}

export interface WithCacheOptions<
    T extends (...args: any[]) => Promise<any> = (...args: unknown[]) => Promise<unknown>,
> {
    ttl?: number;
    namespace?: string;
    keyBuilder?: (...args: Parameters<T>) => string;
    condition?: (result: Awaited<ReturnType<T>>) => boolean;
    cache?: CacheLike;
    enableStats?: boolean;
}

export type CachedFunction<
    TArgs extends unknown[] = unknown[],
    TResult = unknown,
> = HubWrappedFunction<(...args: TArgs) => Promise<TResult>> & {
    /** v1 backward-compat alias for stats(). */
    getCacheStats(): WithCacheStats;
    stats(): WithCacheStats;
};

export interface FunctionCacheOptions {
    namespace?: string;
    ttl?: number;
    /** @deprecated v1 alias for `ttl`. Use `ttl` instead. */
    defaultTTL?: number;
    enableStats?: boolean;
}

export interface FunctionCachePerFnOptions {
    namespace?: string;
    ttl?: number;
    defaultTTL?: number;
    keyBuilder?: (...args: unknown[]) => string;
    condition?: (result: unknown) => boolean;
}

function isValidCache(cache: unknown): cache is CacheLike {
    return (
        cache !== null &&
        typeof cache === 'object' &&
        typeof (cache as Record<string, unknown>).get === 'function' &&
        typeof (cache as Record<string, unknown>).set === 'function'
    );
}

type FunctionCacheSource = CacheLike | { getCache(): CacheLike } | undefined;

function resolveCacheSource(cacheOrDb: FunctionCacheSource): CacheLike {
    if (cacheOrDb === undefined) {
        return new MemoryCache();
    }
    if (isValidCache(cacheOrDb)) {
        return cacheOrDb;
    }

    const getCache = (cacheOrDb as { getCache?: () => CacheLike }).getCache;
    if (typeof getCache === 'function') {
        const cache = getCache.call(cacheOrDb);
        if (isValidCache(cache)) {
            return cache;
        }
    }

    throw createError(ErrorCodes.CACHE_UNAVAILABLE, 'Invalid cache instance from MonSQLize');
}

function toWithCacheStats(stats: HubWithCacheStats, totalTime = 0): WithCacheStats {
    const calls = stats.hits + stats.misses;
    return { ...stats, calls, totalTime, avgTime: calls > 0 ? totalTime / calls : 0 };
}

function toFunctionCacheStats(stats: HubFunctionCacheStats, totalTime = 0): FunctionCacheStats {
    const calls = stats.hits + stats.misses;
    return { ...stats, calls, totalTime, avgTime: calls > 0 ? totalTime / calls : 0 };
}

function isHubFunctionCacheStats(
    stats: HubFunctionCacheStats | Record<string, HubFunctionCacheStats>,
): stats is HubFunctionCacheStats {
    return (
        typeof (stats as HubFunctionCacheStats).hits === 'number' &&
        typeof (stats as HubFunctionCacheStats).misses === 'number' &&
        typeof (stats as HubFunctionCacheStats).errors === 'number' &&
        typeof (stats as HubFunctionCacheStats).hitRate === 'number'
    );
}

function zeroWithCacheStats(): WithCacheStats {
    return { hits: 0, misses: 0, errors: 0, calls: 0, totalTime: 0, avgTime: 0, hitRate: 0 };
}

function normalizeFunctionCacheStats(
    stats: HubFunctionCacheStats | Record<string, HubFunctionCacheStats>,
    timings: ReadonlyMap<string, number>,
    name?: string,
): FunctionCacheStats | Record<string, FunctionCacheStats> {
    if (isHubFunctionCacheStats(stats)) {
        const totalTime = name ? timings.get(name) ?? 0 : Array.from(timings.values()).reduce((sum, value) => sum + value, 0);
        return toFunctionCacheStats(stats, totalTime);
    }

    const normalized: Record<string, FunctionCacheStats> = {};
    for (const [name, value] of Object.entries(stats)) {
        normalized[name] = toFunctionCacheStats(value, timings.get(name) ?? 0);
    }
    return normalized;
}

function validateFunctionCacheOptions(options?: FunctionCacheOptions): FunctionCacheOptions {
    if (
        options !== undefined &&
        (typeof options !== 'object' || options === null || Array.isArray(options))
    ) {
        throw createError(ErrorCodes.INVALID_ARGUMENT, 'options must be an object');
    }

    const opts = options ?? {};
    if (opts.namespace !== undefined && typeof opts.namespace !== 'string') {
        throw createError(ErrorCodes.INVALID_ARGUMENT, 'namespace must be a string');
    }

    const ttl = opts.ttl !== undefined ? opts.ttl : opts.defaultTTL;
    if (ttl !== undefined && (typeof ttl !== 'number' || Number.isNaN(ttl) || ttl < 0)) {
        throw createError(ErrorCodes.INVALID_ARGUMENT, 'defaultTTL must be a non-negative number');
    }

    return opts;
}

function validateFunctionCachePerFnOptions(options?: FunctionCachePerFnOptions): FunctionCachePerFnOptions {
    if (
        options !== undefined &&
        (typeof options !== 'object' || options === null || Array.isArray(options))
    ) {
        throw createError(ErrorCodes.INVALID_ARGUMENT, 'options must be an object');
    }

    const opts = options ?? {};
    if (opts.keyBuilder !== undefined && typeof opts.keyBuilder !== 'function') {
        throw createError(ErrorCodes.INVALID_ARGUMENT, 'keyBuilder must be a function');
    }
    if (opts.condition !== undefined && typeof opts.condition !== 'function') {
        throw createError(ErrorCodes.INVALID_ARGUMENT, 'condition must be a function');
    }

    const ttl = opts.ttl !== undefined ? opts.ttl : opts.defaultTTL;
    if (ttl !== undefined && (typeof ttl !== 'number' || Number.isNaN(ttl) || ttl < 0)) {
        throw createError(ErrorCodes.INVALID_ARGUMENT, 'defaultTTL must be a non-negative number');
    }

    return opts;
}

// ── withCache ──────────────────────────────────────────────────────────────────

export function withCache<TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => Promise<TResult>,
    options: WithCacheOptions<(...args: TArgs) => Promise<TResult>> = {},
): CachedFunction<TArgs, TResult> {
    if (typeof fn !== 'function') throw createError(ErrorCodes.INVALID_ARGUMENT, 'fn must be a function');

    const { ttl = 60000, namespace, keyBuilder, condition, cache: externalCache, enableStats = true } = options;

    if (typeof ttl !== 'number' || Number.isNaN(ttl) || ttl < 0)
        throw createError(ErrorCodes.INVALID_ARGUMENT, 'ttl must be a non-negative number');
    if (keyBuilder !== undefined && typeof keyBuilder !== 'function')
        throw createError(ErrorCodes.INVALID_ARGUMENT, 'keyBuilder must be a function');
    if (condition !== undefined && typeof condition !== 'function')
        throw createError(ErrorCodes.INVALID_ARGUMENT, 'condition must be a function');
    if (externalCache !== undefined && !isValidCache(externalCache))
        throw createError(ErrorCodes.CACHE_UNAVAILABLE, 'Invalid cache instance');

    const wrapped = hubWithCache(fn, {
        ttl,
        namespace: namespace ?? 'fn',
        keyBuilder,
        condition,
        cache: externalCache ?? new MemoryCache(),
        enableStats,
    }) as HubWrappedFunction<(...args: TArgs) => Promise<TResult>>;
    const baseStats = wrapped.stats.bind(wrapped);
    let totalTime = 0;

    const cachedFn = (async (...args: TArgs): Promise<TResult> => {
        const startTime = Date.now();
        try {
            return await wrapped(...args);
        } finally {
            if (enableStats) {
                totalTime += Date.now() - startTime;
            }
        }
    }) as CachedFunction<TArgs, TResult>;

    const getCacheStats = (): WithCacheStats => {
        if (!enableStats) return zeroWithCacheStats();
        return toWithCacheStats(baseStats(), totalTime);
    };

    cachedFn.getCacheStats = getCacheStats;
    cachedFn.stats = getCacheStats;
    cachedFn.invalidate = wrapped.invalidate.bind(wrapped);
    cachedFn.invalidateAll = wrapped.invalidateAll.bind(wrapped);
    return cachedFn;
}

// ── FunctionCache ──────────────────────────────────────────────────────────────

export class FunctionCache {
    private readonly _inner: HubFunctionCache;
    private readonly _enableStats: boolean;
    private readonly _totalTimes = new Map<string, number>();

    constructor(
        cacheOrDb?: FunctionCacheSource,
        options?: FunctionCacheOptions,
    ) {
        const opts = validateFunctionCacheOptions(options);
        const ttl = opts.ttl !== undefined ? opts.ttl : opts.defaultTTL;

        this._enableStats = opts.enableStats !== false;
        this._inner = new HubFunctionCache(resolveCacheSource(cacheOrDb), {
            namespace: opts.namespace ?? 'action',
            ttl: ttl !== undefined ? ttl : 60000,
        });
    }

    register(
        name: string,
        fn: (...args: unknown[]) => Promise<unknown>,
        options?: FunctionCachePerFnOptions,
    ): Promise<void> {
        if (!name || typeof name !== 'string')
            throw createError(ErrorCodes.INVALID_ARGUMENT, 'Function name must be a non-empty string');
        if (typeof fn !== 'function')
            throw createError(ErrorCodes.INVALID_ARGUMENT, 'fn must be a function');
        const opts = validateFunctionCachePerFnOptions(options);
        const ttl = opts.ttl !== undefined ? opts.ttl : opts.defaultTTL;

        this._inner.register(name, fn, {
            namespace: opts.namespace,
            ttl,
            keyBuilder: opts.keyBuilder,
            condition: opts.condition,
        });
        if (!this._totalTimes.has(name)) {
            this._totalTimes.set(name, 0);
        }
        return Promise.resolve();
    }

    async execute(name: string, ...args: unknown[]): Promise<unknown> {
        const startTime = Date.now();
        try {
            return await this._inner.execute(name, ...args);
        } finally {
            if (this._enableStats && this._totalTimes.has(name)) {
                this._totalTimes.set(name, (this._totalTimes.get(name) ?? 0) + Date.now() - startTime);
            }
        }
    }

    async invalidate(name: string, ...args: unknown[]): Promise<void> {
        if (!name || typeof name !== 'string') {
            throw createError(ErrorCodes.INVALID_ARGUMENT, 'Function name must be a non-empty string');
        }
        await this._inner.invalidate(name, ...args);
    }

    async invalidatePattern(pattern: string): Promise<number> {
        if (!pattern || typeof pattern !== 'string')
            throw createError(ErrorCodes.INVALID_ARGUMENT, 'Pattern must be a non-empty string');
        return this._inner.invalidatePattern(pattern);
    }

    list(): string[] {
        return this._inner.list();
    }

    clear(): void {
        this._inner.clear();
        this._totalTimes.clear();
    }

    getStats(name?: string): FunctionCacheStats | Record<string, FunctionCacheStats> | null {
        if (!this._enableStats) return null;
        return normalizeFunctionCacheStats(this._inner.getStats(name), this._totalTimes, name);
    }

    resetStats(name?: string): void {
        this._inner.resetStats(name);
        if (name) {
            this._totalTimes.set(name, 0);
        } else {
            for (const key of this._totalTimes.keys()) {
                this._totalTimes.set(key, 0);
            }
        }
    }
}
