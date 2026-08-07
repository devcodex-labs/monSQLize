import type { ChangeStream, Document, FindOptions as MongoFindOptions, Sort } from 'mongodb';
import type {
    AggregateOptions,
    MetaOptions,
    VectorSearchHit,
    VectorSearchOptions,
} from './aggregation';

export type {
    AggregateOptions,
    MetaOptions,
    VectorSearchAggregateOptions,
    VectorSearchHit,
    VectorSearchOptions,
} from './aggregation';

export type CacheInvalidationOperation =
    | 'find'
    | 'findOne'
    | 'count'
    | 'findPage'
    | 'aggregate'
    | 'distinct'
    | 'findOneById'
    | 'findByIds'
    | 'all';

export type CacheInvalidationEntry =
    | string
    | {
        /** Exact cache key to delete. */
        cacheKey?: string;
        /** Exact cache keys to delete. */
        cacheKeys?: string[];
        /** Cache pattern to delete with delPattern(). */
        pattern?: string;
        /** Cache patterns to delete with delPattern(). */
        patterns?: string[];
        /** Read operation to invalidate. Add query/options for exact key invalidation. */
        operation?: CacheInvalidationOperation | string;
        /** Alias for operation. */
        op?: CacheInvalidationOperation | string;
        query?: unknown;
        options?: unknown;
        pipeline?: unknown[];
        /** Field name for distinct invalidation descriptors. */
        field?: string;
        /** ID for findOneById invalidation descriptors. */
        id?: unknown;
        /** IDs for findByIds invalidation descriptors. */
        ids?: unknown[];
    };

export type CacheInvalidationRequest = CacheInvalidationEntry | CacheInvalidationEntry[];

export interface WriteCacheControlOptions {
    cache?: {
        /**
         * Explicit invalidation for this write. `false` or `[]` means no invalidation for
         * this write, even when instance-level cache.autoInvalidate is enabled.
         */
        invalidate?: false | true | CacheInvalidationRequest;
        /** Per-write broad invalidation shortcut. Prefer invalidate for precise entries. */
        autoInvalidate?: boolean;
    };
    /** Per-write broad invalidation shortcut kept for compatibility. */
    autoInvalidate?: boolean;
}

/** v1-compatible find options exported from the root package. */
export interface FindOptions {
    projection?: Record<string, any> | string[];
    /** Alias for `projection`; `projection` wins when both are provided. */
    project?: Record<string, any> | string[];
    sort?: Record<string, 1 | -1>;
    limit?: number;
    skip?: number;
    cache?: number;
    maxTimeMS?: number;
    hint?: any;
    collation?: any;
    comment?: string;
    meta?: boolean | MetaOptions;
}

/** v1-compatible count options exported from the root package. */
export interface CountOptions {
    cache?: number;
    maxTimeMS?: number;
    hint?: any;
    collation?: any;
    comment?: string;
    meta?: boolean | MetaOptions;
}

/** v1-compatible distinct options exported from the root package. */
export interface DistinctOptions {
    cache?: number;
    maxTimeMS?: number;
    collation?: any;
    hint?: string | object;
    meta?: boolean | MetaOptions;
}

/** Query options that request the v1 `{ data, meta }` wrapper. */
export interface QueryMetaOption extends Record<string, unknown> {
    /** Include operation timing metadata in the resolved query result. */
    meta: true | MetaOptions;
}

/** Cursor-based page navigation info returned by findPage. */
export interface PageInfo {
    hasNext: boolean;
    hasPrev: boolean;
    startCursor: string | null;
    endCursor: string | null;
    /** Target logical page number (cursor/offset-jump modes only) */
    currentPage?: number;
}

/** Totals/count info returned by findPage when totals mode is enabled. */
export interface TotalsInfo {
    mode: 'async' | 'sync' | 'approx';
    /** async: null = not ready yet; approx: undefined = unknown/approximate */
    total?: number | null;
    totalPages?: number | null;
    /** Short token for async totals polling */
    token?: string;
    /** Write timestamp (ms) if from cache */
    ts?: number;
    /** True when an approximate totals strategy was used */
    approx?: boolean;
    /** Error identifier for async mode failures */
    error?: string;
}

type LegacyPageInfo<TSchema = any> = unknown extends TSchema ? any : PageInfo;
type LegacyTotalsInfo<TSchema = any> = unknown extends TSchema ? any : TotalsInfo;
type SyncTotalsInfo = TotalsInfo & {
    mode: 'sync';
    total: number;
    totalPages: number;
};
type LegacySyncTotalsInfo<TSchema = any> = unknown extends TSchema ? any : SyncTotalsInfo;

/** Timing/meta info returned by findPage when the meta option is enabled. */
export interface MetaInfo {
    op: string;
    ns: { iid: string; type: string; db: string; coll: string };
    db?: string;
    collection?: string;
    timestamp?: number;
    startTs: number;
    endTs: number;
    durationMs: number;
    maxTimeMS?: number;
    fromCache?: boolean;
    cacheHit?: boolean;
    cacheTtl?: number;
    keyHash?: string;
    page?: number;
    after?: boolean;
    before?: boolean;
    hops?: number;
    step?: number;
    /** Sub-step timings (level='sub' only) */
    steps?: Array<{ phase: 'hop' | 'offset' | 'fetch' | 'totals'; name: string; index?: number; durationMs: number }>;
    error?: { code?: string; message: string };
}

