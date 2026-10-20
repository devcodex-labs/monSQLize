/**
 * Document lookup by _id (findOneById / findByIds).
 *
 * Responsibilities:
 * - Parse and validate ObjectId values (single and batch).
 * - Execute findOne / find $in queries.
 * - Support preserveOrder to return results in input order.
 *
 * Depends on query-helpers (parseRequiredObjectId, isHexObjectIdString).
 * Does not depend on FindChain to avoid circular references.
 */

import { readThroughCache } from '../../../core/cache-coordination';
import { getModelQueryFilter, MODEL_QUERY_FILTER } from '../../../core/model-query-context';
import { Collection, Document, FindOptions, ObjectId } from 'mongodb';
import { snapshotPipelineValue } from './pipeline-snapshot';

import { createError, ErrorCodes } from '../../../core/errors';
import type { QueryCacheLike, RuntimeDefaults } from '../../../types/internal/query';
import {
    buildFindDriverOptions,
    hasSessionOption,
    isCollectionCacheBarrierActive,
    isHexObjectIdString,
    normalizeFindProjectionOptions,
    parseRequiredObjectId,
} from './query-helpers';
import {
    buildFindByIdsCacheKey,
    buildFindOneByIdCacheKey,
} from './query-cache-keys';

function getCacheTtl(rawOptions: Record<string, unknown>): number {
    return typeof rawOptions.cache === 'number' && rawOptions.cache > 0 ? rawOptions.cache : 0;
}

type OrderedIdentityMode = 'native' | 'omit' | 'computed';

/** Carries a real identity only where native projection semantics can be preserved. */
function prepareOrderedIdentity(
    options: Record<string, unknown>,
    inherited: Collection['bsonOptions'] | undefined,
): OrderedIdentityMode {
    const unsupported = () => createError(ErrorCodes.INVALID_OPERATION,
        'preserveOrder cannot preserve this _id projection or raw/returnKey option. Use preserveOrder: false or include the original _id.');
    if (options.returnKey === true || (options.raw ?? inherited?.raw) === true) throw unsupported();
    // Pin the accepted decoding mode before any cache or driver await.
    options.raw = false;
    const projection = options.projection as Record<string, unknown> | undefined;
    if (!projection) return 'native';
    if (Object.keys(projection).some((key) => key.startsWith('_id.'))) throw unsupported();
    options.projection = projection;
    if (!Object.prototype.propertyIsEnumerable.call(projection, '_id')) return 'native';
    const value = projection._id;
    const bsonType = value && typeof value === 'object' ? (value as { _bsontype?: string })._bsontype : undefined;
    const numeric = typeof value === 'number' || typeof value === 'bigint'
        || (bsonType !== undefined && ['Int32', 'Long', 'Double', 'Decimal128'].includes(bsonType));
    if (typeof value === 'boolean' || numeric) {
        // Decimal128 may be nonzero below the smallest JS Number; test its coefficient exactly.
        const nativeValue = typeof value === 'bigint' ? BigInt.asIntN(64, value) : value;
        const excluded = value === false || (numeric && /^[+-]?0+(?:\.0*)?(?:e[+-]?\d+)?$/i.test(String(nativeValue)));
        if (!excluded) return 'native';
        // Removing the exclusion preserves both inclusion and exclusion projection modes.
        const captured = { ...projection };
        delete captured._id;
        options.projection = captured;
        return 'omit';
    }
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') throw unsupported();
    if (value !== null && typeof value === 'object' && !Array.isArray(value)
        && !bsonType && !(value instanceof Date) && !(value instanceof RegExp) && !(value instanceof Uint8Array)) {
        const keys = Object.keys(value);
        if (keys.length === 0 || keys.some((key) => !key.startsWith('$'))
            || keys.some((key) => ['$slice', '$elemMatch', '$meta', '$'].includes(key))) throw unsupported();
    }
    const fieldsAsRaw = (options.fieldsAsRaw ?? inherited?.fieldsAsRaw ?? {}) as Record<string, unknown>;
    const prototype = Object.getPrototypeOf(fieldsAsRaw);
    if (prototype !== Object.prototype && prototype !== null) throw unsupported();
    const capturedRawFields: Record<string, unknown> = Object.create(prototype);
    for (const key of Object.getOwnPropertyNames(fieldsAsRaw)) {
        Object.defineProperty(capturedRawFields, key, { value: fieldsAsRaw[key], enumerable: true, writable: true, configurable: true });
    }
    // BSON applies these names at every nesting depth, including envelope.value arrays.
    if (capturedRawFields._id || capturedRawFields.value) throw unsupported();
    capturedRawFields._id = false;
    capturedRawFields.value = false;
    options.fieldsAsRaw = capturedRawFields;
    options.projection = { ...projection, _id: { original: '$_id', value } };
    return 'computed';
}

