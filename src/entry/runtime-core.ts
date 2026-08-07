/** MongoDB runtime core assembly layer. Keep business logic in capability / adapter modules. */

import {
    MongoCollectionAccessor as CollectionFacade,
    MongoDbAccessor as DbFacade,
} from '../adapters/mongodb/common/accessors';
import type { RuntimeDefaults } from '../types/internal/query';
import type {
    AdapterBridgeLike,
    AutoConvertConfigPublic,
    ConnectResult,
    LegacyAdapterBridgeLike,
    ScopedUseResult,
} from '../types/internal/runtime';
import { EventEmitter } from 'node:events';
import { MemoryCache, DistributedCacheInvalidator, type CacheLike } from '../capabilities/cache';
import { Lock, LockManager, LockAcquireError, LockOptions, LockStats, LockTimeoutError, DistributedCacheLockManager } from '../capabilities/lock';
import {
    Model, ModelInstance,
    type ModelConnection,
    type ModelDefinition,
    type PopulateConfig,
    type PopulateProxy,
    type RelationConfig,
    type ValidationResult,
    type VirtualConfig,
} from '../capabilities/model';
import {
    ConnectionPoolManager,
    type ConnectionPoolManagerOptions,
    type FallbackStrategy,
    type PoolConfig,
    type PoolHealthStatus,
    type PoolRole,
    type PoolStats,
    type PoolStrategy,
} from '../capabilities/pool';
import {
    SagaOrchestrator,
    type SagaDefinition,
    type SagaOrchestratorOptions,
    type SagaResult,
    type SagaStats,
    type SagaStep,
} from '../capabilities/saga';
import {
    BatchQueue,
    DEFAULT_SLOW_QUERY_LOG_CONFIG,
    SlowQueryLogConfigManager,
    SlowQueryLogManager,
    generateQueryHash,
    getSlowQueryThreshold,
    withSlowQueryLog,
    type SlowQueryLogConfig,
    type SlowQueryLogConfigInput,
    type SlowQueryLogEntry,
    type SlowQueryLogFilter,
    type SlowQueryLogQueryOptions,
    type SlowQueryLogRecord,
} from '../capabilities/slow-query-log';
import { CountQueue, type CountQueueOptions, type CountQueueStats } from '../capabilities/count-queue';
import {
    ChangeStreamSyncManager,
    ResumeTokenStore,
    validateSyncConfig,
    validateTargetConfig,
    validateResumeTokenConfig,
    type ResumeTokenConfig,
    type SyncChangeEvent,
    type SyncConfig,
    type SyncStats,
    type SyncTargetConfig,
} from '../capabilities/sync';
import {
    CacheLockManager,
    Transaction,
    TransactionManager,
    type TransactionOptions,
    type TransactionStats,
    type MongoSession,
} from '../capabilities/transaction';
import { closeMongo, connectMongo } from '../adapters/mongodb/common/connect';
import type { SSHTunnelSSH2 } from '../capabilities/ssh';
import {
    createExpression,
    compilePipelineExpressions,
    expr,
    hasExpressionInObject,
    hasExpressionInPipeline,
    isExpressionObject,
    type ExpressionObject,
} from '../core/expression';
import { ErrorCodes, createError, createConnectionError, createValidationError, createCursorError, createQueryTimeoutError } from '../core/errors';
import { Logger, type LoggerLike } from '../core/logger';
import { encodeCursor, decodeCursor } from '../utils/cursor';
import type { HealthView } from '../../types/collection';
import type { ModelEnsureAllIndexesOptions, ModelIndexEnsureSummary } from '../../types/model';
import type { MonSQLizeOptions } from '../../types/monsqlize';
import type { MultiLevelCacheOptions, MultiLevelCachePolicy, WritePolicy } from '../../types/runtime';
import type { SyncTargetHealthCheckConfig } from '../../types/sync';
import {
    buildRuntimeDefaults,
    createAndStartPoolManager,
    initAutoConvertConfig,
    initializeDistributedCacheInvalidator,
    loadModelFiles,
} from './capability-wiring';
import { buildPublicDefaults, buildPublicSnapshot, createRuntimeDbFacade, createRuntimeModelInstance, ensureRuntimeModelIndexes, resolveDatabaseName, shouldWarnTransactionDistributedLock, shouldWarnUnsignedCursorSecret, validateRuntimeNumericOptions } from './runtime-helpers';
import {
    createRuntimeCoreAccessors,
    createRuntimeCoreAdapterBridgeHost,
    createRuntimeCoreDbFacadeHost,
    createRuntimeCoreModelHost,
} from './runtime-core-hosts';
import {
    asRuntimeCompatRecord,
    assertCompatPoolExists,
    createCompatModelInstance,
    createPoolScope,
    getCompatModelInstanceCache,
    getRegisteredModelMetadata,
    getRuntimeDatabaseName,
    requireCompatDbInstance,
    requireCompatPoolManagerRecord,
    type RuntimeCompatRecord,
    type RuntimeDbInstanceLike,
    type RuntimePoolScopeHost,
} from './runtime-compat-accessors';
import { createRuntimeAdapterBridge, type RuntimeAdapterBridgeHost } from './runtime-admin-bridge';
import {
    ensureRuntimeSlowQueryLogManager,
    getOrCreateLockManager,
    getOrCreateSagaOrchestrator,
    getOrCreateTransactionManager,
    initializeRuntimeSlowQueryLogManager,
    initializeRuntimeSyncManager,
    requireRuntimePoolManager,
} from './runtime-capability-factories';
import { resolveScopedCollection } from './runtime-scoped-collection';
import { normalizeRuntimeCacheWithLifecycle } from './runtime-cache-normalizer';
import { prepareSshTunnelConnectConfig } from './runtime-ssh';
import { createInitialRuntimeSchemaDslEngine, disposeRuntimeSchemaDslEngine, replaceRuntimeSchemaDslEngine, type SchemaDslEngine } from './runtime-schema-dsl';
import { cleanupFailedRuntimeConnection } from './runtime-connect-cleanup';