/** Bookmark/cursor jump configuration for deep pagination. */
export interface JumpOptions {
    /** Bookmark density: store bookmark every N pages (default 10) */
    step?: number;
    /** Max cursor-walking hops per jump (default 20) */
    maxHops?: number;
    /** Optional custom key dimensions for bookmark keying */
    keyDims?: object;
    /** Custom bookmark reader — returns cursor string or null */
    getBookmark?: (params: { keyDims: unknown; page: number }) => Promise<string | null>;
    /** Custom bookmark writer */
    saveBookmark?: (params: { keyDims: unknown; page: number; cursor: string; ttlMs?: number }) => Promise<void>;
}

/** Offset-based fallback configuration for small-range pages in findPage. */
export interface OffsetJumpOptions {
    /** Enable offset fallback when skip <= maxSkip (default false) */
    enable?: boolean;
    /** Max skip before falling back to cursor-jump (default 50000) */
    maxSkip?: number;
}

/** Totals/count mode configuration for findPage. */
export interface TotalsOptions {
    /** Counting strategy (default 'none') */
    mode?: 'none' | 'async' | 'approx' | 'sync';
    /** Timeout for countDocuments / estimatedDocumentCount (ms) */
    maxTimeMS?: number;
    /** Cache TTL for totals (ms; default 10 min) */
    ttlMs?: number;
    /** Index hint for count query */
    hint?: unknown;
    /** Collation for count query */
    collation?: unknown;
}

/** Stream query options for collection.stream(). */
export interface StreamOptions {
    projection?: Record<string, unknown> | string[];
    /** Alias for `projection`; `projection` wins when both are provided. */
    project?: Record<string, unknown> | string[];
    sort?: Record<string, 1 | -1>;
    limit?: number;
    skip?: number;
    /** Cursor batch size (default 1000) */
    batchSize?: number;
    maxTimeMS?: number;
    hint?: unknown;
    collation?: unknown;
    noCursorTimeout?: boolean;
}

/** Explain/query plan options for collection.explain(). */
export interface ExplainOptions {
    projection?: Record<string, unknown>;
    /** Alias for `projection`; `projection` wins when both are provided. */
    project?: Record<string, unknown>;
    sort?: Record<string, 1 | -1>;
    limit?: number;
    skip?: number;
    maxTimeMS?: number;
    hint?: unknown;
    collation?: unknown;
    /** Verbosity level (default 'queryPlanner') */
    verbosity?: 'queryPlanner' | 'executionStats' | 'allPlansExecution';
}

/** MongoDB query execution plan result returned by collection.explain(). */
export interface ExplainResult {
    queryPlanner: {
        plannerVersion: number;
        namespace: string;
        indexFilterSet: boolean;
        parsedQuery?: unknown;
        winningPlan: unknown;
        rejectedPlans: unknown[];
    };
    executionStats?: {
        executionSuccess: boolean;
        nReturned: number;
        executionTimeMillis: number;
        totalKeysExamined: number;
        totalDocsExamined: number;
        executionStages: unknown;
        allPlansExecution?: unknown[];
    };
    serverInfo?: {
        host: string;
        port: number;
        version: string;
        gitVersion: string;
    };
    ok: number;
}

export interface HealthView {
    status: 'up' | 'down';
    connected: boolean;
    /** @since v1 — driver connection state alias */
    driver?: { connected: boolean; error?: string };
    defaults?: Record<string, unknown>;
    cache?: Record<string, unknown>;
    checks?: Record<string, Record<string, unknown> & { status: 'up' | 'down' | 'unknown' }>;
    capabilities?: Record<string, unknown>;
}

export interface InsertOneResult {
    acknowledged: boolean;
    insertedId: any;
}

export interface InsertManyResult {
    acknowledged: boolean;
    insertedCount: number;
    insertedIds: Record<number, any>;
}

export interface UpdateResult {
    acknowledged: boolean;
    matchedCount: number;
    modifiedCount: number;
    upsertedCount: number;
    upsertedId: any;
}

export interface DeleteResult {
    acknowledged: boolean;
    deletedCount: number;
}

export type CursorValueType = 'date' | 'objectId' | 'string' | 'number' | 'boolean' | 'raw';

export type CursorValueNormalizer = (field: string, value: unknown) => unknown;

export interface FindPageOptions<TSchema = any> {
    query?: Document;
    page?: number;
    limit?: number;
    after?: string;
    before?: string;
    sort?: Sort;
    projection?: Document | string[];
    /** Alias for `projection`; `projection` wins when both are provided. */
    project?: Document | string[];
    pipeline?: Document[];
    /** Totals/count configuration */
    totals?: TotalsOptions;
    stream?: boolean;
    explain?: boolean | string;
    /** Query comment for server-side profiling. v1 compat — top-level shortcut for `options.comment`. */
    comment?: string;
    /** Cursor value type hints used when decoding after/before tokens. Keeps ISO-like string fields as strings when set to `string` or `raw`. */
    cursorTypes?: Record<string, CursorValueType>;
    /** Custom cursor value normalizer. Receives the sort field name and decoded cursor value. */
    cursorValueNormalizer?: CursorValueNormalizer;
    options?: MongoFindOptions;
    /** Cursor-walking bookmark jump configuration */
    jump?: JumpOptions;
    /** Offset-based fallback for small page ranges */
    offsetJump?: OffsetJumpOptions;
    maxTimeMS?: number;
    hint?: Document | string;
    collation?: Document;
    batchSize?: number;
    /** Cache TTL in milliseconds for the non-stream/non-explain page result */
    cache?: number;
    /** Include timing/meta info in result — pass true or MetaOptions for sub-step detail */
    meta?: boolean | MetaOptions;
}

