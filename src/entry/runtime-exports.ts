/**
 * runtime-exports.ts — public symbol barrel
 *
 * Notes:
 * - Re-exports types and implementations from sub-modules for external consumption
 * - Fully compatible with the original inline exports in runtime-core.ts; no public API is changed
 * - Add new public symbols here rather than modifying the runtime-core.ts body
 */

export {
    MongoCollectionAccessor as CollectionFacade,
    MongoDbAccessor as DbFacade,
} from '../adapters/mongodb/common/accessors';

// Runtime and cache capabilities
export { Logger } from '../core/logger';
export { MemoryCache, createRedisCacheAdapter, DistributedCacheInvalidator, adaptLegacyCacheLike, MultiLevelCache } from '../capabilities/cache';
export type { CacheStats } from '../capabilities/cache';
export { FunctionCache, withCache } from '../capabilities/function-cache';
export type { CachedFunction, WithCacheOptions } from '../capabilities/function-cache';

// Model / expression / pool / sync and other core capabilities
export { defineModel, Model, ModelInstance } from '../capabilities/model';
export type {
    InferModelDocument,
    ModelConnection,
    ModelDescriptor,
    ModelDefinition,
    PopulateConfig,
    PopulateProxy,
    RelationConfig,
    ValidationResult,
    VirtualConfig,
} from '../capabilities/model';
export {
    createExpression,
    compilePipelineExpressions,
    expr,
    hasExpressionInObject,
    hasExpressionInPipeline,
    isExpressionObject,
} from '../core/expression';
export type { ExpressionObject } from '../core/expression';
export { ConnectionPoolManager } from '../capabilities/pool';
export type {
    ConnectionPoolManagerOptions,
    FallbackStrategy,
    PoolConfig,
    PoolHealthStatus,
    PoolRole,
    PoolStats,
    PoolStrategy,
} from '../capabilities/pool';
export { ChangeStreamSyncManager, ResumeTokenStore, validateSyncConfig, validateTargetConfig, validateResumeTokenConfig } from '../capabilities/sync';
export type {
    ResumeTokenConfig,
    SyncChangeEvent,
    SyncConfig,
    SyncStats,
    SyncTargetConfig,
} from '../capabilities/sync';
export {
    BatchQueue,
    DEFAULT_SLOW_QUERY_LOG_CONFIG,
    MongoDBSlowQueryLogStorage,
    SlowQueryLogConfigManager,
    SlowQueryLogMemoryStorage,
    SlowQueryLogManager,
    generateQueryHash,
    getSlowQueryThreshold,
    withSlowQueryLog,
} from '../capabilities/slow-query-log';
export type {
    SlowQueryLogConfig,
    SlowQueryLogConfigInput,
    SlowQueryLogEntry,
    SlowQueryLogFilter,
    SlowQueryLogQueryOptions,
    SlowQueryLogRecord,
} from '../capabilities/slow-query-log';
export { SagaOrchestrator } from '../capabilities/saga';
export type {
    SagaDefinition,
    SagaOrchestratorOptions,
    SagaResult,
    SagaStats,
    SagaStep,
} from '../capabilities/saga';

// General utilities and error capabilities
export { encodeCursor, decodeCursor } from '../utils/cursor';
export {
    ErrorCodes,
    createError,
    createConnectionError,
    createValidationError,
    createCursorError,
    createQueryTimeoutError,
} from '../core/errors';
export { normalizeProjection, normalizeSort } from '../utils/normalize';
export { makePageResult } from '../utils/page-result';
export { validateRange, validatePositiveInteger } from '../utils/validation';

// Lock, transaction, and statistics capabilities
export { DistributedCacheLockManager, Lock, LockAcquireError, LockTimeoutError, LockManager } from '../capabilities/lock';
export type { LockOptions, LockStats } from '../capabilities/lock';
export { Transaction, TransactionManager, CacheLockManager } from '../capabilities/transaction';
export type { MongoSession, TransactionOptions, TransactionStats } from '../capabilities/transaction';
export { CountQueue } from '../capabilities/count-queue';
export type { CountQueueOptions, CountQueueStats } from '../capabilities/count-queue';
export { DataTaskJobError } from '../capabilities/data-tasks';
export type {
    DataTaskApplyOptions,
    DataTaskApplyResult,
    DataTaskApproval,
    DataTaskBackupOptions,
    DataTaskBackupRef,
    DataTaskChangeSample,
    DataTaskCollectionJob,
    DataTaskCollectionPreview,
    DataTaskConnection,
    DataTaskConnectionRuntime,
    DataTaskDataRule,
    DataTaskIndexDefinition,
    DataTaskIndexPlan,
    DataTaskIdentity,
    DataTaskJob,
    DataTaskJobErrorCode,
    DataTaskLeaseLockOptions,
    DataTaskPreviewOptions,
    DataTaskPreviewResult,
    DataTaskRestoreOptions,
    DataTaskRestorePreviewResult,
    DataTaskRestoreResult,
    DataTaskRestoreTargetOptions,
    DataTaskService,
    DataTaskVerifyRule,
} from '../capabilities/data-tasks';
export type {
    NormalizedWritePathPolicy,
    NormalizedWritePathRule,
    WritePathNamespace,
    WritePathOperationCategory,
    WritePathPolicyManagementMode,
    WritePathPolicyMode,
    WritePathPolicyOptions,
    WritePathPolicyRawMode,
    WritePathPolicyRule,
    WritePathPolicyViolationAction,
    WritePathSource,
} from '../capabilities/write-path-policy';

// Public types referenced by the root declaration file
export type { LoggerLike } from '../core/logger';
export type { MultiLevelCacheOptions, MultiLevelCachePolicy, WritePolicy } from '../../types/runtime';
export type { HealthView } from '../../types/collection';
export type { MonSQLizeOptions } from '../../types/monsqlize';
export type { SyncTargetHealthCheckConfig } from '../../types/sync';
