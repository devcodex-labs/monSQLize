import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createReplSetBootstrap } from '../../bootstrap/replset-server';

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