export interface FindPageResult<TSchema = any> {
    items: TSchema[];
    pageInfo: LegacyPageInfo<TSchema>;
    totals?: LegacyTotalsInfo<TSchema>;
    /** Timing/meta info — present when meta option was passed */
    meta?: MetaInfo;
}

export interface FindAndCountResult<TSchema = any> {
    data: TSchema[];
    total: number;
    /** @deprecated Use `data`. v1 backward-compat alias — will be removed in a future major. */
    documents?: TSchema[];
}

export interface FindChain<TSchema = any, TPromise = TSchema[]> extends Promise<TPromise> {
    limit(value: number): FindChain<TSchema, TPromise>;
    skip(value: number): FindChain<TSchema, TPromise>;
    sort(value: Sort | Record<string, 1 | -1>): FindChain<TSchema, TPromise>;
    project(value: Document): FindChain<TSchema, TPromise>;
    hint(value: unknown): FindChain<TSchema, TPromise>;
    collation(value: Record<string, unknown>): FindChain<TSchema, TPromise>;
    comment(value: string): FindChain<TSchema, TPromise>;
    maxTimeMS(value: number): FindChain<TSchema, TPromise>;
    batchSize(value: number): FindChain<TSchema, TPromise>;
    explain(verbosity?: boolean | string): Promise<unknown>;
    stream(): NodeJS.ReadableStream;
    toArray(): Promise<TSchema[]>;
}

export interface AggregateChain<TResult = unknown, TPromise = TResult[]> extends Promise<TPromise> {
    hint(value: unknown): AggregateChain<TResult, TPromise>;
    collation(value: Record<string, unknown>): AggregateChain<TResult, TPromise>;
    comment(value: string): AggregateChain<TResult, TPromise>;
    maxTimeMS(value: number): AggregateChain<TResult, TPromise>;
    allowDiskUse(value: boolean): AggregateChain<TResult, TPromise>;
    batchSize(value: number): AggregateChain<TResult, TPromise>;
    explain(verbosity?: boolean | string): Promise<unknown>;
    stream(): NodeJS.ReadableStream;
    toArray(): Promise<TResult[]>;
}

/** Write concern options for batch operations. */
export interface WriteConcern {
    /** Write acknowledgement level (default: 1). */
    w?: number | 'majority';
    /** Wait for journal flush before acknowledging (default: false). */
    j?: boolean;
    /** Write timeout in milliseconds. */
    wtimeout?: number;
}

/** Per-batch retry record appended to batch result `retries` arrays. */
export interface BatchRetryRecord {
    batchIndex: number;
    attempt: number;
    /** @alias attempt — v1 compat: v1 runtime emitted `attempts` (plural). */
    attempts?: number;
    maxAttempts: number;
    delay: number;
    /** @since v1 — always `false` on retry records (the attempt that triggered the retry failed). */
    success?: boolean;
    error?: Error;
}

/** Progress callback payload delivered for each completed batch. */
export interface BatchProgress {
    currentBatch: number;
    totalBatches: number;
    inserted?: number;
    modified?: number;
    deleted?: number;
    /** Total document count (null when not yet known). */
    total: number | null;
    /** Completion percentage (null when total is unknown). */
    percentage: number | null;
    errors: number;
    retries: number;
}

/** Payload supplied to the `onRetry` callback for each retry attempt. */
export interface RetryInfo {
    batchIndex: number;
    attempt: number;
    maxAttempts: number;
    error: Error;
}

/** Options for insertBatch operations. */
export interface InsertBatchOptions {
    /** Number of documents per batch (default: 1000). */
    batchSize?: number;
    /** Maximum number of concurrent batch writes. */
    concurrency?: number;
    /** Ordered inserts — stop on first error when true. */
    ordered?: boolean;
    /** Progress callback invoked after each batch. */
    onProgress?: (progress: BatchProgress) => void;
    /** Error handling strategy. */
    onError?: 'stop' | 'skip' | 'collect' | 'retry';
    /** Number of retry attempts per batch on transient failure. */
    retryAttempts?: number;
    /** Delay between retries in milliseconds. */
    retryDelay?: number;
    /** Retry callback invoked before each retry attempt. */
    onRetry?: (retryInfo: RetryInfo) => void;
    /** MongoDB write concern. */
    writeConcern?: WriteConcern;
    /** Skip MongoDB document validation. */
    bypassDocumentValidation?: boolean;
    /** Query comment for server-side profiling. */
    comment?: string;
}

/** Options for deleteBatch operations. */
export interface DeleteBatchOptions {
    /** Number of documents per batch (default: 1000). */
    batchSize?: number;
    /** Estimate total for progress reporting. */
    estimateProgress?: boolean;
    /** Progress callback invoked after each batch. */
    onProgress?: (progress: BatchProgress) => void;
    /** Error handling strategy. */
    onError?: 'stop' | 'skip' | 'collect' | 'retry';
    /** Number of retry attempts per batch on transient failure. */
    retryAttempts?: number;
    /** Delay between retries in milliseconds. */
    retryDelay?: number;
    /** Retry callback invoked before each retry attempt. */
    onRetry?: (retryInfo: RetryInfo) => void;
    /** MongoDB write concern. */
    writeConcern?: WriteConcern;
    /** Query comment for server-side profiling. */
    comment?: string;
}

export interface BatchErrorRecord {
    batchIndex: number;
    message: string;
    /** Additional error details. */
    details?: unknown;
}

