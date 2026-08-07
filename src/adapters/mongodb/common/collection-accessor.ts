/**
 * MongoDB accessor adapter layer.
 *
 * Notes:
 * - Wires runtime defaults, cache, and context into the concrete implementations.
 * - query / write / management logic remains in their respective sub-modules;
 *   this layer only delegates and provides a thin façade.
 * - Complex logic should continue to be pushed down into the query/write/management
 *   modules rather than accumulating here.
 */

import { ChangeStream, Collection, Db, Document } from 'mongodb';
import type { Logger } from '../../../core/logger';
import { normalizeProjection } from '../../../utils/normalize';
import {
    type BookmarkCacheLike,
    type BookmarkClearResult,
    type BookmarkKeyDims,
    type BookmarkListResult,
    type BookmarkPrewarmResult,
    type IndexCreateResult,
} from '../management';
import {
    clearBookmarksForAccessor,
    collModForAccessor,
    convertToCappedForAccessor,
    createCollectionForAccessor,
    createIndexForAccessor,
    createIndexesForAccessor,
    createViewForAccessor,
    dropCollectionForAccessor,
    dropIndexForAccessor,
    dropIndexesForAccessor,
    getValidatorForAccessor,
    indexStatsForAccessor,
    listBookmarksForAccessor,
    listIndexesForAccessor,
    prewarmBookmarksForAccessor,
    renameCollectionForAccessor,
    setValidationActionForAccessor,
    setValidationLevelForAccessor,
    setValidatorForAccessor,
    statsForAccessor,
} from './collection-accessor-management-helpers';

import {
    countDocuments,
    createAggregateChain,
    createFindChain,
    distinctValues,
    explainDocuments,
    findAndCountDocuments,
    findByIdsDocuments,
    findOneByIdDocument,
    findOneDocument,
    findPageDocuments,
    streamDocuments,
    type FindChain,
    type FindPageOptions,
    type FindPageResult,
    wrapQueryResultWithMeta,
    watchDocuments,
} from '../queries';
import {
    attachVectorSearchOperationContext,
    buildVectorSearchPipeline,
    mapVectorSearchRows,
} from '../queries/vector-search';
import type {
    VectorSearchHit,
    VectorSearchOptions,
} from '../../../../types/collection';
import type { QueryCacheLike, RuntimeDefaults } from '../../../types/internal/query';
import type {
    CollectionAccessorManagementOptions,
    CollectionNamespaceView,
} from '../../../types/internal/accessor';
import {
    assertWritePathAllowed,
    getCurrentWritePathSource,
    type WritePathOperationCategory,
    type WritePathSource,
} from '../../../capabilities/write-path-policy';
import {
    type BatchWriteOptions,
    type DeleteBatchResult,
    type IncrementOneOptions,
    type InsertBatchResult,
    type UpdateBatchOptions,
    type UpdateBatchResult,
} from '../writes';
import { convertObjectIdStrings, convertUpdateDocument } from '../utils/objectid-converter';
import {
    invalidateReadCachesAfterWrite as invalidateAccessorReadCachesAfterWrite,
    invalidateReadCachesForNamespace as invalidateAccessorReadCachesForNamespace,
    prepareReadCachesBeforeWrite as prepareAccessorReadCachesBeforeWrite,
    recordTransactionWriteOperation,
    resolveAggregateWriteTarget,
} from './collection-accessor-cache-helpers';
import {
    hasSessionOption,
    isCollectionCacheBarrierActive,
    normalizeFindProjectionOptions,
} from '../queries/query-helpers';
import {
    buildCountCacheKey,
    buildDistinctCacheKey,
    buildFindOneCacheKey,
} from '../queries/query-cache-keys';
import {
    deleteBatchForAccessor,
    incrementOneForAccessor,
    insertBatchForAccessor,
    updateBatchForAccessor,
} from './collection-accessor-batch-helpers';
import {
    deleteManyForAccessor,
    deleteOneForAccessor,
    findOneAndDeleteForAccessor,
    findOneAndReplaceForAccessor,
    findOneAndUpdateForAccessor,
    insertManyForAccessor,
    insertOneForAccessor,
    replaceOneForAccessor,
    updateManyForAccessor,
    updateOneForAccessor,
    upsertOneForAccessor,
} from './collection-accessor-write-helpers';

/**
 * Low-level MongoDB collection accessor.
 * Provides CRUD, query, and management operations for a single collection.
 * @since v1.0.0
 */
