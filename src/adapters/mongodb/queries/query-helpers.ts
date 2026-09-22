/**
 * Query operation helpers (cursor building, filter normalization, pagination, streaming, etc.).
 *
 * Extracted from the MongoCollectionAccessor query path to reduce main-file
 * complexity and enable independent testing.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import { BSON, Collection, Document, ObjectId, Sort } from 'mongodb';

import { createError, ErrorCodes } from '../../../core/errors';
import {
    isCacheInvalidationBarrierActive,
    type CacheInvalidationBarrierCache,
} from '../../../core/cache-invalidation-barrier';
import { normalizeProjection } from '../../../utils/normalize';
import type { CursorPayload, CursorValueNormalizationOptions, QueryCacheLike, RuntimeDefaults, SortShape } from '../../../types/internal/query';
import {
    normalizeObjectIdConversionOptions,
    shouldConvertObjectIdPath,
    type ObjectIdConversionOptions,
} from '../utils/objectid-converter';

/**
 * Internal query-layer helpers.
 *
 * Design goals:
 * - Centralize ObjectId / cursor / sort / projection cross-cutting logic from `queries/index.ts`.
 * - Preserve existing behavior exactly; structural refactor only.
 * - Pave the way for further splitting find / findPage into thin modules.
 */

/** Converts any MongoDB `Sort` input into a normalized `{ field: 1 | -1 }` map, always including `_id`. */
export function normalizeSortShape(sort?: Sort): SortShape {
    const normalized: SortShape = {};

    if (Array.isArray(sort)) {
        for (const [field, direction] of sort) {
            normalized[String(field)] = direction === -1 || direction === 'desc' || direction === 'descending' ? -1 : 1;
        }
    } else if (sort && typeof sort === 'object') {
        for (const [field, direction] of Object.entries(sort)) {
            normalized[field] = direction === -1 || direction === 'desc' || direction === 'descending' ? -1 : 1;
        }
    }

    if (!normalized._id) {
        normalized._id = 1;
    }

    return normalized;
}

/** Returns `true` if the string is a valid 24-character hexadecimal ObjectId. */
export function isHexObjectIdString(value: string): boolean {
    return /^[0-9a-fA-F]{24}$/.test(value);
}

/** Parses and validates an `id` value into an `ObjectId`, throwing `INVALID_ARGUMENT` on failure. */
export function parseRequiredObjectId(id: unknown): ObjectId {
    if (!id) {
        throw createError(
            ErrorCodes.INVALID_ARGUMENT,
            'id is required',
            [{ field: 'id', type: 'required', message: 'id must not be empty' }],
        );
    }

    if (typeof id === 'string') {
        if (!isHexObjectIdString(id)) {
            throw createError(
                ErrorCodes.INVALID_ARGUMENT,
                `invalid ObjectId format: "${id}"`,
                [{
                    field: 'id',
                    type: 'format',
                    message: 'id must be a 24-character hex string or ObjectId instance',
                    received: id,
                }],
            );
        }
        return new ObjectId(id);
    }

    if (id instanceof ObjectId) {
        return id;
    }

    if (id && typeof id === 'object' && typeof (id as { toHexString?: () => string }).toHexString === 'function') {
        const hex = (id as { toHexString: () => string }).toHexString();
        if (isHexObjectIdString(hex)) {
            return new ObjectId(hex);
        }
    }

    if (id && typeof id === 'object' && typeof (id as { toString?: () => string }).toString === 'function') {
        const value = (id as { toString: () => string }).toString();
        if (isHexObjectIdString(value)) {
            return new ObjectId(value);
        }
    }

    throw createError(
        ErrorCodes.INVALID_ARGUMENT,
        'id must be a string or ObjectId instance',
        [{
            field: 'id',
            type: 'type',
            message: `expected: string or ObjectId, received: ${typeof id}`,
            received: typeof id,
        }],
    );
}

/** Converts a 24-char hex string to `ObjectId` when `autoConvert` is enabled; otherwise returns the value unchanged. */
export function normalizeIdentifier(value: unknown, autoConvert = true): unknown {
    if (autoConvert && typeof value === 'string' && value.length === 24 && ObjectId.isValid(value)) {
        return new ObjectId(value);
    }

    return value;
}