export interface InsertBatchResult {
    acknowledged: boolean;
    /** Total document count processed (never null for insert). */
    totalCount: number;
    insertedCount: number;
    batchCount: number;
    errors: BatchErrorRecord[];
    insertedIds: Record<number, unknown>;
    /** Per-batch retry records. */
    retries: BatchRetryRecord[];
}

export interface UpdateBatchResult {
    acknowledged: boolean;
    totalCount: number | null;
    matchedCount: number;
    modifiedCount: number;
    /** Always 0; updateBatch rejects `upsert: true` before executing batch writes. */
    upsertedCount: number;
    batchCount: number;
    errors: BatchErrorRecord[];
    /** Per-batch retry records. */
    retries: BatchRetryRecord[];
    /** Number of documents skipped by strict model version conflict handling. */
    conflictCount?: number;
    /** Document ids skipped by strict model version conflict handling. */
    conflictedIds?: unknown[];
}

export interface DeleteBatchResult {
    acknowledged: boolean;
    totalCount: number | null;
    deletedCount: number;
    batchCount: number;
    errors: BatchErrorRecord[];
    /** Per-batch retry records. */
    retries: BatchRetryRecord[];
}

export interface BatchWriteOptions extends WriteCacheControlOptions {
    batchSize?: number;
    ordered?: boolean;
    concurrency?: number;
    onProgress?: (progress: BatchProgress) => void;
    onError?: 'stop' | 'skip' | 'collect' | 'retry';
    retryAttempts?: number;
    retryDelay?: number;
    onRetry?: (retryInfo: RetryInfo) => void;
}

/** Options for updateBatch operations. */
export interface UpdateBatchOptions extends WriteCacheControlOptions {
    /** Number of documents per batch (default: 1000). */
    batchSize?: number;
    /** Estimate total for progress reporting. */
    estimateProgress?: boolean;
    /** Progress callback invoked after each batch. */
    onProgress?: (progress: BatchProgress) => void;
    /** Error handling strategy. */
    onError?: 'stop' | 'skip' | 'collect' | 'retry';
    /** Number of retry attempts per batch on transient failure. */
    retryAttempts?: number;
    /** Delay between retries in milliseconds. */
    retryDelay?: number;
    /** Retry callback invoked before each retry attempt. */
    onRetry?: (retryInfo: RetryInfo) => void;
    /** MongoDB write concern. */
    writeConcern?: WriteConcern;
    /**
     * @deprecated `updateBatch` does not support `upsert: true`; use `upsertOne` for
     * single-document upserts, or `updateMany(..., { upsert: true })` only when you
     * want MongoDB's native single-insert-on-no-match semantics. Passing `true` throws.
     */
    upsert?: boolean;
    /** Array filters for nested array updates. */
    arrayFilters?: unknown[];
    /** Query comment for server-side profiling. */
    comment?: string;
    /** Sort order used to paginate through batch cursor. */
    sort?: Record<string, 1 | -1>;
}

export interface IncrementOneOptions extends WriteCacheControlOptions, Record<string, unknown> {
    returnDocument?: 'before' | 'after';
    projection?: Record<string, unknown>;
    $set?: Record<string, unknown>;
}

/**
 * Result returned by {@link Collection.incrementOne}.
 * The updated document is available via `.value` (or `null` if not found).
 */
export interface IncrementOneResult<TSchema = unknown> {
    acknowledged: boolean;
    matchedCount: number;
    modifiedCount: number;
    /** The document after the increment (or null when no match). */
    value: TSchema | null;
}

export interface IndexCreateResult {
    name: string;
}

export interface BookmarkPrewarmResult {
    warmed: number;
    failed: number;
    keys: string[];
}

export interface BookmarkListResult {
    count: number;
    pages: number[];
    keys: string[];
}

export interface BookmarkClearResult {
    cleared: number;
    pattern: string;
    keysBefore: number;
}

export interface BookmarkKeyDims<TSchema = unknown> extends Omit<FindPageOptions<TSchema>, 'page'> { }

export interface BookmarkCacheLike {
    set(key: string, value: unknown): void | boolean | Promise<void> | Promise<boolean>;
    get(key: string): unknown | Promise<unknown>;
    delete?(key: string): boolean | Promise<boolean>;
    keys?(pattern: string): string[] | Promise<string[]>;
    delPattern?(pattern: string): number | Promise<number>;
}

export interface AdminBuildInfoView {
    version?: string;
    versionArray?: number[];
    gitVersion?: string;
    bits?: number;
    debug?: boolean;
    maxBsonObjectSize?: number;
}

export interface ServerStatusView {
    connections: {
        current?: number;
        available?: number;
        totalCreated?: number;
    };
    mem: {
        resident?: number;
        virtual?: number;
        mapped?: number;
    };
    opcounters: {
        insert?: number;
        query?: number;
        update?: number;
        delete?: number;
        getmore?: number;
        command?: number;
    };
    network: {
        bytesIn?: number;
        bytesOut?: number;
        numRequests?: number;
    };
    uptime?: number;
    localTime?: Date;
    version?: string;
    process?: string;
}

export interface DbStatsView {
    db?: string;
    collections?: number;
    views?: number;
    objects?: number;
    avgObjSize?: number;
    dataSize?: number;
    storageSize?: number;
    indexes?: number;
    indexSize?: number;
    totalSize?: number;
    scaleFactor?: number;
}

