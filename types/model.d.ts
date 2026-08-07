import type { BookmarkClearResult, BookmarkListResult, BookmarkPrewarmResult, DeleteBatchResult, DeleteResult, IncrementOneResult, IndexCreateResult, InsertBatchResult, InsertManyResult, InsertOneResult, UpdateBatchResult, UpdateResult, VectorSearchHit, VectorSearchOptions } from './collection';
import type { SchemaDslRuntime } from 'schema-dsl/runtime';

/**
 * Runtime-scoped schema-dsl namespace passed to Model schema callbacks.
 */
export type ModelSchemaDsl = SchemaDslRuntime['s'];

/**
 * Schema DSL transformer function.
 * @since v1.0.0
 */
export type SchemaDSL = (s: ModelSchemaDsl) => unknown;

/**
 * Default value for a model field — either a static value or a factory function.
 * @template T Field value type
 * @since v1.0.0
 */
export type DefaultValue<T = unknown> = T | ((context?: unknown, doc?: unknown) => T);

export interface ValidationResult {
    valid: boolean;
    errors?: Array<{
        field: string;
        message: string;
        value?: unknown;
    }>;
    data?: unknown;
}

export interface HookContext {
    operation: string;
    collection: string;
    data?: unknown;
    filter?: unknown;
    update?: unknown;
    result?: unknown;
    error?: Error;
    [key: string]: unknown;
}

export interface ModelConnection {
    pool?: string;
    database?: string;
}

export interface RelationConfig {
    from: string;
    localField: string;
    foreignField: string;
    single?: boolean;
    /** Default inclusion projection for this relation. Call-site `populate().select` takes precedence. */
    select?: string | string[];
}

export interface PopulateConfig {
    path: string;
    select?: string | string[];
    match?: Record<string, unknown>;
    sort?: Record<string, 1 | -1>;
    limit?: number;
    skip?: number;
    /** Maximum nested populate depth for this branch. Defaults to 5. */
    maxDepth?: number;
    populate?: string | PopulateConfig | Array<string | PopulateConfig>;
}

/** Vector search options at the Model layer, including Model soft-delete visibility. */
export interface ModelVectorSearchOptions extends VectorSearchOptions {
    withDeleted?: boolean;
    onlyDeleted?: boolean;
}

/** Bounds and filters for inspecting registered, declared inbound Model relations. */
export interface RelationUsageOptions {
    session?: unknown;
    maxTargets?: number;
    maxSamples?: number;
    includeRelations?: string[];
    excludeRelations?: string[];
    /** Defaults to true so soft-deleted source documents still protect a target. */
    includeSoftDeletedReferences?: boolean;
}

export interface RelationUsageEntry {
    sourceModel: string;
    sourceCollection: string;
    relation: string;
    localField: string;
    foreignField: string;
    count: number;
    sampleIds: unknown[];
}

export interface RelationUsageCoverage {
    mode: 'registered-declared';
    complete: boolean;
    registryModels: string[];
    checkedModels: string[];
    skipped: Array<{
        sourceModel: string;
        reason: string;
    }>;
}

export interface RelationUsageReport {
    used: boolean;
    target: {
        matchedCount: number;
        truncated: boolean;
        sampleIds: unknown[];
    };
    checkedRelations: number;
    usages: RelationUsageEntry[];
    coverage: RelationUsageCoverage;
}

/** Result from a protected single-document delete after a relation usage check. */
export interface RelationProtectedDeleteResult<TResult = unknown> {
    result: TResult;
    usage: RelationUsageReport;
}

/** Driver delete options plus bounds for the protected relation preflight. */
export type RelationProtectedDeleteOptions = Omit<RelationUsageOptions, 'includeRelations' | 'excludeRelations'> & {
    /** Protected deletion never permits narrowing the declared-relation scan. */
    includeRelations?: never;
    /** Protected deletion never permits narrowing the declared-relation scan. */
    excludeRelations?: never;
    [key: string]: unknown;
};

export interface VirtualConfig {
    get: (this: Record<string, unknown>) => unknown;
    set?: (this: Record<string, unknown>, value: unknown) => void;
}

