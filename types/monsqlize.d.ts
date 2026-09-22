import type { LoggerLike } from './base';
import type { SchemaDslRuntime, SchemaDslRuntimeOptions } from 'schema-dsl/runtime';

/**
 * SSH tunnel configuration for connecting through a bastion host.
 * @since v1.3.0
 */
export interface SSHConfig {
    /** SSH server hostname or IP. */
    host: string;
    /** SSH server port (default: 22). */
    port?: number;
    /** SSH login username. */
    username: string;
    /** SSH password (mutually exclusive with privateKey). */
    password?: string;
    /** SSH private key string or Buffer (mutually exclusive with password and privateKeyPath). */
    privateKey?: string | Buffer;
    /** Path to an SSH private key file; supports ~ for home directory (mutually exclusive with password and privateKey). @since v1.3.0 */
    privateKeyPath?: string;
    /** Passphrase for an encrypted private key. */
    passphrase?: string;
    /** Connection ready timeout in milliseconds (default: 20000). */
    readyTimeout?: number;
    /** Keep-alive interval in milliseconds (default: 30000). */
    keepaliveInterval?: number;
    /** ssh2 host-key hash algorithm; pair with hostVerifier for pinned fingerprints. */
    hostHash?: string;
    /** Reject untrusted SSH server host keys by returning false. */
    hostVerifier?: (key: string | Buffer) => boolean;
    /** Target database host as seen from the SSH server (default: auto-parsed from URI). */
    dstHost?: string;
    /** Target database port as seen from the SSH server (default: auto-parsed from URI). */
    dstPort?: number;
    /** Fixed local TCP port for the tunnel; omit for a random OS-assigned port. @since v1.3.0 */
    localPort?: number;
}

import type { Collection, CursorValueNormalizer, CursorValueType, DbAccessor, HealthView } from './collection';
import type { DataTaskJobError } from './data-tasks';
import type { Lock, LockOptions, LockStats } from './lock';
import type { ModelAutoIndexOptions, ModelDescriptor, ModelEnsureAllIndexesOptions, ModelIndexEnsureSummary, ModelInstance } from './model';
import type { MongoConnectConfig } from './mongodb';
import type { ConnectionPoolManagerOptions, PoolConfig, PoolHealthStatus, PoolStats, PoolStrategy } from './pool';
import type {
    BatchQueue,
    CacheLike,
    CacheLockManager,
    DistributedCacheInvalidator,
    DistributedCacheInvalidatorStats,
    FunctionCache,
    Logger,
    MemoryCache,
    MultiLevelCache,
    MultiLevelCacheOptions,
    SlowQueryLogConfigManager,
    SlowQueryLogMemoryStorage,
    MongoDBSlowQueryLogStorage,
    TransactionManager,
    createExpression,
    compilePipelineExpressions,
    createRedisCacheAdapter,
    expr,
    generateQueryHash,
    hasExpressionInObject,
    hasExpressionInPipeline,
    isExpressionObject,
    validateSyncConfig,
    withCache,
    adaptLegacyCacheLike,
} from './runtime';
import type { SagaDefinition, SagaOrchestrator, SagaResult, SagaStats } from './saga';
import type { SlowQueryLogConfigInput, SlowQueryLogEntry, SlowQueryLogFilter, SlowQueryLogManager, SlowQueryLogQueryOptions, SlowQueryLogRecord } from './slow-query-log';
import type { ChangeStreamSyncManager, SyncConfig, SyncStats } from './sync';
import type { Transaction, TransactionOptions, TransactionStats } from './transaction';

/**
 * Callable model accessor that preserves a descriptor's inferred document type.
 * @since v3.3.0
 */
export interface ModelBindingAccessor {
    <TDocument>(descriptor: ModelDescriptor<string, TDocument>): ModelInstance<TDocument>;
    <TDocument = any>(modelName: string): ModelInstance<TDocument>;
}

/** Write path policy mode. `allow-both` preserves the existing collection and model write behavior. */
export type WritePathPolicyMode = 'allow-both' | 'model-only';

/** Controls whether native raw access is available under a write path policy. */
export type WritePathPolicyRawMode = 'inherit' | 'allow' | 'block';