export interface AdminAccessor {
    /** Pings the MongoDB server and returns true when reachable. */
    ping(): Promise<boolean>;
    /** Returns MongoDB server build information. */
    buildInfo(): Promise<AdminBuildInfoView>;
    /**
     * Returns current server status metrics.
     * @param options - Optional scale factor for byte values.
     * @returns Server status snapshot.
     */
    serverStatus(options?: { scale?: number; }): Promise<ServerStatusView>;
    /**
     * Returns database storage statistics.
     * @param options - Optional scale factor for byte values.
     * @returns Database stats view.
     */
    stats(options?: { scale?: number; }): Promise<DbStatsView>;
}

export interface Collection<TSchema = any> {
    /** Returns the namespace descriptor (iid, db, collection) for this collection. */
    getNamespace(): { iid: string; type: 'mongodb'; db: string; collection: string; pool?: string; };
    /** Returns the underlying native MongoDB Collection object. */
    raw(): unknown;
    /**
     * Finds the first document matching the query.
     * @param query - MongoDB filter query.
     * @param options - MongoDB FindOptions.
     * @returns The matched document, or null when not found.
     */
    findOne(query: unknown | undefined, options: QueryMetaOption): Promise<ResultWithMeta<TSchema | null>>;
    findOne(query?: unknown, options?: unknown): Promise<TSchema | null>;
    /**
     * Returns a chainable cursor over documents matching the query.
     * @param query - MongoDB filter query.
     * @param options - MongoDB FindOptions.
     * @returns A chainable FindChain that resolves to an array.
     */
    find(query: unknown | undefined, options: QueryMetaOption): FindChain<TSchema, ResultWithMeta<TSchema[]>>;
    find(query: unknown | undefined, projection: unknown, options?: unknown): FindChain<TSchema>;
    find(query?: unknown, options?: unknown): FindChain<TSchema>;
    /**
     * Finds a single document by its `_id` value.
     * @param id - The `_id` value to look up.
     * @param options - MongoDB FindOptions.
     * @returns The matched document, or null when not found.
     */
    findOneById(id: unknown, options?: unknown): Promise<TSchema | null>;
    /**
     * Fetches multiple documents by their `_id` values in a single query.
     * @param ids - Array of `_id` values to look up.
     * @param options - MongoDB FindOptions.
     * @returns Array of matched documents (order not guaranteed).
     */
    findByIds(ids: unknown[], options?: unknown): Promise<TSchema[]>;
    /**
     * Finds documents matching the query and returns both the data array and
     * the total count unaffected by limit/skip.
     * @param query - MongoDB filter query.
     * @param options - MongoDB FindOptions.
     * @returns Object with `data` array and `total` count.
     */
    findAndCount(query?: unknown, options?: unknown): Promise<FindAndCountResult<TSchema>>;
    /**
     * Returns a Node.js ReadableStream of documents matching the query.
     * @param query - MongoDB filter query.
     * @param options - StreamOptions (projection, sort, limit, batchSize, …).
     * @returns Readable object-mode stream emitting one document per chunk.
     */
    stream(query?: unknown, options?: unknown): NodeJS.ReadableStream;
    /**
     * Returns the MongoDB query execution plan without running the full query.
     * @param query - MongoDB filter query.
     * @param options - ExplainOptions including verbosity level.
     * @returns Raw explain output from MongoDB.
     */
    explain(query?: unknown, options?: unknown): Promise<unknown>;
    /**
     * Counts documents matching the query.
     * @param query - MongoDB filter query.
     * @param options - MongoDB CountDocumentsOptions.
     * @returns Number of matched documents.
     */
    count(query: unknown | undefined, options: QueryMetaOption): Promise<ResultWithMeta<number>>;
    count(query?: unknown, options?: unknown): Promise<number>;
    /**
     * Inserts a single document into the collection.
     * @param document - Document to insert.
     * @param options - InsertOneSimplifiedOptions or InsertOneOptions.
     * @returns Acknowledged result with the inserted `_id`.
     * @since v1.0.0
     */
    insertOne(document?: unknown, options?: unknown): Promise<InsertOneResult>;
    /**
     * Inserts multiple documents into the collection in a single operation.
     * @param documents - Array of documents to insert.
     * @param options - InsertManySimplifiedOptions or InsertManyOptions.
     * @returns Acknowledged result with inserted count and `_id` map.
     * @since v1.0.0
     */
    insertMany(documents?: unknown[], options?: unknown): Promise<InsertManyResult>;
    /**
     * Updates the first document matching the filter.
     * @param filter - MongoDB filter query.
     * @param update - Update operators (e.g. `$set`, `$inc`).
     * @param options - MongoDB UpdateOptions.
     * @returns Update result with matched/modified counts.
     * @since v1.0.0
     */
    updateOne(filter?: unknown, update?: unknown, options?: unknown): Promise<UpdateResult>;
    /**
     * Updates all documents matching the filter.
     * @param filter - MongoDB filter query.
     * @param update - Update operators.
     * @param options - MongoDB UpdateOptions.
     * @returns Update result with matched/modified counts.
     * @since v1.0.0
     */
    updateMany(filter?: unknown, update?: unknown, options?: unknown): Promise<UpdateResult>;
    /**
     * Replaces the first document matching the filter with a new document.
     * @param filter - MongoDB filter query.
     * @param replacement - Full replacement document (no update operators).
     * @param options - MongoDB ReplaceOptions.
     * @returns Update result indicating match and modification.
     * @since v1.0.0
     */
    replaceOne(filter?: unknown, replacement?: unknown, options?: unknown): Promise<UpdateResult>;
    /**
     * Atomically finds the first matching document, replaces it, and returns a document.
     * @param filter - MongoDB filter query.
     * @param replacement - Full replacement document.
     * @param options - MongoDB FindOneAndReplaceOptions.
     * @returns The document before or after replacement, or null when not found.
     * @since v1.0.0
     */
    findOneAndReplace(filter?: unknown, replacement?: unknown, options?: unknown): Promise<TSchema | null>;
    /**
     * Atomically finds the first matching document, applies an update, and returns a document.
     * @param filter - MongoDB filter query.
     * @param update - Update operators.
     * @param options - MongoDB FindOneAndUpdateOptions.
     * @returns The document before or after the update, or null when not found.
     * @since v1.0.0
     */
    findOneAndUpdate(filter?: unknown, update?: unknown, options?: unknown): Promise<TSchema | null>;
    /**
     * Atomically finds the first matching document, deletes it, and returns it.
     * @param filter - MongoDB filter query.
     * @param options - MongoDB FindOneAndDeleteOptions.
     * @returns The deleted document, or null when not found.
     * @since v1.0.0
     */
    findOneAndDelete(filter?: unknown, options?: unknown): Promise<TSchema | null>;
    /**
     * Updates the first matching document or inserts it when no match exists.
     * @param filter - MongoDB filter query.
     * @param update - Update operators.
     * @param options - MongoDB UpdateOptions (upsert is forced true).
     * @returns Update result; `upsertedId` is set when a new document was inserted.
     * @since v1.0.0
     */
    upsertOne(filter?: unknown, update?: unknown, options?: unknown): Promise<UpdateResult>;
    /**
     * Deletes the first document matching the filter.
     * @param filter - MongoDB filter query.
     * @param options - MongoDB DeleteOptions.
     * @returns Delete result with the deleted document count.
     * @since v1.0.0
     */
    deleteOne(filter?: unknown, options?: unknown): Promise<DeleteResult>;
    /**
     * Deletes all documents matching the filter.
     * @param filter - MongoDB filter query.
     * @param options - MongoDB DeleteOptions.
     * @returns Delete result with the total deleted count.
     * @since v1.0.0
     */
    deleteMany(filter?: unknown, options?: unknown): Promise<DeleteResult>;
    /**
     * Inserts a large document array in configurable batches with progress and retry support.
     * @param documents - Documents to insert.
     * @param options - InsertBatchOptions (batchSize, concurrency, onProgress, …).
     * @returns Aggregated insert result across all batches.
     * @since v1.2.0
     */
    insertBatch(documents?: unknown[], options?: unknown): Promise<InsertBatchResult>;
    /**
     * Updates matched documents in configurable batches, walking via a cursor.
     * @param filter - MongoDB filter query.
     * @param update - Update operators.
     * @param options - UpdateBatchOptions (batchSize, onProgress, retry settings; `upsert: true` is rejected).
     * @returns Aggregated update result across all batches.
     * @since v1.2.0
     */
    updateBatch(filter?: unknown, update?: unknown, options?: unknown): Promise<UpdateBatchResult>;
    /**
     * Deletes matched documents in configurable batches.
     * @param filter - MongoDB filter query.
     * @param options - DeleteBatchOptions (batchSize, onProgress, …).
     * @returns Aggregated delete result across all batches.
     * @since v1.2.0
     */
    deleteBatch(filter?: unknown, options?: unknown): Promise<DeleteBatchResult>;
    /**
     * Atomically increments a numeric field on the first matching document.
     * @param filter - MongoDB filter query.
     * @param field - Field name (string) or a `{ field: delta }` map for multi-field increments.
     * @param incrementOrOptions - Numeric delta when `field` is a string, or IncrementOneOptions.
     * @param maybeOptions - IncrementOneOptions when the third argument is the delta.
     * @returns Result containing matched/modified counts and the returned document value.
     * @since v1.1.0
     */
    incrementOne(filter?: unknown, field?: string | Record<string, number>, incrementOrOptions?: unknown, maybeOptions?: unknown): Promise<IncrementOneResult<TSchema>>;
    /**
     * Creates a single index on the collection.
     * @param keys - Index key specification.
     * @param options - MongoDB CreateIndexesOptions (name, unique, sparse, …).
     * @returns Object containing the created index name.
     * @since v1.0.0
     */
    createIndex(keys: unknown, options?: unknown): Promise<IndexCreateResult>;
    /**
     * Creates multiple indexes on the collection in one operation.
     * @param specs - Array of index specifications (each must include a `key` field).
     * @returns Array of created index names.
     * @since v1.0.0
     */
    createIndexes(specs: Array<{ key: unknown; } & Record<string, unknown>>): Promise<string[]>;
    /**
     * Lists all indexes defined on the collection.
     * @returns Array of index descriptor objects as returned by MongoDB.
     */
    listIndexes(): Promise<Record<string, unknown>[]>;
    /**
     * Drops the named index from the collection.
     * @param name - The index name to drop.
     * @since v1.0.0
     */
    dropIndex(name: string): Promise<unknown>;
    /**
     * Drops all non-`_id` indexes from the collection.
     * @since v1.0.0
     */
    dropIndexes(): Promise<unknown>;
    prewarmBookmarks(keyDims?: unknown, pages?: number[]): Promise<BookmarkPrewarmResult>;
    listBookmarks(keyDims?: unknown): Promise<BookmarkListResult>;
    clearBookmarks(keyDims?: unknown): Promise<BookmarkClearResult>;
    /**
     * Returns the distinct values for the specified field across matching documents.
     * @param key - Field path to collect distinct values from.
     * @param query - Optional MongoDB filter query.
     * @param options - MongoDB DistinctOptions.
     * @returns Array of unique field values.
     */
    distinct(key: string, query: unknown | undefined, options: QueryMetaOption): Promise<ResultWithMeta<unknown[]>>;
    distinct(key: string, query?: unknown, options?: unknown): Promise<unknown[]>;
    /**
     * Builds and executes an aggregation pipeline, returning a chainable object.
     * @param pipeline - Array of aggregation stage documents.
     * @param options - MongoDB AggregateOptions.
     * @returns AggregateChain that resolves to the result array.
    */
    aggregate<TResult = unknown>(pipeline: unknown[] | undefined, options: QueryMetaOption): AggregateChain<TResult, ResultWithMeta<TResult[]>>;
    aggregate<TResult = unknown>(pipeline?: unknown[], options?: unknown): AggregateChain<TResult>;
    /**
     * Searches a MongoDB Vector Search index and returns each document with its score.
     * Requires a compatible MongoDB deployment and a pre-created Vector Search index.
     */
    vectorSearch<TDocument = TSchema>(options: VectorSearchOptions): Promise<Array<VectorSearchHit<TDocument>>>;
    /** Stream mode: returns a readable stream of page documents when `stream: true`. */
    findPage(options: FindPageOptions<TSchema> & { stream: true }): NodeJS.ReadableStream;
    /** Sync totals mode guarantees `totals.total` and `totals.totalPages` are immediately available. */
    findPage(options: FindPageOptions<TSchema> & { totals: { mode: 'sync'; } & Record<string, unknown> }): Promise<Omit<FindPageResult<TSchema>, 'totals'> & { totals: LegacySyncTotalsInfo<TSchema> }>;
    /** Returns a cursor-based paginated result set. */
    findPage(options?: FindPageOptions<TSchema>): Promise<FindPageResult<TSchema>>;
    /**
     * Opens a MongoDB change stream to listen for collection-level change events.
     * @param pipeline - Optional aggregation pipeline to filter/transform events.
     * @param options - MongoDB ChangeStreamOptions.
     * @returns A ChangeStream instance emitting change event documents.
     */
    watch(pipeline?: unknown[], options?: unknown): ChangeStream;
    /**
     * Manually invalidates cached query results for the specified operation type.
     * @param op - Operation whose cache entries to clear; omit to clear all.
     * @returns Number of cache entries removed.
     * @since v1.3.0
     */
    invalidate(op?: 'find' | 'findOne' | 'count' | 'findPage' | 'aggregate' | 'distinct'): Promise<number>;
    /**
     * Drops the entire collection from the database.
     * @returns True when the collection was dropped successfully.
     * @since v1.3.0
     */
    dropCollection(): Promise<boolean>;
    /**
     * Creates a new collection (or capped collection) in the database.
     * @param name - Collection name; defaults to the current collection name when omitted.
     * @param options - MongoDB CreateCollectionOptions (capped, size, validator, …).
     * @returns True when the collection was created successfully.
     * @since v1.3.0
     */
    createCollection(name?: string, options?: Record<string, unknown>): Promise<boolean>;
    /**
     * Creates a MongoDB view backed by an aggregation pipeline over a source collection.
     * @param name - Name of the view to create.
     * @param source - Name of the source collection.
     * @param pipeline - Optional aggregation pipeline defining the view.
     * @returns True when the view was created successfully.
     * @since v1.3.0
     */
    createView(name: string, source: string, pipeline?: unknown[]): Promise<boolean>;
    /**
     * Returns index usage statistics for all indexes on the collection.
     * @returns Array of `$indexStats` documents from MongoDB.
     * @since v1.3.0
     */
    indexStats(): Promise<unknown[]>;
    /**
     * Sets the JSON Schema validator and optional validation settings.
     * @since v1.3.0
     */
    setValidator(validator: unknown, options?: { validationLevel?: string; validationAction?: string }): Promise<{ ok: number; collection: string }>;
    /** Sets the collection validation level. @since v1.3.0 */
    setValidationLevel(level: 'off' | 'moderate' | 'strict' | string): Promise<{ ok: number; validationLevel: string }>;
    /** Sets the collection validation action. @since v1.3.0 */
    setValidationAction(action: 'error' | 'warn' | string): Promise<{ ok: number; validationAction: string }>;
    /** Reads the current collection validator and validation settings. @since v1.3.0 */
    getValidator(): Promise<{ validator: Record<string, unknown> | null; validationLevel: string; validationAction: string }>;
    /** Returns collection storage and index statistics. @since v1.3.0 */
    stats(options?: { scale?: number }): Promise<{ ns: string; count: number; size: number; storageSize: number; totalIndexSize: number; nindexes: number; avgObjSize?: number; scaleFactor?: number }>;
    /** Renames the collection, optionally dropping an existing target. @since v1.3.0 */
    renameCollection(newName: string, options?: { dropTarget?: boolean }): Promise<{ renamed: boolean; from: string; to: string }>;
    /** Runs a `collMod` command against the collection. @since v1.3.0 */
    collMod(modifications: Record<string, unknown>): Promise<Record<string, unknown>>;
    /** Converts the collection to capped storage. @since v1.3.0 */
    convertToCapped(size: number, options?: { max?: number }): Promise<{ ok: number; collection: string; capped: boolean; size: number }>;
}