export class MongoCollectionAccessor<TSchema extends Document = Document> {
    constructor(
        private readonly dbName: string,
        private readonly collectionName: string,
        private readonly collectionRef: Collection<TSchema>,
        private readonly management: CollectionAccessorManagementOptions = {},
        private readonly dbRef?: Db,
    ) { }

    /** When autoConvertObjectId is enabled, auto-converts filter/query values. */
    private _cvFilter<T>(val: T): T {
        const autoConvertObjectId = this.management.defaults?.autoConvertObjectId;
        if (!autoConvertObjectId) return val;
        return convertObjectIdStrings(val as unknown, '', 0, new WeakSet(), autoConvertObjectId) as T;
    }

    /** When autoConvertObjectId is enabled, auto-converts plain documents (insert/replace). */
    private _cvDoc<T>(val: T): T {
        const autoConvertObjectId = this.management.defaults?.autoConvertObjectId;
        if (!autoConvertObjectId) return val;
        return convertObjectIdStrings(val as unknown, '', 0, new WeakSet(), autoConvertObjectId) as T;
    }

    /** When autoConvertObjectId is enabled, auto-converts update documents ($set/$push/etc.). */
    private _cvUpdate<T>(val: T): T {
        const autoConvertObjectId = this.management.defaults?.autoConvertObjectId;
        if (!autoConvertObjectId || Array.isArray(val)) return val;
        return convertUpdateDocument(val as unknown, autoConvertObjectId) as T;
    }

    private async invalidateReadCachesForNamespace(
        dbName: string,
        collectionName: string,
        operation?: 'find' | 'findOne' | 'count' | 'findPage' | 'all' | string,
    ): Promise<number> {
        return invalidateAccessorReadCachesForNamespace(
            this.management.queryCache,
            dbName,
            collectionName,
            this.management.defaults,
            operation,
        );
    }

    private buildCacheCollectionView(dbName: string, collectionName: string): Collection<TSchema> {
        return {
            namespace: `${dbName}.${collectionName}`,
            collectionName,
        } as unknown as Collection<TSchema>;
    }

    private async invalidateReadCaches(operation?: 'find' | 'findOne' | 'count' | 'findPage' | 'all' | string): Promise<number> {
        return this.invalidateReadCachesForNamespace(this.dbName, this.collectionName, operation);
    }

    private async invalidateReadCachesAfterWrite(options?: unknown): Promise<number> {
        return invalidateAccessorReadCachesAfterWrite(
            this.management.queryCache,
            this.collectionRef,
            this.dbName,
            this.collectionName,
            this.management.defaults,
            options,
        );
    }

    private async prepareReadCachesBeforeWrite(options?: unknown): Promise<void> {
        await prepareAccessorReadCachesBeforeWrite(
            this.management.queryCache,
            this.dbName,
            this.collectionName,
            this.management.defaults,
            options,
        );
    }

    private buildNamespaceView(dbName: string, collectionName: string): CollectionNamespaceView {
        const instanceId = this.management.defaults?.namespace?.instanceId;
        const scopedName = this.management.poolName
            ? `${this.management.poolName}:${dbName}.${collectionName}`
            : `${dbName}:${collectionName}`;
        const iid = instanceId ? `${instanceId}:${scopedName}` : scopedName;
        return {
            iid,
            type: 'mongodb',
            db: dbName,
            collection: collectionName,
            ...(this.management.poolName ? { pool: this.management.poolName } : {}),
        };
    }

    getNamespace(): CollectionNamespaceView {
        return this.buildNamespaceView(this.dbName, this.collectionName);
    }

    raw(): Collection<TSchema> {
        this.assertWritePath('raw', 'raw');
        return this.collectionRef;
    }

