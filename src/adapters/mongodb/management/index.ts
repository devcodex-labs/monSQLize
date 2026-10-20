/**
 * MongoDB management capability adapter layer.
 *
 * Description:
 * - Handles namespace, index, admin, bookmark, and collection/database-level management operations.
 * - Provides createIndex / dropIndex / listIndexes / createCollection / dropCollection / createView
 *   and other management APIs.
 */

import { normalizeSortShape } from '../queries/query-helpers';
import { coordinateInvalidation, withCacheReads } from '../../../core/cache-coordination';
import type { QueryCacheLike } from '../../../types/internal/query';
import { buildBookmarkBaseKey } from '../queries/find-page-cache-helpers';
import { Collection, Db, Document } from 'mongodb';

import { createError, ErrorCodes } from '../../../core/errors';
import type { Logger } from '../../../core/logger';
import type { FindPageOptions, FindPageResult } from '../queries';
import type {
    AdminBuildInfoView,
    BookmarkCacheLike,
    BookmarkClearResult,
    BookmarkKeyDims,
    BookmarkListResult,
    BookmarkPrewarmResult,
    DbStatsView,
    IndexCreateResult,
    ServerStatusView,
} from '../../../../types/collection';

const DEFAULT_FIND_PAGE_LIMIT = 20;

export type {
    AdminBuildInfoView,
    BookmarkCacheLike,
    BookmarkClearResult,
    BookmarkKeyDims,
    BookmarkListResult,
    BookmarkPrewarmResult,
    DbStatsView,
    IndexCreateResult,
    ServerStatusView,
} from '../../../../types/collection';

/**
 * Database-level admin façade.
 * @since v1.3.0
 */
export class MongoAdminAccessor {
    constructor(
        private readonly dbRef: Db,
        private readonly logger?: Logger,
    ) {}

    /**
     * Checks whether the database connection is available.
     * @since v1.3.0
     */
    async ping(): Promise<boolean> {
        try {
            await this.dbRef.admin().ping();
            return true;
        } catch (cause) {
            this.logger?.error('MongoDB ping failed', cause);
            return false;
        }
    }

    /**
     * Returns MongoDB version and build information.
     * @since v1.3.0
     */
    async buildInfo(): Promise<AdminBuildInfoView> {
        try {
            const info = await this.dbRef.admin().buildInfo();
            return {
                version: info.version,
                versionArray: info.versionArray,
                gitVersion: info.gitVersion,
                bits: info.bits,
                debug: info.debug,
                maxBsonObjectSize: info.maxBsonObjectSize,
            };
        } catch (cause) {
            throw createError(
                ErrorCodes.MANAGEMENT_OPERATION_FAILED,
                `Failed to get MongoDB build info: ${extractErrorMessage(cause)}`,
                undefined,
                cause instanceof Error ? cause : undefined,
            );
        }
    }

    /**
     * Returns a server status snapshot.
     * @since v1.3.0
     */
    async serverStatus(options: { scale?: number; } = {}): Promise<ServerStatusView> {
        try {
            const status = await this.dbRef.admin().command({
                serverStatus: 1,
                scale: options.scale ?? 1,
            });
            return {
                connections: {
                    current: status.connections?.current,
                    available: status.connections?.available,
                    totalCreated: status.connections?.totalCreated,
                },
                mem: {
                    resident: status.mem?.resident,
                    virtual: status.mem?.virtual,
                    mapped: status.mem?.mapped,
                },
                opcounters: {
                    insert: status.opcounters?.insert,
                    query: status.opcounters?.query,
                    update: status.opcounters?.update,
                    delete: status.opcounters?.delete,
                    getmore: status.opcounters?.getmore,
                    command: status.opcounters?.command,
                },
                network: {
                    bytesIn: status.network?.bytesIn,
                    bytesOut: status.network?.bytesOut,
                    numRequests: status.network?.numRequests,
                },
                uptime: status.uptime,
                localTime: status.localTime,
                version: status.version,
                process: status.process,
            };
        } catch (cause) {
            throw createError(
                ErrorCodes.MANAGEMENT_OPERATION_FAILED,
                `Failed to get MongoDB server status: ${extractErrorMessage(cause)}`,
                undefined,
                cause instanceof Error ? cause : undefined,
            );
        }
    }

