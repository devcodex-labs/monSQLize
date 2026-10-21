import type { Collection, Document } from 'mongodb';
import { relatedCacheNamespaces } from '../../../core/cache-scope';
import { coordinateInvalidation } from '../../../core/cache-coordination';
import {
    clearCacheInvalidationBarrier,
} from '../../../core/cache-invalidation-barrier';
import type {
    CacheInvalidationEntry,
    CacheInvalidationIntent,
    CacheInvalidationOperation,
    QueryCacheLike,
    RuntimeDefaults,
    WriteCacheControlOptions,
} from '../../../types/internal/query';
import {
    buildPreparedAggregateCacheKey,
    buildCountCacheKey,
    buildDistinctCacheKey,
    buildFindByIdsCacheKey,
    buildFindCacheKey,
    buildFindOneByIdCacheKey,
    buildFindOneCacheKey,
    buildFindPageCacheKey,
} from '../queries/query-cache-keys';
import { prepareAggregatePipeline } from '../queries/aggregate-pipeline';

type AggregateWriteTarget = {
    dbName?: string;
    collectionName: string;
};

type TransactionInvalidator = {
    recordInvalidation(pattern: string): Promise<void> | void;
    recordCacheInvalidation?(intent: CacheInvalidationIntent): Promise<void> | void;
    recordWriteOperation?(): void;
};

type SessionWithTransaction = {
    inTransaction?: () => boolean;
    __monSQLizeTransaction?: TransactionInvalidator;
};

type ReadCacheOperation = CacheInvalidationOperation | string;

export function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function getTransactionInvalidator(options: unknown): TransactionInvalidator | null {
    if (!isRecord(options)) {
        return null;
    }
    const session = options.session as SessionWithTransaction | undefined;
    const transaction = session?.__monSQLizeTransaction;
    if (!transaction) {
        return null;
    }
    if (typeof session.inTransaction === 'function' && !session.inTransaction()) {
        return null;
    }
    return transaction;
}

export function recordTransactionWriteOperation(options: unknown): void {
    try {
        getTransactionInvalidator(options)?.recordWriteOperation?.();
    } catch {
        // Transaction write stats are derived metadata and must not turn a completed DB write into a failed write.
    }
}

function resolveCollectionTarget(value: unknown): AggregateWriteTarget | null {
    if (typeof value === 'string' && value.length > 0) {
        return { collectionName: value };
    }
    if (!isRecord(value)) {
        return null;
    }
    const coll = value['coll'] ?? value['collection'];
    if (typeof coll !== 'string' || coll.length === 0) {
        return null;
    }
    const db = value['db'];
    return {
        collectionName: coll,
        ...(typeof db === 'string' && db.length > 0 ? { dbName: db } : {}),
    };
}

export function resolveAggregateWriteTarget(pipeline: Document[]): AggregateWriteTarget | null {
    const lastStage = pipeline[pipeline.length - 1];
    if (!isRecord(lastStage)) {
        return null;
    }
    if (Object.prototype.hasOwnProperty.call(lastStage, '$out')) {
        return resolveCollectionTarget(lastStage['$out']);
    }
    if (!Object.prototype.hasOwnProperty.call(lastStage, '$merge')) {
        return null;
    }
    const mergeStage = lastStage['$merge'];
    if (typeof mergeStage === 'string') {
        return { collectionName: mergeStage };
    }
    return isRecord(mergeStage) ? resolveCollectionTarget(mergeStage['into']) : null;
}

function buildAccessorCacheNamespaces(
    dbName: string,
    collectionName: string,
    defaults: RuntimeDefaults | undefined,
): string[] {
    return relatedCacheNamespaces(`${dbName}.${collectionName}`, defaults);
}