    /** Finds a single document matching the query, with optional cache support. */
    async findOne(
        query: Parameters<Collection<TSchema>['findOne']>[0],
        options?: Parameters<Collection<TSchema>['findOne']>[1],
    ): ReturnType<Collection<TSchema>['findOne']> {
        const startTs = Date.now();
        const normalizedQuery = this._cvFilter(query);
        const maxTimeMS = this.management.defaults?.maxTimeMS;
        const rawOptions: Record<string, unknown> = { ...(maxTimeMS !== undefined ? { maxTimeMS } : {}), ...((options ?? {}) as Record<string, unknown>) };
        const driverOptions: Record<string, unknown> = normalizeFindProjectionOptions(rawOptions);
        const cacheTTL = rawOptions.explain ? 0 : typeof rawOptions.cache === 'number' ? rawOptions.cache : 0;

        if (
            cacheTTL > 0
            && this.management.queryCache
            && !hasSessionOption(driverOptions)
            && !(await isCollectionCacheBarrierActive(this.management.queryCache, this.collectionRef, this.management.defaults))
        ) {
            const cacheKey = buildFindOneCacheKey(this.collectionRef, this.management.defaults, normalizedQuery, driverOptions);
            const cached = await Promise.resolve(this.management.queryCache.get(cacheKey)) as TSchema | null | undefined;
            if (cached !== undefined) {
                return Promise.resolve(wrapQueryResultWithMeta(this.collectionRef, this.management.defaults, 'findOne', rawOptions, startTs, cached) as never) as ReturnType<Collection<TSchema>['findOne']>;
            }
            const result = await findOneDocument(this.collectionRef, normalizedQuery, driverOptions as Parameters<Collection<TSchema>['findOne']>[1]);
            await Promise.resolve(this.management.queryCache.set(cacheKey, result, cacheTTL));
            return wrapQueryResultWithMeta(this.collectionRef, this.management.defaults, 'findOne', rawOptions, startTs, result) as never;
        }

        const result = await findOneDocument(this.collectionRef, normalizedQuery, driverOptions as Parameters<Collection<TSchema>['findOne']>[1]);
        return wrapQueryResultWithMeta(this.collectionRef, this.management.defaults, 'findOne', rawOptions, startTs, result) as never;
    }

    /** Returns a find chain (or a readable stream when `options.stream` is true). */
    find(
        query?: Parameters<Collection<TSchema>['find']>[0],
        optionsOrProjection?: (Parameters<Collection<TSchema>['find']>[1] & { stream?: boolean }) | string[] | Record<string, unknown>,
        maybeOptions?: Parameters<Collection<TSchema>['find']>[1] & { stream?: boolean },
    ): FindChain<TSchema> | NodeJS.ReadableStream {
        const options = this.resolveFindOptions(optionsOrProjection, maybeOptions);
        if ((options as Record<string, unknown> | undefined)?.stream) {
            return streamDocuments(this.collectionRef, query, options, this.management.defaults);
        }
        return createFindChain(this.collectionRef, query, options, this.management.defaults, this.management.queryCache) as unknown as FindChain<TSchema>;
    }

    /** Finds a single document by its `_id` field. */
    async findOneById(id: unknown, options?: Parameters<Collection<TSchema>['findOne']>[1]): Promise<TSchema | null> {
        return findOneByIdDocument(this.collectionRef, id, options, this.management.defaults, this.management.queryCache);
    }

    /** Finds multiple documents by an array of `_id` values. */
    async findByIds(ids: unknown[], options?: Parameters<Collection<TSchema>['find']>[1]): Promise<TSchema[]> {
        const { findLimit: _skip, ...noLimitDefaults } = this.management.defaults ?? {};
        return findByIdsDocuments(this.collectionRef, ids, options, noLimitDefaults, this.management.queryCache);
    }

    /** Returns `{ data, total }` — the matched documents together with the total count in a single round-trip. */
    async findAndCount(query?: Parameters<Collection<TSchema>['find']>[0], options?: Parameters<Collection<TSchema>['find']>[1]) {
        return findAndCountDocuments(this.collectionRef, query != null ? this._cvFilter(query) as typeof query : query, options, this.management.defaults);
    }

    /** Returns a Node.js Readable stream of documents matching the query (object mode). */
    stream(query?: Parameters<Collection<TSchema>['find']>[0], options?: Parameters<Collection<TSchema>['find']>[1]): NodeJS.ReadableStream {
        return streamDocuments(this.collectionRef, query, options, this.management.defaults);
    }

    /** Returns the MongoDB query plan for the given query (passes `explain` to the driver). */
    explain(query?: Parameters<Collection<TSchema>['find']>[0], options?: Parameters<Collection<TSchema>['find']>[1] & { explain?: boolean | string; }): Promise<unknown> {
        return explainDocuments(this.collectionRef, query, options, this.management.defaults);
    }

