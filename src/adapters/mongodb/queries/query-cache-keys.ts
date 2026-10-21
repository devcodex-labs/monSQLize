import type { Collection, Document } from 'mongodb';
import { getModelQueryFilter } from '../../../core/model-query-context';

import type {
    CacheInvalidationEntry,
    RuntimeDefaults,
} from '../../../types/internal/query';
import type { FindPageOptions } from '../../../../types/collection';
import { resolveCursorStrategy } from './cursor-strategy';
import { convertObjectIdStrings } from '../utils/objectid-converter';
import { DEFAULT_FIND_PAGE_LIMIT, hashPayload } from './find-page-cache-helpers';
import { snapshotPipelineValue } from './pipeline-snapshot';
import { prepareAggregatePipeline } from './aggregate-pipeline';
import {
    buildCollectionCacheNamespace,
    buildResultCacheKeyOptions,
    normalizeFindProjectionOptions,
    normalizeQueryFilter,
    normalizeSortShape,
    parseRequiredObjectId,
    stableCacheKeyString,
} from './query-helpers';

function normalizeQueryForCache(value: unknown, defaults: RuntimeDefaults = {}): unknown {
    const query = (value ?? {}) as Record<string, unknown>;
    return defaults.autoConvertObjectId
        ? normalizeQueryFilter(query, defaults.autoConvertObjectId)
        : query;
}

function normalizePipelineForCache(pipeline: unknown[] | undefined, defaults: RuntimeDefaults = {}): unknown[] {
    const stages = Array.isArray(pipeline) ? pipeline : [];
    if (!defaults.autoConvertObjectId) {
        return stages;
    }
    return stages.map((stage) => convertObjectIdStrings(
        stage,
        '',
        0,
        new WeakSet(),
        defaults.autoConvertObjectId,
    ));
}

function normalizeFindPageLimit(limit: number | undefined, defaults: RuntimeDefaults): number {
    const rawLimit = limit ?? DEFAULT_FIND_PAGE_LIMIT;
    if (defaults.findPageMaxLimit !== undefined && rawLimit > defaults.findPageMaxLimit) {
        return defaults.findPageMaxLimit;
    }
    return rawLimit;
}

export function buildFindCacheKey<TSchema extends Document = Document>(
    collection: Collection<TSchema>,
    defaults: RuntimeDefaults = {},
    query?: unknown,
    options?: Record<string, unknown>,
): string {
    const executeOptions = normalizeFindProjectionOptions({
        ...(defaults.maxTimeMS !== undefined ? { maxTimeMS: defaults.maxTimeMS } : {}),
        ...(defaults.findLimit !== undefined ? { limit: defaults.findLimit } : {}),
        ...(options ?? {}),
    });
    const namespace = buildCollectionCacheNamespace(collection, defaults);
    return `find:${namespace}:${stableCacheKeyString(normalizeQueryForCache(query, defaults), 'document')}:${stableCacheKeyString(buildResultCacheKeyOptions(executeOptions))}`;
}

export function buildFindOneCacheKey<TSchema extends Document = Document>(
    collection: Collection<TSchema>,
    defaults: RuntimeDefaults = {},
    query?: unknown,
    options?: Record<string, unknown>,
): string {
    const executeOptions = normalizeFindProjectionOptions({
        ...(defaults.maxTimeMS !== undefined ? { maxTimeMS: defaults.maxTimeMS } : {}),
        ...(options ?? {}),
    });
    const namespace = buildCollectionCacheNamespace(collection, defaults);
    return `findOne:${namespace}:${stableCacheKeyString(normalizeQueryForCache(query, defaults), 'document')}:${stableCacheKeyString(buildResultCacheKeyOptions(executeOptions))}`;
}

export function buildCountCacheKey<TSchema extends Document = Document>(
    collection: Collection<TSchema>,
    defaults: RuntimeDefaults = {},
    query?: unknown,
    options?: Record<string, unknown>,
): string {
    const merged: Record<string, unknown> = {
        ...(defaults.maxTimeMS !== undefined ? { maxTimeMS: defaults.maxTimeMS } : {}),
        ...(options ?? {}),
    };
    const { cache: _cache, ...keyOptions } = merged;
    void _cache;
    const namespace = buildCollectionCacheNamespace(collection, defaults);
    return `count:${namespace}:${stableCacheKeyString(normalizeQueryForCache(query, defaults), 'document')}:${stableCacheKeyString(buildResultCacheKeyOptions(keyOptions))}`;
}

