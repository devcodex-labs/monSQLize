/**
 * monSQLize main entry point (barrel).
 *
 * Re-exports the MonSQLize main class and all capability sub-module public APIs.
 * This is the only recommended import entry point for consumers.
 */
import {
    adaptLegacyCacheLike,
    BatchQueue,
    CountQueue,
    DataTaskJobError,
    DEFAULT_SLOW_QUERY_LOG_CONFIG,
    MongoDBSlowQueryLogStorage,
    ChangeStreamSyncManager,
    compilePipelineExpressions,
    ConnectionPoolManager,
    DistributedCacheInvalidator,
    DistributedCacheLockManager,
    encodeCursor,
    decodeCursor,
    ErrorCodes,
    expr,
    createExpression,
    createRedisCacheAdapter,
    createConnectionError,
    createError,
    createValidationError,
    createCursorError,
    createQueryTimeoutError,
    FunctionCache,
    generateQueryHash,
    getSlowQueryThreshold,
    defineModel,
    hasExpressionInObject,
    hasExpressionInPipeline,
    isExpressionObject,
    Logger,
    makePageResult,
    MemoryCache,
    MultiLevelCache,
    Model,
    MonSQLizeRuntime,
    normalizeProjection,
    normalizeSort,
    ResumeTokenStore,
    SagaOrchestrator,
    SlowQueryLogConfigManager,
    SlowQueryLogMemoryStorage,
    SlowQueryLogManager,
    validateRange,
    validatePositiveInteger,
    validateSyncConfig,
    validateTargetConfig,
    validateResumeTokenConfig,
    withCache,
    withSlowQueryLog,
} from './runtime-core';
import { createDataTaskService } from '../capabilities/data-tasks/job-service';
import { Lock, LockAcquireError, LockManager, LockTimeoutError } from '../capabilities/lock';
import { CacheLockManager, Transaction, TransactionManager } from '../capabilities/transaction';
import {
    HealthChecker,
    PoolSelector,
    PoolStatsManager,
    validatePoolConfig,
    validatePoolConfigSafe,
} from '../capabilities/pool';

const MonSQLize = MonSQLizeRuntime as typeof MonSQLizeRuntime & Record<string, unknown>;
const dataTasks = createDataTaskService((options) => new MonSQLizeRuntime(options) as unknown as import('../capabilities/data-tasks/job-service').DataTaskManagedRuntime);

MonSQLize.Logger = Logger;
MonSQLize.MemoryCache = MemoryCache;
MonSQLize.Transaction = Transaction;
MonSQLize.createRedisCacheAdapter = createRedisCacheAdapter;
MonSQLize.TransactionManager = TransactionManager;
MonSQLize.CacheLockManager = CacheLockManager;
MonSQLize.Lock = Lock;
MonSQLize.LockManager = LockManager;
MonSQLize.LockAcquireError = LockAcquireError;
MonSQLize.LockTimeoutError = LockTimeoutError;
MonSQLize.DistributedCacheInvalidator = DistributedCacheInvalidator;
MonSQLize.ConnectionPoolManager = ConnectionPoolManager;
MonSQLize.HealthChecker = HealthChecker;
MonSQLize.PoolSelector = PoolSelector;
MonSQLize.PoolStats = PoolStatsManager;
MonSQLize.validatePoolConfig = validatePoolConfig;
MonSQLize.validatePoolConfigSafe = validatePoolConfigSafe;
MonSQLize.defineModel = defineModel;
MonSQLize.Model = Model;
MonSQLize.expr = expr;
MonSQLize.createExpression = createExpression;
MonSQLize.compilePipelineExpressions = compilePipelineExpressions;
MonSQLize.isExpressionObject = isExpressionObject;
MonSQLize.hasExpressionInObject = hasExpressionInObject;
MonSQLize.hasExpressionInPipeline = hasExpressionInPipeline;
MonSQLize.withCache = withCache;
MonSQLize.FunctionCache = FunctionCache;
MonSQLize.ChangeStreamSyncManager = ChangeStreamSyncManager;
MonSQLize.ResumeTokenStore = ResumeTokenStore;
MonSQLize.validateSyncConfig = validateSyncConfig;
MonSQLize.validateTargetConfig = validateTargetConfig;
MonSQLize.validateResumeTokenConfig = validateResumeTokenConfig;
MonSQLize.SlowQueryLogManager = SlowQueryLogManager;
MonSQLize.SlowQueryLogConfigManager = SlowQueryLogConfigManager;
MonSQLize.SlowQueryLogMemoryStorage = SlowQueryLogMemoryStorage;
MonSQLize.MongoDBSlowQueryLogStorage = MongoDBSlowQueryLogStorage;
MonSQLize.BatchQueue = BatchQueue;
MonSQLize.DataTaskJobError = DataTaskJobError;
MonSQLize.dataTasks = dataTasks;
MonSQLize.generateQueryHash = generateQueryHash;
MonSQLize.SagaOrchestrator = SagaOrchestrator;
MonSQLize.encodeCursor = encodeCursor;
MonSQLize.decodeCursor = decodeCursor;
MonSQLize.ErrorCodes = ErrorCodes;
MonSQLize.normalizeProjection = normalizeProjection;
MonSQLize.normalizeSort = normalizeSort;
MonSQLize.makePageResult = makePageResult;
MonSQLize.validateRange = validateRange;
MonSQLize.validatePositiveInteger = validatePositiveInteger;
MonSQLize.DistributedCacheLockManager = DistributedCacheLockManager;
MonSQLize.withSlowQueryLog = withSlowQueryLog;
MonSQLize.getSlowQueryThreshold = getSlowQueryThreshold;
MonSQLize.CountQueue = CountQueue;
MonSQLize.DEFAULT_SLOW_QUERY_LOG_CONFIG = DEFAULT_SLOW_QUERY_LOG_CONFIG;
MonSQLize.createConnectionError = createConnectionError;
MonSQLize.createError = createError;
MonSQLize.createValidationError = createValidationError;
MonSQLize.createCursorError = createCursorError;
MonSQLize.createQueryTimeoutError = createQueryTimeoutError;
MonSQLize.adaptLegacyCacheLike = adaptLegacyCacheLike;
MonSQLize.MultiLevelCache = MultiLevelCache;

export = MonSQLize;

