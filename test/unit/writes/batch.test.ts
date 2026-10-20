import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { insertBatchDocuments } from '../../../src/adapters/mongodb/writes/write-batch';
import { insertBatchForAccessor, updateBatchForAccessor, deleteBatchForAccessor } from '../../../src/adapters/mongodb/common/collection-accessor-batch-helpers';
import { invalidateReadCachesAfterWrite } from '../../../src/adapters/mongodb/common/collection-accessor-cache-helpers';

const MonSQLize = require('../../../dist/cjs/index.cjs');

type Calls = {
    insertMany: unknown[][];
    find: Array<{ filter: unknown; options: Record<string, unknown> }>;
    countDocuments: Array<{ filter: unknown; options: Record<string, unknown> }>;
    updateMany: unknown[];
    deleteMany: unknown[];
    findOneAndUpdate: Array<{ filter: unknown; update: unknown; options: unknown }>;
};

type FilterWithIds = {
    _id: {
        $in: unknown[];
    };
};

function idCursor(ids: Array<{ _id: unknown }>) {
    return {
        async *[Symbol.asyncIterator]() {
            for (const item of ids) {
                yield item;
            }
        },
        close: async () => true,
    };
}

describe('P2-C writes-batch extension', () => {
    it('B11 does not treat preallocated IDs in an unknown driver failure as successful inserts', async () => {
        const collection: any = { insertMany: async () => {
            throw Object.assign(new Error('network disconnected'), { insertedCount: 0, insertedIds: { 0: 'candidate-a', 1: 'candidate-b' } });
        } };
        const result = await insertBatchDocuments(collection, [{ _id: 'candidate-a' }, { _id: 'candidate-b' }], { onError: 'collect' });
        assert.equal(result.insertedCount, 0);
        assert.deepEqual(result.insertedIds, {});
    });

    it('B10 coordinates cache invalidation after thrown and collected partial batch failures', async () => {
        for (const onError of ['stop', 'collect']) {
            for (const operation of ['insert', 'update', 'delete']) {
                let invalidations = 0;
                const failure = new Error('partial write failure');
                const context: any = {
                    cvFilter: (value: unknown) => value, cvDoc: (value: unknown) => value, cvUpdate: (value: unknown) => value,
                    invalidateAll: async () => { invalidations++; return 1; },
                    collectionRef: {
                        find: () => idCursor([{ _id: 1 }]),
                        countDocuments: async () => 1,
                        insertMany: async () => { throw failure; },
                        updateMany: async () => { throw failure; },
                        deleteMany: async () => { throw failure; },
                    },
                };
                const options = { onError, batchSize: 1, autoInvalidate: true } as any;
                const call = operation === 'insert'
                    ? insertBatchForAccessor(context, [{ _id: 1 }], options)
                    : operation === 'update'
                        ? updateBatchForAccessor(context, {}, { $set: { a: 1 } }, options)
                        : deleteBatchForAccessor(context, {}, options);
                if (onError === 'stop') await assert.rejects(call, /partial write failure/);
                else assert.equal((await call).errors.length, 1);
                assert.equal(invalidations, 1);
            }
        }
    });

    it('B10 never broadcasts or records new intents for an ended managed transaction', async () => {
        let broadcasts = 0;
        let intents = 0;
        const session = { inTransaction: () => false, __monSQLizeTransaction: { recordInvalidation: () => { intents++; } } };
        const cache: any = { delPattern: async () => { broadcasts++; return 1; } };
        const collection: any = {};
        await invalidateReadCachesAfterWrite(cache, collection, 'db', 'items', {}, { session, autoInvalidate: true });
        assert.equal(broadcasts, 0);
        assert.equal(intents, 0);
        session.inTransaction = () => true;
        await invalidateReadCachesAfterWrite(cache, collection, 'db', 'items', {}, { session, autoInvalidate: true });
        assert.ok(intents > 0);
        assert.equal(broadcasts, 0);
    });

    it('exposes insertBatch/updateBatch/deleteBatch/incrementOne through public accessors', async () => {
        const calls: Calls = {
            insertMany: [],
            find: [],
            countDocuments: [],
            updateMany: [],
            deleteMany: [],
            findOneAndUpdate: [],
        };

        const fakeCollection = {
            insertMany: (documents: unknown[]) => {
                calls.insertMany.push(documents);
                return {
                    acknowledged: true,
                    insertedCount: documents.length,
                    insertedIds: Object.fromEntries(documents.map((_, index) => [index, { index }])),
                };
            },
            find: (filter: unknown, options: Record<string, unknown>) => {
                calls.find.push({ filter, options });
                return idCursor([{ _id: 1 }, { _id: 2 }, { _id: 3 }]);
            },
            countDocuments: (filter: unknown, options: Record<string, unknown>) => {
                calls.countDocuments.push({ filter, options });
                return 3;
            },
            updateMany: (filter: FilterWithIds, _update: unknown, options: unknown) => {
                calls.updateMany.push({ filter, options });
                return {
                    acknowledged: true,
                    matchedCount: filter._id.$in.length,
                    modifiedCount: filter._id.$in.length,
                    upsertedCount: 9,
                    upsertedId: null,
                };
            },
            deleteMany: (filter: FilterWithIds, options: unknown) => {
                calls.deleteMany.push({ filter, options });
                return {
                    acknowledged: true,
                    deletedCount: filter._id.$in.length,
                };
            },
            findOneAndUpdate: (filter: unknown, update: unknown, options: unknown) => {
                calls.findOneAndUpdate.push({ filter, update, options });
                return { _id: 1, count: 5 };
            },
            collectionName: 'users',
        };

        const runtime = new MonSQLize({ type: 'mongodb', databaseName: 'unit_batch' });
        runtime._connected = true;
        runtime._client = {
            db() {
                return {
                    collection() {
                        return fakeCollection;
                    },
                };
            },
        };

        const session = { id: 's1' };
        const users = runtime.collection('users');
        const inserted = await users.insertBatch([{ name: 'Ada' }, { name: 'Grace' }, { name: 'Linus' }], { batchSize: 2 });
        const updated = await users.updateBatch({ active: true }, { $set: { active: false } }, {
            batchSize: 2,
            session,
            collation: { locale: 'en', strength: 2 },
            hint: { active: 1 },
            maxTimeMS: 100,
            comment: 'batch-update',
            arrayFilters: [{ 'item.active': true }],
            writeConcern: { w: 'majority' },
        });
        const deleted = await users.deleteBatch({ stale: true }, {
            batchSize: 2,
            session,
            collation: { locale: 'en', strength: 2 },
            hint: { stale: 1 },
            maxTimeMS: 120,
            comment: 'batch-delete',
            writeConcern: { w: 'majority' },
        });
        const incremented = await users.incrementOne({ _id: 1 }, 'count', 2, {
            $set: { touched: true },
            projection: { count: 1 },
            returnDocument: 'before',
            session,
            collation: { locale: 'en', strength: 2 },
            hint: { _id: 1 },
            comment: 'increment-driver-options',
            maxTimeMS: 250,
            writeConcern: { w: 'majority' },
        });

        assert.equal(inserted.insertedCount, 3);
        assert.equal(inserted.batchCount, 2);
        assert.equal(calls.insertMany.length, 2);
        assert.equal(updated.matchedCount, 3);
        assert.equal(updated.modifiedCount, 3);
        assert.equal(updated.upsertedCount, 0);
        assert.equal(updated.batchCount, 2);
        assert.equal(calls.updateMany.length, 2);
        assert.equal(deleted.deletedCount, 3);
        assert.equal(deleted.batchCount, 2);
        assert.equal(calls.deleteMany.length, 2);
        assert.deepEqual(calls.find[0].options, {
            session,
            collation: { locale: 'en', strength: 2 },
            hint: { active: 1 },
            maxTimeMS: 100,
            comment: 'batch-update',
            projection: { _id: 1 },
            sort: { _id: 1 },
        });
        assert.deepEqual(calls.countDocuments[0].options, {
            session,
            collation: { locale: 'en', strength: 2 },
            hint: { active: 1 },
            maxTimeMS: 100,
            comment: 'batch-update',
        });
        assert.deepEqual((calls.updateMany[0] as { options: unknown }).options, {
            session,
            collation: { locale: 'en', strength: 2 },
            hint: { active: 1 },
            maxTimeMS: 100,
            comment: 'batch-update',
            arrayFilters: [{ 'item.active': true }],
            writeConcern: { w: 'majority' },
        });
        assert.deepEqual(calls.find[1].options, {
            session,
            collation: { locale: 'en', strength: 2 },
            hint: { stale: 1 },
            maxTimeMS: 120,
            comment: 'batch-delete',
            projection: { _id: 1 },
            sort: { _id: 1 },
        });
        assert.equal(incremented.modifiedCount, 1);
        assert.deepEqual(incremented.value, { _id: 1, count: 5 });
        assert.deepEqual(calls.findOneAndUpdate[0].update, {
            $inc: { count: 2 },
            $set: { touched: true },
        });
        assert.deepEqual(calls.findOneAndUpdate[0].options, {
            session,
            collation: { locale: 'en', strength: 2 },
            hint: { _id: 1 },
            comment: 'increment-driver-options',
            maxTimeMS: 250,
            writeConcern: { w: 'majority' },
            returnDocument: 'before',
            includeResultMetadata: true,
            projection: { count: 1 },
        });
    });
});
