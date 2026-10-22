import type { Collection, Document } from 'mongodb';
import { getModelQueryFilter } from '../../../core/model-query-context';

import type {
    CacheInvalidationEntry,
    RuntimeDefaults,
} from '../../../types/internal/query';
import type { FindPageOptions } from '../../../../types/collection';
import { resolveCursorStrategy } from './cursor-strategy';
import { DEFAULT_FIND_PAGE_LIMIT, hashPayload } from './find-page-cache-helpers';
import { prepareAggregateExecution } from './aggregate-pipeline';
import {
    buildCollectionCacheNamespace,
    buildResultCacheKeyOptions,
    normalizeFindProjectionOptions,
    normalizeQueryFilter,
    normalizeSortShape,
    parseRequiredObjectId,
    stableCacheKeyString,
    snapshotResultOptions,
    snapshotFindPageOptions,
    snapshotReadInputs,
} from './query-helpers';

function normalizeQueryForCache(value: unknown, defaults: RuntimeDefaults = {}): unknown {
    const query = (value ?? {}) as Record<string, unknown>;
    const normalized = defaults.autoConvertObjectId
        ? normalizeQueryFilter(query, defaults.autoConvertObjectId)
        : query;
    return normalized;
}

function normalizeFindPageLimit(limit: number | undefined, defaults: RuntimeDefaults): number {
    const rawLimit = limit ?? DEFAULT_FIND_PAGE_LIMIT;
    if (defaults.findPageMaxLimit !== undefined && rawLimit > defaults.findPageMaxLimit) {
        return defaults.findPageMaxLimit;
    }
    return rawLimit;
}

function documentReadKey<TSchema extends Document>(
    operation: string, collection: Collection<TSchema>, defaults: RuntimeDefaults,
    query: unknown, options?: Record<string, unknown>, field?: string,
): string {
    const captured = snapshotReadInputs(normalizeQueryForCache(query, defaults), options, collection.bsonOptions);
    const keyOptions = buildResultCacheKeyOptions(captured.options, collection.bsonOptions);
    if (operation === 'count') delete keyOptions.fieldsAsRaw;
    const body = field === undefined ? stableCacheKeyString(captured.query, 'document')
        : stableCacheKeyString({ key: field, query: captured.query });
    return `${operation}:${buildCollectionCacheNamespace(collection, defaults)}:${body}:${stableCacheKeyString(keyOptions)}`;
}

export function buildFindCacheKey<TSchema extends Document = Document>(
    collection: Collection<TSchema>,
    defaults: RuntimeDefaults = {},
    query?: unknown,
    options?: Record<string, unknown>,
): string {
    return documentReadKey('find', collection, defaults, query, normalizeFindProjectionOptions({
        limit: defaults.findLimit,
        ...(options ?? {}),
    }));
}

export function buildFindOneCacheKey<TSchema extends Document = Document>(
    collection: Collection<TSchema>,
    defaults: RuntimeDefaults = {},
    query?: unknown,
    options?: Record<string, unknown>,
): string {
    return documentReadKey('findOne', collection, defaults, query, normalizeFindProjectionOptions(options));
}

export function buildCountCacheKey<TSchema extends Document = Document>(
    collection: Collection<TSchema>,
    defaults: RuntimeDefaults = {},
    query?: unknown,
    options?: Record<string, unknown>,
): string {
    return documentReadKey('count', collection, defaults, query, options);
}

export function buildDistinctCacheKey<TSchema extends Document = Document>(
    collection: Collection<TSchema>,
    defaults: RuntimeDefaults = {},
    field: string,
    query?: unknown,
    options?: Record<string, unknown>,
): string {
    return documentReadKey('distinct', collection, defaults, query, options, field);
}

export function buildAggregateCacheKey<TSchema extends Document = Document>(
    collection: Collection<TSchema>,
    defaults: RuntimeDefaults = {},
    pipeline?: unknown[],
    options?: Record<string, unknown>,
): string {
    const prepared = prepareAggregateExecution(pipeline, options, defaults, { ...collection.bsonOptions });
    return buildPreparedAggregateCacheKey(collection, defaults, prepared.pipeline, prepared.options);
}

