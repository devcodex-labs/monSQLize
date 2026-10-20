import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { ObjectId } from 'mongodb';
import { findByIdsDocuments } from '../../../src/adapters/mongodb/queries/find-by-id';

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

test('AR03 keeps the private model query protocol across CJS ESM and adapter bundles', async () => {
    const cjs = require('../../../dist/cjs/index.cjs');
    const esm = await import(pathToFileURL(path.resolve(__dirname, '../../../dist/esm/index.mjs')).href);
    const id = new ObjectId();
    const queries: any[] = [];
    const native = {
        find(filter: unknown, options: object) {
            queries.push(filter);
            assert.equal(Object.getOwnPropertySymbols(options).length, 0);
            return { toArray: async () => [{ _id: id, name: 'live' }] };
        },
    };
    const values = new Map<string, unknown>();
    const cache = { get: (key: string) => values.get(key), set: (key: string, value: unknown) => { values.set(key, value); }, del: (key: string) => values.delete(key) };
    const collection = { findByIds: (ids: unknown[], options: any) => findByIdsDocuments(native as any, ids, options, {}, cache) };
    for (const Constructor of [cjs.ModelInstance, esm.ModelInstance]) {
        const model = new Constructor(collection, {}, {
            collectionName: 'ar03_protocol', dbName: 'compat',
            definition: { schema: {}, options: { softDelete: true, autoIndex: false } },
        });
        await model.findByIds([id], Object.freeze({ projection: { name: 1 }, cache: 10000 }));
        await model.findByIds([id], Object.freeze({ projection: { name: 1 }, cache: 10000 }));
        assert.deepEqual(queries[queries.length - 1], { $and: [{ _id: { $in: [id] } }, { deletedAt: null }] });
    }
    assert.equal(queries.length, 4, 'filtered model results bypass caches without pattern invalidation');
    assert.equal(values.size, 0);
    const beforeRaw = queries.length;
    await findByIdsDocuments(native as any, [id], { cache: 10000 } as any, {}, cache);
    await findByIdsDocuments(native as any, [id], { cache: 10000 } as any, {}, cache);
    assert.equal(queries.length, beforeRaw + 1, 'raw/all queries retain exact-key caching');
    assert.equal(values.size, 1);
    assert.equal('MODEL_QUERY_FILTER' in cjs, false);
    assert.equal('MODEL_QUERY_FILTER' in esm, false);
});

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