    /**
     * Returns statistics for the current database.
     * @since v1.3.0
     */
    async stats(options: { scale?: number; } = {}): Promise<DbStatsView> {
        try {
            const stats = await this.dbRef.stats({ scale: options.scale ?? 1 });
            return {
                db: stats.db,
                collections: stats.collections,
                views: stats.views,
                objects: stats.objects,
                avgObjSize: stats.avgObjSize,
                dataSize: stats.dataSize,
                storageSize: stats.storageSize,
                indexes: stats.indexes,
                indexSize: stats.indexSize,
                totalSize: stats.totalSize,
                scaleFactor: stats.scaleFactor,
            };
        } catch (cause) {
            throw createError(
                ErrorCodes.MANAGEMENT_OPERATION_FAILED,
                `Failed to get MongoDB database stats: ${extractErrorMessage(cause)}`,
                undefined,
                cause instanceof Error ? cause : undefined,
            );
        }
    }
}

/**
 * Creates a single index.
 * @since v1.3.0
 */
export async function createIndexDefinition<TSchema extends Document = Document>(
    collectionRef: Collection<TSchema>,
    keys: Document,
    options?: Parameters<Collection<TSchema>['createIndex']>[1],
): Promise<IndexCreateResult> {
    validateIndexKeys(keys, 'createIndex');
    const name = await collectionRef.createIndex(keys, options);
    return { name };
}

/**
 * Creates multiple indexes in bulk.
 * @since v1.3.0
 */
export async function createIndexDefinitions<TSchema extends Document = Document>(
    collectionRef: Collection<TSchema>,
    specs: Array<{ key: Document; } & Record<string, unknown>>,
): Promise<string[]> {
    if (!Array.isArray(specs) || specs.length === 0) {
        throw createError(ErrorCodes.INVALID_ARGUMENT, 'createIndexes: specs must be a non-empty array.');
    }

    for (const spec of specs) {
        validateIndexKeys(spec?.key, 'createIndexes');
    }

    return collectionRef.createIndexes(specs as Parameters<Collection<TSchema>['createIndexes']>[0]);
}

/**
 * Lists indexes.
 * @since v1.3.0
 */
export async function listIndexDefinitions<TSchema extends Document = Document>(
    collectionRef: Collection<TSchema>,
): Promise<Record<string, unknown>[]> {
    try {
        return await collectionRef.listIndexes().toArray() as Record<string, unknown>[];
    } catch (err: unknown) {
        const mongoErr = err as { code?: number };
        // v1 compat: code=26 means the collection (namespace) does not exist → return []
        if (mongoErr?.code === 26) {
            return [];
        }
        throw err;
    }
}

/**
 * Drops a specific index.
 * @since v1.3.0
 */
export async function dropIndexDefinition<TSchema extends Document = Document>(
    collectionRef: Collection<TSchema>,
    name: string,
): ReturnType<Collection<TSchema>['dropIndex']> {
    if (!name?.trim()) {
        throw createError(ErrorCodes.INVALID_ARGUMENT, 'dropIndex: name must be a non-empty string.');
    }
    if (name === '_id_') {
        throw createError(ErrorCodes.INVALID_ARGUMENT, 'dropIndex: dropping the _id index is not allowed');
    }
    try {
        return await collectionRef.dropIndex(name);
    } catch (err: unknown) {
        const mongoErr = err as { code?: number; codeName?: string };
        if (mongoErr?.code === 27 || mongoErr?.codeName === 'IndexNotFound') {
            throw createError(ErrorCodes.MONGODB_ERROR, `Index does not exist: ${name}`);
        }
        throw err;
    }
}

/**
 * Drops all non-`_id_` indexes.
 * @since v1.3.0
 */
