import {
    adaptLegacyCacheLike,
    BatchQueue,
    ChangeStreamSyncManager,
    DataTaskJobError,
    CacheLockManager,
    compilePipelineExpressions,
    ConnectionPoolManager,
    CountQueue,
    DEFAULT_SLOW_QUERY_LOG_CONFIG,
    DistributedCacheInvalidator,
    DistributedCacheLockManager,
    encodeCursor,
    decodeCursor,
    ErrorCodes,
    MongoDBSlowQueryLogStorage,
    expr,
    createExpression,
    createConnectionError,
    createError,
    createValidationError,
    createCursorError,
    createQueryTimeoutError,
    createRedisCacheAdapter,
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
    ModelInstance,
    MonSQLizeRuntime,
    normalizeProjection,
    normalizeSort,
    ResumeTokenStore,
    SagaOrchestrator,
    SlowQueryLogConfigManager,
    SlowQueryLogMemoryStorage,
    SlowQueryLogManager,
    Transaction,
    TransactionManager,
    Lock,
    LockAcquireError,
    LockManager,
    LockTimeoutError,
    validateSyncConfig,
    validateTargetConfig,
    validateResumeTokenConfig,
    validateRange,
    validatePositiveInteger,
    withCache,
    withSlowQueryLog,
} from './runtime-core.js';
import { createDataTaskService } from '../capabilities/data-tasks/job-service.js';
import {
    HealthChecker,
    PoolSelector,
    PoolStatsManager,
    validatePoolConfig,
    validatePoolConfigSafe,
} from '../capabilities/pool/index.js';

const MonSQLize = MonSQLizeRuntime as typeof MonSQLizeRuntime & Record<string, unknown>;
const dataTasks = createDataTaskService((options) => new MonSQLizeRuntime(options) as unknown as import('../capabilities/data-tasks/job-service.js').DataTaskManagedRuntime);

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
MonSQLize.ModelInstance = ModelInstance;
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

export default MonSQLize;

export {
    MonSQLize,
    Logger,
    MemoryCache,
    MultiLevelCache,
    adaptLegacyCacheLike,
    createRedisCacheAdapter,
    Transaction,
    TransactionManager,
    CacheLockManager,
    Lock,
    LockManager,
    LockAcquireError,
    LockTimeoutError,
    DistributedCacheLockManager,
    DistributedCacheInvalidator,
    ConnectionPoolManager,
    HealthChecker,
    PoolSelector,
    PoolStatsManager,
    validatePoolConfig,
    validatePoolConfigSafe,
    defineModel,
    Model,
    ModelInstance,
    expr,
    createExpression,
    compilePipelineExpressions,
    isExpressionObject,
    hasExpressionInObject,
    hasExpressionInPipeline,
    withCache,
    FunctionCache,
    ChangeStreamSyncManager,
    ResumeTokenStore,
    validateSyncConfig,
    validateTargetConfig,
    validateResumeTokenConfig,
    SlowQueryLogManager,
    SlowQueryLogConfigManager,
    SlowQueryLogMemoryStorage,
    MongoDBSlowQueryLogStorage,
    BatchQueue,
    DataTaskJobError,
    dataTasks,
    generateQueryHash,
    SagaOrchestrator,
    encodeCursor,
    decodeCursor,
    ErrorCodes,
    normalizeProjection,
    normalizeSort,
    makePageResult,
    validateRange,
    validatePositiveInteger,
    withSlowQueryLog,
    getSlowQueryThreshold,
    CountQueue,
    DEFAULT_SLOW_QUERY_LOG_CONFIG,
    createConnectionError,
    createError,
    createValidationError,
    createCursorError,
    createQueryTimeoutError,
};