export function buildReadCacheInvalidationPatterns(
    dbName: string,
    collectionName: string,
    defaults: RuntimeDefaults | undefined,
    operation?: ReadCacheOperation,
): string[] {
    const namespaces = buildAccessorCacheNamespaces(dbName, collectionName, defaults);
    const bookmarkNamespaces = relatedCacheNamespaces(`${dbName}:${collectionName}`, defaults);
    const legacyNamespacePatterns = !defaults?.cacheScope && defaults?.namespace?.instanceId
        ? [`${defaults.namespace.instanceId}:mongodb:${dbName}:${collectionName}:*`]
        : [];
    const forNamespaces = (prefix: string) => namespaces.map((namespace) => `${prefix}:${namespace}:*`);
    const findPagePatterns = [
        ...forNamespaces('findPage'),
        ...forNamespaces('findPageTotals'),
        ...bookmarkNamespaces.map(namespace => `${namespace}:bm:*`),
    ];
    const aggregatePatterns = forNamespaces('aggregate');
    const distinctPatterns = forNamespaces('distinct');
    const patterns = operation === 'find'
        ? forNamespaces('find')
        : operation === 'findOne'
            ? forNamespaces('findOne')
            : operation === 'count'
                ? forNamespaces('count')
                : operation === 'findPage'
                    ? findPagePatterns
                    : operation === 'findOneById'
                        ? forNamespaces('findOneById')
                        : operation === 'findByIds'
                            ? forNamespaces('findByIds')
                    : operation === 'aggregate'
                        ? aggregatePatterns
                        : operation === 'distinct'
                            ? distinctPatterns
                            : [
                                ...forNamespaces('find'),
                                ...forNamespaces('findOne'),
                                ...forNamespaces('count'),
                                ...forNamespaces('findOneById'),
                                ...forNamespaces('findByIds'),
                                ...findPagePatterns,
                                ...aggregatePatterns,
                                ...distinctPatterns,
                            ];
    patterns.push(...legacyNamespacePatterns);
    return patterns;
}

function isKnownOperation(value: string): value is CacheInvalidationOperation {
    return [
        'find',
        'findOne',
        'count',
        'findPage',
        'aggregate',
        'distinct',
        'findOneById',
        'findByIds',
        'all',
    ].includes(value);
}

function getExplicitInvalidate(value: unknown): unknown {
    if (!isRecord(value)) {
        return undefined;
    }
    const cacheOptions = value.cache;
    if (!isRecord(cacheOptions)) {
        return undefined;
    }
    return Object.prototype.hasOwnProperty.call(cacheOptions, 'invalidate')
        ? cacheOptions.invalidate
        : undefined;
}

function isExplicitNoopInvalidate(value: unknown): boolean {
    return value === false || (Array.isArray(value) && value.length === 0);
}

function getWriteCacheControl(value: unknown): WriteCacheControlOptions {
    if (!isRecord(value)) {
        return {};
    }
    const cache = isRecord(value.cache) ? value.cache : undefined;
    return {
        ...(typeof value.autoInvalidate === 'boolean' ? { autoInvalidate: value.autoInvalidate } : {}),
        ...(cache ? {
            cache: {
                ...(typeof cache.autoInvalidate === 'boolean' ? { autoInvalidate: cache.autoInvalidate } : {}),
                ...(Object.prototype.hasOwnProperty.call(cache, 'invalidate')
                    ? { invalidate: cache.invalidate as NonNullable<WriteCacheControlOptions['cache']>['invalidate'] }
                    : {}),
            },
        } : {}),
    };
}

function patternsToIntents(patterns: string[]): CacheInvalidationIntent[] {
    return patterns.map((value) => ({ type: 'pattern', value }));
}

