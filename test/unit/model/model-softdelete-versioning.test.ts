import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryServerBootstrap } from '../../bootstrap/memory-server';

const MonSQLize = require('../../../dist/cjs/index.cjs');

describe('Model softDelete / versioning behavior', () => {
    const bootstrap = createMemoryServerBootstrap();
    let runtime: any;

    before(async () => {
        const ctx = await bootstrap.setup();
        const uri = ctx.uri;

        MonSQLize.Model.define('sd_docs', {
            schema: (dsl: any) => dsl({}),
            options: { softDelete: true },
        });
        MonSQLize.Model.define('sd_bool', {
            schema: (dsl: any) => dsl({}),
            options: {
                softDelete: { field: 'removedAt', type: 'boolean', ttl: 7200 },
            },
        });
        MonSQLize.Model.define('ver_items', {
            schema: (dsl: any) => dsl({}),
            options: { version: true },
        });
        MonSQLize.Model.define('pipeline_ts_items', {
            schema: (dsl: any) => dsl({}),
            options: { timestamps: true },
        });

        runtime = new MonSQLize({
            type: 'mongodb',
            databaseName: 'test_model_softdelete_v',
            config: { uri },
        });
        await runtime.connect();
    });

    after(async () => {
        if (runtime) await runtime.close();
        await bootstrap.teardown();
    });

    beforeEach(async () => {
        const db = runtime._adapter.db;
        await Promise.all([
            db.collection('sd_docs').deleteMany({}),
            db.collection('sd_bool').deleteMany({}),
            db.collection('ver_items').deleteMany({}),
            db.collection('pipeline_ts_items').deleteMany({}),
        ]);
    });

    // ── config resolution ─────────────────────────────────────────────────────

    describe('softDelete config resolution', () => {
        it('softDelete: true → default config (field=deletedAt, type=timestamp, ttl=null)', () => {
            const model = runtime.model('sd_docs');
            assert.deepEqual(model.softDeleteConfig, {
                enabled: true,
                field: 'deletedAt',
                type: 'timestamp',
                ttl: null,
            });
        });

        it('softDelete: { field, type, ttl } → custom config', () => {
            const model = runtime.model('sd_bool');
            assert.deepEqual(model.softDeleteConfig, {
                enabled: true,
                field: 'removedAt',
                type: 'boolean',
                ttl: 7200,
            });
        });

        it('no softDelete option → softDeleteConfig is null', () => {
            const model = runtime.model('ver_items');
            assert.equal(model.softDeleteConfig, null);
        });
    });

    // ── deleteOne soft-marks document ─────────────────────────────────────────

    describe('deleteOne behavior', () => {
        it('sets deletedAt on the document instead of removing it', async () => {
            const model = runtime.model('sd_docs');
            await model.insertOne({ name: 'alice' });
            await model.deleteOne({ name: 'alice' });

            const db = runtime._adapter.db;
            const raw = await db.collection('sd_docs').findOne({ name: 'alice' });
            assert.ok(raw !== null, 'document should remain in DB');
            assert.ok(raw.deletedAt instanceof Date, 'deletedAt should be a Date');
        });

        it('find() excludes soft-deleted documents', async () => {
            const model = runtime.model('sd_docs');
            await model.insertOne({ name: 'bob' });
            await model.insertOne({ name: 'carol' });
            await model.deleteOne({ name: 'bob' });

            const docs = await model.find({});
            assert.equal(docs.length, 1);
            assert.equal(docs[0].name, 'carol');
        });

        it('count() excludes soft-deleted documents', async () => {
            const model = runtime.model('sd_docs');
            await model.insertOne({ name: 'dave' });
            await model.insertOne({ name: 'eve' });
            await model.deleteOne({ name: 'dave' });

            assert.equal(await model.count({}), 1);
        });

        it('all standard read paths exclude soft-deleted documents by default', async () => {
            const model = runtime.model('sd_docs');
            const deleted = await model.insertOne({ name: 'soft-gone', group: 'read-paths' });
            const active = await model.insertOne({ name: 'soft-live', group: 'read-paths' });
            await model.deleteOne({ _id: deleted.insertedId });

            assert.equal(await model.findOneById(deleted.insertedId), null);
            assert.equal((await model.findOneById(deleted.insertedId, { withDeleted: true })).name, 'soft-gone');

            const byIds = await model.findByIds([deleted.insertedId, active.insertedId]);
            assert.deepEqual(byIds.map((doc: any) => doc.name), ['soft-live']);

            const page = await model.findPage({ query: { group: 'read-paths' }, sort: { name: 1 }, limit: 10 });
            assert.deepEqual(page.items.map((doc: any) => doc.name), ['soft-live']);

            assert.deepEqual(await model.distinct('name', { group: 'read-paths' }), ['soft-live']);

            const aggregateRows = await model.aggregate([
                { $match: { group: 'read-paths' } },
                { $group: { _id: null, names: { $push: '$name' } } },
            ]);
            assert.deepEqual(aggregateRows[0].names, ['soft-live']);

            const streamed: string[] = [];
            await new Promise<void>((resolve, reject) => {
                model.stream({ group: 'read-paths' })
                    .on('data', (doc: any) => streamed.push(doc.name))
                    .on('error', reject)
                    .on('end', resolve);
            });
            assert.deepEqual(streamed, ['soft-live']);
        });

        it('boolean type sets field to true instead of a Date', async () => {
            const model = runtime.model('sd_bool');
            await model.insertOne({ name: 'frank' });
            await model.deleteOne({ name: 'frank' });

            const db = runtime._adapter.db;
            const raw = await db.collection('sd_bool').findOne({ name: 'frank' });
            assert.equal(raw?.removedAt, true);
        });

        it('boolean mode treats false, null and missing as visible across read paths', async () => {
            const model = runtime.model('sd_bool');
            const raw = runtime._adapter.db.collection('sd_bool');
            const inserted = await raw.insertMany([
                { name: 'false', removedAt: false, group: 'boolean-reads' },
                { name: 'null', removedAt: null, group: 'boolean-reads' },
                { name: 'missing', group: 'boolean-reads' },
                { name: 'deleted', removedAt: true, group: 'boolean-reads' },
            ]);
            const ids = Object.values(inserted.insertedIds);
            assert.deepEqual((await model.find({ group: 'boolean-reads' })).map((doc: any) => doc.name).sort(), ['false', 'missing', 'null']);
            assert.equal(await model.count({ group: 'boolean-reads' }), 3);
            assert.equal(await model.findOneById(ids[3], { projection: { name: 1 } }), null);
            assert.equal((await model.findOneById(ids[0], { projection: { name: 1 } })).name, 'false');
            const projected = await model.findByIds(ids, { projection: { name: 1 } });
            assert.deepEqual(projected.map((doc: any) => doc.name).sort(), ['false', 'missing', 'null']);
            assert.ok(projected.every((doc: any) => !Object.prototype.hasOwnProperty.call(doc, 'removedAt')));
            assert.deepEqual((await model.findOnlyDeleted({ group: 'boolean-reads' })).map((doc: any) => doc.name), ['deleted']);
            assert.equal((await model.findWithDeleted({ group: 'boolean-reads' })).length, 4);
        });
    });

    // ── findWithDeleted / findOnlyDeleted ─────────────────────────────────────

    describe('findWithDeleted / findOnlyDeleted', () => {
        it('findWithDeleted includes both active and soft-deleted documents', async () => {
            const model = runtime.model('sd_docs');
            await model.insertOne({ name: 'grace' });
            await model.insertOne({ name: 'hank' });
            await model.deleteOne({ name: 'grace' });

            const docs = await model.findWithDeleted({});
            assert.equal(docs.length, 2);
        });

        it('findOnlyDeleted returns only soft-deleted documents', async () => {
            const model = runtime.model('sd_docs');
            await model.insertOne({ name: 'iris' });
            await model.insertOne({ name: 'jack' });
            await model.deleteOne({ name: 'iris' });

            const docs = await model.findOnlyDeleted({});
            assert.equal(docs.length, 1);
            assert.equal(docs[0].name, 'iris');
        });

        it('countWithDeleted includes soft-deleted documents', async () => {
            const model = runtime.model('sd_docs');
            await model.insertOne({ name: 'kate' });
            await model.insertOne({ name: 'leo' });
            await model.deleteOne({ name: 'kate' });

            assert.equal(await model.countWithDeleted({}), 2);
        });

        it('countOnlyDeleted returns count of soft-deleted documents only', async () => {
            const model = runtime.model('sd_docs');
            await model.insertOne({ name: 'mia' });
            await model.insertOne({ name: 'nora' });
            await model.deleteOne({ name: 'mia' });

            assert.equal(await model.countOnlyDeleted({}), 1);
        });
    });

    // ── restore ───────────────────────────────────────────────────────────────

    describe('restore()', () => {
        it('restore() un-marks a soft-deleted document', async () => {
            const model = runtime.model('sd_docs');
            await model.insertOne({ name: 'oliver' });
            await model.deleteOne({ name: 'oliver' });
            assert.equal((await model.find({})).length, 0);

            await model.restore({ name: 'oliver' });
            const docs = await model.find({});
            assert.equal(docs.length, 1);
            assert.equal(docs[0].name, 'oliver');
        });

        it('restoreMany() un-marks multiple soft-deleted documents', async () => {
            const model = runtime.model('sd_docs');
            await model.insertOne({ tag: 'batch', name: 'penny' });
            await model.insertOne({ tag: 'batch', name: 'quinn' });
            await model.deleteOne({ name: 'penny' });
            await model.deleteOne({ name: 'quinn' });
            assert.equal((await model.find({ tag: 'batch' })).length, 0);

            await model.restoreMany({ tag: 'batch' });
            assert.equal((await model.find({ tag: 'batch' })).length, 2);
        });
    });

    // ── forceDelete ───────────────────────────────────────────────────────────

    describe('forceDelete()', () => {
        it('permanently removes document from the database', async () => {
            const model = runtime.model('sd_docs');
            await model.insertOne({ name: 'rose' });
            await model.forceDelete({ name: 'rose' });

            const db = runtime._adapter.db;
            const raw = await db.collection('sd_docs').findOne({ name: 'rose' });
            assert.equal(raw, null);
        });

        it('forceDeleteMany() permanently removes multiple documents', async () => {
            const model = runtime.model('sd_docs');
            await model.insertOne({ tag: 'purge', name: 'sam' });
            await model.insertOne({ tag: 'purge', name: 'tara' });
            await model.forceDeleteMany({ tag: 'purge' });

            const db = runtime._adapter.db;
            const count = await db.collection('sd_docs').countDocuments({ tag: 'purge' });
            assert.equal(count, 0);
        });
    });

    // ── version increment ─────────────────────────────────────────────────────

    describe('version increment', () => {
        it('insertOne sets version to 0', async () => {
            const model = runtime.model('ver_items');
            const result = await model.insertOne({ name: 'uma' });
            const doc = await model.findOneById(result.insertedId);
            assert.equal(doc.version, 0);
        });

        it('updateOne increments version by 1', async () => {
            const model = runtime.model('ver_items');
            const result = await model.insertOne({ name: 'victor' });
            await model.updateOne({ _id: result.insertedId }, { $set: { x: 1 } });
            const doc = await model.findOneById(result.insertedId);
            assert.equal(doc.version, 1);
        });

        it('multiple updates increment version cumulatively', async () => {
            const model = runtime.model('ver_items');
            const result = await model.insertOne({ name: 'wendy' });
            await model.updateOne({ _id: result.insertedId }, { $set: { x: 1 } });
            await model.updateOne({ _id: result.insertedId }, { $set: { x: 2 } });
            const doc = await model.findOneById(result.insertedId);
            assert.equal(doc.version, 2);
        });

        it('updateOne rejects stale expected versions', async () => {
            const model = runtime.model('ver_items');
            const result = await model.insertOne({ name: 'stale' });
            await model.updateOne({ _id: result.insertedId, version: 0 }, { $set: { x: 1 } });
            await assert.rejects(
                () => model.updateOne({ _id: result.insertedId, version: 0 }, { $set: { x: 2 } }),
                /optimistic lock conflict/i,
            );
        });

        it('updateOne honors explicit expectedVersion over automatic lookup', async () => {
            const model = runtime.model('ver_items');
            const result = await model.insertOne({ name: 'explicit-wins' });
            await assert.rejects(
                () => model.updateOne({ _id: result.insertedId }, { $set: { x: 1 } }, { expectedVersion: 1 }),
                /optimistic lock conflict/i,
            );
            const doc = await model.findOneById(result.insertedId);
            assert.equal(doc.version, 0);
        });

        it('updateOne automatic version lookup forwards session to the pre-read', async () => {
            const model = runtime.model('ver_items');
            const result = await model.insertOne({ name: 'session-lookup' });
            const session = runtime._client.startSession();
            const originalFindOne = model.collection.findOne.bind(model.collection);
            const originalUpdateOne = model.collection.updateOne.bind(model.collection);
            let lookupOptions: any = null;
            let writeOptions: any = null;

            model.collection.findOne = async (query: any, options: any) => {
                if (String(query?._id) === String(result.insertedId)) {
                    lookupOptions = options;
                }
                return originalFindOne(query, options);
            };
            model.collection.updateOne = async (filter: any, update: any, options: any) => {
                if (String(filter?._id) === String(result.insertedId)) {
                    writeOptions = options;
                }
                return originalUpdateOne(filter, update, options);
            };

            try {
                await model.updateOne(
                    { _id: result.insertedId },
                    { $set: { x: 10 } },
                    { session, comment: 'occ-session-lookup' },
                );
            } finally {
                model.collection.findOne = originalFindOne;
                model.collection.updateOne = originalUpdateOne;
                await session.endSession();
            }

            assert.equal(lookupOptions?.session, session);
            assert.equal(lookupOptions?.comment, 'occ-session-lookup');
            assert.deepEqual(lookupOptions?.projection, { version: 1 });
            assert.equal(writeOptions?.session, session);
        });

        it('updateOne without version or direct _id rejects unsafe automatic lookup', async () => {
            const model = runtime.model('ver_items');
            await model.insertOne({ name: 'unsafe-filter' });
            await assert.rejects(
                () => model.updateOne({ name: 'unsafe-filter' }, { $set: { x: 1 } }),
                /direct _id filter/i,
            );
        });

        it('findOneAndReplace enforces expected version and advances the replacement version', async () => {
            const model = runtime.model('ver_items');
            const result = await model.insertOne({ name: 'replace-occ' });

            await model.findOneAndReplace(
                { _id: result.insertedId },
                { name: 'replace-occ-next' },
                { returnDocument: 'after' },
            );

            const doc = await model.findOneById(result.insertedId);
            assert.equal(doc.name, 'replace-occ-next');
            assert.equal(doc.version, 1);
            await assert.rejects(
                () => model.findOneAndReplace(
                    { _id: result.insertedId },
                    { name: 'replace-occ-stale' },
                    { expectedVersion: 0 },
                ),
                /optimistic lock conflict/i,
            );
        });

        it('updateMany counter mode increments all matched document versions', async () => {
            const model = runtime.model('ver_items');
            await model.insertMany([
                { group: 'counter', n: 1 },
                { group: 'counter', n: 2 },
            ]);
            const result = await model.updateMany({ group: 'counter' }, { $set: { x: 1 } });
            assert.equal(result.matchedCount, 2);
            const docs = await model.find({ group: 'counter' });
            assert.deepEqual(docs.map((doc: any) => doc.version).sort(), [1, 1]);
        });

        it('updateMany off mode skips version increments', async () => {
            const model = runtime.model('ver_items');
            await model.insertMany([
                { group: 'off', n: 1 },
                { group: 'off', n: 2 },
            ]);
            await model.updateMany({ group: 'off' }, { $set: { x: 1 } }, { versionMode: 'off' });
            const docs = await model.find({ group: 'off' });
            assert.deepEqual(docs.map((doc: any) => doc.version).sort(), [0, 0]);
        });

        it('updateMany strict mode reports conflicting documents', async () => {
            const model = runtime.model('ver_items');
            const first = await model.insertOne({ group: 'strict', n: 1 });
            await model.insertOne({ group: 'strict', n: 2 });
            let firstAttempt = true;
            const originalUpdateOne = model.collection.updateOne.bind(model.collection);
            model.collection.updateOne = async (filter: any, update: any, options: any) => {
                const candidateId = filter.$and?.find((part: any) => part._id !== undefined)?._id ?? filter._id;
                if (firstAttempt && String(candidateId) === String(first.insertedId)) {
                    firstAttempt = false;
                    await originalUpdateOne({ _id: candidateId }, { $inc: { version: 1 } });
                }
                return originalUpdateOne(filter, update, options);
            };
            const result = await model.updateMany({ group: 'strict' }, { $set: { x: 1 } }, { versionMode: 'strict' });
            assert.equal((result as any).conflictCount, 1);
            assert.equal((result as any).conflictedIds.length, 1);
            const docs = await model.find({ group: 'strict' });
            assert.deepEqual(docs.map((doc: any) => doc.version).sort(), [1, 1]);
        });

        it('strict update classifies business-filter drift as skipped rather than a version conflict', async () => {
            const model = runtime.model('ver_items');
            const first = await model.insertOne({ group: 'strict-drift', status: 'pending' });
            await model.insertOne({ group: 'strict-drift', status: 'pending' });
            const originalUpdateOne = model.collection.updateOne.bind(model.collection);
            let drifted = false;
            model.collection.updateOne = async (filter: any, update: any, options: any) => {
                const candidateId = filter.$and?.find((part: any) => part._id !== undefined)?._id;
                if (!drifted && String(candidateId) === String(first.insertedId)) {
                    drifted = true;
                    await originalUpdateOne({ _id: candidateId }, { $set: { status: 'cancelled' } });
                }
                return originalUpdateOne(filter, update, options);
            };
            try {
                const result = await model.updateMany(
                    { group: 'strict-drift', status: 'pending' },
                    { $set: { touched: true } },
                    { versionMode: 'strict' },
                );
                assert.equal(result.matchedCount, 1);
                assert.equal((result as any).conflictCount, 0);
                assert.equal((result as any).skippedCount, 1);
                assert.equal((result as any).skippedIds.length, 1);
            } finally {
                model.collection.updateOne = originalUpdateOne;
            }
        });

        it('updateMany strict mode forwards session to the version pre-read', async () => {
            const model = runtime.model('ver_items');
            await model.insertMany([
                { group: 'strict-session', n: 1 },
                { group: 'strict-session', n: 2 },
            ]);
            const session = runtime._client.startSession();
            const originalStream = model.collection.stream.bind(model.collection);
            let lookupOptions: any = null;

            model.collection.stream = (filter: any, options: any) => {
                if (filter?.group === 'strict-session') {
                    lookupOptions = options;
                }
                return originalStream(filter, options);
            };

            try {
                const result = await model.updateMany(
                    { group: 'strict-session' },
                    { $set: { x: 1 } },
                    { versionMode: 'strict', session, comment: 'strict-session-lookup' },
                );
                assert.equal(result.matchedCount, 2);
            } finally {
                model.collection.stream = originalStream;
                await session.endSession();
            }

            assert.equal(lookupOptions?.session, session);
            assert.equal(lookupOptions?.comment, 'strict-session-lookup');
            assert.deepEqual(lookupOptions?.projection, { _id: 1, version: 1 });
            assert.deepEqual(lookupOptions?.sort, { _id: 1 });
        });

        it('updateMany strict mode visits more than the default 500 documents and closes the stream', async () => {
            const model = runtime.model('ver_items');
            await model.insertMany(Array.from({ length: 501 }, (_, n) => ({ group: 'strict-large', n })));
            const originalStream = model.collection.stream.bind(model.collection);
            let destroyed = false;
            model.collection.stream = (filter: any, options: any) => {
                const stream = originalStream(filter, options);
                const originalDestroy = stream.destroy.bind(stream);
                stream.destroy = (...args: any[]) => {
                    destroyed = true;
                    return originalDestroy(...args);
                };
                return stream;
            };
            try {
                const result = await model.updateMany({ group: 'strict-large' }, { $set: { touched: true } }, { versionMode: 'strict' });
                assert.equal(result.matchedCount, 501);
                assert.equal(result.modifiedCount, 501);
                assert.equal((result as any).conflictCount, 0);
            } finally {
                model.collection.stream = originalStream;
            }
            assert.equal(destroyed, true);
            assert.equal(await model.count({ group: 'strict-large', touched: true, version: 1 }), 501);
        });

        it('updateBatch strict mode reports conflicting documents', async () => {
            const model = runtime.model('ver_items');
            const first = await model.insertOne({ group: 'strict-batch', n: 1 });
            await model.insertOne({ group: 'strict-batch', n: 2 });
            let firstAttempt = true;
            const progress: any[] = [];
            const originalUpdateOne = model.collection.updateOne.bind(model.collection);
            model.collection.updateOne = async (filter: any, update: any, options: any) => {
                const candidateId = filter.$and?.find((part: any) => part._id !== undefined)?._id ?? filter._id;
                if (firstAttempt && String(candidateId) === String(first.insertedId)) {
                    firstAttempt = false;
                    await originalUpdateOne({ _id: candidateId }, { $inc: { version: 1 } });
                }
                return originalUpdateOne(filter, update, options);
            };

            try {
                const result = await model.updateBatch(
                    { group: 'strict-batch' },
                    { $set: { x: 1 } },
                    { versionMode: 'strict', batchSize: 1, onProgress: (info: any) => progress.push(info) },
                );
                assert.equal((result as any).conflictCount, 1);
                assert.equal((result as any).conflictedIds.length, 1);
                assert.equal(result.matchedCount, 1);
                assert.equal(result.batchCount, 2);
                assert.equal(progress.length, 2);
            } finally {
                model.collection.updateOne = originalUpdateOne;
            }

            const docs = await model.find({ group: 'strict-batch' });
            assert.deepEqual(docs.map((doc: any) => doc.version).sort(), [1, 1]);
        });

        it('updateBatch strict mode rejects upsert and invalid batch sizes', async () => {
            const model = runtime.model('ver_items');
            await assert.rejects(
                () => model.updateBatch({ group: 'strict-invalid' }, { $set: { touched: true } }, { versionMode: 'strict', upsert: true }),
                /strict.*upsert/i,
            );
            await assert.rejects(
                () => model.updateBatch({ group: 'strict-invalid' }, { $set: { touched: true } }, { versionMode: 'strict', batchSize: 0 }),
                /batchSize must be a positive integer/,
            );
        });

        it('updateBatch strict mode skips a candidate that leaves the original filter', async () => {
            const model = runtime.model('ver_items');
            const first = await model.insertOne({ group: 'strict-batch-drift', status: 'pending' });
            await model.insertOne({ group: 'strict-batch-drift', status: 'pending' });
            const originalUpdateOne = model.collection.updateOne.bind(model.collection);
            const progress: any[] = [];
            let drifted = false;
            model.collection.updateOne = async (filter: any, update: any, options: any) => {
                const candidateId = filter.$and?.find((part: any) => part._id !== undefined)?._id;
                if (!drifted && String(candidateId) === String(first.insertedId)) {
                    drifted = true;
                    await originalUpdateOne({ _id: candidateId }, { $set: { status: 'moved' } });
                }
                return originalUpdateOne(filter, update, options);
            };
            try {
                const result = await model.updateBatch(
                    { group: 'strict-batch-drift', status: 'pending' },
                    { $set: { touched: true } },
                    { versionMode: 'strict', batchSize: 1, onProgress: (info: any) => progress.push(info) },
                );
                assert.equal(result.matchedCount, 1);
                assert.equal(result.skippedCount, 1);
                assert.equal(result.conflictCount, 0);
                assert.deepEqual(result.skippedIds?.map(String), [String(first.insertedId)]);
                assert.equal(progress[progress.length - 1]?.skipped, 1);
                assert.equal(await model.count({ group: 'strict-batch-drift', status: 'moved', touched: true }), 0);
            } finally {
                model.collection.updateOne = originalUpdateOne;
            }
        });

        it('updateOne preserves pipeline updates while advancing version', async () => {
            const model = runtime.model('ver_items');
            const result = await model.insertOne({ name: 'pipeline-version', score: 1 });

            await model.updateOne(
                { _id: result.insertedId, version: 0 },
                [{ $set: { score: { $add: ['$score', 4] } } }],
            );

            const doc = await model.findOneById(result.insertedId);
            assert.equal(doc.score, 5);
            assert.equal(doc.version, 1);
        });
    });

    describe('pipeline update timestamps', () => {
        it('updateOne preserves pipeline updates while appending updatedAt', async () => {
            const model = runtime.model('pipeline_ts_items');
            const result = await model.insertOne({ name: 'pipeline-ts', score: 1 });

            await model.updateOne(
                { _id: result.insertedId },
                [{ $set: { score: { $add: ['$score', 2] } } }],
            );

            const doc = await model.findOneById(result.insertedId);
            assert.equal(doc.score, 3);
            assert.ok(doc.updatedAt instanceof Date);
        });

        it('upsertOne rejects pipeline updates instead of rewriting them into update documents', async () => {
            const model = runtime.model('pipeline_ts_items');

            await assert.rejects(
                () => model.upsertOne(
                    { name: 'pipeline-upsert' },
                    [{ $set: { score: 9 } }],
                ),
                /update must be a non-empty object/,
            );
        });
    });
});