    /** Counts documents matching the query, with optional cache and queue support. */
    async count(
        query?: Parameters<Collection<TSchema>['countDocuments']>[0],
        options?: Parameters<Collection<TSchema>['countDocuments']>[1],
    ): ReturnType<Collection<TSchema>['countDocuments']> {
        const startTs = Date.now();
        const normalizedQuery = this._cvFilter(query);
        const maxTimeMS = this.management.defaults?.maxTimeMS;
        const merged: Record<string, unknown> = { ...(maxTimeMS !== undefined ? { maxTimeMS } : {}), ...((options ?? {}) as Record<string, unknown>) };
        const cacheTTL = typeof merged.cache === 'number' ? merged.cache : 0;
        const { cache: _cache, ...keyOptions } = merged;
        void _cache;
        const executeCount = (signal?: AbortSignal) => countDocuments(
            this.collectionRef,
            normalizedQuery ?? {},
            (signal ? { ...keyOptions, signal } : keyOptions) as Parameters<Collection<TSchema>['countDocuments']>[1],
        );
        const countQueue = this.management.defaults?.countQueue;
        if (
            cacheTTL > 0
            && this.management.queryCache
            && !hasSessionOption(keyOptions)
            && !(await isCollectionCacheBarrierActive(this.management.queryCache, this.collectionRef, this.management.defaults))
        ) {
            const cacheKey = buildCountCacheKey(this.collectionRef, this.management.defaults, normalizedQuery, keyOptions);
            const cached = await Promise.resolve(this.management.queryCache.get(cacheKey));
            if (cached !== undefined) {
                return Promise.resolve(wrapQueryResultWithMeta(this.collectionRef, this.management.defaults, 'count', merged, startTs, cached as number) as never) as ReturnType<Collection<TSchema>['countDocuments']>;
            }
            const runner = countQueue ? countQueue.execute(executeCount) : executeCount();
            return runner.then(async (result) => {
                await Promise.resolve(this.management.queryCache?.set(cacheKey, result, cacheTTL));
                return wrapQueryResultWithMeta(this.collectionRef, this.management.defaults, 'count', merged, startTs, result) as number;
            }) as ReturnType<Collection<TSchema>['countDocuments']>;
        }
        const runner = countQueue ? countQueue.execute(executeCount) : executeCount();
        return runner.then((result) => wrapQueryResultWithMeta(this.collectionRef, this.management.defaults, 'count', merged, startTs, result) as number) as ReturnType<Collection<TSchema>['countDocuments']>;
    }

    /** Runs an aggregation pipeline and returns a chainable aggregate cursor. */
    aggregate(
        pipeline: Document[] = [],
        options?: Parameters<Collection<TSchema>['aggregate']>[1],
    ) {
        const normalizedPipeline = this.management.defaults?.autoConvertObjectId
            ? pipeline.map((stage) => convertObjectIdStrings(
                stage as unknown,
                '',
                0,
                new WeakSet(),
                this.management.defaults?.autoConvertObjectId,
            ) as Document)
            : pipeline;
        const writeTarget = resolveAggregateWriteTarget(normalizedPipeline);
        if (writeTarget) {
            this.assertWritePath('aggregate', 'write', this.buildNamespaceView(
                writeTarget.dbName ?? this.dbName,
                writeTarget.collectionName,
            ));
        }
        return createAggregateChain(
            this.collectionRef,
            normalizedPipeline,
            options,
            this.management.defaults,
            this.management.queryCache,
            writeTarget
                ? {
                    onWriteComplete: async () => {
                        recordTransactionWriteOperation(options);
                        await invalidateAccessorReadCachesAfterWrite(
                            this.management.queryCache,
                            this.buildCacheCollectionView(
                                writeTarget.dbName ?? this.dbName,
                                writeTarget.collectionName,
                            ),
                            writeTarget.dbName ?? this.dbName,
                            writeTarget.collectionName,
                            this.management.defaults,
                            options,
                        );
                    },
                }
                : undefined,
        );
    }

    /** Searches a MongoDB Vector Search index through a constrained aggregate pipeline. */
    async vectorSearch<TDocument = TSchema>(
        options: VectorSearchOptions,
    ): Promise<Array<VectorSearchHit<TDocument>>> {
        const { pipeline, aggregateOptions } = buildVectorSearchPipeline(options);
        try {
            const rows = await this.aggregate(
                pipeline,
                aggregateOptions as Parameters<Collection<TSchema>['aggregate']>[1],
            );
            return mapVectorSearchRows<TDocument>(rows as Document[]);
        } catch (error) {
            throw attachVectorSearchOperationContext(error, this.getNamespace());
        }
    }

