import { withCacheReads } from '../../../core/cache-coordination';
import { Collection, Document } from 'mongodb';

import { MemoryCache } from '../../../capabilities/cache';
import type { QueryCacheLike, RuntimeDefaults } from '../../../types/internal/query';
import type { TotalsInfo, TotalsOptions } from '../../../../types/collection';
import {
    buildCollectionCacheNamespace,
    buildCountDriverOptions,
    hasSessionOption,
    isCollectionCacheBarrierActive,
    stableCacheKeyString,
} from './query-helpers';
import { hashPayload } from './find-page-cache-helpers';

function buildTotalsCacheKey<TSchema extends Document>(
    collection: Collection<TSchema>,
    defaults: RuntimeDefaults,
    query: Document,
    limit: number,
    totals: TotalsOptions,
    countOptions: Record<string, unknown>,
): { key: string; token: string } {
    const payload = {
        query,
        limit,
        mode: totals.mode ?? 'sync',
        countOptions,
    };
    const token = hashPayload(stableCacheKeyString(payload));
    const namespace = buildCollectionCacheNamespace(collection, defaults);
    return { key: `findPageTotals:${namespace}:v4:${token}`, token };
}

function getPositiveTtl(value: number | undefined, fallback: number): number {
    return typeof value === 'number' && value > 0 ? value : fallback;
}

const _asyncTotalsCache = new MemoryCache({
    maxEntries: 10_000,
    enableStats: false,
});
const _totalsInflight = new Map<string, Promise<void>>();

function runTotalsOnce(key: string, task: () => Promise<void>): void {
    if (_totalsInflight.has(key)) {
        return;
    }
    const promise = task()
        .catch(() => { /* failures are cached by the task itself */ })
        .finally(() => {
            _totalsInflight.delete(key);
        });
    _totalsInflight.set(key, promise);
}

async function executeComputeTotals<TSchema extends Document = Document>(
    coll: Collection<TSchema>,
    query: Document,
    limit: number,
    totals: TotalsOptions,
    defaults: RuntimeDefaults = {},
    queryCache?: QueryCacheLike | null,
    driverOptions: Record<string, unknown> = {},
): Promise<TotalsInfo> {
    const mode = (totals.mode ?? 'sync') as TotalsInfo['mode'];
    const cacheBarrierActive = queryCache
        ? await isCollectionCacheBarrierActive(queryCache, coll, defaults)
        : false;
    const cacheEnabled = !hasSessionOption(driverOptions) && !cacheBarrierActive;
    const cache = cacheEnabled ? queryCache ?? _asyncTotalsCache : null;
    const ttlMs = getPositiveTtl(totals.ttlMs, 10 * 60_000);

    const buildCountOptions = (fallbackMaxTimeMS: number): Record<string, unknown> => {
        const countOpts: Record<string, unknown> = {
            ...(buildCountDriverOptions(driverOptions) as Record<string, unknown>),
        };
        const maxTimeMS = totals.maxTimeMS ?? fallbackMaxTimeMS;
        if (maxTimeMS !== undefined) {
            countOpts.maxTimeMS = maxTimeMS;
        }
        if (totals.hint !== undefined) {
            countOpts.hint = totals.hint;
        }
        if (totals.collation !== undefined) {
            countOpts.collation = totals.collation;
        }
        return countOpts;
    };

    const countOpts = buildCountOptions(2000);
    const { session: _session, signal: _signal, ...keyCountOptions } = countOpts;
    void _session; void _signal;
    const { key: cacheKey, token } = buildTotalsCacheKey(coll, defaults, query, limit, totals, keyCountOptions);

    const countWithOptions = async (): Promise<number> => {
        const countQuery = query as Parameters<Collection<TSchema>['countDocuments']>[0];
        const runner = () => coll.countDocuments(
            countQuery,
            countOpts as Parameters<Collection<TSchema>['countDocuments']>[1],
        );
        return defaults.countQueue ? defaults.countQueue.execute(runner) : runner();
    };

    const buildPayload = (total: number, approx = false): TotalsInfo => ({
        mode,
        total,
        totalPages: total > 0 ? Math.ceil(total / limit) : 0,
        ts: Date.now(),
        ...(approx ? { approx: true } as Record<string, unknown> : {}),
    });

    const buildFailurePayload = (error: string): TotalsInfo => ({
        mode,
        total: null,
        totalPages: null,
        ts: Date.now(),
        error,
    });

    if (mode === 'sync') {
        if (cache) {
            const cached = await Promise.resolve(cache.get(cacheKey)) as TotalsInfo | undefined;
            if (cached !== undefined) {
                return { ...cached, mode: 'sync' };
            }
        }
        try {
            const payload = buildPayload(await countWithOptions());
            await Promise.resolve(cache?.set(cacheKey, payload, ttlMs));
            return { ...payload, mode: 'sync' };
        } catch {
            const payload = buildFailurePayload('count_failed');
            await Promise.resolve(cache?.set(cacheKey, payload, ttlMs));
            return { ...payload, mode: 'sync' };
        }
    }

    if (mode === 'async') {
        if (!cache) {
            return { mode: 'async', total: null, token };
        }
        const cached = await Promise.resolve(cache.get(cacheKey)) as TotalsInfo | undefined;
        if (cached !== undefined) {
            return { ...cached, mode: 'async', token };
        }
        setImmediate(() => {
            runTotalsOnce(cacheKey, () => withCacheReads(cache, async cache => {
                await cache.get(cacheKey);
                try {
                    const payload = buildPayload(await countWithOptions());
                    await Promise.resolve(cache.set(cacheKey, payload, ttlMs));
                } catch {
                    await Promise.resolve(cache.set(cacheKey, buildFailurePayload('count_failed'), ttlMs));
                }
            }));
        });
        return { mode: 'async', total: null, token };
    }

    if (mode === 'approx') {
        if (cache) {
            const cached = await Promise.resolve(cache.get(cacheKey)) as TotalsInfo | undefined;
            if (cached !== undefined) {
                return { ...cached, mode: 'approx' };
            }
        }
        try {
            const total = Object.keys(query ?? {}).length > 0 || hasSessionOption(driverOptions)
                ? await countWithOptions()
                : await coll.estimatedDocumentCount({
                    maxTimeMS: totals.maxTimeMS ?? 1000,
                } as Parameters<Collection<TSchema>['estimatedDocumentCount']>[0]);
            const payload = buildPayload(total, true);
            await Promise.resolve(cache?.set(cacheKey, payload, ttlMs));
            return { ...payload, mode: 'approx' };
        } catch {
            const payload = buildFailurePayload('approx_failed');
            await Promise.resolve(cache?.set(cacheKey, payload, ttlMs));
            return { ...payload, mode: 'approx' };
        }
    }

    return { mode: mode ?? 'sync' };
}

export function computeTotals<TSchema extends Document = Document>(
    coll: Collection<TSchema>, query: Document, limit: number, totals: TotalsOptions,
    defaults: RuntimeDefaults = {}, queryCache?: QueryCacheLike | null,
    driverOptions: Record<string, unknown> = {},
): Promise<TotalsInfo> {
    const cache = queryCache ?? _asyncTotalsCache;
    return withCacheReads(cache, guarded => executeComputeTotals(coll, query, limit, totals, defaults, guarded, driverOptions));
}