/** Controls whether collection/database management writes are available under a write path policy. */
export type WritePathPolicyManagementMode = 'inherit' | 'allow' | 'block';

/** Controls violation handling; `warn` logs and allows for migration observation. */
export type WritePathPolicyViolationAction = 'throw' | 'warn';

/** Per-namespace write path policy rule. */
export interface WritePathPolicyRule {
    /** Write policy mode. Default: `allow-both`. */
    mode?: WritePathPolicyMode;
    /** Raw native access policy. `inherit` allows in `allow-both` and blocks in `model-only`. */
    raw?: WritePathPolicyRawMode;
    /** Management write policy. `inherit` allows model management and blocks external management in `model-only`. */
    management?: WritePathPolicyManagementMode;
    /** Violation action. Default: `throw`. */
    onViolation?: WritePathPolicyViolationAction;
}

/** Runtime write path policy configuration. */
export interface WritePathPolicyOptions {
    /**
     * Default rule applied when no namespace override matches.
     * Omit this option to preserve existing behavior (`allow-both`).
     */
    default?: WritePathPolicyMode | WritePathPolicyRule;
    /**
     * Namespace overrides matched in this order: `iid`, `pool:db.collection`,
     * `db.collection`, then `collection`.
     */
    namespaces?: Record<string, WritePathPolicyMode | WritePathPolicyRule>;
}

export type MonSQLizeSchemaDslRuntime = Pick<
    SchemaDslRuntime,
    's' | 'dsl' | 'validate' | 'registerExtensions' | 'dispose'
>;

/** schema-dsl runtime integration. Omit to let monSQLize create one isolated runtime per MonSQLize instance. */
export interface SchemaDslRuntimeConfig {
    /** Disable model schema-dsl compilation and validation when false. Default: true. */
    enabled?: boolean;
    /** Existing schema-dsl runtime instance. monSQLize will use it but will not dispose it. */
    runtime?: MonSQLizeSchemaDslRuntime;
    /** Options passed to `createRuntime()` when monSQLize owns the runtime. */
    options?: SchemaDslRuntimeOptions;
    /** Extension definitions registered on the selected runtime before model schema compilation. */
    extensions?: readonly unknown[];
}