    /** Returns an array of distinct values for the given field key. */
    async distinct(
        key: string,
        query?: Document,
        options?: Parameters<Collection<TSchema>['distinct']>[2],
    ): ReturnType<Collection<TSchema>['distinct']> {
        const startTs = Date.now();
        const rawOptions = (options ?? {}) as Record<string, unknown>;
        const {
            meta: _meta,
            cache,
            explain: _explain,
            stream: _stream,
            preserveOrder: _preserveOrder,
            withDeleted: _withDeleted,
            onlyDeleted: _onlyDeleted,
            ...driverOptions
        } = rawOptions;
        void _meta;
        void _explain;
        void _stream;
        void _preserveOrder;
        void _withDeleted;
        void _onlyDeleted;
        const normalizedQuery = this._cvFilter(query);
        const cacheTTL = typeof cache === 'number' ? cache : 0;
        const executeDistinct = () => distinctValues(
            this.collectionRef,
            key,
            normalizedQuery,
            options === undefined ? undefined : driverOptions as Parameters<Collection<TSchema>['distinct']>[2],
        );
        if (
            cacheTTL > 0
            && this.management.queryCache
            && !hasSessionOption(driverOptions)
            && !(await isCollectionCacheBarrierActive(this.management.queryCache, this.collectionRef, this.management.defaults))
        ) {
            const cacheKey = buildDistinctCacheKey(this.collectionRef, this.management.defaults, key, normalizedQuery, driverOptions);
            const cached = await Promise.resolve(this.management.queryCache.get(cacheKey));
            if (cached !== undefined) {
                return Promise.resolve(wrapQueryResultWithMeta(this.collectionRef, this.management.defaults, 'distinct', rawOptions, startTs, cached) as never) as ReturnType<Collection<TSchema>['distinct']>;
            }
            const result = await executeDistinct();
            await Promise.resolve(this.management.queryCache.set(cacheKey, result, cacheTTL));
            return wrapQueryResultWithMeta(this.collectionRef, this.management.defaults, 'distinct', rawOptions, startTs, result) as never;
        }
        const result = await executeDistinct();
        return wrapQueryResultWithMeta(this.collectionRef, this.management.defaults, 'distinct', rawOptions, startTs, result) as never;
    }

    async findPage(options: FindPageOptions<TSchema> = {}): Promise<FindPageResult<TSchema>> {
        const resolvedOptions = options.query
            ? { ...options, query: this._cvFilter(options.query) as typeof options.query }
            : options;
        return findPageDocuments(this.collectionRef, resolvedOptions, this.management.defaults, this.management.queryCache);
    }

    /** Opens a change stream on the collection with an optional aggregation pipeline. */
    watch(pipeline: Document[] = [], options?: Parameters<Collection<TSchema>['watch']>[1]): ChangeStream<TSchema> {
        return watchDocuments(this.collectionRef, pipeline, options);
    }

    /** Inserts a single document and invalidates read caches. */
    async insertOne(
        doc: Parameters<Collection<TSchema>['insertOne']>[0],
        options?: Parameters<Collection<TSchema>['insertOne']>[1],
    ): ReturnType<Collection<TSchema>['insertOne']> {
        return insertOneForAccessor(this.writeContext('insertOne'), doc, options);
    }

    /** Inserts multiple documents and invalidates read caches. */
    async insertMany(...args: Parameters<Collection<TSchema>['insertMany']>): ReturnType<Collection<TSchema>['insertMany']> {
        const [documents, options] = args;
        return insertManyForAccessor(this.writeContext('insertMany'), documents, options);
    }

    /**
     * Passthrough for native single-document update, with v1 validation and cache invalidation.
     * @since v1.3.0
     */
    async updateOne(
        filter: Parameters<Collection<TSchema>['updateOne']>[0],
        update: Parameters<Collection<TSchema>['updateOne']>[1],
        options?: Parameters<Collection<TSchema>['updateOne']>[2],
    ): ReturnType<Collection<TSchema>['updateOne']> {
        return updateOneForAccessor(this.writeContext('updateOne'), filter, update, options);
    }

    /** Updates all documents matching the filter and invalidates read caches. */
    async updateMany(...args: Parameters<Collection<TSchema>['updateMany']>): ReturnType<Collection<TSchema>['updateMany']> {
        const [filter, update, options] = args;
        return updateManyForAccessor(this.writeContext('updateMany'), filter, update, options);
    }

    /** Replaces a single matching document and invalidates read caches. */
    async replaceOne(...args: Parameters<Collection<TSchema>['replaceOne']>): ReturnType<Collection<TSchema>['replaceOne']> {
        const [filter, replacement, options] = args;
        return replaceOneForAccessor(this.writeContext('replaceOne'), filter, replacement, options);
    }

