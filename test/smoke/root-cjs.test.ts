import test from 'node:test';
import assert from 'node:assert/strict';

const MonSQLize = require('../../dist/cjs/index.cjs');

test('CJS root entry returns default class and static exports', () => {
    assert.equal(typeof MonSQLize, 'function');
    assert.equal(typeof MonSQLize.expr, 'function');
    assert.equal(typeof MonSQLize.createExpression, 'function');
    assert.equal(typeof MonSQLize.withCache, 'function');
    assert.equal(typeof MonSQLize.FunctionCache, 'function');
    assert.equal(typeof MonSQLize.ConnectionPoolManager, 'function');
    assert.equal(typeof MonSQLize.defineModel, 'function');
    assert.equal(typeof MonSQLize.Model, 'function');
    assert.equal(typeof MonSQLize.DataTaskJobError, 'function');
    assert.equal(typeof MonSQLize.dataTasks?.preview, 'function');
});

test('CJS root entry creates a minimal instance and keeps connect / health contracts', async () => {
    const msq = new MonSQLize({
        type: 'mongodb',
        databaseName: 'p1_smoke',
    });

    assert.equal(typeof msq.connect, 'function');
    assert.equal(typeof msq.health, 'function');
    assert.equal(msq.dataTasks, undefined);
    assert.equal((await msq.health()).connected, false);
    await assert.rejects(
        Promise.resolve().then(() => msq.collection('users')),
        (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'NOT_CONNECTED'),
    );
});

test('CJS root entry can initialize the default schema-dsl runtime path', async () => {
    const msq = new MonSQLize({
        type: 'mongodb',
        databaseName: 'cjs_schema_runtime_smoke',
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