export async function dropIndexDefinitions<TSchema extends Document = Document>(
    collectionRef: Collection<TSchema>,
): ReturnType<Collection<TSchema>['dropIndexes']> {
    try {
        const result = await collectionRef.dropIndexes();
        // v1 compat: normalize falsy result (e.g. false from driver when collection doesn't exist)
        return (result || { ok: 1, nIndexesWas: 0 }) as unknown as ReturnType<Collection<TSchema>['dropIndexes']>;
    } catch (err: unknown) {
        const mongoErr = err as { code?: number };
        // v1 compat: code=26 = namespace not found → treat as success
        if (mongoErr?.code === 26) {
            return { ok: 1, msg: 'collection does not exist, no indexes to drop', nIndexesWas: 0 } as unknown as ReturnType<Collection<TSchema>['dropIndexes']>;
        }
        throw err;
    }
}

/**
 * Pre-warms the bookmark page cache.
 * @since v1.3.0
 */
export async function prewarmBookmarks<TSchema extends Document = Document>(params: {
    namespace: string;
    cache?: BookmarkCacheLike | null;
    logger?: Logger;
    keyDims?: BookmarkKeyDims<TSchema>;
    pages?: number[];
    findPage: (options: FindPageOptions<TSchema>) => Promise<FindPageResult<TSchema>>;
}): Promise<BookmarkPrewarmResult> {
    const cache = ensureBookmarkCache(params.cache);
    const pages = params.pages ?? [];
    if (!Array.isArray(pages) || pages.length === 0) {
        throw createError('INVALID_PAGES', 'INVALID_PAGES: pages must be a non-empty array');
    }

    const keyDims = normalizeBookmarkKeyDims(params.keyDims);
    const result: BookmarkPrewarmResult = {
        warmed: 0,
        failed: 0,
        keys: [],
    };

    for (const page of pages) {
        if (!Number.isInteger(page) || page < 1) {
            result.failed += 1;
            params.logger?.warn(`Skip invalid bookmark page: ${page}`);
            continue;
        }

        try {
            await withCacheReads(cache as unknown as QueryCacheLike, async guarded => {
                const key = buildBookmarkKey(params.namespace, keyDims, page);
                await guarded.get(key);
                const payload = await params.findPage({ ...keyDims, page, totals: false, jump: { step: 1, maxHops: 1000 } } as unknown as FindPageOptions<TSchema>);
                const items = (payload as unknown as { items?: unknown[]; data?: unknown[] }).items
                    ?? (payload as unknown as { data?: unknown[] }).data
                    ?? [];
                if (items.length > 0) {
                    await Promise.resolve((guarded as unknown as BookmarkCacheLike).set(key, {
                        page,
                        pageInfo: payload.pageInfo,
                        size: items.length,
                        warmedAt: new Date().toISOString(),
                    }));
                    result.warmed += 1;
                } else {
                    result.failed += 1;
                }
            });
        } catch (cause) {
            result.failed += 1;
            params.logger?.warn('Bookmark prewarm failed', cause);
        }
    }

    result.keys = await resolveKeys(cache, buildBookmarkPattern(params.namespace));
    return result;
}

/**
 * Lists the bookmark page cache entries.
 * @since v1.3.0
 */
export async function listBookmarks(params: {
    namespace: string;
    cache?: BookmarkCacheLike | null;
    keyDims?: BookmarkKeyDims;
}): Promise<BookmarkListResult> {
    const cache = ensureBookmarkCache(params.cache);
    const normalizedKeyDims = params.keyDims === undefined ? undefined : normalizeBookmarkKeyDims(params.keyDims);
    const keys = await resolveKeys(cache, buildBookmarkPattern(params.namespace, normalizedKeyDims));
    const pages = keys
        .map(extractBookmarkPage)
        .filter((page): page is number => page !== null)
        .sort((a, b) => a - b);

    return {
        count: pages.length,
        pages,
        keys,
    };
}