    /**
     * Atomically finds and replaces a single document.
     * @since v1.3.0
     */
    async findOneAndReplace(
        filter: Parameters<Collection<TSchema>['findOneAndReplace']>[0],
        replacement: Parameters<Collection<TSchema>['findOneAndReplace']>[1],
        options?: unknown,
    ): ReturnType<Collection<TSchema>['findOneAndReplace']> {
        return findOneAndReplaceForAccessor(this.writeContext('findOneAndReplace'), filter, replacement, options);
    }

    /**
     * Atomically finds and updates a single document.
     * @since v1.3.0
     */
    async findOneAndUpdate(
        filter: Parameters<Collection<TSchema>['findOneAndUpdate']>[0],
        update: Parameters<Collection<TSchema>['findOneAndUpdate']>[1],
        options?: unknown,
    ): ReturnType<Collection<TSchema>['findOneAndUpdate']> {
        return findOneAndUpdateForAccessor(this.writeContext('findOneAndUpdate'), filter, update, options);
    }

    /**
     * Atomically finds and deletes a single document.
     * @since v1.3.0
     */
    async findOneAndDelete(
        filter: Parameters<Collection<TSchema>['findOneAndDelete']>[0],
        options?: unknown,
    ): ReturnType<Collection<TSchema>['findOneAndDelete']> {
        return findOneAndDeleteForAccessor(this.writeContext('findOneAndDelete'), filter, options);
    }

    /**
     * Convenience upsert wrapper.
     * @since v1.3.0
     */
    async upsertOne(
        filter: Parameters<Collection<TSchema>['updateOne']>[0],
        update: Parameters<Collection<TSchema>['updateOne']>[1],
        options?: Parameters<Collection<TSchema>['updateOne']>[2],
    ): ReturnType<Collection<TSchema>['updateOne']> {
        return upsertOneForAccessor(this.writeContext('upsertOne'), filter, update, options);
    }

    /**
     * Passthrough for native single-document delete, with v1 validation and cache invalidation.
     * @since v1.3.0
     */
    async deleteOne(
        filter: Parameters<Collection<TSchema>['deleteOne']>[0],
        options?: Parameters<Collection<TSchema>['deleteOne']>[1],
    ): ReturnType<Collection<TSchema>['deleteOne']> {
        return deleteOneForAccessor(this.writeContext('deleteOne'), filter, options);
    }

    /** Deletes all documents matching the filter and invalidates read caches. */
    async deleteMany(...args: Parameters<Collection<TSchema>['deleteMany']>): ReturnType<Collection<TSchema>['deleteMany']> {
        const [filter, options] = args;
        return deleteManyForAccessor(this.writeContext('deleteMany'), filter, options);
    }

    /** Inserts documents in configurable batches to avoid exceeding driver limits. */
    async insertBatch(documents: TSchema[], options?: BatchWriteOptions & Parameters<Collection<TSchema>['insertMany']>[1]): Promise<InsertBatchResult> {
        return insertBatchForAccessor(this.batchContext('insertBatch'), documents, options);
    }

    /** Applies an update to matching documents in configurable batches. */
    async updateBatch(
        filter: Parameters<Collection<TSchema>['find']>[0],
        update: Parameters<Collection<TSchema>['updateMany']>[1],
        options?: UpdateBatchOptions & Parameters<Collection<TSchema>['updateMany']>[2],
    ): Promise<UpdateBatchResult> {
        return updateBatchForAccessor(this.batchContext('updateBatch'), filter, update, options);
    }

    /** Deletes matching documents in configurable batches. */
    async deleteBatch(
        filter: Parameters<Collection<TSchema>['find']>[0],
        options?: UpdateBatchOptions & Parameters<Collection<TSchema>['deleteMany']>[1],
    ): Promise<DeleteBatchResult> {
        return deleteBatchForAccessor(this.batchContext('deleteBatch'), filter, options);
    }

    /** Atomically increments one or more numeric fields on a matching document. */
    async incrementOne(
        filter: Parameters<Collection<TSchema>['findOneAndUpdate']>[0],
        field: string | Record<string, number>,
        incrementOrOptions?: number | IncrementOneOptions,
        maybeOptions?: IncrementOneOptions,
    ): Promise<import('../writes/index.js').IncrementOneResult<TSchema>> {
        return incrementOneForAccessor(this.batchContext('incrementOne'), filter, field, incrementOrOptions, maybeOptions);
    }

    /** Creates a single index on the collection. */
    async createIndex(keys: Document, options?: Parameters<Collection<TSchema>['createIndex']>[1]): Promise<IndexCreateResult> {
        this.assertWritePath('createIndex', 'management');
        return createIndexForAccessor(this.collectionRef, keys, options);
    }