function shouldConvertQueryField(autoConvert: ObjectIdConversionOptions, path: string, depth: number): boolean {
    const config = normalizeObjectIdConversionOptions(autoConvert);
    if (!config.enabled || depth > config.maxDepth) return false;
    return shouldConvertObjectIdPath(path, config);
}

function isPlainQueryRecord(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function normalizeQueryArray(
    value: unknown[],
    autoConvert: ObjectIdConversionOptions,
    path: string,
    depth: number,
): unknown[] {
    return value.map((item, index) => {
        if (typeof item === 'string' && item.length === 24 && ObjectId.isValid(item) && shouldConvertQueryField(autoConvert, path, depth)) {
            return new ObjectId(item);
        }
        if (isPlainQueryRecord(item)) {
            return normalizeQueryFilter(item, autoConvert, `${path}[${index}]`, depth + 1);
        }
        return item;
    });
}

const QUERY_OBJECTID_ARRAY_OPERATORS = new Set(['$in', '$nin', '$all']);
const QUERY_OBJECTID_SCALAR_OPERATORS = new Set(['$eq', '$ne', '$gt', '$gte', '$lt', '$lte']);

/**
 * Recursively normalizes a query filter, converting eligible 24-char hex strings to ObjectId.
 *
 * Notes:
 * - This is the query-path-specific filter normalizer.
 * - Unlike `utils/objectid-converter.ts` (general object traversal), this one preserves
 *   query operator semantics: $and/$or/$nor/$elemMatch/$in/$nin/$all/$eq/$ne/$gt/$gte/$lt/$lte.
 */
export function normalizeQueryFilter(
    filter: Record<string, unknown>,
    autoConvert: ObjectIdConversionOptions,
    fieldPath = '',
    depth = 0,
): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const autoConvertConfig = normalizeObjectIdConversionOptions(autoConvert);
    if (!autoConvertConfig.enabled || depth > autoConvertConfig.maxDepth) {
        return filter;
    }

    for (const [key, value] of Object.entries(filter)) {
        if (key === '$and' || key === '$or' || key === '$nor') {
            result[key] = Array.isArray(value)
                ? value.map((item) => isPlainQueryRecord(item)
                    ? normalizeQueryFilter(item, autoConvert, fieldPath, depth + 1)
                    : item)
                : value;
            continue;
        }

        const currentPath = fieldPath ? `${fieldPath}.${key}` : key;
        const shouldConvert = shouldConvertQueryField(autoConvert, currentPath, depth);

        if (typeof value === 'string' && value.length === 24 && ObjectId.isValid(value)) {
            result[key] = shouldConvert ? new ObjectId(value) : value;
        } else if (Array.isArray(value)) {
            result[key] = shouldConvert ? normalizeQueryArray(value, autoConvert, currentPath, depth + 1) : value;
        } else if (isPlainQueryRecord(value)) {
            const nested = value;
            const hasOperators = Object.keys(nested).some((k) => k.startsWith('$'));

            if (hasOperators) {
                const nestedResult: Record<string, unknown> = {};
                for (const [op, opVal] of Object.entries(nested)) {
                    if (shouldConvert && QUERY_OBJECTID_ARRAY_OPERATORS.has(op) && Array.isArray(opVal)) {
                        nestedResult[op] = opVal.map((item) =>
                            typeof item === 'string' && item.length === 24 && ObjectId.isValid(item)
                                ? new ObjectId(item)
                                : item,
                        );
                    } else if (shouldConvert && QUERY_OBJECTID_SCALAR_OPERATORS.has(op) && typeof opVal === 'string' && opVal.length === 24 && ObjectId.isValid(opVal)) {
                        nestedResult[op] = new ObjectId(opVal);
                    } else if (op === '$elemMatch' && isPlainQueryRecord(opVal)) {
                        nestedResult[op] = normalizeQueryFilter(opVal, autoConvert, currentPath, depth + 1);
                    } else {
                        nestedResult[op] = opVal;
                    }
                }
                result[key] = nestedResult;
            } else {
                result[key] = normalizeQueryFilter(nested, autoConvert, currentPath, depth + 1);
            }
        } else {
            result[key] = value;
        }
    }

    return result;
}

