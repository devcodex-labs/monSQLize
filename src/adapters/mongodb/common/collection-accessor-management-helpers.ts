import { DEFAULT_FIND_PAGE_LIMIT } from '../queries/find-page-cache-helpers';
/**
 * Management operation helper functions for the collection accessor.
 *
 * Provides the underlying implementations for bookmark, index,
 * and collection info operations used by MongoCollectionAccessor.
 */
import { Collection, Db, Document } from 'mongodb';
import { createError, ErrorCodes } from '../../../core/errors';
import type { Logger } from '../../../core/logger';
import type { RuntimeDefaults } from '../../../types/internal/query';
import { resolveCursorStrategy } from '../queries/cursor-strategy';
import type { FindPageOptions, FindPageResult } from '../queries';
import {
    clearBookmarks,
    createIndexDefinition,
    createIndexDefinitions,
    dropIndexDefinition,
    dropIndexDefinitions,
    listBookmarks,
    listIndexDefinitions,
    prewarmBookmarks,
    type BookmarkCacheLike,
    type BookmarkClearResult,
    type BookmarkKeyDims,
    type BookmarkListResult,
    type BookmarkPrewarmResult,
    type IndexCreateResult,
} from '../management';

type BookmarkContext<TSchema extends Document> = {
    defaults?: RuntimeDefaults;
    cvFilter?: (query: Document) => Document;
    namespace: string;
    cache?: BookmarkCacheLike | null;
    getCache?: () => BookmarkCacheLike | null | undefined;
    logger?: Logger;
    findPage: (options: FindPageOptions<TSchema>) => Promise<FindPageResult<TSchema>>;
};

function resolveDb<TSchema extends Document>(collectionRef: Collection<TSchema>, dbRef?: Db): Db {
    return dbRef ?? collectionRef.db;
}

function resolveBookmarkCache(context: BookmarkContext<Document>): BookmarkCacheLike | null | undefined {
    return context.getCache ? context.getCache() : context.cache;
}

export function createIndexForAccessor<TSchema extends Document>(
    collectionRef: Collection<TSchema>,
    keys: Document,
    options?: Parameters<Collection<TSchema>['createIndex']>[1],
): Promise<IndexCreateResult> {
    return createIndexDefinition(collectionRef, keys, options);
}

export function createIndexesForAccessor<TSchema extends Document>(
    collectionRef: Collection<TSchema>,
    specs: Array<{ key: Document; } & Record<string, unknown>>,
): Promise<string[]> {
    return createIndexDefinitions(collectionRef, specs);
}

export function listIndexesForAccessor<TSchema extends Document>(collectionRef: Collection<TSchema>): Promise<Record<string, unknown>[]> {
    return listIndexDefinitions(collectionRef);
}

export function dropIndexForAccessor<TSchema extends Document>(
    collectionRef: Collection<TSchema>,
    name: string,
): ReturnType<Collection<TSchema>['dropIndex']> {
    return dropIndexDefinition(collectionRef, name);
}

export function dropIndexesForAccessor<TSchema extends Document>(collectionRef: Collection<TSchema>): ReturnType<Collection<TSchema>['dropIndexes']> {
    return dropIndexDefinitions(collectionRef);
}

function normalizeAccessorBookmarkDims<TSchema extends Document>(
    context: BookmarkContext<TSchema>, keyDims: BookmarkKeyDims<TSchema>,
): BookmarkKeyDims<TSchema> {
    const requested = keyDims.limit ?? DEFAULT_FIND_PAGE_LIMIT;
    if (!Number.isInteger(requested) || requested <= 0) throw createError(ErrorCodes.INVALID_PAGINATION, 'limit must be a positive integer.');
    const limit = context.defaults?.findPageMaxLimit !== undefined
        ? Math.min(requested, context.defaults.findPageMaxLimit) : requested;
    return { ...keyDims, limit, query: context.cvFilter?.(keyDims.query ?? {}) ?? keyDims.query ?? {} };
}

export function prewarmBookmarksForAccessor<TSchema extends Document>(
    context: BookmarkContext<TSchema>,
    keyDims: BookmarkKeyDims<TSchema> = {},
    pages: number[] = [],
): Promise<BookmarkPrewarmResult> {
    keyDims = normalizeAccessorBookmarkDims(context, keyDims);
    const strategy = resolveCursorStrategy(keyDims as Record<string, unknown>, context.defaults);
    if (!strategy.cacheable) throw createError(ErrorCodes.INVALID_ARGUMENT, 'Bookmark prewarming with a custom cursor normalizer requires cursorValueNormalizerVersion.');
    return prewarmBookmarks({
        namespace: context.namespace,
        cache: resolveBookmarkCache(context as BookmarkContext<Document>),
        logger: context.logger,
        keyDims: { ...keyDims, ...strategy },
        pages,
        findPage: context.findPage,
    });
}