export type ModelAutoIndexOptions = boolean | {
    /** Enable automatic model index creation. Defaults to true for backward compatibility. */
    enabled?: boolean;
    /** Emit `model-index-error` when automatic index creation fails or conflicts are detected. Defaults to true. */
    emitEvents?: boolean;
};

export type ModelVersionUpdateManyMode = 'counter' | 'strict' | 'off';

export interface ModelVersionOptions {
    enabled?: boolean;
    field?: string;
    /**
     * Version handling for updateMany on versioned models.
     * - counter: native batch update plus version increment; not optimistic locking.
     * - strict: pre-read IDs/versions and conditionally update each document.
     * - off: skip version handling for this batch update.
     */
    updateMany?: ModelVersionUpdateManyMode;
}

export type ModelWriteOptions = Record<string, unknown> & {
    expectedVersion?: number;
    version?: number;
};

export type ModelUpdateManyOptions = ModelWriteOptions & {
    versionMode?: ModelVersionUpdateManyMode;
};

export type ModelStrictUpdateManyResult = UpdateResult & {
    conflictCount: number;
    conflictedIds: unknown[];
};

export type ModelIndexSource = 'definition' | 'softDelete';

export interface ModelDeclaredIndex {
    source: ModelIndexSource;
    key: unknown;
    options: Record<string, unknown>;
    name?: string;
    fingerprint: string;
}

export interface ModelIndexNamespace {
    db: string;
    collection: string;
    poolName: string;
}

export interface ModelIndexErrorSummary {
    name?: string;
    message: string;
    code?: unknown;
}

export interface ModelIndexEnsureExisting {
    declared: ModelDeclaredIndex;
    existing: Record<string, unknown>;
}

export interface ModelIndexConflict {
    declared: ModelDeclaredIndex;
    existing?: Record<string, unknown>;
    reason: string;
}

export interface ModelIndexCreated {
    declared: ModelDeclaredIndex;
    name?: string;
    result?: unknown;
}

export interface ModelIndexFailure {
    declared: ModelDeclaredIndex;
    error: ModelIndexErrorSummary;
}

export interface ModelIndexSkipped {
    declared: ModelDeclaredIndex;
    reason: string;
}

export interface ModelEnsureIndexesOptions {
    /** Return the index diff without creating missing indexes. */
    dryRun?: boolean;
    /** Throw a MonSQLize `MONGODB_ERROR` when conflicts or creation failures are found. */
    throwOnError?: boolean;
}

export interface ModelEnsureAllIndexesOptions extends ModelEnsureIndexesOptions {
    /** Limit the operation to specific registered model names. Defaults to all models. */
    models?: string[];
    /** Optional database scope for models without their own connection override. */
    database?: string;
    /** Optional pool scope for models without their own connection override. */
    pool?: string;
}

export interface ModelIndexEnsureResult {
    dryRun: boolean;
    namespace: ModelIndexNamespace;
    declared: ModelDeclaredIndex[];
    existing: ModelIndexEnsureExisting[];
    missing: ModelDeclaredIndex[];
    created: ModelIndexCreated[];
    conflicts: ModelIndexConflict[];
    failed: ModelIndexFailure[];
    skipped: ModelIndexSkipped[];
}

export interface ModelIndexEnsureSummary {
    dryRun: boolean;
    models: Array<{ name: string; result: ModelIndexEnsureResult }>;
    totals: {
        declared: number;
        existing: number;
        missing: number;
        created: number;
        conflicts: number;
        failed: number;
        skipped: number;
    };
}

/** v1 hooks factory format */
export type V1HooksFactory<TDocument = Record<string, unknown>> = (
    model: ModelInstance<TDocument>,
) => {
    find?: {
        before?: (ctx: Record<string, unknown>, ...args: unknown[]) => unknown;
        after?: (ctx: Record<string, unknown>, result: unknown) => unknown;
    };
    insert?: {
        before?: (ctx: Record<string, unknown>, ...args: unknown[]) => unknown;
        after?: (ctx: Record<string, unknown>, result: unknown) => unknown;
    };
    update?: {
        before?: (ctx: Record<string, unknown>, ...args: unknown[]) => unknown;
        after?: (ctx: Record<string, unknown>, result: unknown) => unknown;
    };
    delete?: {
        before?: (ctx: Record<string, unknown>, ...args: unknown[]) => unknown;
        after?: (ctx: Record<string, unknown>, result: unknown) => unknown;
    };
};