/** Encodes cursor values into a base64url token, optionally signing with an HMAC-SHA256 secret. */
export function encodeCursor(values: unknown[], secret?: string): string {
    const payload: CursorPayload = { v: 1, values };
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

    if (!secret) {
        return encoded;
    }

    const sig = createHmac('sha256', secret).update(encoded).digest('base64url');
    return `${encoded}.${sig}`;
}

/** Decodes and verifies a cursor token produced by `encodeCursor`; throws `INVALID_ARGUMENT` on tampering or malformed input. */
export function decodeCursor(cursor: string, secret?: string): unknown[] {
    try {
        let raw = cursor;

        if (secret) {
            const dotIndex = cursor.lastIndexOf('.');
            if (dotIndex === -1) {
                throw createError(ErrorCodes.INVALID_PAGINATION, 'Cursor signature missing.');
            }
            const encoded = cursor.slice(0, dotIndex);
            const sig = cursor.slice(dotIndex + 1);
            const expected = createHmac('sha256', secret).update(encoded).digest('base64url');
            const sigBuffer = Buffer.from(sig);
            const expectedBuffer = Buffer.from(expected);
            if (sigBuffer.length !== expectedBuffer.length || !timingSafeEqual(sigBuffer, expectedBuffer)) {
                throw createError(ErrorCodes.INVALID_PAGINATION, 'Cursor signature invalid.');
            }
            raw = encoded;
        }

        const payload = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as CursorPayload;
        if (payload?.v !== 1 || !Array.isArray(payload.values)) {
            throw createError(ErrorCodes.INVALID_ARGUMENT, 'Invalid cursor payload.');
        }
        return payload.values;
    } catch (cause) {
        if ((cause as { code?: string }).code === ErrorCodes.INVALID_PAGINATION) {
            throw cause;
        }
        throw createError(ErrorCodes.INVALID_PAGINATION, 'Invalid pagination cursor.', undefined, cause as Error);
    }
}

/** Inverts every sort direction in a `SortShape` (used to walk backward through a cursor page). */
export function reverseSort(sort: SortShape): SortShape {
    return Object.fromEntries(Object.entries(sort).map(([field, direction]) => [field, direction === 1 ? -1 : 1]));
}

/**
 * JSON round-tripping converts Date objects to ISO strings;
 * this function restores them before cursor comparison.
 */
export function normalizeCursorValue(
    value: unknown,
    field = '',
    options: CursorValueNormalizationOptions = {},
): unknown {
    if (typeof options.cursorValueNormalizer === 'function') {
        return options.cursorValueNormalizer(field, value);
    }

    const declaredType = field ? options.cursorTypes?.[field] : undefined;
    if (declaredType === 'raw' || declaredType === 'string') {
        return value;
    }
    if (declaredType === 'objectId') {
        return normalizeIdentifier(value);
    }
    if (declaredType === 'date') {
        if (value instanceof Date) return value;
        if (typeof value === 'string') {
            const d = new Date(value);
            return isNaN(d.getTime()) ? value : d;
        }
        return value;
    }
    if (declaredType === 'number') {
        if (typeof value === 'number') return value;
        if (typeof value === 'string' && value.trim() !== '') {
            const n = Number(value);
            return Number.isFinite(n) ? n : value;
        }
        return value;
    }
    if (declaredType === 'boolean') {
        if (typeof value === 'boolean') return value;
        if (value === 'true') return true;
        if (value === 'false') return false;
        return value;
    }

    if (typeof value === 'string') {
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value)) {
            const d = new Date(value);
            if (!isNaN(d.getTime())) {
                return d;
            }
        }
        return normalizeIdentifier(value);
    }
    return value;
}

const QUERY_CONTROL_OPTION_KEYS = new Set(['cache', 'explain', 'meta', 'stream', 'preserveOrder', 'withDeleted', 'onlyDeleted']);
const RESULT_CACHE_KEY_OPTION_FIELDS = [
    'projection',
    'sort',
    'skip',
    'limit',
    'hint',
    'collation',
    'readConcern',
    'readPreference',
    'min',
    'max',
    'returnKey',
    'showRecordId',
    'tailable',
    'awaitData',
    'noCursorTimeout',
    'allowDiskUse',
    'let',
];