export function listBookmarksForAccessor<TSchema extends Document>(
    context: BookmarkContext<TSchema>,
    keyDims?: BookmarkKeyDims<TSchema>,
): Promise<BookmarkListResult> {
    return listBookmarks({
        namespace: context.namespace,
        cache: resolveBookmarkCache(context as BookmarkContext<Document>),
        keyDims: keyDims ? { ...normalizeAccessorBookmarkDims(context, keyDims), ...resolveCursorStrategy(keyDims as Record<string, unknown>, context.defaults) } : undefined,
    });
}

export function clearBookmarksForAccessor<TSchema extends Document>(
    context: BookmarkContext<TSchema>,
    keyDims?: BookmarkKeyDims<TSchema>,
): Promise<BookmarkClearResult> {
    return clearBookmarks({
        namespace: context.namespace,
        cache: resolveBookmarkCache(context as BookmarkContext<Document>),
        keyDims: keyDims ? { ...normalizeAccessorBookmarkDims(context, keyDims), ...resolveCursorStrategy(keyDims as Record<string, unknown>, context.defaults) } : undefined,
    });
}

export function dropCollectionForAccessor<TSchema extends Document>(collectionRef: Collection<TSchema>): Promise<boolean> {
    return collectionRef.drop();
}

export async function createCollectionForAccessor<TSchema extends Document>(
    collectionRef: Collection<TSchema>,
    collectionName: string,
    dbRef: Db | undefined,
    name?: string,
    options: Record<string, unknown> = {},
): Promise<boolean> {
    await resolveDb(collectionRef, dbRef).createCollection(name ?? collectionName, options as Parameters<Db['createCollection']>[1]);
    return true;
}

export async function createViewForAccessor<TSchema extends Document>(
    collectionRef: Collection<TSchema>,
    dbRef: Db | undefined,
    name: string,
    source: string,
    pipeline: unknown[] = [],
): Promise<boolean> {
    await resolveDb(collectionRef, dbRef).createCollection(name, { viewOn: source, pipeline } as Parameters<Db['createCollection']>[1]);
    return true;
}

export async function indexStatsForAccessor<TSchema extends Document>(collectionRef: Collection<TSchema>): Promise<unknown[]> {
    return collectionRef.aggregate([{ $indexStats: {} }]).toArray();
}

export async function setValidatorForAccessor<TSchema extends Document>(
    collectionRef: Collection<TSchema>,
    collectionName: string,
    dbRef: Db | undefined,
    validator: unknown,
    options: { validationLevel?: string; validationAction?: string } = {},
): Promise<{ ok: number; collection: string }> {
    if (validator === null || typeof validator !== 'object') {
        throw createError(ErrorCodes.INVALID_ARGUMENT, 'Validator must be a non-null object');
    }
    const isEmptyValidator = Object.keys(validator as Record<string, unknown>).length === 0;
    const command: Record<string, unknown> = {
        collMod: collectionName,
        validator: validator as Record<string, unknown>,
    };
    if (options.validationLevel) {
        command['validationLevel'] = options.validationLevel;
    } else if (isEmptyValidator) {
        command['validationLevel'] = 'strict';
        command['validationAction'] = 'error';
    }
    if (options.validationAction) {
        command['validationAction'] = options.validationAction;
    }
    const result = await resolveDb(collectionRef, dbRef).command(command);
    return { ok: result['ok'] as number, collection: collectionName };
}

export async function setValidationLevelForAccessor<TSchema extends Document>(
    collectionRef: Collection<TSchema>,
    collectionName: string,
    dbRef: Db | undefined,
    level: unknown,
): Promise<{ ok: number; validationLevel: string }> {
    if (typeof level !== 'string' || !['off', 'strict', 'moderate'].includes(level)) {
        throw createError(ErrorCodes.INVALID_ARGUMENT, 'Invalid validation level: must be "off", "strict", or "moderate"');
    }
    const result = await resolveDb(collectionRef, dbRef).command({ collMod: collectionName, validationLevel: level });
    return { ok: result['ok'] as number, validationLevel: level };
}