    /** Creates multiple indexes in a single command. */
    async createIndexes(specs: Array<{ key: Document; } & Record<string, unknown>>): Promise<string[]> { this.assertWritePath('createIndexes', 'management'); return createIndexesForAccessor(this.collectionRef, specs); }

    /** Lists all indexes on the collection. */
    async listIndexes(): Promise<Record<string, unknown>[]> { return listIndexesForAccessor(this.collectionRef); }

    /** Drops a named index from the collection. */
    async dropIndex(name: string): ReturnType<Collection<TSchema>['dropIndex']> { this.assertWritePath('dropIndex', 'management'); return dropIndexForAccessor(this.collectionRef, name); }

    /** Drops all non-`_id` indexes from the collection. */
    async dropIndexes(): ReturnType<Collection<TSchema>['dropIndexes']> { this.assertWritePath('dropIndexes', 'management'); return dropIndexesForAccessor(this.collectionRef); }

    /** Pre-populates bookmark cache entries for the specified key dimensions and page numbers. */
    async prewarmBookmarks(keyDims: BookmarkKeyDims<TSchema> = {}, pages: number[] = []): Promise<BookmarkPrewarmResult> {
        return prewarmBookmarksForAccessor(this.bookmarkContext(), keyDims, pages);
    }

    /** Lists cached bookmark entries, optionally filtered by key dimensions. */
    async listBookmarks(keyDims?: BookmarkKeyDims<TSchema>): Promise<BookmarkListResult> {
        return listBookmarksForAccessor(this.bookmarkContext(), keyDims);
    }

    /** Removes cached bookmark entries, optionally scoped to specific key dimensions. */
    async clearBookmarks(keyDims?: BookmarkKeyDims<TSchema>): Promise<BookmarkClearResult> {
        return clearBookmarksForAccessor(this.bookmarkContext(), keyDims);
    }

    async invalidate(op?: 'find' | 'findOne' | 'count' | 'findPage' | 'all' | string): Promise<number> { return this.invalidateReadCaches(op); }

    /** Drops the collection from the database. */
    async dropCollection(): Promise<boolean> { this.assertWritePath('dropCollection', 'management'); return dropCollectionForAccessor(this.collectionRef); }

    /** Creates a collection (or a named alternative) with the given options. */
    async createCollection(name?: string, options: Record<string, unknown> = {}): Promise<boolean> {
        this.assertManagementWriteTargets('createCollection', name);
        return createCollectionForAccessor(this.collectionRef, this.collectionName, this.dbRef, name, options);
    }

    /** Creates a MongoDB view backed by the given source collection and aggregation pipeline. */
    async createView(name: string, source: string, pipeline: unknown[] = []): Promise<boolean> {
        this.assertManagementWriteTargets('createView', name);
        return createViewForAccessor(this.collectionRef, this.dbRef, name, source, pipeline);
    }

    /** Returns usage statistics for each index on the collection. */
    async indexStats(): Promise<unknown[]> { return indexStatsForAccessor(this.collectionRef); }

    /** Sets the JSON Schema validator and optional validation level/action for the collection. */
    async setValidator(validator: unknown, options: { validationLevel?: string; validationAction?: string } = {}): Promise<{ ok: number; collection: string }> {
        this.assertWritePath('setValidator', 'management');
        return setValidatorForAccessor(this.collectionRef, this.collectionName, this.dbRef, validator, options);
    }

    /** Sets the validation level (`off`, `moderate`, or `strict`) for the collection. */
    async setValidationLevel(level: unknown): Promise<{ ok: number; validationLevel: string }> {
        this.assertWritePath('setValidationLevel', 'management');
        return setValidationLevelForAccessor(this.collectionRef, this.collectionName, this.dbRef, level);
    }

    /** Sets the validation action (`error` or `warn`) for the collection. */
    async setValidationAction(action: unknown): Promise<{ ok: number; validationAction: string }> {
        this.assertWritePath('setValidationAction', 'management');
        return setValidationActionForAccessor(this.collectionRef, this.collectionName, this.dbRef, action);
    }

    /** Retrieves the current validator schema, validation level, and validation action. */
    async getValidator(): Promise<{ validator: Record<string, unknown> | null; validationLevel: string; validationAction: string; }> {
        return getValidatorForAccessor(this.collectionRef, this.collectionName, this.dbRef);
    }

    /** Returns storage and document statistics for the collection. */
    async stats(options: { scale?: number } = {}): Promise<{ ns: string; count: number; size: number; storageSize: number; totalIndexSize: number; nindexes: number; avgObjSize?: number; scaleFactor?: number; }> {
        return statsForAccessor(this.collectionRef, this.dbName, this.collectionName, options);
    }