/**
 * Clears the bookmark page cache.
 * @since v1.3.0
 */
export async function clearBookmarks(params: {
    namespace: string;
    cache?: BookmarkCacheLike | null;
    keyDims?: BookmarkKeyDims;
}): Promise<BookmarkClearResult> {
    const cache = ensureBookmarkCache(params.cache);
    const normalizedKeyDims = params.keyDims === undefined ? undefined : normalizeBookmarkKeyDims(params.keyDims);
    const pattern = buildBookmarkPattern(params.namespace, normalizedKeyDims);
    const keysBefore = await resolveKeys(cache, pattern);
    const cleared = await resolveDeletePattern(cache, pattern);

    return {
        cleared,
        pattern,
        keysBefore: keysBefore.length,
    };
}

// v1 compat: valid index direction/type values
const VALID_INDEX_VALUES = new Set([1, -1, '1', '-1', 'text', '2d', '2dsphere', 'geoHaystack', 'hashed', 'columnstore']);

function validateIndexKeys(keys: Document | undefined, operation: string): void {
    if (!keys || typeof keys !== 'object' || Array.isArray(keys) || Object.keys(keys).length === 0) {
        throw createError(ErrorCodes.INVALID_ARGUMENT, `${operation}: index keys must not be empty`);
    }
    for (const [field, value] of Object.entries(keys)) {
        if (!VALID_INDEX_VALUES.has(value as number | string)) {
            throw createError(
                ErrorCodes.INVALID_ARGUMENT,
                `${operation}: invalid value "${value}" for index key "${field}", must be 1, -1, "text", "2d", "2dsphere", "hashed", or "columnstore"`,
            );
        }
    }
}

function ensureBookmarkCache(cache?: BookmarkCacheLike | null): BookmarkCacheLike {
    if (!cache || typeof cache.set !== 'function' || typeof cache.get !== 'function' || typeof cache.keys !== 'function' || typeof cache.delPattern !== 'function') {
        throw createError(ErrorCodes.CACHE_UNAVAILABLE, 'CACHE_UNAVAILABLE: Cache is required for bookmark operations');
    }
    return cache;
}

function normalizeBookmarkKeyDims<TSchema extends Document = Document>(
    keyDims: BookmarkKeyDims<TSchema> | undefined,
): BookmarkKeyDims<TSchema> {
    const normalized = {
        ...(keyDims ?? {}),
    };
    const sort = normalizeSortShape(normalized.sort);
    normalized.sort = sort as typeof normalized.sort;
    normalized.limit = normalized.limit ?? DEFAULT_FIND_PAGE_LIMIT;
    normalized.query = normalized.query ?? {};
    return normalized;
}

function buildBookmarkKey(namespace: string, keyDims: BookmarkKeyDims, page: number): string {
    return `${buildBookmarkBaseKey(namespace, keyDims)}:${page}`;
}

function buildBookmarkPattern(namespace: string, keyDims?: BookmarkKeyDims): string {
    return keyDims ? `${buildBookmarkBaseKey(namespace, keyDims)}:*` : `${namespace}:bm:*`;
}

async function resolveKeys(cache: BookmarkCacheLike, pattern: string): Promise<string[]> {
    const keys = await Promise.resolve(cache.keys?.(pattern) ?? []);
    return Array.isArray(keys) ? keys : [];
}

async function resolveDeletePattern(cache: BookmarkCacheLike, pattern: string): Promise<number> {
    const deleted = await coordinateInvalidation(cache as unknown as QueryCacheLike, [{ type: 'pattern', value: pattern }], async () => await Promise.resolve(cache.delPattern?.(pattern) ?? 0));
    return typeof deleted === 'number' ? deleted : 0;
}

function extractBookmarkPage(key: string): number | null {
    const match = key.match(/:(\d+)$/);
    if (!match) {
        return null;
    }
    return Number.parseInt(match[1], 10);
}

function extractErrorMessage(cause: unknown): string {
    if (cause instanceof Error) {
        return cause.message;
    }
    return String(cause);
}