/** v1 methods factory format */
export type V1MethodsFactory<TDocument = Record<string, unknown>> = (
    model: ModelInstance<TDocument>,
) => {
    instance?: Record<string, (this: TDocument & Record<string, unknown>, ...args: unknown[]) => unknown>;
    static?: Record<string, (...args: unknown[]) => unknown>;
};

export interface ModelDefinitionOptions {
    timestamps?: boolean | { createdAt?: string | boolean; updatedAt?: string | boolean };
    validate?: boolean;
    autoIndex?: ModelAutoIndexOptions;
    softDelete?: boolean | {
        enabled?: boolean;
        field?: string;
        type?: string;
        ttl?: number | null;
    };
    version?: boolean | ModelVersionOptions;
}

export interface ModelDefinition<TDocument = Record<string, unknown>> {
    /** Actual MongoDB collection name; falls back to `name` and then the `Model.define()` registration name. */
    collection?: string;
    /** Compatibility collection name used by model auto-loading files; `collection` has higher priority. */
    name?: string;
    enums?: Record<string, string>;
    schema?: SchemaDSL | Record<string, unknown>;
    defaults?: Record<string, unknown | ((context?: unknown, doc?: TDocument) => unknown)>;
    hooks?:
    | {
        beforeCreate?: (context: HookContext) => Promise<void> | void;
        afterCreate?: (context: HookContext) => Promise<void> | void;
        beforeInsert?: (context: HookContext) => Promise<void> | void;
        afterInsert?: (context: HookContext) => Promise<void> | void;
        beforeUpdate?: (context: HookContext) => Promise<void> | void;
        afterUpdate?: (context: HookContext) => Promise<void> | void;
        beforeDelete?: (context: HookContext) => Promise<void> | void;
        afterDelete?: (context: HookContext) => Promise<void> | void;
        beforeFind?: (context: HookContext) => Promise<void> | void;
        afterFind?: (context: HookContext) => Promise<void> | void;
    }
    | V1HooksFactory<TDocument>;
    methods?:
    | Record<string, (this: TDocument & Record<string, unknown>, ...args: unknown[]) => unknown>
    | V1MethodsFactory<TDocument>;
    statics?: Record<string, (...args: unknown[]) => unknown>;
    relations?: Record<string, RelationConfig>;
    virtuals?: Record<string, VirtualConfig>;
    connection?: ModelConnection;
    indexes?: Array<{ key: unknown } & Record<string, unknown>>;
    options?: ModelDefinitionOptions;
}

export interface RegisteredModel<TDocument = Record<string, unknown>> {
    collectionName: string;
    definition: ModelDefinition<TDocument>;
}

export interface ModelScopeOptions {
    database?: string;
    pool?: string;
}

export interface PopulateProxy<T = unknown> extends Promise<T> {
    populate(path: string | PopulateConfig | Array<string | PopulateConfig>, options?: Partial<Omit<PopulateConfig, 'path'>>): PopulateProxy<T>;
    exec(): Promise<T>;
}

type LegacyModelPageInfo<TDocument = any> = unknown extends TDocument ? any : {
    hasNext: boolean;
    hasPrev: boolean;
    startCursor: string | null;
    endCursor: string | null;
    currentPage?: number;
};
type LegacyModelTotalsInfo<TDocument = any> = unknown extends TDocument ? any : import('./collection').TotalsInfo;
type LegacyModelSyncTotalsInfo<TDocument = any> = unknown extends TDocument ? any : (import('./collection').TotalsInfo & {
    mode: 'sync';
    total: number;
    totalPages: number;
});
export type RestoreResult = Pick<UpdateResult, 'modifiedCount'> & Partial<UpdateResult>;

export type ModelDocument<TDocument = any> = TDocument & Record<string, unknown> & {
    save(): Promise<ModelDocument<TDocument>>;
    remove(): Promise<boolean>;
    validate(): Promise<ValidationResult>;
    populate(path: string | PopulateConfig | Array<string | PopulateConfig>): PopulateProxy<ModelDocument<TDocument> | null>;
    toObject(): TDocument & Record<string, unknown>;
    toJSON(): TDocument & Record<string, unknown>;
};

