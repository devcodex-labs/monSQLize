import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

test('ESM root entry returns default export and named export matrix', async () => {
    const entryUrl = pathToFileURL(path.resolve(__dirname, '../../dist/esm/index.mjs')).href;
    const mod = await import(entryUrl);

    assert.equal(typeof mod.default, 'function');
    assert.equal(mod.default, mod.MonSQLize);
    assert.equal(typeof mod.Logger, 'function');
    assert.equal(typeof mod.MemoryCache, 'function');
    assert.equal(typeof mod.createRedisCacheAdapter, 'function');
    assert.equal(typeof mod.TransactionManager, 'function');
    assert.equal(typeof mod.CacheLockManager, 'function');
    assert.equal(typeof mod.DistributedCacheInvalidator, 'function');
    assert.equal(typeof mod.ConnectionPoolManager, 'function');
    assert.equal(typeof mod.defineModel, 'function');
    assert.equal(typeof mod.default.defineModel, 'function');
    assert.equal(typeof mod.Model, 'function');
    assert.equal(typeof mod.DataTaskJobError, 'function');
    assert.equal(mod.default.DataTaskJobError, mod.DataTaskJobError);
    assert.equal(typeof mod.dataTasks?.preview, 'function');
    assert.equal(mod.default.dataTasks, undefined);
    assert.equal(typeof mod.expr, 'function');
    assert.equal(typeof mod.createExpression, 'function');
    assert.equal(typeof mod.withCache, 'function');
    assert.equal(typeof mod.FunctionCache, 'function');
    assert.equal(new mod.default({ type: 'mongodb', databaseName: 'esm_data_task_smoke' }).dataTasks, undefined);
});

test('ESM root entry can initialize the default schema-dsl runtime path', async () => {
    const entryUrl = pathToFileURL(path.resolve(__dirname, '../../dist/esm/index.mjs')).href;
    const mod = await import(entryUrl);
    const msq = new mod.default({
        type: 'mongodb',
        databaseName: 'esm_schema_runtime_smoke',
    });

    try {
        await assert.rejects(
            () => msq.connect(),
            (error: unknown) => Boolean(
                error
                && typeof error === 'object'
                && 'code' in error
                && error.code === 'INVALID_CONFIG'
                && 'message' in error
                && String(error.message).includes('MongoDB connect requires config.uri'),
            ),
        );
    } finally {
        await msq.close?.().catch(() => { });
    }
});