export async function setValidationActionForAccessor<TSchema extends Document>(
    collectionRef: Collection<TSchema>,
    collectionName: string,
    dbRef: Db | undefined,
    action: unknown,
): Promise<{ ok: number; validationAction: string }> {
    if (typeof action !== 'string' || !['error', 'warn'].includes(action)) {
        throw createError(ErrorCodes.INVALID_ARGUMENT, 'Invalid validation action: must be "error" or "warn"');
    }
    const result = await resolveDb(collectionRef, dbRef).command({ collMod: collectionName, validationAction: action });
    return { ok: result['ok'] as number, validationAction: action };
}

export async function getValidatorForAccessor<TSchema extends Document>(
    collectionRef: Collection<TSchema>,
    collectionName: string,
    dbRef?: Db,
): Promise<{
    validator: Record<string, unknown> | null;
    validationLevel: string;
    validationAction: string;
}> {
    const collections = await resolveDb(collectionRef, dbRef).listCollections({ name: collectionName }).toArray();
    const info = collections[0] as { options?: Record<string, unknown> } | undefined;
    return {
        validator: (info?.options?.['validator'] as Record<string, unknown> | undefined) ?? null,
        validationLevel: (info?.options?.['validationLevel'] as string | undefined) ?? 'strict',
        validationAction: (info?.options?.['validationAction'] as string | undefined) ?? 'error',
    };
}

export async function statsForAccessor<TSchema extends Document>(
    collectionRef: Collection<TSchema>,
    dbName: string,
    collectionName: string,
    options: { scale?: number } = {},
): Promise<{
    ns: string;
    count: number;
    size: number;
    storageSize: number;
    totalIndexSize: number;
    nindexes: number;
    avgObjSize?: number;
    scaleFactor?: number;
}> {
    const scale = options.scale ?? 1;
    const results = await collectionRef.aggregate<Record<string, unknown>>([{ $collStats: { storageStats: { scale }, count: {} } }]).toArray();
    const raw = results[0] ?? {};
    const storage = (raw['storageStats'] as Record<string, unknown>) ?? {};
    return {
        ns: (raw['ns'] as string) ?? `${dbName}.${collectionName}`,
        count: (storage['count'] as number) ?? 0,
        size: (storage['size'] as number) ?? 0,
        storageSize: (storage['storageSize'] as number) ?? 0,
        totalIndexSize: (storage['totalIndexSize'] as number) ?? 0,
        nindexes: (storage['nindexes'] as number) ?? 0,
        avgObjSize: storage['avgObjSize'] as number | undefined,
        scaleFactor: (storage['scaleFactor'] as number) ?? scale,
    };
}

export async function renameCollectionForAccessor<TSchema extends Document>(
    collectionRef: Collection<TSchema>,
    collectionName: string,
    newName: unknown,
    options: { dropTarget?: boolean } = {},
): Promise<{ renamed: boolean; from: string; to: string }> {
    if (!newName || typeof newName !== 'string') {
        throw createError(ErrorCodes.INVALID_ARGUMENT, 'New collection name is required and must be a non-empty string');
    }
    await (collectionRef as unknown as Collection<Document>).rename(newName, { dropTarget: options.dropTarget ?? false });
    return { renamed: true, from: collectionName, to: newName };
}

export async function collModForAccessor<TSchema extends Document>(
    collectionRef: Collection<TSchema>,
    collectionName: string,
    dbRef: Db | undefined,
    modifications: unknown,
): Promise<Record<string, unknown>> {
    if (modifications === null || typeof modifications !== 'object') {
        throw createError(ErrorCodes.INVALID_ARGUMENT, 'Modifications must be a non-null object');
    }
    if (Object.prototype.hasOwnProperty.call(modifications, 'collMod')) {
        throw createError(ErrorCodes.INVALID_ARGUMENT, 'Modifications must not override the collMod target.');
    }
    return resolveDb(collectionRef, dbRef).command({
        collMod: collectionName,
        ...(modifications as Record<string, unknown>),
    }) as Promise<Record<string, unknown>>;
}

export async function convertToCappedForAccessor<TSchema extends Document>(
    collectionRef: Collection<TSchema>,
    collectionName: string,
    dbRef: Db | undefined,
    size: unknown,
    options: { max?: number } = {},
): Promise<{ ok: number; collection: string; capped: boolean; size: number }> {
    if (typeof size !== 'number') {
        throw createError(ErrorCodes.INVALID_ARGUMENT, 'Size must be a number');
    }
    if (size <= 0) {
        throw createError(ErrorCodes.INVALID_ARGUMENT, 'Size must be a positive number');
    }
    const command: Record<string, unknown> = { convertToCapped: collectionName, size };
    if (options.max !== undefined) {
        command['max'] = options.max;
    }
    const result = await resolveDb(collectionRef, dbRef).command(command);
    return { ok: result['ok'] as number, collection: collectionName, capped: true, size };
}
