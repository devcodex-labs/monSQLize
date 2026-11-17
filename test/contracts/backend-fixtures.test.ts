import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import type { MonSQLizeOptions } from '../../types/monsqlize';
import { createReplSetBootstrap } from '../bootstrap/replset-server';
import { registerBackendFixtures } from '../utils/backend-fixture';
import { createOrderFixture } from '../utils/fixtures';

const MonSQLize = require('../../dist/cjs/index.cjs');
const scope = 'monsqlize_b01_' + randomUUID().replace(/-/g, '');

/** Public flow stays the same when the fixture supplies a different backend configuration. */
async function insertAndRead(options: MonSQLizeOptions) {
    const runtime = new MonSQLize(options);
    try {
        await runtime.connect();
        const orders = runtime.collection('orders');
        const order = createOrderFixture({ currency: 'CNY', amount: 89 });
        const insertResult = await orders.insertOne(order);
        const found = await orders.findOne({ _id: order._id });
        return { insertedId: insertResult.insertedId, found, order };
    } finally {
        await runtime.close();
    }
}

test('contract fixture registration rejects duplicates and missing selected engines', async () => {
    const create = async () => ({});
    assert.throws(() => registerBackendFixtures([['mongodb', create], ['mongodb', create]]),
        /Duplicate contract fixture for mongodb/);
    const registry = registerBackendFixtures([['mongodb', create]]);
    assert.deepEqual(registry.configured(), ['mongodb']);
    await assert.rejects(registry.open('sqlite'), /No contract fixture registered for sqlite/);
});

test('LIF-01/mongodb-control binds public options to the same actual physical data', async t => {
    const bootstrap = createReplSetBootstrap({ dbName: scope, useEnvironmentUri: false });
    let oracle: MongoClient | undefined;
    t.after(async () => {
        try {
            await oracle?.close();
        } finally {
            await bootstrap.teardown();
        }
    });
    const registry = registerBackendFixtures([['mongodb', async () => {
        const { uri, external } = await bootstrap.setup();
        assert.equal(external, false);
        const options: MonSQLizeOptions = { type: 'mongodb', databaseName: scope, config: { uri } };
        oracle = new MongoClient(uri);
        return { options, oracle };
    }]]);

    const fixture = await registry.open('mongodb');
    await fixture.oracle.connect();
    const { insertedId, found, order } = await insertAndRead(fixture.options);
    assert.equal(insertedId, order._id);
    assert.deepEqual(found, order);
    const actual = await fixture.oracle.db(scope).collection<{ _id: string }>('orders').findOne({ _id: order._id });
    assert.deepEqual(actual, order);
});