// All public symbols are re-exported from the barrel file to keep the public API unchanged
export * from './runtime-exports';

type RuntimeAdapterSurface = LegacyAdapterBridgeLike;

/** Core entry point for the monSQLize TypeScript runtime. */
export class MonSQLizeRuntime {
    private _connected = false;
    private readonly _cache: CacheLike;
    private readonly _cacheClose?: () => Promise<void>;
    private _adapterCacheOverride: CacheLike | null | undefined;
    private readonly _adapterBridge: RuntimeAdapterSurface;
    private readonly _logger: Logger;
    private readonly _events = new EventEmitter();
    private readonly _cacheLockManager: CacheLockManager;
    private readonly _runtimeDefaults: RuntimeDefaults;
    private _client: Awaited<ReturnType<typeof connectMongo>>['client'] | null = null;
    private _defaultDb: DbFacade | null = null;
    private _poolManager: ConnectionPoolManager | null = null;
    private _syncManager: ChangeStreamSyncManager | null = null;
    private _slowQueryLogManager: SlowQueryLogManager | null = null;
    private _sagaOrchestrator: SagaOrchestrator | null = null;
    private _transactionManager: TransactionManager | null = null;
    private _lockManager: LockManager | null = null;
    private _iidCache: MemoryCache | null = null;
    private readonly _modelInstances = new MemoryCache({
        maxEntries: 100_000,
        enableStats: false,
    });
    private _connectionPromise: Promise<ConnectResult<MonSQLizeRuntime>> | null = null;
    private _sshTunnel: SSHTunnelSSH2 | null = null;
    private _distributedInvalidator: DistributedCacheInvalidator | null = null;
    private _schemaDslEngine: SchemaDslEngine;

