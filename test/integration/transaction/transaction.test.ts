import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createReplSetBootstrap } from '../../bootstrap/replset-server';
import { buildFindPageCacheKey } from '../../../src/adapters/mongodb/queries/query-cache-keys';

const MonSQLize = require('../../../dist/cjs/index.cjs');

describe('P4-A transaction integration', () => {
    const bootstrap = createReplSetBootstrap();
    let uri = '';

    before(async () => {
        const context = await bootstrap.setup();
        uri = context.uri;
    });

    after(async () => {
        await bootstrap.teardown();
    });

    beforeEach(async () => {
        const runtime = new MonSQLize({ type: 'mongodb', databaseName: 'p4a_tx', config: { uri } });
        await runtime.connect();
        await runtime.collection('accounts').deleteMany({});
        await runtime.close();
    });

    it('supports withTransaction commit and rollback', async () => {
        const runtime = new MonSQLize({
            type: 'mongodb',
            databaseName: 'p4a_tx',
            config: { uri },
            cache: new MonSQLize.MemoryCache(),
        });
        await runtime.connect();

        await runtime.collection('accounts').insertMany([
            { _id: 'A', balance: 1000 },
            { _id: 'B', balance: 500 },
        ]);

        const committed = await runtime.withTransaction(async (tx: any) => {
            await runtime.collection('accounts').updateOne({ _id: 'A' }, { $inc: { balance: -100 } }, { session: tx.session });
            await runtime.collection('accounts').updateOne({ _id: 'B' }, { $inc: { balance: 100 } }, { session: tx.session });
            return tx.getInfo().status;
        });

        assert.equal(committed, 'started');
        assert.equal((await runtime.collection('accounts').findOne({ _id: 'A' })).balance, 900);
        assert.equal((await runtime.collection('accounts').findOne({ _id: 'B' })).balance, 600);

        await assert.rejects(
            () => runtime.withTransaction(async (tx: any) => {
                await runtime.collection('accounts').updateOne({ _id: 'A' }, { $inc: { balance: -200 } }, { session: tx.session });
                throw new Error('rollback');
            }),
            /rollback/,
        );

        assert.equal((await runtime.collection('accounts').findOne({ _id: 'A' })).balance, 900);
        await runtime.close();
    });

    it('freezes DSL aggregate descriptor keys before transaction commit and discards them on abort', async () => {
        const runtime = new MonSQLize({ type: 'mongodb', databaseName: 'repair_tx_descriptor', config: { uri }, autoConvertObjectId: false });
        await runtime.connect();
        try {
            const col = runtime.collection('balances'), native = runtime._adapter.db.collection('balances');
            for (const commit of [true, false]) {
                await native.deleteMany({}); await runtime.getCache().clear(); await native.insertOne({ _id: 'A', balance: 1 });
                const read = [{ $project: { _id: 0, balance: MonSQLize.expr('balance+1') } }];
                assert.equal((await col.aggregate(read, { cache: 10000 }))[0].balance, 2);
                await native.updateOne({ _id: 'A' }, { $set: { balance: 9 } });
                let captures = 0, expression = 'balance+1';
                const descriptor = [{ toBSON() { captures++; return { $project: { _id: 0, balance: MonSQLize.expr(expression) } }; } }];
                const operation = runtime.withTransaction(async (tx: any) => {
                    await col.updateOne({ _id: 'A' }, { $inc: { balance: 1 } }, { session: tx.session,
                        cache: { invalidate: [{ operation: 'aggregate', pipeline: descriptor }] } });
                    assert.equal(captures, 1); expression = 'balance+50';
                    assert.equal((await col.aggregate(read, { cache: 10000 }))[0].balance, 2);
                    if (!commit) throw new Error('descriptor abort');
                });
                if (commit) await operation; else await assert.rejects(operation, /descriptor abort/);
                assert.equal(captures, 1);
                assert.equal((await native.findOne({ _id: 'A' })).balance, commit ? 10 : 9);
                assert.equal((await col.aggregate(read, { cache: 10000 }))[0].balance, commit ? 11 : 2);
            }
        } finally { await runtime.close(); }
    });

    it('resolves soft-delete Model aggregate invalidation before commit and discards it on abort', async () => {
        MonSQLize.Model.define('visibility_balances', { schema: {}, options: { softDelete: true, autoIndex: false } });
        const runtime = new MonSQLize({ type: 'mongodb', databaseName: 'repair_tx_model_descriptor', config: { uri }, autoConvertObjectId: false });
        try {
            await runtime.connect();
            const col = runtime.collection('visibility_balances'), model = runtime.model('visibility_balances'), raw = col.raw();
            const read = [{ $project: { _id: 0, balance: MonSQLize.expr('balance+1') } }];
            for (const commit of [true, false]) {
                await raw.deleteMany({}); await runtime.getCache().clear(); await raw.insertOne({ _id: 'A', balance: 1, deletedAt: null });
                assert.equal((await model.aggregate(read, { cache: 10000 }))[0].balance, 2);
                const operation = runtime.withTransaction(async (tx: any) => {
                    await model.updateOne({ _id: 'A' }, { $set: { balance: 9 } }, { session: tx.session,
                        cache: { invalidate: [{ operation: 'aggregate', pipeline: read }] } });
                    assert.equal((await model.aggregate(read, { cache: 10000 }))[0].balance, 2);
                    if (!commit) throw new Error('model descriptor abort');
                });
                if (commit) await operation; else await assert.rejects(operation, /model descriptor abort/);
                assert.equal((await model.aggregate(read, { cache: 10000 }))[0].balance, commit ? 10 : 2);
            }
        } finally { await runtime.close(); MonSQLize.Model._clear(); }
    });

    it('freezes Model page invalidation at registration and discards it on rollback', async () => {
        MonSQLize.Model.define('visibility_pages', { schema: {}, options: { softDelete: true, autoIndex: false } });
        const runtime = new MonSQLize({ type: 'mongodb', databaseName: 'repair_tx_page', config: { uri }, autoConvertObjectId: false });
        try {
            await runtime.connect();
            const col = runtime.collection('visibility_pages'), model = runtime.model('visibility_pages'), raw = col.raw();
            const read = { query: { _id: 'A' }, sort: { balance: 1 as const }, limit: 1 };
            const key = buildFindPageCacheKey(raw, col.management.defaults, { ...read, query: { _id: 'A', deletedAt: null } }).key;
            for (const commit of [true, false]) {
                await raw.deleteMany({}); await runtime.getCache().clear(); await raw.insertOne({ _id: 'A', balance: 1, deletedAt: null });
                assert.equal((await model.findPage({ ...read, cache: 10000 })).items[0].balance, 1);
                const descriptor = { ...read, query: { _id: 'A' } };
                const operation = runtime.withTransaction(async (tx: any) => {
                    await model.updateOne({ _id: 'A' }, { $set: { balance: 9 } }, { session: tx.session,
                        cache: { invalidate: [{ operation: 'findPage', options: descriptor }] } });
                    descriptor.query._id = 'B';
                    assert.ok(await runtime.getCache().get(key));
                    if (!commit) throw new Error('page descriptor abort');
                });
                if (commit) await operation; else await assert.rejects(operation, /page descriptor abort/);
                assert.equal((await runtime.getCache().get(key)) === undefined, commit);
                assert.equal((await model.findPage({ ...read, cache: 10000 })).items[0].balance, commit ? 9 : 1);
            }
        } finally { await runtime.close(); MonSQLize.Model._clear(); }
    });

    it('B10 defers partial-batch invalidation until commit and discards it on abort', async () => {
        const runtime = new MonSQLize({ type: 'mongodb', databaseName: 'b10_tx', config: { uri }, cache: new MonSQLize.MemoryCache() });
        await runtime.connect();
        try {
            const col = runtime.collection('partial');
            const native = runtime._adapter.db.collection('partial');
            for (const commit of [true, false]) {
                const tag = commit ? 'commit' : 'abort';
                await native.insertMany([{ tag, value: 0 }, { tag, value: 0 }]);
                assert.equal((await col.find({ tag }, { cache: 10000 })).length, 2);
                // A raw write makes invalidation observable without touching the managed cache.
                await native.insertOne({ tag, value: 0 });
                const operation = runtime.withTransaction(async (tx: any) => {
                    await assert.rejects(col.updateBatch({ tag }, { $set: { value: 1 } }, {
                        session: tx.session, autoInvalidate: true, batchSize: 1,
                        onProgress: () => { throw new Error('B10 partial batch'); },
                    }), /B10 partial batch/);
                    assert.equal(tx.session.inTransaction(), true);
                    assert.equal((await col.find({ tag }, { cache: 10000 })).length, 2);
                    if (!commit) throw new Error('B10 abort');
                });
                if (commit) await operation;
                else await assert.rejects(operation, /B10 abort/);
                assert.equal(await native.countDocuments({ tag, value: 1 }), commit ? 1 : 0);
                assert.equal((await col.find({ tag }, { cache: 10000 })).length, commit ? 3 : 2);
            }
        } finally { await runtime.close(); }
    });

    it('rejects wrapped writes after a managed abort while allowing a native session', async () => {
        const runtime = new MonSQLize({ type: 'mongodb', databaseName: 'p4a_tx_guard', config: { uri } });
        await runtime.connect();
        try {
            const transaction = await runtime.startSession();
            await transaction.start();
            await transaction.abort();
            await assert.rejects(
                () => runtime.collection('guarded').insertOne({ name: 'late' }, { session: transaction.session }),
                /no longer accepting writes/,
            );
            await transaction.end();
            assert.equal(await runtime.collection('guarded').count({}), 0);

            await runtime.collection('source').insertOne({ name: 'source' });
            const lazyTransaction = await runtime.startSession();
            await lazyTransaction.start();
            const writePipeline = runtime.collection('source').aggregate(
                [{ $out: 'late_output' }], { session: lazyTransaction.session },
            );
            await lazyTransaction.abort();
            await assert.rejects(() => writePipeline.toArray(), /no longer accepting writes/);
            await lazyTransaction.end();
            assert.equal(await runtime.collection('late_output').count({}), 0);

            const nativeSession = runtime._client.startSession();
            try {
                nativeSession.startTransaction();
                await runtime.collection('guarded').insertOne({ name: 'native' }, { session: nativeSession });
                await nativeSession.commitTransaction();
            } finally {
                await nativeSession.endSession();
            }
            assert.equal(await runtime.collection('guarded').count({}), 1);
        } finally {
            await runtime.close();
        }
    });
});