function stripControlOptions(options: Record<string, unknown> = {}): Record<string, unknown> {
    const driverOptions = { ...options };
    for (const key of QUERY_CONTROL_OPTION_KEYS) {
        delete driverOptions[key];
    }
    return driverOptions;
}

export function resolveProjectionOption(options: Record<string, unknown> = {}): string[] | Record<string, unknown> | null | undefined {
    return (options.projection ?? options.project) as string[] | Record<string, unknown> | null | undefined;
}

export function normalizeFindProjectionOptions(options: Record<string, unknown> = {}): Record<string, unknown> {
    const driverOptions = { ...options };
    const projection = normalizeProjection(resolveProjectionOption(driverOptions));
    delete driverOptions.projection;
    delete driverOptions.project;
    if (projection !== undefined) {
        driverOptions.projection = projection;
    }
    return driverOptions;
}

export function getValueByPath(source: unknown, path: string): unknown {
    if (!path) {
        return undefined;
    }
    let current = source;
    for (const segment of path.split('.')) {
        if (current === null || typeof current !== 'object') {
            return undefined;
        }
        current = (current as Record<string, unknown>)[segment];
    }
    return current;
}

export function getSortValues(source: unknown, sort: SortShape): unknown[] {
    return Object.keys(sort).map((field) => getValueByPath(source, field));
}

export function buildCollectionCacheNamespace<TSchema extends Document = Document>(
    collection: Collection<TSchema>,
    defaults: RuntimeDefaults = {},
): string {
    const namespace = (collection as unknown as { namespace?: string }).namespace ?? '';
    const instanceId = defaults.namespace?.instanceId;
    return instanceId ? `${instanceId}:${namespace}` : namespace;
}

export function buildCollectionCacheBarrierNamespaces<TSchema extends Document = Document>(
    collection: Collection<TSchema>,
    defaults: RuntimeDefaults = {},
): string[] {
    const namespace = (collection as unknown as { namespace?: string }).namespace ?? '';
    const scopedNamespace = buildCollectionCacheNamespace(collection, defaults);
    return scopedNamespace === namespace ? [namespace] : [scopedNamespace, namespace];
}

export async function isCollectionCacheBarrierActive<TSchema extends Document = Document>(
    queryCache: QueryCacheLike | null | undefined,
    collection: Collection<TSchema>,
    defaults: RuntimeDefaults = {},
): Promise<boolean> {
    return isCacheInvalidationBarrierActive(
        queryCache as CacheInvalidationBarrierCache | null | undefined,
        buildCollectionCacheBarrierNamespaces(collection, defaults),
    );
}

type CacheKeyMode = 'document' | 'options';

const ORDERED_OPTION_FIELDS = new Set(['query', 'filter', 'pipeline', 'sort', 'hint', 'projection', 'min', 'max']);

function normalizeCacheKeyValue(value: unknown, mode: CacheKeyMode): unknown {
    if (value === null) return ['null'];
    if (value === undefined) return ['undefined'];
    if (typeof value === 'number') return ['number', String(value)];
    if (typeof value === 'bigint') return ['bigint', value.toString()];
    if (typeof value !== 'object') return [typeof value, value];
    if (value instanceof Date) return ['date', String(value.getTime())];
    if (value instanceof RegExp) return ['regexp', value.source, value.flags];
    if (Array.isArray(value)) return ['array', value.map((item) => normalizeCacheKeyValue(item, mode))];
    const bsonType = (value as { _bsontype?: unknown })._bsontype;
    if (typeof bsonType === 'string') {
        return ['bson', bsonType, BSON.EJSON.serialize(value, { relaxed: false })];
    }
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined && typeof item !== 'function' && typeof item !== 'symbol');
    if (mode === 'options') entries.sort(([left], [right]) => left.localeCompare(right));
    return ['object', entries.map(([key, item]) => [
        key,
        normalizeCacheKeyValue(item, mode === 'options' && ORDERED_OPTION_FIELDS.has(key) ? 'document' : mode),
    ])];
}

export function stableCacheKeyString(value: unknown, mode: CacheKeyMode = 'options'): string {
    return `v2:${JSON.stringify(normalizeCacheKeyValue(value, mode))}`;
}