    readonly defaults: Readonly<Record<string, unknown>>; readonly autoConvertConfig: AutoConvertConfigPublic;
    get logger(): Logger {
        return this._logger;
    }
    constructor(public readonly options: MonSQLizeOptions = {}) {
        const type = options.type;
        if (type !== 'mongodb') {
            throw createError(ErrorCodes.UNSUPPORTED_DATABASE, 'Invalid database type. Supported types are: mongodb');
        }
        this.options = {
            ...options,
            type,
        };
        // v1 compat: validate critical parameters at construction time.
        validateRuntimeNumericOptions(options);
        const rawCacheInput = options.cache as Record<string, unknown> | MemoryCache | CacheLike | undefined;
        const hasDistributedCfg = rawCacheInput != null
            && typeof rawCacheInput === 'object'
            && !(rawCacheInput instanceof MemoryCache)
            && typeof (rawCacheInput as Record<string, unknown>)['get'] !== 'function'
            && typeof (rawCacheInput as Record<string, unknown>)['distributed'] === 'object'
            && (rawCacheInput as Record<string, unknown>)['distributed'] !== null;
        const cacheInput = hasDistributedCfg
            ? {
                ...(rawCacheInput as Record<string, unknown>),
                publish: (msg: { type: string; pattern?: string; key?: string; ts: number }) => {
                    const publishTask = msg.key
                        ? this._distributedInvalidator?.invalidateKey(msg.key)
                        : msg.pattern
                            ? this._distributedInvalidator?.invalidate(msg.pattern)
                            : undefined;
                    void publishTask?.catch((error: unknown) => {
                        this._logger?.warn?.('[Cache] distributed invalidation publish failed.', error);
                    });
                },
            }
            : rawCacheInput;
        const normalizedCache = normalizeRuntimeCacheWithLifecycle(cacheInput as Record<string, unknown> | MemoryCache | undefined);
        this._cache = normalizedCache.cache;
        this._cacheClose = normalizedCache.close;
        this._logger = Logger.create(options.logger ?? null);
        this._schemaDslEngine = createInitialRuntimeSchemaDslEngine();
        if (shouldWarnUnsignedCursorSecret(options)) this._logger.warn?.('[MonSQLizeRuntime] cursorSecret is not configured; findPage cursor tokens are unsigned.');
        if (shouldWarnTransactionDistributedLock(options)) this._logger.warn?.('[MonSQLizeRuntime] transaction.distributedLock is a compatibility configuration and is not wired into the transaction cache lock in the v2 runtime. Transaction cache locks remain process-local; use explicit business locking with idempotency/fencing or disable cache when cross-instance strict consistency is required.');
        this._cacheLockManager = new CacheLockManager({
            logger: options.logger ?? null,
            maxDuration: options.transaction?.lockMaxDuration,
            cleanupInterval: options.transaction?.lockCleanupInterval,
        });
        this._cache.setLockManager?.(this._cacheLockManager);
        this._runtimeDefaults = buildRuntimeDefaults(options);
        this._adapterCacheOverride = undefined;
        this._adapterBridge = createRuntimeAdapterBridge(createRuntimeCoreAdapterBridgeHost(this));
        this.defaults = buildPublicDefaults(options);
        // v1 compat: initialise autoConvertConfig (delegates to the capability-wiring pure function).
        this.autoConvertConfig = initAutoConvertConfig(options.autoConvertObjectId, options.type);
    }
    async connect(): Promise<ConnectResult<MonSQLizeRuntime>> {
        if (this._connected) {
            return createRuntimeCoreAccessors(this);
        }
        if (this._connectionPromise) {
            return this._connectionPromise;
        }
        this._connectionPromise = (async () => {
            this._schemaDslEngine = replaceRuntimeSchemaDslEngine(this._schemaDslEngine, this.options, this._logger);
            const databaseName = resolveDatabaseName(this.options);
            let connectConfig = this.options.config;
            const sshPrepared = await prepareSshTunnelConnectConfig(connectConfig, databaseName, this._logger);
            connectConfig = sshPrepared.connectConfig;
            this._sshTunnel = sshPrepared.tunnel;
            const { client } = await connectMongo({
                databaseName,
                config: connectConfig,
                logger: this._logger,
            });
            this._client = client;
            this._defaultDb = this.createDbFacade(databaseName);
            if (!this._poolManager) {
                this._poolManager = await createAndStartPoolManager(this.options);
            }
            this.initializeSagaOrchestrator();
            this.initializeSlowQueryLogManager();
            await this.initializeSyncManager();
            if (!this._distributedInvalidator) {
                this._distributedInvalidator = await initializeDistributedCacheInvalidator(
                    this.options, this._cache, this._logger,
                );
                if (this._distributedInvalidator && this._cache instanceof MemoryCache) {
                    this._logger.warn?.(
                        '[Cache] distributed invalidator created but cache has no publish hook — ' +
                        'broadcast path disabled. Use cache: { local, remote, distributed } for full cross-instance sync.',
                    );
                }
            }
            await this._loadModels();
            this._connected = true;
            this.emit('connected', {
                type: this.options.type,
                db: databaseName,
            });
            return createRuntimeCoreAccessors(this);
        })();
        try {
            return await this._connectionPromise;
        } catch (error) {
            // Clean up partially initialized resources so a retry starts fresh.
            // Only runs when _connected is still false (i.e., failure before the
            // point-of-no-return assignment), which means client/pool may have
            // been created but never handed off to callers.
            if (!this._connected) {
                const resources = {
                    client: this._client,
                    pool: this._poolManager,
                    tunnel: this._sshTunnel,
                    invalidator: this._distributedInvalidator,
                    sync: this._syncManager,
                    slowQuery: this._slowQueryLogManager,
                    transaction: this._transactionManager,
                    lock: this._lockManager,
                };
                this._client = null;
                this._defaultDb = null;
                this._poolManager = null;
                this._sshTunnel = null;
                this._distributedInvalidator = null;
                this._syncManager = null;
                this._slowQueryLogManager = null;
                this._transactionManager = null;
                this._lockManager = null;
                this._sagaOrchestrator = null;
                await cleanupFailedRuntimeConnection(resources, this._logger);
            }
            this.emit('error', {
                type: this.options.type,
                db: resolveDatabaseName(this.options),
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        } finally {
            this._connectionPromise = null;
        }
    }
    getCache(): CacheLike { return this._cache; }
    getDefaults(): Record<string, unknown> {
        const d = this.defaults as Record<string, unknown>;
        return buildPublicSnapshot({
            type: this.options.type,
            databaseName: this.options.databaseName,
            sync: this.options.sync,
            slowQueryLog: d.slowQueryLog ?? this.options.slowQueryLog ?? false,
            maxTimeMS: d.maxTimeMS,
            findLimit: d.findLimit,
            findMaxLimit: d.findMaxLimit,
            findMaxSkip: d.findMaxSkip,
            findPageMaxLimit: d.findPageMaxLimit,
            autoConvertObjectId: d.autoConvertObjectId,
            cursorSecret: this.options.cursorSecret !== undefined ? '***' : undefined,
            requireCursorSecret: d.requireCursorSecret,
            cursorTypes: d.cursorTypes,
            namespace: d.namespace,
            log: d.log,
            countQueue: this.options.countQueue,
            models: this.options.models,
            autoIndex: this.options.autoIndex,
        });
}
    async close(): Promise<void> {
        // Run async cleanup concurrently; a single failure must not skip remaining steps.
        const results = await Promise.allSettled([
            this._syncManager?.stop(),
            this._slowQueryLogManager?.close(),
            this._transactionManager?.abortAll(),
            this._poolManager?.close(),
            this._distributedInvalidator?.close(),
        ]);
        for (const result of results) {
            if (result.status === 'rejected') {
                this._logger.warn('[MonSQLizeRuntime] cleanup error during close', result.reason);
            }
        }
        // Synchronous cleanup — order matters: locks before mongo client.
        this._cacheLockManager.stop();
        this._lockManager?.close();
        if (this._cacheClose) {
            await this._cacheClose().catch((err) => {
                this._logger.warn('[MonSQLizeRuntime] cache cleanup error during close', err);
            });
        }
        disposeRuntimeSchemaDslEngine(this._schemaDslEngine, this._logger, 'during close');
        await closeMongo(this._client, this._logger);
        // Close SSH tunnel after MongoDB — the driver used the tunnel, so tear it down last.
        if (this._sshTunnel) {
            await this._sshTunnel.close().catch((err) => {
                this._logger.warn('[SSH] Error closing SSH tunnel', err);
            });
        }
        // Reset all state references.
        this._client = null;
        this._defaultDb = null;
        this._connected = false;
        this._poolManager = null;
        this._syncManager = null;
        this._slowQueryLogManager = null;
        this._transactionManager = null;
        this._lockManager = null;
        this._sagaOrchestrator = null;
        this._iidCache = null;
        this._sshTunnel = null;
        this._distributedInvalidator = null;
        this._modelInstances.clear();
        this.emit('closed', {
            type: this.options.type,
            db: resolveDatabaseName(this.options),
        });
    }

    async health(): Promise<HealthView> {
        let driverConnected = this._connected;
        let driverError: string | undefined;
        if (this._connected && this._adapterBridge) {
            try {
                driverConnected = await this._adapterBridge.ping();
            } catch (error) {
                driverConnected = false;
                driverError = error instanceof Error ? error.message : String(error);
            }
        }
        const cacheStats = (this._cache as { getStats?: () => unknown }).getStats?.();
        const poolHealth = this._poolManager?.getHealthStatus();
        const distributedStats = this._distributedInvalidator?.getStats() ?? null;
        const connected = this._connected && driverConnected;
        return {
            status: connected ? 'up' : 'down',
            connected,
            driver: { connected: driverConnected, ...(driverError ? { error: driverError } : {}) },
            defaults: this.getDefaults(),
            cache: {
                enabled: true,
                stats: cacheStats,
                pools: poolHealth,
                distributed: distributedStats,
            },
            checks: {
                driver: {
                    status: driverConnected ? 'up' : 'down',
                    connected: driverConnected,
                    ...(driverError ? { error: driverError } : {}),
                },
                cache: {
                    status: 'up',
                    enabled: true,
                    hasStats: cacheStats !== undefined,
                },
                distributedCacheInvalidator: {
                    status: distributedStats ? 'up' : 'unknown',
                    enabled: distributedStats !== null,
                    stats: distributedStats,
                },
                pools: {
                    status: poolHealth ? 'up' : 'unknown',
                    enabled: poolHealth !== undefined,
                    health: poolHealth,
                },
            },
            capabilities: {
                models: Model.list().length,
                sync: this._syncManager?.getStats?.() ?? null,
                locks: this.getLockStats(),
            },
        };
    }

    // v1 exposes cache / _adapter / dbInstance / _connecting directly; keep same-name bridges here.
    get cache(): CacheLike { return this._cache; }

    get _adapter(): RuntimeAdapterSurface | null {
        if (this._client === null) return null;
        return this._adapterBridge;
    }

    get dbInstance(): {
        collection: (name: string) => unknown;
        db: (name?: string) => unknown;
        /** @deprecated Access via `msq.withLock()` — v1 compatibility shim. */
        withLock: <T>(key: string, callback: () => Promise<T>, options?: LockOptions) => Promise<T>;
        /** @deprecated Access via `msq.acquireLock()` — v1 compatibility shim. */
        acquireLock: (key: string, options?: LockOptions) => Promise<Lock>;
        /** @deprecated Access via `msq.tryAcquireLock()` — v1 compatibility shim. */
        tryAcquireLock: (key: string, options?: Omit<LockOptions, 'retryTimes'>) => Promise<Lock | null>;
        /** @deprecated Access via `msq.getLockStats()` — v1 compatibility shim. */
        getLockStats: () => LockStats | null;
    } | null {
        if (this._client === null) return null;
        return {
            collection: (name: string) => this.collection(name),
            db: (name?: string) => this.db(name),
            withLock: <T>(key: string, callback: () => Promise<T>, options?: LockOptions) => this.withLock(key, callback, options),
            acquireLock: (key: string, options?: LockOptions) => this.acquireLock(key, options),
            tryAcquireLock: (key: string, options?: Omit<LockOptions, 'retryTimes'>) => this.tryAcquireLock(key, options),
            getLockStats: () => this.getLockStats(),
        };
    }

    get _connecting(): Promise<unknown> | null { return this._connectionPromise; }

    // Root accessors ----------------------------------------------------------
    collection(name: string): CollectionFacade {
        if (!name || typeof name !== 'string' || !name.trim()) {
            const err = new Error('Collection name must be a non-empty string') as Error & { code: string };
            err.code = 'INVALID_COLLECTION_NAME';
            throw err;
        }
        const dbInstance = requireCompatDbInstance(this);
        // v2 path: delegate to db().collection() via MongoClient
        if (this._client) {
            return this.db().collection(name);
        }
        // v1 compat path: delegate via dbInstance
        return dbInstance.collection(name) as CollectionFacade;
    }

    db(name?: string): DbFacade {
        if (name !== undefined) {
            if (!name || typeof name !== 'string' || !name.trim()) {
                const err = new Error('Database name must be a non-empty string') as Error & { code: string };
                err.code = 'INVALID_DATABASE_NAME';
                throw err;
            }
        }
        this.ensureConnected();
        if (!this._client) {
            throw createError(ErrorCodes.NOT_CONNECTED, 'MonSQLize is not connected yet.');
        }
        const databaseName = name ?? resolveDatabaseName(this.options);
        if (databaseName === resolveDatabaseName(this.options) && this._defaultDb) {
            return this._defaultDb;
        }
        return this.createDbFacade(databaseName);
    }

    use(name: string): ScopedUseResult {
        requireCompatDbInstance(this);
        return {
            collection: (collectionName: string) => this.scopedCollection(collectionName, { database: name }),
            model: <TDocument = Record<string, unknown>>(modelName: string) => this.scopedModel<TDocument>(modelName, { database: name }),
        };
    }

    pool(poolName: string): {
        collection: (name: string) => CollectionFacade;
        model: <TDocument = Record<string, unknown>>(name: string) => ModelInstance<TDocument>;
        use: (dbName: string) => { collection: (name: string) => CollectionFacade; model: <TDocument = Record<string, unknown>>(name: string) => ModelInstance<TDocument>; };
    } {
        requireCompatDbInstance(this);
        const poolManager = requireCompatPoolManagerRecord(this);
        assertCompatPoolExists(poolManager, poolName);
        return createPoolScope(this, poolName);
    }

    scopedCollection(name: string, options: { database?: string; pool?: string; } = {}): CollectionFacade {
        requireCompatDbInstance(this);
        const { pool, database } = options;
        if (!pool && !database) {
            return this.collection(name);
        }
        return this._resolveModelCollection(name, { pool, database }) as CollectionFacade;
    }

    _resolveModelCollection(collectionName: string, connection: { pool?: string; database?: string }): unknown {
        return resolveScopedCollection({
            collectionName,
            connection,
            options: this.options,
            self: asRuntimeCompatRecord(this),
            client: this._client,
            poolManager: this._poolManager,
            cache: this._cache,
            logger: this._logger,
            runtimeDefaults: this._runtimeDefaults,
            db: (name?: string) => this.db(name),
        });
    }

    // Model accessors ---------------------------------------------------------
    scopedModel<TDocument = Record<string, unknown>>(name: string, options: { database?: string; pool?: string; } = {}): ModelInstance<TDocument> {
        const dbInstance = requireCompatDbInstance(this);
        // v2 path: use createModelInstance (handles connection and caching)
        if (this._client) {
            return this.createModelInstance<TDocument>(name, options);
        }
        // v1 compat path: v1-style implementation (with connection merging)
        const registered = Model.get<TDocument>(name);
        if (!registered) {
            throw createError(ErrorCodes.MODEL_NOT_DEFINED, `Model '${name}' is not defined. Call Model.define() first.`);
        }
        const { actualCollectionName, connection } = getRegisteredModelMetadata(registered);
        // v1 connection merge: definition.connection as fallback, opts takes higher priority
        const merged: Record<string, unknown> = { ...(connection ?? {}), ...options };
        const { pool, database } = merged as { pool?: string; database?: string };
        const collection = (pool || database)
            ? this._resolveModelCollection(actualCollectionName, { pool, database })
            : dbInstance.collection(actualCollectionName);
        return createCompatModelInstance<TDocument>({
            collection,
            runtime: this,
            collectionName: actualCollectionName,
            modelName: registered.collectionName,
            dbName: database ?? getRuntimeDatabaseName(this),
            poolName: pool,
            definition: registered.definition,
            schemaEngine: this._schemaDslEngine,
        });
    }

    model<TDocument = Record<string, unknown>>(name: string): ModelInstance<TDocument> {
        // v2 path
        if (this._client) {
            this.ensureConnected();
            return this.createModelInstance<TDocument>(name, {
                database: resolveDatabaseName(this.options),
            });
        }
        // v1 compat path: mirrors v1 model() — checks dbInstance, lazily initialises _modelInstances cache
        const dbInstance = requireCompatDbInstance(this);

        // Cache hit + _redefinedNames invalidation check
        const cache = getCompatModelInstanceCache(this);
        if (cache.has(name)) {
            if (!Model._redefinedNames.has(name)) {
                return cache.get(name) as ModelInstance<TDocument>;
            }
            cache.del(name);
            Model._redefinedNames.delete(name);
        }

        const registered = Model.get<TDocument>(name);
        if (!registered) {
            throw createError(ErrorCodes.MODEL_NOT_DEFINED, `Model '${name}' is not defined.`);
        }
        const { actualCollectionName, connection } = getRegisteredModelMetadata(registered);
        const collection = (connection && (connection.pool || connection.database))
            ? this._resolveModelCollection(actualCollectionName, connection)
            : dbInstance.collection(actualCollectionName);
        const instance = createCompatModelInstance<TDocument>({
            collection,
            runtime: this,
            collectionName: actualCollectionName,
            modelName: registered.collectionName,
            dbName: getRuntimeDatabaseName(this),
            definition: registered.definition,
            schemaEngine: this._schemaDslEngine,
        });
        cache.set(name, instance as ModelInstance<Record<string, unknown>>);
        return instance;
    }

    async ensureModelIndexes(options: ModelEnsureAllIndexesOptions = {}): Promise<ModelIndexEnsureSummary> { this.ensureConnected(); return ensureRuntimeModelIndexes(this, options); }

    // Capability delegation ----------------------------------------------------
    async startSession(options: TransactionOptions = {}): Promise<Transaction> {
        this.ensureConnected();
        return this.getTransactionManager().startSession(options);
    }

    async withTransaction<T>(callback: (transaction: Transaction) => Promise<T>, options: TransactionOptions = {}): Promise<T> {
        this.ensureConnected();
        return this.getTransactionManager().withTransaction(callback, options);
    }

    async withLock<T>(key: string, callback: () => Promise<T>, options: LockOptions = {}): Promise<T> {
        this.ensureConnected();
        return this.getLockManager().withLock(key, callback, options);
    }

    async acquireLock(key: string, options: LockOptions = {}): Promise<Lock> {
        this.ensureConnected();
        return this.getLockManager().acquireLock(key, options);
    }

    async tryAcquireLock(key: string, options: Omit<LockOptions, 'retryTimes'> = {}): Promise<Lock | null> {
        this.ensureConnected();
        return this.getLockManager().tryAcquireLock(key, options);
    }

    getSyncManager(): ChangeStreamSyncManager | null { return this._syncManager; }
    getSlowQueryLogManager(): SlowQueryLogManager | null { return this._slowQueryLogManager; }
    getSagaOrchestrator(): SagaOrchestrator { return this.initializeSagaOrchestrator(); }
    saga(): SagaOrchestrator { return this.getSagaOrchestrator(); }
    async recordSlowQuery(log: SlowQueryLogEntry): Promise<void> {
        this.ensureConnected();
        const manager = this.ensureSlowQueryLogManager();
        await manager.save(log);
        this.emit('slow-query', log);
        this.emit('query', log);
    }

    async getSlowQueryLogs(filter: SlowQueryLogFilter = {}, options: SlowQueryLogQueryOptions = {}): Promise<SlowQueryLogRecord[]> {
        this.ensureConnected();
        const manager = this.ensureSlowQueryLogManager();
        return manager.query(filter, options);
    }

    defineSaga(definition: SagaDefinition): Promise<SagaDefinition> { return this.initializeSagaOrchestrator().defineSaga(definition); }
    async executeSaga(name: string, data: unknown): Promise<SagaResult> { return this.initializeSagaOrchestrator().execute(name, data); }
    listSagas(): string[] { return this.initializeSagaOrchestrator().listSagas(); }
    getTransactionStats(): TransactionStats | null { return this._transactionManager?.getStats() ?? null; }
    getSagaStats(): SagaStats { return this.initializeSagaOrchestrator().getStats(); }
    getDistributedCacheInvalidatorStats(): ReturnType<DistributedCacheInvalidator['getStats']> | null {
        return this._distributedInvalidator?.getStats() ?? null;
    }
    async startSync(): Promise<void> {
        this.ensureConnected();
        const manager = await this.initializeSyncManager();
        if (!manager) {
            throw createError(ErrorCodes.INVALID_CONFIG, 'MonSQLize sync is not enabled for this runtime.');
        }
        await manager.start();
    }

    async stopSync(): Promise<void> { await this._syncManager?.stop(); }
    getSyncStats(): SyncStats | null { return this._syncManager?.getStats() ?? null; }
    on(event: string, handler: (payload: unknown) => void): void { this._events.on(event, handler); }
    once(event: string, handler: (payload: unknown) => void): void { this._events.once(event, handler); }
    off(event: string, handler: (payload: unknown) => void): void { this._events.off(event, handler); }
    emit(event: string, payload: unknown): void {
        if (event === 'error' && this._events.listenerCount('error') === 0) {
            this._logger.error('[MonSQLizeRuntime] error event', payload);
            return;
        }
        this._events.emit(event, payload);
    }

    async addPool(config: PoolConfig): Promise<void> { await this.requirePoolManager().addPool(config); }
    async removePool(name: string): Promise<void> { await this.requirePoolManager().removePool(name); }
    getPoolNames(): string[] { return this.requirePoolManager().getPoolNames(); }
    getPoolStats(): Record<string, PoolStats> { return this.requirePoolManager().getPoolStats(); }
    getPoolHealth(): Record<string, PoolHealthStatus> { return this.requirePoolManager().getHealthStatus(); }
    getLockStats(): LockStats | null { return this._lockManager?.getStats() ?? null; }
    async listDatabases(options: { nameOnly?: boolean } = {}): Promise<Array<{ name: string; sizeOnDisk: number; empty: boolean }> | string[]> { this.ensureConnected(); return this.db().listDatabases(options); }
    async dropDatabase(options: { confirm: boolean; allowProduction?: boolean; user?: string } = { confirm: false }): Promise<{ dropped: boolean; database: string; timestamp: Date }> { this.ensureConnected(); return this.db().dropDatabase(options); }
    async listCollections(filter: Record<string, unknown> = {}, options: Record<string, unknown> = {}): Promise<Array<{ name: string; type: string }>> { this.ensureConnected(); return this.db().listCollections(filter, options); }
    async runCommand(command: Record<string, unknown>, options: Record<string, unknown> = {}): Promise<Record<string, unknown>> { this.ensureConnected(); return this.db().runCommand(command, options); }

    private ensureConnected(): void {
        if (!this._connected) {
            throw createError(ErrorCodes.NOT_CONNECTED, 'Database is not connected. Please call connect() first.');
        }
    }

    private createDbFacade(databaseName: string): DbFacade {
        return createRuntimeDbFacade(createRuntimeCoreDbFacadeHost(this), databaseName);
    }

    private getTransactionManager(): TransactionManager {
        this._transactionManager = getOrCreateTransactionManager({
            current: this._transactionManager,
            client: this._client,
            cache: this._cache,
            logger: this.options.logger ?? null,
            lockManager: this._cacheLockManager,
            transaction: this.options.transaction,
        });
        return this._transactionManager;
    }

    private getLockManager(): LockManager {
        this._lockManager = getOrCreateLockManager(this._lockManager, this.options.logger ?? null);
        return this._lockManager;
    }

    async _loadModels(opts: { reload?: boolean } = {}): Promise<void> { await loadModelFiles(this.options, this._logger, opts); }

    private async initializeSyncManager(): Promise<ChangeStreamSyncManager | null> {
        this._syncManager = await initializeRuntimeSyncManager({
            enabled: !!this.options.sync?.enabled,
            defaultDb: this._defaultDb,
            current: this._syncManager,
            poolManager: this._poolManager,
            sync: this.options.sync!,
            logger: this.options.logger ?? null,
            onStartFailure: (error) => {
                this._logger.warn('[Sync] failed to start automatically', error);
                this.emit('error', {
                    type: this.options.type,
                    db: resolveDatabaseName(this.options),
                    error: error instanceof Error ? error.message : String(error),
                });
            },
        });
        return this._syncManager;
    }

    private initializeSlowQueryLogManager(): SlowQueryLogManager | null {
        this._slowQueryLogManager = initializeRuntimeSlowQueryLogManager({
            current: this._slowQueryLogManager,
            slowQueryLog: this.options.slowQueryLog,
            slowQueryMs: this.options.slowQueryMs,
            client: this._client,
            logger: this.options.logger ?? null,
        });
        return this._slowQueryLogManager;
    }

    private ensureSlowQueryLogManager(): SlowQueryLogManager { return ensureRuntimeSlowQueryLogManager(this.initializeSlowQueryLogManager()); }

    private initializeSagaOrchestrator(): SagaOrchestrator {
        this._sagaOrchestrator = getOrCreateSagaOrchestrator(this._sagaOrchestrator, this.options.logger ?? null, this._cache);
        return this._sagaOrchestrator;
    }

    private requirePoolManager(): ConnectionPoolManager {
        return requireRuntimePoolManager(this._poolManager);
    }

    private createModelInstance<TDocument = Record<string, unknown>>(
        name: string,
        scope: { database?: string; pool?: string; },
    ): ModelInstance<TDocument> {
        return createRuntimeModelInstance(createRuntimeCoreModelHost(this), name, scope);
    }
}