/**
 * Finds a single document by `_id`.
 * Accepts a string, ObjectId, or any value convertible to an ObjectId.
 * @param collection - Target collection.
 * @param id - Document identifier.
 * @param options - Native driver `findOne` options.
 * @returns The matching document, or `null` if not found.
 * @since v1.0.0
 */
export async function findOneByIdDocument<TSchema extends Document = Document>(
    collection: Collection<TSchema>,
    id: unknown,
    options?: Parameters<Collection<TSchema>['findOne']>[1],
    defaults: RuntimeDefaults = {},
    queryCache?: QueryCacheLike | null,
): Promise<TSchema | null> {
    const objectId = parseRequiredObjectId(id);
    const rawOptions = (options ?? {}) as Record<string, unknown>;
    const baseOptions = normalizeFindProjectionOptions({
        ...(defaults.maxTimeMS !== undefined ? { maxTimeMS: defaults.maxTimeMS } : {}),
        ...rawOptions,
    });
    const findOptions = buildFindDriverOptions(baseOptions) as FindOptions;

    const cacheTTL = getCacheTtl(rawOptions);
    if (
        cacheTTL > 0
        && queryCache
        && !hasSessionOption(baseOptions)
        && !(await isCollectionCacheBarrierActive(queryCache, collection, defaults))
    ) {
        const cacheKey = buildFindOneByIdCacheKey(collection, defaults, objectId, baseOptions);
        return readThroughCache(queryCache, cacheKey, cacheTTL, () => collection.findOne(
            { _id: objectId } as Parameters<Collection<TSchema>['findOne']>[0],
            findOptions as Parameters<Collection<TSchema>['findOne']>[1],
        ) as unknown as Promise<TSchema | null>);
    }

    return collection.findOne(
        { _id: objectId } as Parameters<Collection<TSchema>['findOne']>[0],
        findOptions as Parameters<Collection<TSchema>['findOne']>[1],
    ) as unknown as Promise<TSchema | null>;
}

/**
 * Finds multiple documents by `_id`.
 * @param collection - Target collection.
 * @param ids - Array of document identifiers (string and ObjectId may be mixed).
 * @param options - Native driver `find` options; set `preserveOrder: true` to return results in input order.
 * @param defaults - Runtime-level defaults.
 * @returns Array of matching documents (order not guaranteed unless preserveOrder is enabled).
 * @since v1.0.0
 */