    /** Renames the collection, optionally dropping an existing target collection. */
    async renameCollection(newName: unknown, options: { dropTarget?: boolean } = {}): Promise<{ renamed: boolean; from: string; to: string }> {
        this.assertManagementWriteTargets('renameCollection', newName);
        return renameCollectionForAccessor(this.collectionRef, this.collectionName, newName, options);
    }

    /** Runs a `collMod` command to modify collection options or validator settings. */
    async collMod(modifications: unknown): Promise<Record<string, unknown>> {
        this.assertWritePath('collMod', 'management');
        return collModForAccessor(this.collectionRef, this.collectionName, this.dbRef, modifications);
    }

    /** Converts the collection to a capped collection with the given maximum byte size. */
    async convertToCapped(size: unknown, options: { max?: number } = {}): Promise<{ ok: number; collection: string; capped: boolean; size: number }> {
        this.assertWritePath('convertToCapped', 'management');
        return convertToCappedForAccessor(this.collectionRef, this.collectionName, this.dbRef, size, options);
    }

    private assertWritePath(operation: string, category: WritePathOperationCategory, namespace: CollectionNamespaceView = this.getNamespace()): void {
        const source = getCurrentWritePathSource() ?? 'collection';
        assertWritePathAllowed({
            policy: this.management.defaults?.writePathPolicy,
            namespace,
            source: source as WritePathSource,
            operation,
            category,
            logger: this.management.logger,
        });
    }

    private assertManagementWriteTargets(operation: string, targetCollectionName?: unknown): void {
        this.assertWritePath(operation, 'management');
        if (
            typeof targetCollectionName === 'string'
            && targetCollectionName.length > 0
            && targetCollectionName !== this.collectionName
        ) {
            this.assertWritePath(
                operation,
                'management',
                this.buildNamespaceView(this.dbName, targetCollectionName),
            );
        }
    }

    private batchContext(operation: string) {
        this.assertWritePath(operation, 'batch');
        return {
            collectionRef: this.collectionRef,
            cvFilter: <T>(value: T) => this._cvFilter(value),
            cvDoc: <T>(value: T) => this._cvDoc(value),
            cvUpdate: <T>(value: T) => this._cvUpdate(value),
            prepareCacheForWrite: (options?: unknown) => this.prepareReadCachesBeforeWrite(options),
            invalidateAll: (options?: unknown) => this.invalidateReadCachesAfterWrite(options),
        };
    }

    private writeContext(operation: string) {
        this.assertWritePath(operation, 'write');
        return {
            dbName: this.dbName,
            collectionName: this.collectionName,
            collectionRef: this.collectionRef,
            defaults: this.management.defaults,
            logger: this.management.logger,
            cvFilter: <T>(value: T) => this._cvFilter(value),
            cvDoc: <T>(value: T) => this._cvDoc(value),
            cvUpdate: <T>(value: T) => this._cvUpdate(value),
            prepareCacheForWrite: (options?: unknown) => this.prepareReadCachesBeforeWrite(options),
            invalidateAll: (options?: unknown) => this.invalidateReadCachesAfterWrite(options),
        };
    }

    private bookmarkContext() {
        return {
            namespace: `${this.dbName}:${this.collectionName}`,
            cache: this.management.cache,
            getCache: this.management.getCache,
            logger: this.management.logger,
            findPage: (options: FindPageOptions<TSchema>) => this.findPage(options),
        };
    }

    private resolveFindOptions(
        optionsOrProjection?: (Parameters<Collection<TSchema>['find']>[1] & { stream?: boolean }) | string[] | Record<string, unknown>,
        maybeOptions?: Parameters<Collection<TSchema>['find']>[1] & { stream?: boolean },
    ): (Parameters<Collection<TSchema>['find']>[1] & { stream?: boolean }) | undefined {
        if (maybeOptions === undefined) {
            return optionsOrProjection as (Parameters<Collection<TSchema>['find']>[1] & { stream?: boolean }) | undefined;
        }

        const projection = normalizeProjection(optionsOrProjection as string[] | Record<string, unknown> | null | undefined);
        const resolvedOptions = { ...(maybeOptions as Record<string, unknown>) };
        if (projection !== undefined) {
            resolvedOptions.projection = projection;
        }
        return resolvedOptions as Parameters<Collection<TSchema>['find']>[1] & { stream?: boolean };
    }
}