export interface MonSQLizeOptions {
    type?: 'mongodb';
    databaseName?: string;
    /** @alias databaseName — v1 compatibility */
    database?: string;
    config?: MongoConnectConfig;
    /**
     * Cache configuration. Accepts:
     * - A `MemoryCache` instance (direct injection)
     * - A `CacheLike` instance (v1 compat: custom cache implementation)
     * - A `MultiLevelCacheOptions` object (multi-level cache setup)
     * - A plain config object. Recognised fields:
     *     `maxEntries` / `maxSize` (v1 alias), `maxMemory`, `defaultTtl` / `ttl` (v1 alias),
     *     `enableStats`, `enableTags`, `cleanupInterval`, `enabled`,
     *     `autoInvalidate` (broad write invalidation, disabled by default)
     */
    cache?: CacheLike | MemoryCache | MultiLevelCacheOptions | {
        /** Maximum number of entries; v2 name. Alias: maxSize (v1). */
        maxEntries?: number;
        /** @deprecated Use `maxEntries`. v1 alias for `maxEntries`. */
        maxSize?: number;
        /** Maximum memory in bytes (0 = unlimited). */
        maxMemory?: number;
        /** Default TTL in milliseconds; v2 name. Alias: ttl (v1). */
        defaultTtl?: number;
        /** @deprecated Use `defaultTtl`. v1 alias for `defaultTtl`. */
        ttl?: number;
        /** Enable cache hit/miss statistics. Default: true. */
        enableStats?: boolean;
        /** Enable tag-based invalidation. Default: false. */
        enableTags?: boolean;
        /** Periodic TTL cleanup interval in milliseconds. */
        cleanupInterval?: number;
        /** Disable cache entirely when false. Default: true. */
        enabled?: boolean;
        /** Broadly invalidate collection query caches after successful writes. Default: false. */
        autoInvalidate?: boolean;
        /**
         * Distributed cache invalidation via Redis Pub/Sub.
         * When configured, broadcasts `delPattern` events to all other connected instances.
         * Provide `redisUrl` or an existing Redis-like `redis` instance when enabling this block.
         * @since v2.0.0
         */
        distributed?: {
            /** Redis URL for the Pub/Sub connection. */
            redisUrl?: string;
            /** Alias for `redisUrl`. */
            url?: string;
            /** Alias for `redisUrl`. */
            uri?: string;
            /** Existing ioredis `Redis` instance to use for publishing. */
            redis?: unknown;
            /** Pub/Sub channel name shared across instances. Default: `"monsqlize:cache:invalidate"`. */
            channel?: string;
            /** Unique ID for this instance; used to filter self-published messages. Auto-generated if omitted. */
            instanceId?: string;
            /** Set to `false` to disable without removing the config block. Default: `true`. */
            enabled?: boolean;
        };
        [key: string]: unknown;
    };
    logger?: LoggerLike | null;
    /** Isolated schema-dsl runtime configuration for Model schema compilation and validation. */
    schemaDsl?: false | SchemaDslRuntimeConfig;
    pools?: PoolConfig[];
    poolStrategy?: PoolStrategy;
    poolFallback?: ConnectionPoolManagerOptions['poolFallback'];
    maxPoolsCount?: number;
    sync?: SyncConfig;
    slowQueryLog?: SlowQueryLogConfigInput;
    /** Global transaction defaults and transaction statistics settings. @since v1.4.0 */
    transaction?: {
        enableRetry?: boolean;
        maxRetries?: number;
        retryDelay?: number;
        retryBackoff?: number;
        /** Default transaction timeout in milliseconds. Alias: `maxDuration`. */
        defaultTimeout?: number;
        /** Default transaction timeout in milliseconds. Alias: `defaultTimeout`. */
        maxDuration?: number;
        defaultReadConcern?: TransactionOptions['readConcern'];
        defaultWriteConcern?: TransactionOptions['writeConcern'];
        defaultReadPreference?: TransactionOptions['readPreference'];
        lockMaxDuration?: number;
        lockCleanupInterval?: number;
        maxStatsSamples?: number;
        /**
         * v1 compatibility placeholder. The current v2 transaction cache lock is process-local
         * and this option is not wired into distributed cache-lock interception.
         *
         * Use `DistributedCacheLockManager` explicitly for business critical sections, pair it
         * with idempotency/fencing, or disable cache where cross-instance strict consistency is
         * required.
         *
         * @deprecated This option is retained for compatibility only and does not enable a
         * distributed transaction cache lock in the v2 runtime.
         */
        distributedLock?: Record<string, unknown>;
    };
    /** Global query timeout in milliseconds applied to all find/aggregate operations. Default: 2000. @since v1.3.0 */
    maxTimeMS?: number;
    /** Default limit for find() when caller does not specify one. Default: 500. @since v1.3.0 */
    findLimit?: number;
    /** Maximum allowed explicit limit for find(). limit(0) keeps MongoDB's unlimited semantics. Default: 10000. @since v3.0.0 */
    findMaxLimit?: number;
    /** Maximum allowed explicit skip for find() and offsetJump. Default: 50000. @since v3.0.0 */
    findMaxSkip?: number;
    /** Slow query threshold in milliseconds; populates slowQueryLog.filter.minExecutionTimeMs when slowQueryLog is enabled. Default: 500. @since v1.3.0 */
    slowQueryMs?: number;
    /** Maximum allowed limit for findPage() operations. Requests exceeding this cap are silently clamped. Default: 500. @since v1.3.0 */
    findPageMaxLimit?: number;
    /** Namespace scope for cursor isolation between multiple MonSQLize instances sharing a cache. @since v1.3.0 */
    namespace?: { scope?: 'database' | 'connection'; instanceId?: string; };
    /** HMAC-SHA256 secret used to sign and verify cursor tokens returned by findPage(). @since v1.3.0 */
    cursorSecret?: string;
    /** Require cursorSecret before findPage can emit or consume cursor tokens. Default: false. @since v3.0.0 */
    requireCursorSecret?: boolean;
    /** Controls startup warning when cursorSecret is missing. Default: 'production'. @since v3.0.0 */
    cursorSecretWarning?: 'off' | 'production' | 'always';
    /** Global cursor value type hints used when findPage decodes after/before tokens. @since v3.0.0 */
    cursorTypes?: Record<string, CursorValueType>;
    /** Global cursor value normalizer used when findPage decodes after/before tokens. @since v3.0.0 */
    cursorValueNormalizer?: CursorValueNormalizer;
    /** Logging tag configuration applied to slow-query event payloads. @since v1.3.0 */
    log?: { slowQueryTag?: { event?: string; code?: string;[key: string]: unknown }; formatSlowQuery?: (meta: unknown) => unknown; };
    /** Auto-convert valid 24-character hex strings to ObjectId across query/write paths. Pass `false` to disable, or use `excludeFields`, `maxDepth`, or `{ field: false }` escape hatches. Default: true for mongodb type. @since v1.3.0 */
    autoConvertObjectId?: boolean | {
        enabled?: boolean;
        excludeFields?: string[];
        customFieldPatterns?: string[];
        maxDepth?: number;
        logLevel?: 'info' | 'warn' | 'error' | string;
    } | Record<string, boolean>;
    /** Batch count operations to reduce server round-trips. @since v1.3.0 */
    countQueue?: boolean | { enabled?: boolean; concurrency?: number; maxQueueSize?: number; timeout?: number; };
    /** Model definitions to auto-register on connect. Accepts a file path (string) or an object with { path, pattern?, recursive? }. @since v1.3.0 */
    models?: string | { path: string; pattern?: string; recursive?: boolean; };
    /** Global automatic model index creation control. Defaults to true for backward compatibility. */
    autoIndex?: ModelAutoIndexOptions;
    /** Compatibility alias for `cache.autoInvalidate`. Prefer the nested cache option. */
    cacheAutoInvalidate?: boolean;
    /**
     * Optional write path governance. By default both collection and model write APIs remain available.
     * Use `model-only` per default or namespace to require writes through the model API.
     */
    writePathPolicy?: WritePathPolicyOptions;
}