export async function findByIdsDocuments<TSchema extends Document = Document>(
    collection: Collection<TSchema>,
    ids: unknown[],
    options?: Parameters<Collection<TSchema>['find']>[1],
    defaults: RuntimeDefaults = {},
    queryCache?: QueryCacheLike | null,
): Promise<TSchema[]> {
    if (!Array.isArray(ids)) {
        throw createError(
            ErrorCodes.INVALID_ARGUMENT,
            'ids must be an array',
            [{ field: 'ids', type: 'type', message: 'ids must be an array', received: typeof ids }],
        );
    }

    if (ids.length === 0) {
        return [];
    }

    const objectIds: ObjectId[] = [];
    const invalidIds: Array<{ index: number; value: unknown; }> = [];

    for (const [index, id] of ids.entries()) {
        if (id instanceof ObjectId) {
            objectIds.push(id);
            continue;
        }

        if (typeof id === 'string' && isHexObjectIdString(id)) {
            objectIds.push(new ObjectId(id));
            continue;
        }

        if (id && typeof id === 'object' && typeof (id as { toHexString?: () => string; }).toHexString === 'function') {
            const hex = (id as { toHexString: () => string; }).toHexString();
            if (isHexObjectIdString(hex)) {
                objectIds.push(new ObjectId(hex));
                continue;
            }
        }

        invalidIds.push({ index, value: id });
    }

    if (invalidIds.length > 0) {
        throw createError(
            ErrorCodes.INVALID_ARGUMENT,
            `ids array contains ${invalidIds.length} invalid ID(s)`,
            invalidIds.map((item) => ({
                field: `ids[${item.index}]`,
                type: 'format',
                message: 'invalid ID',
                received: item.value,
            })),
        );
    }

    const uniqueIds = [...new Set(objectIds.map((item) => item.toString()))].map((item) => new ObjectId(item));
    const rawOptions = (options ?? {}) as Record<string, unknown>;
    const baseOptions = normalizeFindProjectionOptions({
        ...(defaults.maxTimeMS !== undefined ? { maxTimeMS: defaults.maxTimeMS } : {}),
        ...rawOptions,
    });
    const preserveOrder = baseOptions.preserveOrder === true;
    baseOptions.projection = snapshotPipelineValue(baseOptions.projection);
    const identityMode = preserveOrder ? prepareOrderedIdentity(baseOptions, collection.bsonOptions) : 'native';
    const driverOptions = buildFindDriverOptions(baseOptions);
    delete (driverOptions as Record<symbol, unknown>)[MODEL_QUERY_FILTER];
    const visibility = getModelQueryFilter(rawOptions);
    const idFilter = { _id: { $in: uniqueIds } };
    const filter = visibility && Object.keys(visibility).length > 0
        ? { $and: [idFilter, visibility] }
        : idFilter;

    const cacheTTL = getCacheTtl(rawOptions);
    const cacheKey = identityMode === 'native' && cacheTTL > 0
        && queryCache
        && (!visibility || Object.keys(visibility).length === 0 || typeof queryCache.delPattern === 'function')
        && !hasSessionOption(baseOptions)
        && !(await isCollectionCacheBarrierActive(queryCache, collection, defaults))
        ? buildFindByIdsCacheKey(collection, defaults, uniqueIds, baseOptions)
        : null;

    let results: TSchema[];
    if (cacheKey && queryCache) {
        results = await readThroughCache(queryCache, cacheKey, cacheTTL, () => collection.find(
            filter as Parameters<Collection<TSchema>['find']>[0], driverOptions as Parameters<Collection<TSchema>['find']>[1],
        ).toArray() as Promise<TSchema[]>);
    } else {
        results = await collection.find(
            filter as Parameters<Collection<TSchema>['find']>[0], driverOptions as Parameters<Collection<TSchema>['find']>[1],
        ).toArray() as TSchema[];
    }

    if (preserveOrder) {
        const resultMap = new Map<string, TSchema>();
        for (const doc of results) {
            const envelope = (doc as Record<string, unknown>)._id;
            const docId = identityMode === 'computed'
                ? (envelope as { original?: unknown } | null)?.original : envelope;
            let output = doc;
            if (identityMode !== 'native') {
                const copy: Record<string, unknown> = { ...doc };
                if (identityMode === 'computed' && envelope && Object.prototype.hasOwnProperty.call(envelope, 'value')) {
                    copy._id = (envelope as { value: unknown }).value;
                } else {
                    delete copy._id;
                }
                output = copy as TSchema;
            }
            if (docId instanceof ObjectId) {
                resultMap.set(docId.toString(), output);
            } else if (docId !== undefined && docId !== null) {
                resultMap.set(String(docId), output);
            }
        }
        return uniqueIds.map((item) => resultMap.get(item.toString())).filter((item): item is TSchema => item !== undefined);
    }

    return results;
}