function uniqueIntents(intents: CacheInvalidationIntent[]): CacheInvalidationIntent[] {
    const seen = new Set<string>();
    const output: CacheInvalidationIntent[] = [];
    for (const intent of intents) {
        const key = `${intent.type}:${intent.value}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        output.push(intent);
    }
    return output;
}

function linkedQueryKeyIntents(key: string, defaults: RuntimeDefaults | undefined): CacheInvalidationIntent[] {
    const scopes = defaults?.relatedCacheScopes?.();
    return scopes && defaults?.cacheScope
        ? scopes.map(scope => ({ type: 'key', value: key.replace(`:${defaults.cacheScope}:`, `:${scope}:`) }))
        : [{ type: 'key', value: key }];
}

function entryToIntents<TSchema extends Document>(
    collection: Collection<TSchema>,
    dbName: string,
    collectionName: string,
    defaults: RuntimeDefaults | undefined,
    entry: CacheInvalidationEntry,
): CacheInvalidationIntent[] {
    if (typeof entry === 'string') {
        if (isKnownOperation(entry)) {
            return patternsToIntents(buildReadCacheInvalidationPatterns(dbName, collectionName, defaults, entry));
        }
        return [{ type: entry.includes('*') ? 'pattern' : 'key', value: entry }];
    }
    if (!isRecord(entry)) {
        return [];
    }
    const intents: CacheInvalidationIntent[] = [];
    if (typeof entry.cacheKey === 'string' && entry.cacheKey.length > 0) {
        intents.push({ type: 'key', value: entry.cacheKey });
    }
    if (Array.isArray(entry.cacheKeys)) {
        for (const key of entry.cacheKeys) {
            if (typeof key === 'string' && key.length > 0) {
                intents.push({ type: 'key', value: key });
            }
        }
    }
    if (typeof entry.pattern === 'string' && entry.pattern.length > 0) {
        intents.push({ type: 'pattern', value: entry.pattern });
    }
    if (Array.isArray(entry.patterns)) {
        for (const pattern of entry.patterns) {
            if (typeof pattern === 'string' && pattern.length > 0) {
                intents.push({ type: 'pattern', value: pattern });
            }
        }
    }
    if (intents.length > 0) {
        return intents;
    }

    const operation = entry.operation ?? entry.op;
    if (typeof operation !== 'string') {
        return [];
    }

    const descriptorOptions = isRecord(entry.options) ? entry.options : undefined;
    if (operation === 'find') {
        if (entry.query !== undefined || descriptorOptions !== undefined) {
            return linkedQueryKeyIntents(buildFindCacheKey(collection, defaults, entry.query, descriptorOptions), defaults);
        }
    } else if (operation === 'findOne') {
        if (entry.query !== undefined || descriptorOptions !== undefined) {
            return linkedQueryKeyIntents(buildFindOneCacheKey(collection, defaults, entry.query, descriptorOptions), defaults);
        }
    } else if (operation === 'count') {
        if (entry.query !== undefined || descriptorOptions !== undefined) {
            return linkedQueryKeyIntents(buildCountCacheKey(collection, defaults, entry.query, descriptorOptions), defaults);
        }
    } else if (operation === 'distinct') {
        if (typeof entry.field === 'string' && entry.field.length > 0) {
            return linkedQueryKeyIntents(buildDistinctCacheKey(collection, defaults, entry.field, entry.query, descriptorOptions), defaults);
        }
    } else if (operation === 'aggregate') {
        if (Array.isArray(entry.pipeline) || descriptorOptions !== undefined) {
            let prepared: Document[];
            try {
                prepared = prepareAggregatePipeline(entry.pipeline, defaults);
            } catch {
                // A bad best-effort descriptor must not reject a write that already succeeded.
                return [];
            }
            return linkedQueryKeyIntents(buildPreparedAggregateCacheKey(collection, defaults, prepared, descriptorOptions), defaults);
        }
    } else if (operation === 'findPage') {
        const findPageOptions = isRecord(entry.options)
            ? { ...entry.options }
            : {};
        if (entry.query !== undefined && findPageOptions.query === undefined) {
            findPageOptions.query = entry.query;
        }
        return linkedQueryKeyIntents(buildFindPageCacheKey(collection, defaults, findPageOptions as never).key, defaults);
    } else if (operation === 'findOneById') {
        if (entry.id !== undefined) {
            return linkedQueryKeyIntents(buildFindOneByIdCacheKey(collection, defaults, entry.id, descriptorOptions), defaults);
        }
    } else if (operation === 'findByIds') {
        if (Array.isArray(entry.ids)) {
            const keys = linkedQueryKeyIntents(buildFindByIdsCacheKey(collection, defaults, entry.ids, descriptorOptions), defaults);
            return keys.flatMap(intent => [intent, { type: 'pattern' as const, value: `${intent.value}:model:*` }]);
        }
    }

    return patternsToIntents(buildReadCacheInvalidationPatterns(dbName, collectionName, defaults, operation));
}

function resolveExplicitInvalidationIntents<TSchema extends Document>(
    collection: Collection<TSchema>,
    dbName: string,
    collectionName: string,
    defaults: RuntimeDefaults | undefined,
    invalidate: unknown,
): CacheInvalidationIntent[] {
    if (invalidate === true) {
        return patternsToIntents(buildReadCacheInvalidationPatterns(dbName, collectionName, defaults, 'all'));
    }
    const entries = Array.isArray(invalidate) ? invalidate : [invalidate];
    return uniqueIntents(entries.flatMap((entry) =>
        entryToIntents(collection, dbName, collectionName, defaults, entry as CacheInvalidationEntry),
    ));
}

export function resolveWriteCacheInvalidationIntents<TSchema extends Document>(
    collection: Collection<TSchema>,
    dbName: string,
    collectionName: string,
    defaults: RuntimeDefaults | undefined,
    options?: unknown,
): CacheInvalidationIntent[] {
    const explicitInvalidate = getExplicitInvalidate(options);
    if (isExplicitNoopInvalidate(explicitInvalidate)) {
        return [];
    }
    if (explicitInvalidate !== undefined) {
        return resolveExplicitInvalidationIntents(collection, dbName, collectionName, defaults, explicitInvalidate);
    }

    const control = getWriteCacheControl(options);
    const autoInvalidate = control.cache?.autoInvalidate === true
        || control.autoInvalidate === true
        || defaults?.cacheAutoInvalidate === true;
    return autoInvalidate
        ? patternsToIntents(buildReadCacheInvalidationPatterns(dbName, collectionName, defaults, 'all'))
        : [];
}

async function deleteCacheKey(queryCache: QueryCacheLike, key: string): Promise<number> {
    if (typeof queryCache.del === 'function') {
        const deleted = await Promise.resolve(queryCache.del(key));
        return Number(deleted === true ? 1 : deleted || 0);
    }
    if (typeof queryCache.delete === 'function') {
        const deleted = await Promise.resolve(queryCache.delete(key));
        return Number(deleted === true ? 1 : deleted || 0);
    }
    return 0;
}

export async function applyCacheInvalidationIntents(
    queryCache: QueryCacheLike | null | undefined,
    intents: CacheInvalidationIntent[],
): Promise<number> {
    if (!queryCache || intents.length === 0) {
        return 0;
    }
    return coordinateInvalidation(queryCache, intents, async () => {
        let deleted = 0;
        for (const intent of uniqueIntents(intents)) {
            if (intent.type === 'pattern') {
                deleted += Number(await Promise.resolve(queryCache.delPattern?.(intent.value) ?? 0));
            } else {
                deleted += await deleteCacheKey(queryCache, intent.value);
            }
        }
        return deleted;
    });
}

export async function invalidateReadCachesForNamespace(
    queryCache: QueryCacheLike | null | undefined,
    dbName: string,
    collectionName: string,
    defaults: RuntimeDefaults | undefined,
    operation?: ReadCacheOperation,
): Promise<number> {
    if (!queryCache?.delPattern) {
        return 0;
    }
    return applyCacheInvalidationIntents(queryCache, patternsToIntents(buildReadCacheInvalidationPatterns(dbName, collectionName, defaults, operation)));
}

export async function prepareReadCachesBeforeWrite(
    queryCache: QueryCacheLike | null | undefined,
    dbName: string,
    collectionName: string,
    defaults: RuntimeDefaults | undefined,
    options?: unknown,
): Promise<void> {
    void queryCache;
    void dbName;
    void collectionName;
    void defaults;
    void options;
}

export async function clearReadCacheBarrierAfterWrite(
    queryCache: QueryCacheLike | null | undefined,
    dbName: string,
    collectionName: string,
    defaults: RuntimeDefaults | undefined,
    options?: unknown,
): Promise<void> {
    if (getTransactionInvalidator(options) || !queryCache) {
        return;
    }
    await clearCacheInvalidationBarrier(queryCache, buildAccessorCacheNamespaces(dbName, collectionName, defaults));
}

export async function invalidateReadCachesAfterWrite<TSchema extends Document>(
    queryCache: QueryCacheLike | null | undefined,
    collection: Collection<TSchema>,
    dbName: string,
    collectionName: string,
    defaults: RuntimeDefaults | undefined,
    options?: unknown,
): Promise<number> {
    const intents = resolveWriteCacheInvalidationIntents(collection, dbName, collectionName, defaults, options);
    const transaction = getTransactionInvalidator(options);
    if (transaction) {
        for (const intent of intents) {
            if (transaction.recordCacheInvalidation) {
                await transaction.recordCacheInvalidation(intent);
            } else if (intent.type === 'pattern') {
                await transaction.recordInvalidation(intent.value);
            }
        }
        return intents.length;
    }
    // An ended managed transaction has already committed or discarded its intents.
    const session = isRecord(options) ? options.session as SessionWithTransaction | undefined : undefined;
    if (session?.__monSQLizeTransaction) return 0;
    const deleted = await applyCacheInvalidationIntents(queryCache, intents);
    await clearReadCacheBarrierAfterWrite(queryCache, dbName, collectionName, defaults, options);
    return deleted;
}