/** Serializes the pipeline already used by the driver without repeating conversion or compilation. */
export function buildPreparedAggregateCacheKey<TSchema extends Document = Document>(
    collection: Collection<TSchema>,
    defaults: RuntimeDefaults = {},
    pipeline: unknown[] = [],
    options?: Record<string, unknown>,
): string {
    const namespace = buildCollectionCacheNamespace(collection, defaults);
    return `aggregate:${namespace}:prepared-v2:${stableCacheKeyString(pipeline, 'document')}:${stableCacheKeyString(buildResultCacheKeyOptions(options, collection.bsonOptions))}`;
}

export function buildFindOneByIdCacheKey<TSchema extends Document = Document>(
    collection: Collection<TSchema>,
    defaults: RuntimeDefaults = {},
    id: unknown,
    options?: Record<string, unknown>,
): string {
    const objectId = parseRequiredObjectId(id);
    const namespace = buildCollectionCacheNamespace(collection, defaults);
    const captured = snapshotResultOptions(options, collection.bsonOptions);
    return `findOneById:${namespace}:${objectId.toString()}:${stableCacheKeyString(buildResultCacheKeyOptions(captured, collection.bsonOptions))}`;
}

export function buildFindByIdsCacheKey<TSchema extends Document = Document>(
    collection: Collection<TSchema>,
    defaults: RuntimeDefaults = {},
    ids: unknown[],
    options?: Record<string, unknown>,
): string {
    const uniqueIds = Array.from(new Set(ids.map((id) => parseRequiredObjectId(id).toString())));
    const namespace = buildCollectionCacheNamespace(collection, defaults);
    const capturedOptions = snapshotResultOptions(normalizeFindProjectionOptions(options), collection.bsonOptions);
    const key = `findByIds:${namespace}:${hashPayload({ ids: uniqueIds, options: buildResultCacheKeyOptions(capturedOptions, collection.bsonOptions) })}`;
    const visibility = getModelQueryFilter(options);
    return visibility && Object.keys(visibility).length > 0
        ? `${key}:model:${hashPayload(stableCacheKeyString(visibility))}`
        : key;
}

export function buildFindPageCacheKey<TSchema extends Document = Document>(
    collection: Collection<TSchema>,
    defaults: RuntimeDefaults = {},
    options: FindPageOptions<TSchema> = {},
): { key: string; keyHash: string } {
    options = snapshotFindPageOptions(options, collection.bsonOptions);
    const ext = options as Record<string, unknown>;
    const cursorTypes = ext.cursorTypes && typeof ext.cursorTypes === 'object' && !Array.isArray(ext.cursorTypes)
        ? ext.cursorTypes as Record<string, unknown>
        : undefined;
    const { let: nestedLet, ...nestedOptions } = (options.options ?? {}) as Record<string, unknown>;
    const effectiveLet = ext.let !== undefined ? ext.let : nestedLet;
    const strategy = resolveCursorStrategy(ext, defaults);
    const payload = {
        query: normalizeQueryForCache(options.query, defaults),
        sort: normalizeSortShape(options.sort),
        limit: normalizeFindPageLimit(options.limit, defaults),
        page: options.page ?? 1,
        after: options.after,
        before: options.before,
        projection: normalizeFindProjectionOptions(options as Record<string, unknown>).projection,
        pipeline: options.pipeline ?? [],
        totals: options.totals,
        jump: options.jump,
        offsetJump: options.offsetJump,
        maxTimeMS: (ext.maxTimeMS as number | undefined) ?? defaults.maxTimeMS,
        cursorTypes: {
            ...(defaults.cursorTypes ?? {}),
            ...(cursorTypes ?? {}),
        },
        hasCursorValueNormalizer: typeof ext.cursorValueNormalizer === 'function'
            || typeof defaults.cursorValueNormalizer === 'function',
        cursorValueNormalizerVersion: strategy.cursorValueNormalizerVersion,
        hint: ext.hint,
        collation: ext.collation,
        batchSize: ext.batchSize,
        let: effectiveLet,
        options: nestedOptions,
    };
    const keyHash = hashPayload(stableCacheKeyString(payload));
    const namespace = buildCollectionCacheNamespace(collection, defaults);
    return { key: `findPage:${namespace}:${keyHash}`, keyHash };
}

export function isOperationInvalidationEntry(value: CacheInvalidationEntry): value is Exclude<CacheInvalidationEntry, string> {
    return typeof value === 'object' && value !== null && (
        'operation' in value
        || 'op' in value
        || 'cacheKey' in value
        || 'cacheKeys' in value
        || 'pattern' in value
        || 'patterns' in value
    );
}