export interface ModelInstance<TDocument = any> {
    readonly collectionName: string;
    readonly dbName: string;
    readonly poolName?: string;
    readonly definition: ModelDefinition<TDocument>;
    /** Returns namespace metadata for the current model, including instance ID, type, database, and collection. */
    getNamespace(): { iid: string; type: 'mongodb'; db: string; collection: string; pool?: string; };
    /** Returns the relation config map declared by the current model. */
    getRelations(): Record<string, RelationConfig>;
    /** Returns the enum value map declared by the current model. */
    getEnums(): Record<string, string>;
    /** Returns the underlying native MongoDB Collection for raw operations not wrapped by the framework. */
    raw(): unknown;
    /**
     * Finds documents matching the query.
     * @param query Optional filter.
     * @param options Optional query options such as projection, sort, and limit.
     * @returns Document array with chainable `.populate()` support.
     */
    find(query?: unknown, options?: unknown): PopulateProxy<Array<ModelDocument<TDocument>>>;
    /**
     * Finds the first document matching the query.
     * @param query Optional filter.
     * @param options Optional query options.
     * @returns The matching document, or `null` when none is found.
     */
    findOne(query?: unknown, options?: unknown): PopulateProxy<ModelDocument<TDocument> | null>;
    /**
     * Finds a single document by primary ID, as an ID shortcut for `findOne`.
     * @param id Document primary key value.
     * @param options Optional query options.
     * @returns The matching document, or `null` when none is found.
     */
    findOneById(id: unknown, options?: unknown): PopulateProxy<ModelDocument<TDocument> | null>;
    /**
     * Finds a single document by primary ID; alias of `findOneById`.
     * @param id Document primary key value.
     * @param options Optional query options.
     * @returns The matching document, or `null` when none is found.
     */
    findById(id: unknown, options?: unknown): PopulateProxy<ModelDocument<TDocument> | null>;
    /**
     * Finds documents by multiple primary IDs.
     * @param ids Primary key values.
     * @param options Optional query options.
     * @returns Matching documents.
     */
    findByIds(ids: unknown[], options?: unknown): PopulateProxy<Array<ModelDocument<TDocument>>>;
    /**
     * Finds documents with cursor-based or page-number pagination.
     * @param options Pagination options including `limit`, `cursor`/`page`, `filter`, and `sort`.
     * @returns Result object containing items, page information, and optional totals.
     */
    findPage(options: { totals: { mode: 'sync'; } & Record<string, unknown>; } & Record<string, unknown>): PopulateProxy<{
        items: Array<ModelDocument<TDocument>>;
        pageInfo: LegacyModelPageInfo<TDocument>;
        totals: LegacyModelSyncTotalsInfo<TDocument>;
        meta?: import('./collection').MetaInfo;
    }>;
    findPage(options?: unknown): PopulateProxy<{
        items: Array<ModelDocument<TDocument>>;
        pageInfo: LegacyModelPageInfo<TDocument>;
        totals?: LegacyModelTotalsInfo<TDocument>;
        meta?: import('./collection').MetaInfo;
    }>;
    /**
     * Finds documents and returns the unpaginated total count.
     * @param query Optional filter.
     * @param options Optional query options.
     * @returns Object containing documents and total count.
     */
    findAndCount(query?: unknown, options?: unknown): PopulateProxy<{
        data: Array<ModelDocument<TDocument>>;
        total: number;
    }>;
    /**
     * Runs Vector Search while applying Model soft-delete visibility and hydrating hit documents.
     * The returned order and score are produced by MongoDB Vector Search.
     */
    vectorSearch(options: ModelVectorSearchOptions): Promise<Array<VectorSearchHit<ModelDocument<TDocument>>>>;
    /**
     * Counts documents matching the query.
     * @param query Optional filter.
     * @param options Optional count options.
     * @returns Number of matching documents.
     */
    count(query?: unknown, options?: unknown): Promise<number>;
    /**
     * Inserts a single document.
     * @param document Document data to insert.
     * @param options Optional write options.
     * @returns Result object containing the inserted ID.
     */
    insertOne(document?: unknown, options?: unknown): Promise<InsertOneResult>;
    /**
     * Inserts multiple documents in order, stopping on the first error.
     * @param documents Documents to insert.
     * @param options Optional write options.
     */
    insertMany(documents?: unknown[], options?: unknown): Promise<InsertManyResult>;
    /**
     * Updates the first document matching the filter.
     * @param filter Filter.
     * @param update Update operator document, such as `$set` or `$inc`.
     * @param options Optional update options.
     */
    updateOne(filter?: unknown, update?: unknown, options?: ModelWriteOptions): Promise<UpdateResult>;
    /**
     * Updates all documents matching the filter.
     * @param filter Filter.
     * @param update Update operator document.
     * @param options Optional update options.
     */
    updateMany(filter?: unknown, update?: unknown, options?: ModelUpdateManyOptions): Promise<UpdateResult>;
    /**
     * Replaces the first document matching the filter with a full replacement document.
     * @param filter Filter.
     * @param replacement Full replacement document.
     * @param options Optional replacement options.
     */
    replaceOne(filter?: unknown, replacement?: unknown, options?: ModelWriteOptions): Promise<UpdateResult>;
    /**
     * Atomically finds and updates one document.
     * @param filter Filter.
     * @param update Update operator document.
     * @param options Optional options such as `returnDocument: 'after'`.
     * @returns Updated document, or `null` when none is found.
     */
    findOneAndUpdate(filter?: unknown, update?: unknown, options?: ModelWriteOptions): Promise<TDocument | null>;
    /**
     * Atomically finds and replaces one document.
     * @param filter Filter.
     * @param replacement Full replacement document.
     * @param options Optional options.
     * @returns Replaced document, or `null` when none is found.
     */
    findOneAndReplace(filter?: unknown, replacement?: unknown, options?: ModelWriteOptions): Promise<TDocument | null>;
    /**
     * Atomically finds and deletes one document.
     * @param filter Filter.
     * @param options Optional options.
     * @returns Deleted document, or `null` when none is found.
     */
    findOneAndDelete(filter?: unknown, options?: unknown): Promise<TDocument | null>;
    /**
     * Updates an existing document or inserts one when none matches.
     * @param filter Filter.
     * @param update Update operator document.
     * @param options Optional update options.
     * @returns Standard `UpdateResult` object.
     */
    upsertOne(filter?: unknown, update?: unknown, options?: unknown): Promise<UpdateResult>;
    /**
     * Atomically increments a field on one matching document.
     * @param filter Filter.
     * @param field Field name or field-increment map.
     * @param increment Increment value used when `field` is a string.
     * @param options Optional update options.
     */
    incrementOne(filter?: unknown, field?: string | Record<string, number>, increment?: number, options?: unknown): Promise<IncrementOneResult<TDocument>>;
    /**
     * Deletes the first document matching the filter.
     * @param filter Filter.
     * @param options Optional delete options.
     * @returns Standard `DeleteResult` object.
     */
    deleteOne(filter?: unknown, options?: unknown): Promise<DeleteResult>;
    /**
     * Deletes all documents matching the filter.
     * @param filter Filter.
     * @param options Optional delete options.
     * @returns Standard `DeleteResult` object.
     */
    deleteMany(filter?: unknown, options?: unknown): Promise<DeleteResult>;
    /**
     * Reports declared, registered Model relations currently using matching target documents.
     * This is a read-only best-effort scan; inspect `coverage.complete` before relying on it.
     */
    checkRelationUsage(filter?: unknown, options?: RelationUsageOptions): Promise<RelationUsageReport>;
    /**
     * Deletes one visible target only after a complete declared-relation usage scan finds no references.
     * Existing `deleteOne` behavior is otherwise preserved.
     */
    deleteOneWithRelations(filter: unknown, options?: RelationProtectedDeleteOptions): Promise<RelationProtectedDeleteResult>;
    /**
     * Physically deletes one target, including soft-deleted documents, only after the same protected scan.
     */
    forceDeleteWithRelations(filter: unknown, options?: RelationProtectedDeleteOptions): Promise<RelationProtectedDeleteResult>;
    // soft-delete extended methods
    /**
     * Finds matching documents, including soft-deleted documents.
     * @param query Optional filter.
     * @param options Optional query options.
     */
    findWithDeleted(query?: unknown, options?: unknown): PopulateProxy<Array<ModelDocument<TDocument>>>;
    /**
     * Finds only soft-deleted documents.
     * @param query Optional filter.
     * @param options Optional query options.
     */
    findOnlyDeleted(query?: unknown, options?: unknown): PopulateProxy<Array<ModelDocument<TDocument>>>;
    /**
     * Finds the first matching document, including soft-deleted documents.
     * @param query Optional filter.
     * @param options Optional query options.
     * @returns Matching document, or `null` when none is found.
     */
    findOneWithDeleted(query?: unknown, options?: unknown): PopulateProxy<ModelDocument<TDocument> | null>;
    /**
     * Restores the first soft-deleted document matching the filter.
     * @param filter Filter.
     * @param options Optional update options.
     */
    restore(filter?: unknown, options?: unknown): Promise<RestoreResult>;
    /**
     * Restores all soft-deleted documents matching the filter.
     * @param filter Filter.
     * @param options Optional update options.
     */
    restoreMany(filter?: unknown, options?: unknown): Promise<RestoreResult>;
    /**
     * Physically deletes the first matching document, bypassing soft-delete.
     * @param filter Filter.
     * @param options Optional delete options.
     * @returns Standard `DeleteResult` object.
     */
    forceDelete(filter?: unknown, options?: unknown): Promise<DeleteResult>;
    /**
     * Physically deletes all matching documents, bypassing soft-delete.
     * @param filter Filter.
     * @param options Optional delete options.
     * @returns Standard `DeleteResult` object.
     */
    forceDeleteMany(filter?: unknown, options?: unknown): Promise<DeleteResult>;
    /**
     * Finds the first matching document from only the soft-deleted set.
     * @param query Optional filter.
     * @param options Optional query options.
     * @returns Matching deleted document, or `null` when none is found.
     */
    findOneOnlyDeleted(query?: unknown, options?: unknown): PopulateProxy<ModelDocument<TDocument> | null>;
    /**
     * Counts matching documents, including soft-deleted documents.
     * @param query Optional filter.
     * @param options Optional count options.
     */
    countWithDeleted(query?: unknown, options?: unknown): Promise<number>;
    /**
     * Counts soft-deleted documents matching the query.
     * @param query Optional filter.
     * @param options Optional count options.
     */
    countOnlyDeleted(query?: unknown, options?: unknown): Promise<number>;
    /**
     * Inserts a large document batch through the write queue.
     * @param docs Documents to insert.
     * @param options Optional batch write options.
     */
    insertBatch(docs: unknown[], options?: unknown): Promise<InsertBatchResult>;
    /**
     * Batch-updates matching documents using `bulkWrite`.
     * @param filter Filter.
     * @param update Update operator document.
     * @param options Optional batch write options.
     */
    updateBatch(filter?: unknown, update?: unknown, options?: unknown): Promise<UpdateBatchResult>;
    /** Batch-deletes matching documents. */
    deleteBatch(filter?: unknown, options?: unknown): Promise<DeleteBatchResult>;
    /**
     * Creates a single index on the collection.
     * @param keys Index key specification.
     * @param options Optional index options such as `unique` or `sparse`.
     * @returns Index creation result.
     */
    createIndex(keys: unknown, options?: unknown): Promise<IndexCreateResult>;
    /**
     * Creates multiple indexes.
     * @param specs Index specifications, each containing `key` and optional index options.
     * @returns Names of created indexes.
     */
    createIndexes(specs: Array<{ key: unknown; } & Record<string, unknown>>): Promise<string[]>;
    /** Lists all existing index definitions on the collection. */
    listIndexes(): Promise<Record<string, unknown>[]>;
    /**
     * Compares declared model indexes with the database and optionally creates missing indexes.
     * Does not drop, rename, or rebuild conflicting indexes.
     */
    ensureIndexes(options?: ModelEnsureIndexesOptions): Promise<ModelIndexEnsureResult>;
    /**
     * Drops the specified index by name.
     * @param name Index name.
     */
    dropIndex(name: string): Promise<unknown>;
    /** Drops all non-`_id` indexes on the collection. */
    dropIndexes(): Promise<unknown>;
    /** Prewarms cursor pagination bookmark cache. */
    prewarmBookmarks(keyDims?: unknown, pages?: number[]): Promise<BookmarkPrewarmResult>;
    /** Lists cursor pagination bookmark cache entries. */
    listBookmarks(keyDims?: unknown): Promise<BookmarkListResult>;
    /** Clears cursor pagination bookmark cache entries. */
    clearBookmarks(keyDims?: unknown): Promise<BookmarkClearResult>;
    /**
     * Gets distinct values for a field from matching documents.
     * @param key Target field name.
     * @param query Optional filter.
     * @param options Optional driver-level options.
     * @returns Distinct values.
     */
    distinct(key: string, query?: unknown, options?: unknown): Promise<unknown[]>;
    /**
     * Executes an aggregation pipeline and returns result documents.
     * @param pipeline Aggregation stages.
     * @param options Optional aggregation options such as `allowDiskUse`.
     * @returns Aggregation result documents.
     */
    aggregate(pipeline?: unknown[], options?: unknown): Promise<unknown[]>;
    /** Returns a readable stream for matching query results. */
    stream(query?: unknown, options?: unknown): NodeJS.ReadableStream;
    /** Returns the MongoDB query execution plan. */
    explain(query?: unknown, options?: unknown): Promise<unknown>;
    /** Manually invalidates read cache for the current model collection. */
    invalidate(op?: 'find' | 'findOne' | 'count' | 'findPage' | 'aggregate' | 'distinct'): Promise<number>;
    /** Drops the collection for the current model. */
    dropCollection(): Promise<boolean>;
    /** Creates the current collection or a collection with the specified name. */
    createCollection(name?: string, options?: Record<string, unknown>): Promise<boolean>;
    /** Creates a MongoDB view. */
    createView(name: string, source: string, pipeline?: unknown[]): Promise<boolean>;
    /** Returns index usage statistics. */
    indexStats(): Promise<unknown[]>;
    /** Sets the collection JSON Schema validator. */
    setValidator(validator: unknown, options?: { validationLevel?: string; validationAction?: string }): Promise<{ ok: number; collection: string }>;
    /** Sets the collection validation level. */
    setValidationLevel(level: 'off' | 'moderate' | 'strict' | string): Promise<{ ok: number; validationLevel: string }>;
    /** Sets the collection validation action. */
    setValidationAction(action: 'error' | 'warn' | string): Promise<{ ok: number; validationAction: string }>;
    /** Reads the collection validator and validation settings. */
    getValidator(): Promise<{ validator: Record<string, unknown> | null; validationLevel: string; validationAction: string }>;
    /** Returns collection storage and index statistics. */
    stats(options?: { scale?: number }): Promise<{ ns: string; count: number; size: number; storageSize: number; totalIndexSize: number; nindexes: number; avgObjSize?: number; scaleFactor?: number }>;
    /** Renames the collection for the current model. */
    renameCollection(newName: string, options?: { dropTarget?: boolean }): Promise<{ renamed: boolean; from: string; to: string }>;
    /** Executes a collMod management command. */
    collMod(modifications: Record<string, unknown>): Promise<Record<string, unknown>>;
    /** Converts the collection to a capped collection. */
    convertToCapped(size: number, options?: { max?: number }): Promise<{ ok: number; collection: string; capped: boolean; size: number }>;
    /**
     * Opens a ChangeStream on the collection.
     * @param pipeline Optional aggregation filter pipeline.
     * @param options Optional ChangeStream options.
     * @returns Native MongoDB ChangeStream object.
     */
    watch(pipeline?: unknown[], options?: unknown): import('mongodb').ChangeStream;
    /**
     * Validates document data against the model schema definition.
     * @param document Document to validate.
     * @returns Validation result containing the `valid` flag and error details.
     */
    validate(document?: unknown): ValidationResult;
}

export declare class Model {
    static define<TDocument = Record<string, unknown>>(collectionName: string, definition: ModelDefinition<TDocument>): void;
    static get<TDocument = Record<string, unknown>>(collectionName: string): RegisteredModel<TDocument> | undefined;
    static has(collectionName: string): boolean;
    static list(): string[];
    static undefine(collectionName: string): boolean;
    static redefine<TDocument = Record<string, unknown>>(collectionName: string, definition: ModelDefinition<TDocument>): void;
    static _clear(): void;
}