export interface MonSQLizeInstance {
    /**
     * Establish the database connection and return the top-level accessor bundle.
     * @returns Object containing `collection`, `db`, `use` shortcuts and the current instance reference.
     */
    connect(): Promise<{
        collection: <TSchema = any>(name: string) => Collection<TSchema>;
        db: (name?: string) => DbAccessor;
        use: (name: string) => {
            collection: <TSchema = any>(collectionName: string) => Collection<TSchema>;
            model: ModelBindingAccessor;
        };
        instance: MonSQLize;
    }>;
    /**
     * Return the active cache instance (MemoryCache, MultiLevelCache, or a custom CacheLike).
     * Can be used to manually read, write, or invalidate cache entries.
     */
    getCache(): CacheLike;
    /** Return a frozen snapshot of the merged runtime defaults. */
    getDefaults(): Record<string, unknown>;
    /** Close all database connections and release associated resources. */
    close(): Promise<void>;
    /** Return the current connection health status view. */
    health(): Promise<HealthView>;
    /**
     * Return a collection accessor for the given collection name.
     * @param name Collection name.
     */
    collection<TSchema = any>(name: string): Collection<TSchema>;
    collection(name: string): Collection<any>;
    /**
     * Return a database accessor, optionally scoped to a specific database.
     * @param name Target database name; omit to use the default database.
     */
    db(name?: string): DbAccessor;
    /**
     * Switch to the given database and return its `collection` and `model` accessors.
     * @param name Target database name.
     */
    use(name: string): {
        collection: <TSchema = any>(collectionName: string) => Collection<TSchema>;
        model: ModelBindingAccessor;
    };
    /**
     * Return collection and model accessors for the named connection pool.
     * @param poolName Connection pool name.
     */
    pool(poolName: string): {
        collection: <TSchema = any>(name: string) => Collection<TSchema>;
        model: ModelBindingAccessor;
        use: (dbName: string) => {
            collection: <TSchema = any>(name: string) => Collection<TSchema>;
            model: ModelBindingAccessor;
        };
    };
    /**
     * Return a collection accessor scoped to the given database.
     * @param name Collection name.
     * @param options Optional database scope options.
     */
    scopedCollection<TSchema = any>(name: string, options?: { database?: string; pool?: string; }): Collection<TSchema>;
    scopedCollection(name: string, options?: { database?: string; pool?: string; }): Collection<any>;
    /**
     * Return a model instance scoped to the given database or connection pool.
     * @param name Model name.
     * @param options Optional database or pool scope options.
     */
    /** @since v3.3.0 */
    scopedModel<TDocument>(descriptor: ModelDescriptor<string, TDocument>, options?: { database?: string; pool?: string; }): ModelInstance<TDocument>;
    scopedModel<TDocument = any>(name: string, options?: { database?: string; pool?: string; }): ModelInstance<TDocument>;
    scopedModel(name: string, options?: { database?: string; pool?: string; }): ModelInstance<any>;
    /**
     * Return the registered model instance for the given model name.
     * @param name Model name used during registration.
     */
    /** @since v3.3.0 */
    model<TDocument>(descriptor: ModelDescriptor<string, TDocument>): ModelInstance<TDocument>;
    model<TDocument = any>(name: string): ModelInstance<TDocument>;
    model(name: string): ModelInstance<any>;
    /**
     * Ensures declared indexes for registered models.
     * Use `dryRun: true` for production preflight; execution only creates missing indexes.
     */
    ensureModelIndexes(options?: ModelEnsureAllIndexesOptions): Promise<ModelIndexEnsureSummary>;
    /**
     * Start a MongoDB transaction session.
     * @param options Optional transaction options.
     * @returns The transaction session object.
     */
    startSession(options?: TransactionOptions): Promise<Transaction>;
    /**
     * Execute a callback inside a transaction; commits on success, auto-rolls back on failure.
     * @param callback Async callback that receives the transaction session.
     * @param options Optional transaction options.
     */
    withTransaction<T>(callback: (transaction: Transaction) => Promise<T>, options?: TransactionOptions): Promise<T>;
    /**
     * Execute a callback while holding a legacy monSQLize lock; the lock is released automatically on completion.
     * @deprecated Business locks are retained for compatibility. Prefer application/framework-level locking.
     * @param key Unique lock identifier key.
     * @param callback Async callback executed while the lock is held.
     * @param options Optional lock options.
     */
    withLock<T>(key: string, callback: () => Promise<T>, options?: LockOptions): Promise<T>;
    /**
     * Acquire a legacy monSQLize lock, blocking until it is available or the timeout is reached.
     * @deprecated Business locks are retained for compatibility. Prefer application/framework-level locking.
     * @param key Unique lock identifier key.
     * @param options Optional lock options.
     * @returns The acquired lock instance.
     */
    acquireLock(key: string, options?: LockOptions): Promise<Lock>;
    /**
     * Try to acquire a legacy monSQLize lock without blocking; returns `null` if the lock is already held.
     * @deprecated Business locks are retained for compatibility. Prefer application/framework-level locking.
     * @param key Unique lock identifier key.
     * @param options Optional lock options (`retryTimes` is not supported).
     * @returns The acquired lock instance, or `null` if unavailable.
     */
    tryAcquireLock(key: string, options?: Omit<LockOptions, 'retryTimes'>): Promise<Lock | null>;
    /** Return the ChangeStream sync manager; `null` when sync is not enabled. */
    getSyncManager(): ChangeStreamSyncManager | null;
    /** Return the slow-query log manager; `null` when slow-query logging is not enabled. */
    getSlowQueryLogManager(): SlowQueryLogManager | null;
    /** @deprecated Saga APIs are retained for compatibility. Prefer application/framework-level workflow orchestration. */
    getSagaOrchestrator(): SagaOrchestrator;
    /** @deprecated Saga APIs are retained for compatibility. Prefer application/framework-level workflow orchestration. */
    saga(): SagaOrchestrator;
    /**
     * Register a Saga definition.
     * @deprecated Saga APIs are retained for compatibility. Prefer application/framework-level workflow orchestration.
     * @param definition Saga definition object containing steps and compensation logic.
     */
    defineSaga(definition: SagaDefinition): Promise<SagaDefinition>;
    /**
     * Execute the named registered Saga.
     * @deprecated Saga APIs are retained for compatibility. Prefer application/framework-level workflow orchestration.
     * @param name Saga name.
     * @param data Initial data passed into the Saga.
     * @returns The Saga execution result.
     */
    executeSaga(name: string, data: unknown): Promise<SagaResult>;
    /** @deprecated Saga APIs are retained for compatibility. Prefer application/framework-level workflow orchestration. */
    listSagas(): string[];
    /** Return aggregate transaction statistics; `null` before transaction capability initialization. */
    getTransactionStats(): TransactionStats | null;
    /** @deprecated Saga APIs are retained for compatibility. Prefer application/framework-level workflow orchestration. */
    getSagaStats(): SagaStats;
    /** Return distributed cache invalidator statistics; `null` when distributed invalidation is not enabled. */
    getDistributedCacheInvalidatorStats(): DistributedCacheInvalidatorStats | null;
    /** Start ChangeStream data synchronisation. */
    startSync(): Promise<void>;
    /** Stop ChangeStream data synchronisation. */
    stopSync(): Promise<void>;
    /** Return current data sync statistics; `null` when sync is not enabled. */
    getSyncStats(): SyncStats | null;
    /**
     * Manually record a slow-query log entry.
     * @param log The slow-query log entry object.
     */
    recordSlowQuery(log: SlowQueryLogEntry): Promise<void>;
    /**
     * Query slow-query log records.
     * @param filter Optional filter criteria.
     * @param options Optional pagination and sort options.
     * @returns Array of matching slow-query log records.
     */
    getSlowQueryLogs(filter?: SlowQueryLogFilter, options?: SlowQueryLogQueryOptions): Promise<SlowQueryLogRecord[]>;
    /**
     * Subscribe to an event.
     * @param event Event name.
     * @param handler Event handler callback.
     */
    on(event: string, handler: (payload: unknown) => void): void;
    /**
     * Subscribe to an event; automatically unsubscribes after the first invocation.
     * @param event Event name.
     * @param handler Event handler callback.
     */
    once(event: string, handler: (payload: unknown) => void): void;
    /**
     * Unsubscribe from an event.
     * @param event Event name.
     * @param handler The handler to remove.
     */
    off(event: string, handler: (payload: unknown) => void): void;
    /**
     * Emit an event and dispatch the payload to all subscribers.
     * @param event Event name.
     * @param payload Event payload data.
     */
    emit(event: string, payload: unknown): void;
    /**
     * Dynamically add a connection pool.
     * @param config Pool configuration object.
     * @since v1.3.0 — v1 pool management parity
     */
    addPool(config: PoolConfig): Promise<void>;
    /**
     * Remove the named connection pool and close its connections.
     * @param name Connection pool name.
     */
    removePool(name: string): Promise<void>;
    /** Return the names of all registered connection pools. */
    getPoolNames(): string[];
    /** Return runtime statistics for all connection pools. */
    getPoolStats(): Record<string, PoolStats>;
    /** Return the health status of all connection pools. */
    getPoolHealth(): Record<string, PoolHealthStatus>;
    /** Return distributed lock usage statistics; `null` when locks are not enabled. */
    getLockStats(): LockStats | null;
    /**
     * List all databases accessible on the current connection.
     * @param options Pass `nameOnly: true` to return a plain string array of database names.
     * @since v1.3.0 — v1 database management parity
     */
    listDatabases(options?: { nameOnly?: boolean }): Promise<Array<{ name: string; sizeOnDisk: number; empty: boolean }> | string[]>;
    /**
     * Drop the current default database; requires explicit confirmation via `confirm: true`.
     * @param options Drop confirmation and safety options.
     * @returns Object containing the operation result, database name, and timestamp.
     */
    dropDatabase(options?: { confirm: boolean; allowProduction?: boolean; user?: string }): Promise<{ dropped: boolean; database: string; timestamp: Date }>;
    /**
     * List all collections in the current database.
     * @param filter Optional collection name filter.
     * @param options Optional driver-level options.
     * @returns Array of objects containing collection name and type.
     */
    listCollections(filter?: Record<string, unknown>, options?: Record<string, unknown>): Promise<Array<{ name: string; type: string }>>;
    /**
     * Execute a raw MongoDB command on the current database.
     * @param command Command document object.
     * @param options Optional driver-level options.
     * @returns The command result document.
     */
    runCommand(command: Record<string, unknown>, options?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export default class MonSQLize implements MonSQLizeInstance {
    constructor(options?: MonSQLizeOptions);
    connect(): Promise<{
        collection: <TSchema = any>(name: string) => Collection<TSchema>;
        db: (name?: string) => DbAccessor;
        use: (name: string) => {
            collection: <TSchema = any>(collectionName: string) => Collection<TSchema>;
            model: ModelBindingAccessor;
        };
        instance: MonSQLize;
    }>;
    getCache(): CacheLike;
    getDefaults(): Record<string, unknown>;
    close(): Promise<void>;
    health(): Promise<HealthView>;
    collection<TSchema = any>(name: string): Collection<TSchema>;
    collection(name: string): Collection<any>;
    db(name?: string): DbAccessor;
    use(name: string): {
        collection: <TSchema = any>(collectionName: string) => Collection<TSchema>;
        model: ModelBindingAccessor;
    };
    pool(poolName: string): {
        collection: <TSchema = any>(name: string) => Collection<TSchema>;
        model: ModelBindingAccessor;
        use: (dbName: string) => {
            collection: <TSchema = any>(name: string) => Collection<TSchema>;
            model: ModelBindingAccessor;
        };
    };
    scopedCollection<TSchema = any>(name: string, options?: { database?: string; pool?: string; }): Collection<TSchema>;
    scopedCollection(name: string, options?: { database?: string; pool?: string; }): Collection<any>;
    /** @since v3.3.0 */
    scopedModel<TDocument>(descriptor: ModelDescriptor<string, TDocument>, options?: { database?: string; pool?: string; }): ModelInstance<TDocument>;
    scopedModel<TDocument = any>(name: string, options?: { database?: string; pool?: string; }): ModelInstance<TDocument>;
    scopedModel(name: string, options?: { database?: string; pool?: string; }): ModelInstance<any>;
    /** @since v3.3.0 */
    model<TDocument>(descriptor: ModelDescriptor<string, TDocument>): ModelInstance<TDocument>;
    model<TDocument = any>(name: string): ModelInstance<TDocument>;
    model(name: string): ModelInstance<any>;
    ensureModelIndexes(options?: ModelEnsureAllIndexesOptions): Promise<ModelIndexEnsureSummary>;
    startSession(options?: TransactionOptions): Promise<Transaction>;
    withTransaction<T>(callback: (transaction: Transaction) => Promise<T>, options?: TransactionOptions): Promise<T>;
    /** @deprecated Business locks are retained for compatibility. Prefer application/framework-level locking. */
    withLock<T>(key: string, callback: () => Promise<T>, options?: LockOptions): Promise<T>;
    /** @deprecated Business locks are retained for compatibility. Prefer application/framework-level locking. */
    acquireLock(key: string, options?: LockOptions): Promise<Lock>;
    /** @deprecated Business locks are retained for compatibility. Prefer application/framework-level locking. */
    tryAcquireLock(key: string, options?: Omit<LockOptions, 'retryTimes'>): Promise<Lock | null>;
    getSyncManager(): ChangeStreamSyncManager | null;
    getSlowQueryLogManager(): SlowQueryLogManager | null;
    /** @deprecated Saga APIs are retained for compatibility. Prefer application/framework-level workflow orchestration. */
    getSagaOrchestrator(): SagaOrchestrator;
    /** @deprecated Saga APIs are retained for compatibility. Prefer application/framework-level workflow orchestration. */
    saga(): SagaOrchestrator;
    /** @deprecated Saga APIs are retained for compatibility. Prefer application/framework-level workflow orchestration. */
    defineSaga(definition: SagaDefinition): Promise<SagaDefinition>;
    /** @deprecated Saga APIs are retained for compatibility. Prefer application/framework-level workflow orchestration. */
    executeSaga(name: string, data: unknown): Promise<SagaResult>;
    /** @deprecated Saga APIs are retained for compatibility. Prefer application/framework-level workflow orchestration. */
    listSagas(): string[];
    getTransactionStats(): TransactionStats | null;
    /** @deprecated Saga APIs are retained for compatibility. Prefer application/framework-level workflow orchestration. */
    getSagaStats(): SagaStats;
    getDistributedCacheInvalidatorStats(): DistributedCacheInvalidatorStats | null;
    startSync(): Promise<void>;
    stopSync(): Promise<void>;
    getSyncStats(): SyncStats | null;
    recordSlowQuery(log: SlowQueryLogEntry): Promise<void>;
    getSlowQueryLogs(filter?: SlowQueryLogFilter, options?: SlowQueryLogQueryOptions): Promise<SlowQueryLogRecord[]>;
    on(event: string, handler: (payload: unknown) => void): void;
    once(event: string, handler: (payload: unknown) => void): void;
    off(event: string, handler: (payload: unknown) => void): void;
    emit(event: string, payload: unknown): void;
    addPool(config: PoolConfig): Promise<void>;
    removePool(name: string): Promise<void>;
    getPoolNames(): string[];
    getPoolStats(): Record<string, PoolStats>;
    getPoolHealth(): Record<string, PoolHealthStatus>;
    getLockStats(): LockStats | null;
    listDatabases(options?: { nameOnly?: boolean }): Promise<Array<{ name: string; sizeOnDisk: number; empty: boolean }> | string[]>;
    dropDatabase(options?: { confirm: boolean; allowProduction?: boolean; user?: string }): Promise<{ dropped: boolean; database: string; timestamp: Date }>;
    listCollections(filter?: Record<string, unknown>, options?: Record<string, unknown>): Promise<Array<{ name: string; type: string }>>;
    runCommand(command: Record<string, unknown>, options?: Record<string, unknown>): Promise<Record<string, unknown>>;

    static Logger: typeof Logger;
    static MemoryCache: typeof MemoryCache;
    static Transaction: typeof Transaction;
    static TransactionManager: typeof TransactionManager;
    static CacheLockManager: typeof CacheLockManager;
    static Lock: typeof Lock;
    static LockManager: typeof import('./lock').LockManager;
    static LockAcquireError: typeof import('./lock').LockAcquireError;
    static LockTimeoutError: typeof import('./lock').LockTimeoutError;
    static DistributedCacheInvalidator: typeof DistributedCacheInvalidator;
    static ConnectionPoolManager: typeof import('./pool').ConnectionPoolManager;
    /** @since v3.3.0 */
    static defineModel: typeof import('./model').defineModel;
    static Model: typeof import('./runtime').Model;
    static ModelInstance: typeof import('./runtime').ModelInstance;
    static expr: typeof expr;
    static createExpression: typeof createExpression;
    static compilePipelineExpressions: typeof compilePipelineExpressions;
    static isExpressionObject: typeof isExpressionObject;
    static hasExpressionInObject: typeof hasExpressionInObject;
    static hasExpressionInPipeline: typeof hasExpressionInPipeline;
    static createRedisCacheAdapter: typeof createRedisCacheAdapter;
    /**
     * @deprecated Retained for v1 compatibility. Non-database function caching is no longer a recommended monSQLize feature path;
     * use `cache-hub` directly or an application-owned cache layer for new generic function-cache usage.
     */
    static withCache: typeof withCache;
    /**
     * @deprecated Retained for v1 compatibility. Non-database function caching is no longer a recommended monSQLize feature path;
     * use `cache-hub` directly or an application-owned cache layer for new generic function-cache usage.
     */
    static FunctionCache: typeof FunctionCache;
    static adaptLegacyCacheLike: typeof adaptLegacyCacheLike;
    static MultiLevelCache: typeof MultiLevelCache;
    static ChangeStreamSyncManager: typeof ChangeStreamSyncManager;
    static ResumeTokenStore: typeof import('./sync').ResumeTokenStore;
    static validateSyncConfig: typeof validateSyncConfig;
    static SlowQueryLogManager: typeof SlowQueryLogManager;
    static SlowQueryLogConfigManager: typeof SlowQueryLogConfigManager;
    static SlowQueryLogMemoryStorage: typeof SlowQueryLogMemoryStorage;
    static MongoDBSlowQueryLogStorage: typeof MongoDBSlowQueryLogStorage;
    static BatchQueue: typeof BatchQueue;
    static DataTaskJobError: typeof DataTaskJobError;
    static generateQueryHash: typeof generateQueryHash;
    static SagaOrchestrator: typeof SagaOrchestrator;
}

export { MonSQLize };
