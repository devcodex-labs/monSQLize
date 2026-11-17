import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { Collection, MongoClient, type Document, type InsertOneOptions } from 'mongodb';
import { createMemoryServerBootstrap } from '../bootstrap/memory-server';
import { createReplSetBootstrap } from '../bootstrap/replset-server';

const MonSQLize = require('../../dist/cjs/index.cjs');

function barrier() {
    let release!: () => void;
    const reached = new Promise<void>(resolve => { release = resolve; });
    return { reached, release };
}

test('P-CORE records the MongoDB transaction admission baseline on independent instances', { timeout: 25_000 }, async t => {
    const scope = 'b01_core_' + randomUUID().replace(/-/g, '');
    const replSet = createReplSetBootstrap({ dbName: scope, useEnvironmentUri: false });
    const standalone = createMemoryServerBootstrap({ dbName: scope, useEnvironmentUri: false });
    const beforeDriver = barrier();
    const releaseDriver = barrier();
    const owned: {
        firstClient?: MongoClient;
        secondClient?: MongoClient;
        runtime?: InstanceType<typeof MonSQLize>;
        replacement?: InstanceType<typeof MonSQLize>;
        pendingWrite?: Promise<unknown>;
        pendingCommit?: Promise<void>;
    } = {};
    t.after(async () => {
        releaseDriver.release();
        await Promise.allSettled([owned.pendingWrite, owned.pendingCommit]);
        try {
            const closed = await Promise.allSettled([
                owned.runtime?.close(), owned.replacement?.close(), owned.firstClient?.close(), owned.secondClient?.close(),
            ]);
            for (const result of closed) if (result.status === 'rejected') throw result.reason;
        } finally {
            MonSQLize.Model._clear();
            const stopped = await Promise.allSettled([replSet.teardown(), standalone.teardown()]);
            for (const result of stopped) if (result.status === 'rejected') throw result.reason;
        }
    });

    const first = await replSet.setup();
    const second = await standalone.setup();
    assert.equal(first.external, false);
    assert.equal(second.external, false);
    assert.notEqual(new URL(first.uri).host, new URL(second.uri).host);
    const firstClient = owned.firstClient = new MongoClient(first.uri);
    const secondClient = owned.secondClient = new MongoClient(second.uri);
    await Promise.all([firstClient.connect(), secondClient.connect()]);
    const local = firstClient.db(scope).collection<{ _id: string; origin: string }>('events');
    const independent = secondClient.db(scope).collection<{ _id: string; origin: string }>('events');
    await local.insertOne({ _id: 'origin', origin: 'local' });
    await independent.insertOne({ _id: 'origin', origin: 'independent' });
    const versions = await Promise.all([firstClient.db('admin').command({ buildInfo: 1 }), secondClient.db('admin').command({ buildInfo: 1 })]);

    function connect(rootUri: string, poolUri: string) {
        return new MonSQLize({
            type: 'mongodb', databaseName: scope, autoConvertObjectId: false,
            config: { uri: rootUri }, pools: [{ name: 'reused', uri: poolUri, role: 'analytics' }],
        });
    }
    MonSQLize.Model.define('events', { schema: {} });
    const runtime = owned.runtime = connect(first.uri, second.uri);
    await runtime.connect();
    assert.equal((await runtime.collection('events').findOne({ _id: 'origin' })).origin, 'local');
    const originalModel = runtime.pool('reused').model('events');
    assert.equal((await originalModel.findOne({ _id: 'origin' })).origin, 'independent');

    const transaction = await runtime.startSession();
    await transaction.start();
    const events = runtime.collection('events');
    await events.insertOne({ _id: 'A', origin: scope }, { session: transaction.session });
    assert.equal(await local.findOne({ _id: 'A' }), null);
    let terminalDispatches = 0;
    const nativeInsert = Collection.prototype.insertOne;
    t.mock.method(Collection.prototype, 'insertOne', async function (this: Collection, document: Document, options?: InsertOneOptions) {
        if (document.origin === scope && document._id === 'B') {
            beforeDriver.release();
            await releaseDriver.reached;
        }
        if (document.origin === scope && document._id === 'C') terminalDispatches += 1;
        return nativeInsert.call(this, document, options);
    });

    const write = events.insertOne({ _id: 'B', origin: scope }, { session: transaction.session });
    owned.pendingWrite = write;
    const writeOutcome = write.then(() => 'returned', () => 'rejected');
    const admitted = await Promise.race([beforeDriver.reached.then(() => true), wait(3_000, false)]);
    assert.equal(admitted, true, 'B reached the real driver boundary before commit');
    const commit = transaction.commit();
    owned.pendingCommit = commit;
    const commitReturnedBeforeRead = await Promise.race([commit.then(() => true), wait(1_250, false)]);
    const early = (await local.find({ origin: scope }).sort({ _id: 1 }).toArray()).map(row => row._id);
    if (commitReturnedBeforeRead) assert.deepEqual(early, ['A']);
    else assert.ok(early.every(id => id === 'A'), 'B must remain paused during the first independent read');
    const commitBeforeWrite = commitReturnedBeforeRead || early.includes('A');
    releaseDriver.release();
    await commit;
    const admittedWriteOutcome = await writeOutcome;
    const terminalWriteOutcome = await events.insertOne({ _id: 'C', origin: scope }, { session: transaction.session })
        .then(() => 'returned', () => 'rejected');
    const finalRows = (await local.find({ origin: scope }).sort({ _id: 1 }).toArray()).map(row => row._id);
    assert.ok(finalRows.includes('A'));
    assert.deepEqual(await independent.find({ origin: scope }).toArray(), []);

    await runtime.close();
    owned.runtime = undefined;
    const replacement = owned.replacement = connect(second.uri, first.uri);
    await replacement.connect();
    const reopenedModel = replacement.pool('reused').model('events');
    const reopenedRows = (await reopenedModel.find({ _id: 'origin' })).map((row: { origin: string }) => row.origin);
    assert.deepEqual(reopenedRows, ['local']);
    assert.notEqual(reopenedModel, originalModel);
    t.diagnostic(JSON.stringify({
        caseId: 'P-CORE/mongodb-baseline', operationScope: scope, versions: versions.map(server => server.version),
        transactionId: transaction.getInfo().id, independentInstances: true, commitBeforeWrite, early,
        admittedWriteOutcome, terminalWriteOutcome, terminalDispatches, finalRows, reopenedRows,
    }));
});
