import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryServerBootstrap } from '../../bootstrap/memory-server';

const MonSQLize = require('../../../dist/cjs/index.cjs');

function hasErrorCode(error: unknown, code: string): boolean {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}

describe('P2-B MongoDB expression/queries', () => {
    const bootstrap = createMemoryServerBootstrap();
    let uri = '';

    before(async () => {
        const context = await bootstrap.setup();
        uri = context.uri;
    });

    after(async () => {
        await bootstrap.teardown();
    });

    it('rejects a pre-aborted caller signal through public count paths', async () => {
        const runtime = new MonSQLize({
            type: 'mongodb',
            databaseName: 'p2b_count_abort',
            config: { uri },
            countQueue: { concurrency: 1 },
            cache: { maxEntries: 20 },
        });
        try {
            await runtime.connect();
            const collection = runtime.collection('count_abort');
            await collection.insertOne({ marker: 'cached' });
            const cachedController = new AbortController();
            assert.equal(await collection.count(
                { marker: 'cached' },
                { cache: 60_000, signal: cachedController.signal },
            ), 1);
            cachedController.abort();
            await assert.rejects(
                () => collection.count({ marker: 'cached' }, { cache: 60_000, signal: cachedController.signal }),
                (error: unknown) => hasErrorCode(error, 'INVALID_OPERATION'),
            );
            for (const cache of [0, 60_000]) {
                const controller = new AbortController();
                controller.abort();
                await assert.rejects(
                    () => collection.count({ marker: 'missing' }, { cache, signal: controller.signal }),
                    (error: unknown) => hasErrorCode(error, 'INVALID_OPERATION'),
                );
            }
        } finally {
            await runtime.close();
        }
    });

    it('propagates public count cancellation while retaining the running queue slot', async () => {
        const runtime = new MonSQLize({
            type: 'mongodb',
            databaseName: 'p2b_count_queue_abort',
            config: { uri },
            countQueue: { concurrency: 1 },
        });
        await runtime.connect();
        const collection = runtime.collection('count_queue_abort');
        const raw = collection.raw();
        const originalCountDocuments = raw.countDocuments;
        const queue = runtime._runtimeDefaults.countQueue;
        let releaseWork: (value: number) => void = () => undefined;
        const work = new Promise<number>((resolve) => { releaseWork = resolve; });
        let calls = 0;
        let internalSignal: AbortSignal | undefined;
        raw.countDocuments = async (_query: unknown, options: { signal?: AbortSignal }) => {
            calls++;
            if (calls === 1) {
                internalSignal = options.signal;
                return work;
            }
            return 2;
        };
        try {
            const runningController = new AbortController();
            const running = collection.count({ marker: 'running' }, { signal: runningController.signal });
            const runningRejected = assert.rejects(running, (error: unknown) => hasErrorCode(error, 'INVALID_OPERATION'));
            await new Promise<void>((resolve) => setImmediate(resolve));
            assert.equal(queue.getStats().running, 1);
            runningController.abort();
            await runningRejected;
            assert.equal(internalSignal?.aborted, true);
            assert.equal(queue.getStats().running, 1);

            const queuedController = new AbortController();
            const queued = collection.count({ marker: 'queued' }, { signal: queuedController.signal });
            const queuedRejected = assert.rejects(queued, (error: unknown) => hasErrorCode(error, 'INVALID_OPERATION'));
            await new Promise<void>((resolve) => setImmediate(resolve));
            assert.equal(queue.getStats().queuedNow, 1);
            queuedController.abort();
            await queuedRejected;
            assert.equal(queue.getStats().queuedNow, 0);
            assert.equal(calls, 1);

            const resumed = collection.count({ marker: 'resumed' });
            await new Promise<void>((resolve) => setImmediate(resolve));
            assert.equal(queue.getStats().queuedNow, 1);
            releaseWork(1);
            assert.equal(await resumed, 2);
            assert.equal(queue.getStats().running, 0);
        } finally {
            releaseWork(1);
            raw.countDocuments = originalCountDocuments;
            await runtime.close();
        }
    });

    it('restores minimal query facade: find/findOne/count/distinct/findPage and native write passthrough', async () => {
        const runtime = new MonSQLize({ type: 'mongodb', databaseName: 'p2b_queries', config: { uri } });

        await runtime.connect();
        const users = runtime.collection('users');

        const insertAda = await users.insertOne({ firstName: 'Ada', lastName: 'Lovelace', category: 'engineer', score: 99 });
        await users.insertOne({ firstName: 'Grace', lastName: 'Hopper', category: 'engineer', score: 98 });
        await users.insertOne({ firstName: 'Alan', lastName: 'Turing', category: 'research', score: 97 });
        const updateAda = await users.updateOne({ firstName: 'Ada' }, { $set: { score: 100 } });

        const found = await users.find({ category: 'engineer' }, { sort: { score: -1 } });
        const one = await users.findOne({ firstName: 'Ada' });
        const count = await users.count({ category: 'engineer' });
        const categories = await users.distinct('category');
        const page = await users.findPage({ query: {}, limit: 2, sort: { score: -1 } });
        const watcher = users.watch([]);
        const deleteAlan = await users.deleteOne({ firstName: 'Alan' });

        assert.equal(found.length, 2);
        assert.equal(insertAda.acknowledged, true);
        assert.equal(typeof insertAda.insertedId?.toHexString, 'function');
        assert.equal(updateAda.acknowledged, true);
        assert.equal(updateAda.matchedCount, 1);
        assert.equal(typeof updateAda.upsertedCount, 'number');
        assert.equal(found[0].firstName, 'Ada');
        assert.equal(one.lastName, 'Lovelace');
        assert.equal(one.score, 100);
        assert.equal(count, 2);
        assert.deepEqual(categories.sort(), ['engineer', 'research']);
        assert.equal(page.items.length, 2);
        assert.equal(page.pageInfo.hasNext, true);
        assert.equal(typeof page.pageInfo.endCursor, 'string');
        assert.equal(deleteAlan.acknowledged, true);
        assert.equal(deleteAlan.deletedCount, 1);
        assert.equal(typeof users.raw, 'function');
        assert.equal(typeof watcher.close, 'function');

        await watcher.close();
        await runtime.close();
    });

    it('aggregate() supports the minimal expression compilation subset', async () => {
        const runtime = new MonSQLize({ type: 'mongodb', databaseName: 'p2b_aggregate', config: { uri } });

        await runtime.connect();
        const orders = runtime.collection('orders');

        await orders.insertOne({ firstName: 'Ada', lastName: 'Lovelace', amount: 10, createdAt: new Date('2026-05-01T00:00:00Z') });
        await orders.insertOne({ firstName: 'Grace', lastName: 'Hopper', amount: 20, createdAt: new Date('2026-05-02T00:00:00Z') });

        const rows = await orders.aggregate([
            {
                $project: {
                    _id: 0,
                    fullName: MonSQLize.expr("CONCAT(firstName, ' ', lastName)"),
                    orderYear: MonSQLize.expr('YEAR(createdAt)'),
                    amount: 1,
                },
            },
            { $sort: { amount: 1 } },
        ]);

        assert.deepEqual(rows, [
            { fullName: 'Ada Lovelace', orderYear: 2026, amount: 10 },
            { fullName: 'Grace Hopper', orderYear: 2026, amount: 20 },
        ]);

        await runtime.close();
    });

    it('restores v1 query contract: chained find/aggregate, cursor findPage, and collection helpers', async () => {
        const runtime = new MonSQLize({ type: 'mongodb', databaseName: 'compat_query_contract', config: { uri } });

        await runtime.connect();
        const users = runtime.collection('users');

        const ada = await users.insertOne({ firstName: 'Ada', category: 'engineer', score: 100 });
        const grace = await users.insertOne({ firstName: 'Grace', category: 'engineer', score: 90 });
        const alan = await users.insertOne({ firstName: 'Alan', category: 'research', score: 80 });

        assert.equal(typeof users.findOneById, 'function');
        assert.equal(typeof users.findByIds, 'function');
        assert.equal(typeof users.findAndCount, 'function');
        assert.equal(typeof users.stream, 'function');
        assert.equal(typeof users.explain, 'function');

        const findChain = users.find({ category: 'engineer' });
        assert.equal(typeof findChain.limit, 'function');
        assert.equal(typeof findChain.sort, 'function');
        assert.equal(typeof findChain.project, 'function');
        assert.equal(typeof findChain.explain, 'function');
        assert.equal(typeof findChain.stream, 'function');

        const topEngineer = await findChain.sort({ score: -1 }).limit(1).project({ _id: 0, firstName: 1, score: 1 });
        assert.deepEqual(topEngineer, [{ firstName: 'Ada', score: 100 }]);

        const queryPlan = await users.find({ category: 'engineer' }).limit(1).explain('queryPlanner');
        assert.equal(typeof queryPlan, 'object');
        assert.equal(queryPlan !== null, true);

        const streamRows: string[] = [];
        await new Promise<void>((resolve, reject) => {
            users.find({ category: 'engineer' })
                .sort({ score: -1 })
                .stream()
                .on('data', (doc: any) => streamRows.push(doc.firstName))
                .on('end', resolve)
                .on('error', reject);
        });
        assert.deepEqual(streamRows, ['Ada', 'Grace']);

        const aggregateChain = users.aggregate([
            { $match: { category: 'engineer' } },
            { $project: { _id: 0, firstName: 1, score: 1 } },
        ]);
        assert.equal(typeof aggregateChain.allowDiskUse, 'function');
        assert.equal(typeof aggregateChain.batchSize, 'function');
        assert.equal(typeof aggregateChain.explain, 'function');
        assert.equal(typeof aggregateChain.stream, 'function');

        const aggregateRows = await aggregateChain.allowDiskUse(true).comment('compat-query-contract');
        assert.deepEqual(aggregateRows, [
            { firstName: 'Ada', score: 100 },
            { firstName: 'Grace', score: 90 },
        ]);

        const foundAda = await users.findOneById(ada.insertedId);
        const foundByIds = await users.findByIds([grace.insertedId, alan.insertedId]);
        const counted = await users.findAndCount({ category: 'engineer' }, { sort: { score: -1 }, limit: 1 });

        assert.equal(foundAda.firstName, 'Ada');
        assert.deepEqual(foundByIds.map((doc: any) => doc.firstName).sort(), ['Alan', 'Grace']);
        assert.ok(Object.keys(counted).includes('data') && Object.keys(counted).includes('total'));
        assert.equal(counted.total, 2);
        assert.equal(counted.data.length, 1);
        assert.equal(counted.data[0].firstName, 'Ada');

        const firstPage = await users.findPage({ query: { category: 'engineer' }, sort: { score: -1 }, limit: 1, page: 1 });
        assert.deepEqual(Object.keys(firstPage).sort(), ['items', 'pageInfo']);
        assert.equal(firstPage.items.length, 1);
        assert.equal(firstPage.items[0].firstName, 'Ada');
        assert.equal(typeof firstPage.pageInfo.endCursor, 'string');
        assert.equal(firstPage.pageInfo.hasNext, true);

        const secondPage = await users.findPage({
            query: { category: 'engineer' },
            sort: { score: -1 },
            limit: 1,
            after: firstPage.pageInfo.endCursor,
        });
        assert.equal(secondPage.items.length, 1);
        assert.equal(secondPage.items[0].firstName, 'Grace');
        assert.equal(secondPage.pageInfo.hasPrev, true);

        await runtime.close();
    });

    it('blocks invalid pagination parameters and unsupported expressions', async () => {
        const runtime = new MonSQLize({ type: 'mongodb', databaseName: 'p2b_negative', config: { uri } });

        await runtime.connect();
        const logs = runtime.collection('logs');

        await assert.rejects(
            () => logs.findPage({ page: 0, limit: 10 }),
            (error: unknown) => hasErrorCode(error, 'INVALID_PAGINATION'),
        );

        assert.throws(
            () => logs.aggregate([{ $project: { unsupported: MonSQLize.expr('UNSUPPORTED(metric)') } }]),
            (error: unknown) => hasErrorCode(error, 'INVALID_EXPRESSION'),
        );

        await runtime.close();
    });

    it('restores first writes-core convenience methods: insertMany/updateMany/deleteMany', async () => {
        const runtime = new MonSQLize({ type: 'mongodb', databaseName: 'p2c_write_convenience', config: { uri } });

        await runtime.connect();
        const tasks = runtime.collection('tasks');

        const inserted = await tasks.insertMany([
            { title: 'A', status: 'draft', archived: false },
            { title: 'B', status: 'draft', archived: false },
            { title: 'C', status: 'published', archived: false },
        ]);
        const updated = await tasks.updateMany({ status: 'draft' }, { $set: { archived: true } });
        const archivedTasks = await tasks.find({ archived: true }, { sort: { title: 1 } });
        const deleted = await tasks.deleteMany({ archived: true });
        const remaining = await tasks.count({});

        assert.equal(inserted.acknowledged, true);
        assert.equal(inserted.insertedCount, 3);
        assert.deepEqual(Object.keys(inserted.insertedIds), ['0', '1', '2']);
        assert.equal(updated.acknowledged, true);
        assert.equal(updated.matchedCount, 2);
        assert.equal(updated.modifiedCount, 2);
        assert.equal(updated.upsertedCount, 0);
        assert.deepEqual(archivedTasks.map((item: any) => item.title), ['A', 'B']);
        assert.equal(deleted.acknowledged, true);
        assert.equal(deleted.deletedCount, 2);
        assert.equal(remaining, 1);

        await runtime.close();
    });

    it('restores remaining writes-core convenience methods: replaceOne/findOneAnd*/upsertOne', async () => {
        const runtime = new MonSQLize({ type: 'mongodb', databaseName: 'p2c_write_convenience_remaining', config: { uri } });

        await runtime.connect();
        const profiles = runtime.collection('profiles');

        await profiles.insertOne({ name: 'Ada', role: 'engineer', visits: 1, status: 'active' });

        const replaced = await profiles.replaceOne({ name: 'Ada' }, { name: 'Ada', role: 'architect', visits: 2, status: 'active' });
        const replacedDoc = await profiles.findOne({ name: 'Ada' });
        const updatedDoc = await profiles.findOneAndUpdate({ name: 'Ada' }, { $set: { status: 'inactive' } }, { returnDocument: 'after' });
        const deletedDoc = await profiles.findOneAndDelete({ name: 'Ada' });
        const afterDeleteCount = await profiles.count({});
        const upserted = await profiles.upsertOne({ name: 'Grace' }, { $set: { role: 'scientist', visits: 1, status: 'active' } }, { upsert: false });
        const upsertedDoc = await profiles.findOne({ name: 'Grace' });

        assert.equal(replaced.acknowledged, true);
        assert.equal(replaced.matchedCount, 1);
        assert.equal(replaced.modifiedCount, 1);
        assert.equal(replacedDoc.role, 'architect');
        assert.equal(replacedDoc.visits, 2);
        assert.equal(updatedDoc.status, 'inactive');
        assert.equal(deletedDoc.name, 'Ada');
        assert.equal(afterDeleteCount, 0);
        assert.equal(upserted.acknowledged, true);
        assert.equal(upserted.upsertedCount, 1);
        assert.equal(typeof upserted.upsertedId?.toHexString, 'function');
        assert.equal(upsertedDoc.role, 'scientist');

        await runtime.close();
    });
});