export function buildDistinctCacheKey<TSchema extends Document = Document>(
    collection: Collection<TSchema>,
    defaults: RuntimeDefaults = {},
    field: string,
    query?: unknown,
    options?: Record<string, unknown>,
): string {
    const rawOptions = options ?? {};
    const {
        meta: _meta,
        cache: _cache,
        explain: _explain,
        stream: _stream,
        preserveOrder: _preserveOrder,
        withDeleted: _withDeleted,
        onlyDeleted: _onlyDeleted,
        ...driverOptions
    } = rawOptions;
    void _meta;
    void _cache;
    void _explain;
    void _stream;
    void _preserveOrder;
    void _withDeleted;
    void _onlyDeleted;
    const namespace = buildCollectionCacheNamespace(collection, defaults);
    return `distinct:${namespace}:${stableCacheKeyString({ key: field, query: normalizeQueryForCache(query, defaults) })}:${stableCacheKeyString(buildResultCacheKeyOptions(driverOptions))}`;
}

export function buildAggregateCacheKey<TSchema extends Document = Document>(
    collection: Collection<TSchema>,
    defaults: RuntimeDefaults = {},
    pipeline?: unknown[],
    options?: Record<string, unknown>,
): string {
    return buildPreparedAggregateCacheKey(collection, defaults, prepareAggregatePipeline(pipeline, defaults), options);
}

/** Serializes the pipeline already used by the driver without repeating conversion or compilation. */
export function buildPreparedAggregateCacheKey<TSchema extends Document = Document>(
    collection: Collection<TSchema>,
    defaults: RuntimeDefaults = {},
    pipeline: unknown[] = [],
    options?: Record<string, unknown>,
): string {
    const executeOptions = {
        ...(defaults.maxTimeMS !== undefined ? { maxTimeMS: defaults.maxTimeMS } : {}),
        ...(options ?? {}),
    };
    const namespace = buildCollectionCacheNamespace(collection, defaults);
    return `aggregate:${namespace}:prepared-v1:${stableCacheKeyString(pipeline, 'document')}:${stableCacheKeyString(buildResultCacheKeyOptions(executeOptions))}`;
}

export function buildFindOneByIdCacheKey<TSchema extends Document = Document>(
    collection: Collection<TSchema>,
    defaults: RuntimeDefaults = {},
    id: unknown,
    options?: Record<string, unknown>,
): string {
    const objectId = parseRequiredObjectId(id);
    const namespace = buildCollectionCacheNamespace(collection, defaults);
    return `findOneById:${namespace}:${objectId.toString()}:${stableCacheKeyString(buildResultCacheKeyOptions(options ?? {}))}`;
}

export function buildFindByIdsCacheKey<TSchema extends Document = Document>(
    collection: Collection<TSchema>,
    defaults: RuntimeDefaults = {},
    ids: unknown[],
    options?: Record<string, unknown>,
): string {
    const uniqueIds = Array.from(new Set(ids.map((id) => parseRequiredObjectId(id).toString())));
    const namespace = buildCollectionCacheNamespace(collection, defaults);
    const capturedOptions = normalizeFindProjectionOptions(options ?? {});
    capturedOptions.projection = snapshotPipelineValue(capturedOptions.projection);
    // Native BSON result modes must never share entries (including inherited options).
    // This dimension also separates entries created before decoding options were keyed.
    const bson: Record<string, unknown> = {};
    for (const field of ['raw', 'useBigInt64', 'promoteLongs', 'promoteValues', 'promoteBuffers',
        'ignoreUndefined', 'bsonRegExp', 'serializeFunctions', 'enableUtf8Validation']) {
        bson[field] = options?.[field] ?? (collection.bsonOptions as unknown as Record<string, unknown> | undefined)?.[field];
    }
    const fieldsAsRaw = (options?.fieldsAsRaw ?? collection.bsonOptions?.fieldsAsRaw ?? {}) as Record<string, unknown>;
    const rawFieldNames = new Set<string>();
    for (let level = fieldsAsRaw; level; level = Object.getPrototypeOf(level)) {
        for (const field of Object.getOwnPropertyNames(level)) rawFieldNames.add(field);
    }
    bson.fieldsAsRaw = [...rawFieldNames].sort().map((field) => [field, Boolean(fieldsAsRaw[field])]);
    const key = `findByIds:${namespace}:${hashPayload({ ids: uniqueIds, options: buildResultCacheKeyOptions(capturedOptions), bson })}`;
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
        pipeline: normalizePipelineForCache(options.pipeline, defaults),
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
