import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const EXPECTED_ESM_EXPORTS = [
    'MonSQLize',
    'Logger',
    'MemoryCache',
    'MultiLevelCache',
    'adaptLegacyCacheLike',
    'createRedisCacheAdapter',
    'Transaction',
    'TransactionManager',
    'CacheLockManager',
    'Lock',
    'LockManager',
    'LockAcquireError',
    'LockTimeoutError',
    'DistributedCacheLockManager',
    'DistributedCacheInvalidator',
    'ConnectionPoolManager',
    'defineModel',
    'Model',
    'ModelInstance',
    'expr',
    'createExpression',
    'compilePipelineExpressions',
    'isExpressionObject',
    'hasExpressionInObject',
    'hasExpressionInPipeline',
    'withCache',
    'FunctionCache',
    'ChangeStreamSyncManager',
    'ResumeTokenStore',
    'validateSyncConfig',
    'validateTargetConfig',
    'validateResumeTokenConfig',
    'SlowQueryLogManager',
    'SlowQueryLogConfigManager',
    'SlowQueryLogMemoryStorage',
    'MongoDBSlowQueryLogStorage',
    'BatchQueue',
    'generateQueryHash',
    'SagaOrchestrator',
];

const EXPECTED_CJS_STATICS = [
    'Logger',
    'MemoryCache',
    'Transaction',
    'TransactionManager',
    'CacheLockManager',
    'Lock',
    'LockManager',
    'LockAcquireError',
    'LockTimeoutError',
    'DistributedCacheInvalidator',
    'defineModel',
    'Model',
    'ConnectionPoolManager',
    'HealthChecker',
    'PoolSelector',
    'PoolStats',
    'validatePoolConfig',
    'validatePoolConfigSafe',
    'createRedisCacheAdapter',
    'expr',
    'createExpression',
    'compilePipelineExpressions',
    'isExpressionObject',
    'hasExpressionInObject',
    'hasExpressionInPipeline',
    'withCache',
    'FunctionCache',
    'ChangeStreamSyncManager',
    'ResumeTokenStore',
    'validateSyncConfig',
    'validateTargetConfig',
    'validateResumeTokenConfig',
    'SlowQueryLogManager',
    'SlowQueryLogConfigManager',
    'SlowQueryLogMemoryStorage',
    'MongoDBSlowQueryLogStorage',
    'BatchQueue',
    'generateQueryHash',
    'SagaOrchestrator',
    'encodeCursor',
    'decodeCursor',
    'ErrorCodes',
    'normalizeProjection',
    'normalizeSort',
    'makePageResult',
    'validateRange',
    'validatePositiveInteger',
    'DistributedCacheLockManager',
    'withSlowQueryLog',
    'getSlowQueryThreshold',
    'CountQueue',
    'DEFAULT_SLOW_QUERY_LOG_CONFIG',
    'createConnectionError',
    'createError',
    'createValidationError',
    'createCursorError',
    'createQueryTimeoutError',
    'adaptLegacyCacheLike',
    'MultiLevelCache',
];

const EXPECTED_ESM_DEFAULT_STATICS = EXPECTED_CJS_STATICS;

test('compatibility(exports): ESM export matrix is complete', async () => {
    const entryUrl = pathToFileURL(path.resolve(__dirname, '../../../dist/esm/index.mjs')).href;
    const mod = await import(entryUrl);

    for (const name of EXPECTED_ESM_EXPORTS) {
        assert.ok(name in mod, `Missing ESM export: ${name}`);
    }

    for (const name of EXPECTED_ESM_DEFAULT_STATICS) {
        assert.ok(name in mod.default, `Missing ESM default static export: ${name}`);
    }
});

test('compatibility(exports): CJS static export matrix is complete', () => {
    const MonSQLize = require('../../../dist/cjs/index.cjs');

    for (const name of EXPECTED_CJS_STATICS) {
        assert.ok(name in MonSQLize, `Missing CJS static export: ${name}`);
    }
});

test('compatibility(exports): package metadata subpath remains published', () => {
    const packageJson = require('../../../../../package.json');
    assert.equal(packageJson.exports['./package.json'], './package.json');
});