export function buildResultCacheKeyOptions(options: Record<string, unknown> = {}): Record<string, unknown> {
    const keyOptions: Record<string, unknown> = {};
    for (const field of RESULT_CACHE_KEY_OPTION_FIELDS) {
        if (options[field] !== undefined) {
            keyOptions[field] = options[field];
        }
    }
    return keyOptions;
}

export function hasSessionOption(options: Record<string, unknown> | undefined): boolean {
    return options?.session !== undefined;
}

/** Builds MongoDB driver `find` options, preserving native options while removing monSQLize control flags. */
export function buildFindDriverOptions<TSchema extends Document = Document>(
    options: Record<string, unknown> = {},
): Parameters<Collection<TSchema>['find']>[1] {
    return normalizeFindProjectionOptions(stripControlOptions(options)) as Parameters<Collection<TSchema>['find']>[1];
}

/** Builds MongoDB driver `aggregate` options, preserving native options while removing monSQLize control flags. */
export function buildAggregateDriverOptions<TSchema extends Document = Document>(
    options: Record<string, unknown> = {},
): Parameters<Collection<TSchema>['aggregate']>[1] {
    return stripControlOptions(options) as Parameters<Collection<TSchema>['aggregate']>[1];
}

/** Builds MongoDB driver `countDocuments` options, preserving native consistency options. */
export function buildCountDriverOptions<TSchema extends Document = Document>(
    options: Record<string, unknown> = {},
): Parameters<Collection<TSchema>['countDocuments']>[1] {
    const driverOptions = stripControlOptions(options);
    const allowed = new Set([
        'limit',
        'skip',
        'hint',
        'maxTimeMS',
        'collation',
        'comment',
        'session',
        'readConcern',
        'readPreference',
        'signal',
    ]);
    for (const key of Object.keys(driverOptions)) {
        if (!allowed.has(key)) {
            delete driverOptions[key];
        }
    }
    return driverOptions as Parameters<Collection<TSchema>['countDocuments']>[1];
}

/** Builds a MongoDB filter that selects documents strictly after or before the given cursor values. */
export function buildCursorFilter(
    sort: SortShape,
    cursorValues: unknown[],
    direction: 'after' | 'before',
    options: CursorValueNormalizationOptions = {},
): Document {
    const entries = Object.entries(sort);
    const clauses: Document[] = [];

    for (let index = 0; index < entries.length; index += 1) {
        const equalityPrefix = entries.slice(0, index).reduce<Record<string, unknown>>((carry, [field], prefixIndex) => {
            carry[field] = normalizeCursorValue(cursorValues[prefixIndex], field, options);
            return carry;
        }, {});
        const [field, sortDirection] = entries[index];
        const operator = direction === 'after'
            ? (sortDirection === 1 ? '$gt' : '$lt')
            : (sortDirection === 1 ? '$lt' : '$gt');

        clauses.push({
            ...equalityPrefix,
            [field]: {
                [operator]: normalizeCursorValue(cursorValues[index], field, options),
            },
        });
    }

    return clauses.length === 1 ? clauses[0] : { $or: clauses };
}

/**
 * Ensures sort fields are always included in the projection so cursor anchors are not lost.
 */
export function buildEffectiveProjection(
    projection: unknown,
    sort: Record<string, 1 | -1>,
): Record<string, unknown> | undefined {
    if (!projection) return undefined;

    let projObj: Record<string, unknown>;
    if (Array.isArray(projection)) {
        projObj = {};
        for (const f of projection as string[]) {
            projObj[f] = 1;
        }
    } else {
        projObj = { ...(projection as Record<string, unknown>) };
    }

    const sortFields = Object.keys(sort || {});
    const isExclusion = Object.entries(projObj).some(
        ([k, v]) => k !== '_id' && (v === 0 || v === false),
    );

    if (isExclusion) {
        for (const k of sortFields) {
            if (projObj[k] === 0 || projObj[k] === false) {
                delete projObj[k];
            }
        }
    } else {
        for (const k of sortFields) {
            if (!projObj[k]) projObj[k] = 1;
        }
    }

    return projObj;
}