export interface DbAccessor {
    /**
     * Returns a typed Collection accessor for the named collection.
     * @param name - MongoDB collection name.
     * @returns Collection instance bound to the specified collection.
     */
    collection<TSchema = any>(name: string): Collection<TSchema>;
    /** Returns the underlying native MongoDB Db object. */
    raw(): unknown;
    /** Returns an AdminAccessor for server-level administrative operations. */
    admin(): AdminAccessor;
    /**
     * Lists all databases available on the server.
     * @param options - Pass `nameOnly: true` to return string names instead of full descriptors.
     * @returns Array of database descriptor objects, or string names when `nameOnly` is true.
     * @since v1.3.0
     */
    listDatabases(options?: { nameOnly?: boolean }): Promise<Array<{ name: string; sizeOnDisk: number; empty: boolean }> | string[]>;
    /**
     * Drops the current database; requires explicit confirmation to prevent accidental data loss.
     * @param options - Must include `confirm: true`; optionally restrict to non-production environments.
     * @returns Result object with the dropped database name and timestamp.
     * @since v1.3.0
     */
    dropDatabase(options?: { confirm: boolean; allowProduction?: boolean; user?: string }): Promise<{ dropped: boolean; database: string; timestamp: Date }>;
    /**
     * Lists collections (and views) in the current database.
     * @param filter - Optional MongoDB filter applied to the collection list.
     * @param options - MongoDB ListCollectionsOptions.
     * @returns Array of objects with `name` and `type` fields.
     * @since v1.3.0
     */
    listCollections(filter?: Record<string, unknown>, options?: Record<string, unknown>): Promise<Array<{ name: string; type: string }>>;
    /**
     * Runs an arbitrary command against the current database.
     * @param command - Command document (e.g. `{ ping: 1 }`).
     * @param options - MongoDB RunCommandOptions.
     * @returns Raw command result document from MongoDB.
     * @since v1.3.0
     */
    runCommand(command: Record<string, unknown>, options?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// v1 backward-compat name aliases
// ---------------------------------------------------------------------------

/** @alias FindPageResult — v1 called the findPage result PageResult */
export type PageResult<T = any> = FindPageResult<T>;

/** @alias BookmarkPrewarmResult — v1 name */
export type PrewarmBookmarksResult = BookmarkPrewarmResult;

/** @alias BookmarkListResult — v1 name */
export type ListBookmarksResult = BookmarkListResult;

/** @alias BookmarkClearResult — v1 name */
export type ClearBookmarksResult = BookmarkClearResult;

// ---------------------------------------------------------------------------
// Write options (v1 parity)
// ---------------------------------------------------------------------------

/** Simplified insertOne options (used for the shorthand call form). */
export interface InsertOneSimplifiedOptions extends WriteCacheControlOptions {
    writeConcern?: WriteConcern;
    bypassDocumentValidation?: boolean;
    comment?: string;
    session?: unknown;
    /** Broadly invalidate query cache on success. Prefer `cache.invalidate` for precise entries. */
    autoInvalidate?: boolean;
}

/** Full insertOne options (document + write configuration). */
export interface InsertOneOptions {
    document: unknown;
    writeConcern?: WriteConcern;
    bypassDocumentValidation?: boolean;
    comment?: string;
}

/** Simplified insertMany options (used for the shorthand call form). */
export interface InsertManySimplifiedOptions extends WriteCacheControlOptions {
    ordered?: boolean;
    writeConcern?: WriteConcern;
    bypassDocumentValidation?: boolean;
    comment?: string;
    session?: unknown;
    /** Broadly invalidate query cache on success. Prefer `cache.invalidate` for precise entries. */
    autoInvalidate?: boolean;
}

/** Full insertMany options (documents array + write configuration). */
export interface InsertManyOptions {
    documents: unknown[];
    ordered?: boolean;
    writeConcern?: WriteConcern;
    bypassDocumentValidation?: boolean;
    comment?: string;
}

// ---------------------------------------------------------------------------
// Chain helpers (v1 parity)
// ---------------------------------------------------------------------------

/**
 * Collation options for locale-aware string comparison.
 * @since v1.0.0
 */
export interface CollationOptions {
    /** IETF language tag, e.g. 'en', 'zh'. */
    locale: string;
    /** Comparison strength: 1=base, 2=accent, 3=case. */
    strength?: number;
    /** Distinguish uppercase from lowercase at strength < 3. */
    caseLevel?: boolean;
    /** Which case is sorted first when cases are equal. */
    caseFirst?: 'upper' | 'lower';
    /** Sort numeric strings numerically, not lexicographically. */
    numericOrdering?: boolean;
    /** How spaces and punctuation are handled. */
    alternate?: 'non-ignorable' | 'shifted';
    /** Highest ignored character category. */
    maxVariable?: 'punct' | 'space';
    /** Sort secondary weights in reverse order. */
    backwards?: boolean;
}

// ---------------------------------------------------------------------------
// Pagination helpers (v1 parity)
// ---------------------------------------------------------------------------

/**
 * Query result with attached metadata (timing, cache, totals).
 * @since v1.3.0
 */
export interface ResultWithMeta<T = unknown> {
    data: T;
    meta: MetaInfo;
}

// ---------------------------------------------------------------------------
// Collection accessor alias (v1 parity)
// ---------------------------------------------------------------------------

/** @alias Collection — v1 called the collection accessor CollectionAccessor */
export type CollectionAccessor<TSchema = any> = Collection<TSchema>;

