import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId, Int32, Long, Decimal128, BSON } from 'mongodb';
import { runInNewContext } from 'node:vm';
import { createMemoryServerBootstrap } from '../../bootstrap/memory-server';
import { findByIdsDocuments } from '../../../src/adapters/mongodb/queries/find-by-id';
import { buildFindCacheKey, buildPreparedAggregateCacheKey } from '../../../src/adapters/mongodb/queries/query-cache-keys';

const MonSQLize = require('../../../dist/cjs/index.cjs');
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

describe('review repair query contracts against native MongoDB', () => {
    const bootstrap = createMemoryServerBootstrap();
    const databaseName = 'repair_query_contracts';
    let runtime: any, raw: any, nativeDb: any, collection: any, model: any;
    let ids: ObjectId[];
    const commands: any[] = [];

    before(async () => {
        const { uri } = await bootstrap.setup();
        MonSQLize.Model._clear();
        MonSQLize.Model.define('items', { schema: {}, options: { softDelete: true, autoIndex: false } });
        runtime = new MonSQLize({ type: 'mongodb', databaseName, autoConvertObjectId: false,
            config: { uri, options: { monitorCommands: true } },
            writePathPolicy: { default: 'allow-both', namespaces: { [`${databaseName}.blocked_output`]: 'model-only' } },
        });
        await runtime.connect();
        collection = runtime.collection('items'); model = runtime.model('items');
        raw = collection.raw(); nativeDb = raw.client.db(databaseName);
        raw.client.on('commandStarted', (event: any) => commands.push(event));
        await raw.createIndex({ score: 1 });
    });
    after(async () => {
        try { if (runtime) await runtime.close(); }
        finally { MonSQLize.Model._clear(); await bootstrap.teardown(); }
    });
    beforeEach(async () => {
        await raw.deleteMany({}); await runtime.getCache().clear();
        await nativeDb.collection('blocked_output').deleteMany({});
        ids = [new ObjectId(), new ObjectId(), new ObjectId()];
        await raw.insertMany([
            { _id: ids[0], name: 'a', score: 1, secret: 'hidden', arr: [1, 2], active: true },
            { _id: ids[1], name: 'b', score: 2, secret: 'hidden', arr: [2, 3], active: true },
            { _id: ids[2], name: 'deleted', score: 3, secret: 'hidden', arr: [3], active: false, deletedAt: new Date(1) },
        ]);
        commands.length = 0;
    });

    it('rejects every top-level pagination write before executing a Mongo command', async () => {
        for (const terminal of ['await', 'array', 'stream', 'explain']) {
            assert.throws(() => {
                const chain = collection.aggregate([{ $match: {} }], { out: 'blocked_output', cache: 10000 });
                if (terminal === 'array') return chain.toArray();
                if (terminal === 'stream') return chain.stream();
                if (terminal === 'explain') return chain.explain();
                return chain;
            }, /writePathPolicy blocked/);
        }
        for (const accessor of [collection, model]) {
            for (const pipeline of [undefined, [], [{ $match: {} }]]) {
                await assert.rejects(() => accessor.findPage({ pipeline, options: { out: 'blocked_output' }, cache: 10000 }), { code: 'INVALID_OPERATION' });
            }
        }
        const hidden = Object.defineProperty({ $match: {} }, '$out', { value: 'blocked_output', enumerable: false });
        const converted = { toBSON: () => ({ $merge: 'blocked_output' }) };
        for (const stage of [{ $out: '' }, { $merge: { into: 'blocked_output' } }, hidden, converted]) {
            for (const accessor of [collection, model]) {
                await assert.rejects(() => accessor.findPage({ pipeline: [stage], cache: 10000 }), { code: 'INVALID_OPERATION' });
            }
        }
        assert.equal(commands.filter((event) => event.commandName === 'aggregate').length, 0);
    });

    it('isolates BSON input families in every shared query cache consumer', async () => {
        const empty = new BSON.Binary(), one = new BSON.Binary(); one.put(0);
        const cases: Array<[string, any, any]> = [
            ['undefined', { x: undefined }, {}], ['empty bytes', Buffer.alloc(0), {}],
            ['buffer view', Buffer.from([9, 1, 8]).subarray(1, 2), { '0': 1 }],
            ['uint8 view', new Uint8Array([9, 1, 8]).subarray(1, 2), { '0': 1 }],
            ['foreign bytes', runInNewContext('new Uint8Array([1])'), { '0': 1 }],
            ['map', new Map([['x', 1]]), {}], ['foreign map', runInNewContext('new Map([["x",1]])'), {}],
            ['foreign date', runInNewContext('new Date(1)'), {}],
            ['foreign regex', runInNewContext('/a/i'), {}], ['binary position', empty, one], ['negative zero', -0, 0],
        ];
        const canonical = (value: any) => BSON.EJSON.stringify(value, { relaxed: false });
        for (const [label, a, b] of cases) {
            await raw.deleteMany({});
            const rows = [{ _id: ids[0], n: 1, name: 'a1', payload: a, kind: 'double' },
                { _id: ids[1], n: 2, name: 'a2', payload: a, kind: 'double' },
                { _id: ids[2], n: 3, name: 'b', payload: b, kind: 'int' }];
            await raw.insertMany(rows);
            for (const operation of ['find', 'findOne', 'count', 'distinct', 'aggregate', 'findPage', 'findOneById', 'findByIds']) {
                await runtime.getCache().clear();
                const run = async (value: any, native: boolean, ttl = 10000) => {
                    const query = label === 'negative zero'
                        ? { $expr: { $eq: ['$kind', { $type: { $literal: value } }] } } : { payload: value };
                    const options = { cache: ttl, sort: { n: 1 } };
                    if (operation === 'find') return native ? raw.find(query).sort({ n: 1 }).toArray() : collection.find(query, options);
                    if (operation === 'findOne') return native ? raw.findOne(query, { sort: { n: 1 } }) : collection.findOne(query, options);
                    if (operation === 'count') return native ? raw.countDocuments(query) : collection.count(query, { cache: ttl });
                    if (operation === 'distinct') return native ? raw.distinct('name', query) : collection.distinct('name', query, { cache: ttl });
                    if (operation === 'aggregate') {
                        const pipeline = [{ $match: query }, { $sort: { n: 1 } }];
                        return native ? raw.aggregate(pipeline).toArray() : collection.aggregate(pipeline, { cache: ttl });
                    }
                    if (operation === 'findPage') return native ? raw.find(query).sort({ n: 1, _id: 1 }).toArray()
                        : (await collection.findPage({ query, sort: { n: 1 }, limit: 10, cache: ttl })).items;
                    const projection = { _id: 0, value: { $literal: value } };
                    if (operation === 'findOneById') return native ? raw.findOne({ _id: ids[0] }, { projection })
                        : collection.findOneById(ids[0], { projection, cache: ttl });
                    return native ? raw.find({ _id: { $in: [ids[0]] } }, { projection }).toArray()
                        : collection.findByIds([ids[0]], { projection, cache: ttl, preserveOrder: false });
                };
                const expectedA = canonical(await run(a, true)), expectedB = canonical(await run(b, true));
                assert.notEqual(expectedA, expectedB, label + '/' + operation + ': native control');
                assert.equal(canonical(await run(a, false)), expectedA, label + '/' + operation + ': first');
                assert.equal(canonical(await run(b, false)), expectedB, label + '/' + operation + ': hot');
                assert.equal(canonical(await run(b, false)), expectedB, label + '/' + operation + ': repeated');
                assert.equal(canonical(await run(b, false, 0)), expectedB, label + '/' + operation + ': uncached');
            }
        }
    });

    it('keeps v2 entries cold and precisely invalidates only the requested v3 BSON query', async () => {
        const query = { payload: { x: undefined } }, other = { payload: {} }, options = { sort: { score: 1 }, limit: 10 };
        await raw.updateOne({ _id: ids[0] }, { $set: { payload: { x: null } } });
        await raw.updateOne({ _id: ids[1] }, { $set: { payload: {} } });
        const key = buildFindCacheKey(raw, collection.management.defaults, query, options);
        const otherKey = buildFindCacheKey(raw, collection.management.defaults, other, options);
        // Frozen baseline-v2 fixture: undefined was omitted and input flags were absent.
        const legacy = key.slice(0, key.indexOf(':v3:'))
            + ':v2:["object",[["payload",["object",[]]]]]'
            + ':v2:["object",[["limit",["number","10"]],["sort",["object",[["score",["number","1"]]]]]]]';
        await runtime.getCache().set(legacy, [{ name: 'poison' }], 10000);
        assert.equal((await collection.find(query, { ...options, cache: 10000 }))[0].name, 'a');
        await collection.find(other, { ...options, cache: 10000 });
        await collection.updateOne({ _id: ids[0] }, { $set: { name: 'new' } }, {
            cache: { invalidate: [{ operation: 'find', query, options }] },
        });
        assert.equal(await runtime.getCache().get(key), undefined);
        assert.ok(await runtime.getCache().get(otherKey)); assert.ok(await runtime.getCache().get(legacy));
        assert.equal((await collection.find(query, { ...options, cache: 10000 }))[0].name, 'new');
        await collection.invalidate('find');
        assert.equal(await runtime.getCache().get(key), undefined); assert.equal(await runtime.getCache().get(legacy), undefined);
    });

    it('uses inherited undefined flags for reads and aggregate target descriptor invalidation', async () => {
        const inherited = new MonSQLize({ type: 'mongodb', databaseName, autoConvertObjectId: false,
            config: { uri: bootstrap.getUri(), options: { ignoreUndefined: true } } });
        try {
            await inherited.connect();
            const source = inherited.collection('rf12_source'), target = inherited.collection('rf12_target');
            await source.raw().deleteMany({}); await target.raw().deleteMany({});
            await source.raw().insertOne({ _id: ids[0], payload: {}, name: 'new' });
            await target.raw().insertMany([{ _id: ids[0], payload: {}, name: 'old' },
                { _id: ids[1], payload: { x: null }, name: 'null' },
                { _id: ids[2], payload: {}, name: 'second' }]);
            const query = { payload: { x: undefined } };
            assert.equal((await target.findOne(query, { cache: 10000, sort: { _id: 1 } })).name, 'old');
            assert.equal((await target.findOne(query, { cache: 10000, ignoreUndefined: false })).name, 'null');
            assert.equal(await target.count(query, { cache: 10000, ignoreUndefined: false }), 1);
            assert.equal(await target.count(query, { cache: 10000, ignoreUndefined: true }), 2);
            await source.aggregate([{ $out: 'rf12_target' }], {
                cache: { invalidate: [{ operation: 'findOne', query, options: { sort: { _id: 1 } } }] },
            });
            assert.equal((await target.findOne(query, { cache: 10000, sort: { _id: 1 } })).name, 'new');
        } finally { await inherited.close(); }
    });

    it('materializes native out after DSL conversion and never consumes or fills a read cache entry', async () => {
        const pipeline = [{ $project: { score: MonSQLize.expr('score+1') } }];
        assert.equal((await collection.aggregate(pipeline, { cache: 10000 })).length, 3);
        const target = 'ABCDEFABCDEFABCDEFABCDEF'; await nativeDb.collection(target).drop().catch(() => {});
        await collection.aggregate(pipeline, { out: target, cache: 10000 });
        assert.equal(await nativeDb.collection(target).countDocuments(), 3);
        await nativeDb.collection(target).drop();
        const stream = collection.aggregate(pipeline, { out: target, cache: 10000 }).stream();
        for await (const row of stream) void row;
        assert.equal(await nativeDb.collection(target).countDocuments(), 3);
        await model.aggregate([{ $match: {} }], { out: 'blocked_output', cache: 10000 });
        assert.equal(await nativeDb.collection('blocked_output').countDocuments(), 2);
        await assert.rejects(async () => await collection.aggregate([{ $out: 'out_first' }], { out: 'out_second' }));
    });

    it('captures pagination native out exactly once before asynchronous cache work', async () => {
        let reads = 0;
        const options: any = { pipeline: [{ $match: { active: true } }], limit: 10, cache: 10000,
            get options() { reads++; return reads === 1 ? {} : { out: 'late_output' }; } };
        assert.equal((await collection.findPage(options)).items.length, 2); assert.equal(reads, 1);
        const native: any = {};
        const pending = collection.findPage({ pipeline: [{ $match: { active: true } }], options: native, cache: 10000 });
        native.out = 'late_output'; await pending;
        assert.equal(commands.some((event) => event.command.pipeline?.some((stage: any) => '$out' in stage)), false);
    });

    it('isolates mutable BSON decoding options from ordinary aggregate cache results', async () => {
        const pipeline = [{ $limit: 1 }, { $project: { _id: 0, payload: { $literal: [{ value: 1 }] } } }];
        const plainRows = await collection.aggregate(pipeline, { cache: 10000 });
        const fields: any = Object.create({ payload: false });
        const chain = collection.aggregate(pipeline, { fieldsAsRaw: fields, cache: 10000 });
        fields.payload = true;
        assert.deepEqual(await chain, plainRows);
        const rawRows = await collection.aggregate(pipeline, { fieldsAsRaw: fields, cache: 10000 });
        const nativeRows = await raw.aggregate(pipeline, { fieldsAsRaw: fields }).toArray();
        assert.ok(Buffer.isBuffer(rawRows[0].payload[0])); assert.deepEqual(rawRows, nativeRows);
        assert.deepEqual(await collection.aggregate(pipeline, { cache: 10000 }), plainRows);
        const buffers = await collection.aggregate(pipeline, { raw: true, cache: 10000 });
        assert.ok(Buffer.isBuffer(buffers[0]));
        const dynamic = new Proxy({}, { get: (_target, key) => key === 'payload' });
        assert.deepEqual(await collection.aggregate(pipeline, { fieldsAsRaw: dynamic, cache: 10000 }),
            await raw.aggregate(pipeline, { fieldsAsRaw: dynamic }).toArray());
    });

    it('captures class stages for every aggregate terminal and pagination', async () => {
        for (const terminal of ['await', 'array', 'stream', 'explain']) {
            class Stage { $match: any = { active: true }; }
            const stage: any = new Stage();
            const chain = collection.aggregate([stage]);
            delete stage.$match; stage.$out = 'blocked_output';
            if (terminal === 'await') assert.equal((await chain).length, 2);
            if (terminal === 'array') assert.equal((await chain.toArray()).length, 2);
            if (terminal === 'stream') {
                const rows = []; for await (const row of chain.stream()) rows.push(row);
                assert.equal(rows.length, 2);
            }
            if (terminal === 'explain') await chain.explain();
        }
        const stage: any = { $match: { active: true } };
        const page = collection.findPage({ pipeline: [stage], limit: 10 });
        delete stage.$match; stage.$out = 'blocked_output';
        assert.equal((await page).items.length, 2);
        assert.ok(commands.some((event) => event.commandName === 'aggregate'));
        for (const event of commands.filter((event) => event.commandName === 'aggregate')) {
            assert.equal(event.command.pipeline.some((stage: any) => '$out' in stage || '$merge' in stage), false);
        }
    });

    it('checks materialized targets and executes the captured target after caller mutation', async () => {
        assert.throws(() => collection.aggregate([{ toBSON: () => ({ $out: 'blocked_output' }) }]), /writePathPolicy blocked/);
        class Target { db = databaseName; coll = 'allowed_output'; }
        const target = new Target();
        const chain = collection.aggregate([{ $limit: 1 }, { $out: target }]);
        target.coll = 'blocked_output';
        await chain.toArray();
        assert.equal(await nativeDb.collection('allowed_output').countDocuments(), 1);
        assert.equal(await nativeDb.collection('blocked_output').countDocuments(), 0);
    });

    it('checks DSL-compiled merge targets before any driver or cache work', async () => {
        const cache = runtime.getCache();
        let cacheCalls = 0;
        const get = cache.get, set = cache.set;
        cache.get = function (...args: any[]) { cacheCalls++; return get.apply(this, args); };
        cache.set = function (...args: any[]) { cacheCalls++; return set.apply(this, args); };
        try {
            for (const into of [MonSQLize.expr('"blocked_output"'), { db: databaseName, coll: MonSQLize.expr('"blocked_output"') }]) {
                for (const terminal of ['await', 'array', 'stream', 'explain']) {
                    assert.throws(() => {
                        const chain = collection.aggregate([{ $merge: { into } }], { cache: 10000 });
                        if (terminal === 'array') return chain.toArray();
                        if (terminal === 'stream') return chain.stream();
                        if (terminal === 'explain') return chain.explain();
                        return chain;
                    }, { code: 'INVALID_OPERATION' });
                }
            }
            assert.equal(commands.filter((event) => event.commandName === 'aggregate').length, 0);
            assert.equal(cacheCalls, 0);
        } finally { cache.get = get; cache.set = set; }
        const target = runtime.collection('compiled_output');
        await nativeDb.collection('compiled_output').deleteMany({});
        assert.equal((await target.find({}, { cache: 10000 })).length, 0);
        await collection.aggregate([{ $limit: 1 }, { $merge: { into: MonSQLize.expr('"compiled_output"') } }], { autoInvalidate: true });
        assert.equal((await target.find({}, { cache: 10000 })).length, 1);
        // A Model source may write to a model-only target using the same compiled pipeline.
        await model.aggregate([{ $limit: 1 }, { $merge: { into: MonSQLize.expr('"blocked_output"') } }]);
        assert.equal(await nativeDb.collection('blocked_output').countDocuments(), 1);
    });

    it('invalidates supported DSL aggregate descriptors after updates and merge writes', async () => {
        const target = runtime.collection('descriptor_output');
        for (const syntax of ['dsl', 'native', 'literal']) for (const write of ['update', 'merge']) {
            await nativeDb.collection('descriptor_output').deleteMany({}); await runtime.getCache().clear();
            await nativeDb.collection('descriptor_output').insertOne({ _id: ids[0], score: 1 });
            const p = [{ $match: { _id: ids[0] } }, { $project: { _id: 0,
                score: syntax === 'native' ? { $add: ['$score', 1] } : MonSQLize.expr('score+1'),
                ...(syntax === 'literal' ? { literal: MonSQLize.expr('LITERAL("507f1f77bcf86cd799439011")') } : {}),
            } }];
            assert.equal((await target.aggregate(p, { cache: 10000 }))[0].score, 2);
            const options = { autoInvalidate: true, cache: { invalidate: [{ operation: 'aggregate', pipeline: p }] } };
            if (write === 'update') await target.updateOne({ _id: ids[0] }, { $set: { score: 9 } }, options);
            else {
                await raw.updateOne({ _id: ids[0] }, { $set: { score: 9 } });
                await collection.aggregate([{ $match: { _id: ids[0] } }, { $merge: { into: 'descriptor_output', whenMatched: 'replace' } }], options);
            }
            const actual = await target.aggregate(p, { cache: 10000 });
            assert.equal(actual[0].score, 10);
            if (syntax === 'literal') assert.equal(actual[0].literal, '507f1f77bcf86cd799439011');
        }
    });

    it('does not reuse legacy aggregate keys that conflated literal strings and ObjectIds', async () => {
        const target = runtime.collection('descriptor_legacy');
        await nativeDb.collection('descriptor_legacy').deleteMany({}); await runtime.getCache().clear();
        const id = new ObjectId(); await nativeDb.collection('descriptor_legacy').insertOne({ score: 1 });
        const pipeline = [{ $project: { _id: 0, value: { $literal: id } } }];
        const key = buildPreparedAggregateCacheKey(target.raw(), target.management.defaults, pipeline);
        const legacy = key.replace(':prepared-v2:', ':prepared-v1:');
        assert.notEqual(key, legacy);
        await runtime.getCache().set(legacy, [{ value: id.toHexString() }], 10000);
        const [row] = await target.aggregate(pipeline, { cache: 10000 });
        assert.ok(row.value instanceof ObjectId); assert.equal(row.value.toHexString(), id.toHexString());
        assert.ok(await runtime.getCache().get(legacy)); assert.ok(await runtime.getCache().get(key));
        await target.updateOne({}, { $set: { score: 2 } }, { cache: { invalidate: 'aggregate' } });
        assert.equal(await runtime.getCache().get(legacy), undefined);
        assert.equal(await runtime.getCache().get(key), undefined);
    });

    it('keeps successful aggregate writes and valid descriptors when another descriptor cannot compile', async () => {
        const target = runtime.collection('descriptor_output');
        await nativeDb.collection('descriptor_output').deleteMany({}); await runtime.getCache().clear();
        const good = [{ $project: { _id: 0, score: MonSQLize.expr('score+1') } }];
        const invalid = [{ $project: { value: MonSQLize.expr('not valid(') } }];
        assert.deepEqual(await target.aggregate(good, { cache: 10000 }), []);
        for (const terminal of ['await', 'array']) {
            const score = terminal === 'array' ? 9 : 1;
            await raw.updateOne({ _id: ids[0] }, { $set: { score } });
            const chain = collection.aggregate([{ $match: { _id: ids[0] } }, { $merge: { into: 'descriptor_output' } }], {
                cache: { invalidate: [{ operation: 'aggregate', pipeline: invalid }, { operation: 'aggregate', pipeline: good }] },
            });
            await (terminal === 'array' ? chain.toArray() : chain);
            assert.equal(await nativeDb.collection('descriptor_output').countDocuments(), 1);
            assert.equal((await target.aggregate(good, { cache: 10000 }))[0].score, score + 1);
        }
        assert.throws(() => target.aggregate(invalid), { code: 'INVALID_EXPRESSION' });
        let conversions = 0;
        await assert.rejects(async () => await collection.aggregate([{ $project: { invalid: { $notAnOperator: 1 } } }, { $merge: { into: 'descriptor_output' } }], {
            cache: { invalidate: [{ operation: 'aggregate', pipeline: [{ toBSON() { conversions++; return { $match: {} }; } }] }] },
        }));
        assert.equal(conversions, 0);
        await collection.aggregate([{ $match: { _id: ids[0] } }, { $out: 'descriptor_native_out' }]);
        assert.equal(await nativeDb.collection('descriptor_native_out').countDocuments(), 1);
    });

    it('applies page inclusion, exclusion and array projections after custom stages', async () => {
        for (const accessor of [collection, model]) {
            for (const projection of [{ name: 1, _id: 0 }, ['name'], { secret: 0, _id: 0 }, {}]) {
                const page = await accessor.findPage({ pipeline: [{ $set: { derived: 1 } }], projection,
                    limit: 10, totals: { mode: 'sync' }, cache: 10000 });
                assert.equal(page.items.length, accessor === model ? 2 : 3);
                for (const row of page.items) {
                    assert.ok(row._id instanceof ObjectId);
                    if (Object.keys(projection).length) assert.equal('secret' in row, false);
                    if (Array.isArray(projection) || (projection as any).name === 1) assert.equal('derived' in row, false);
                }
            }
        }
    });

    it('rejects find-only page projections only when using a pipeline', async () => {
        for (const projection of [{ arr: { $slice: 1 } }, { arr: { $elemMatch: { $gte: 2 } } }, { 'arr.$': 1 }]) {
            await assert.rejects(() => collection.findPage({ pipeline: [{ $match: {} }], projection, cache: 10000 }), { code: 'INVALID_OPERATION' });
        }
        const nativePage = await collection.findPage({ projection: { arr: { $slice: 1 } }, limit: 10 });
        assert.ok(nativePage.items.every((row: any) => row.arr.length === 1));
        const literalPage = await collection.findPage({ pipeline: [{ $match: {} }],
            projection: { value: { $literal: { $slice: 1 } } }, limit: 10 });
        assert.deepEqual(literalPage.items[0].value, { $slice: 1 });
    });

    it('matches original native projections while preserving actual ID order and Model visibility', async () => {
        const projections: any[] = [
            { _id: 0 }, { name: 1, _id: false }, { name: 0, _id: 0 },
            { name: 1, _id: { $literal: 'replacement' } }, { name: 1, _id: '$$REMOVE' },
            { name: 1, _id: { $concat: ['$name', '!'] } }, { name: 1, _id: null },
            { arr: { $slice: 1 }, _id: 0 }, { arr: { $elemMatch: { $gte: 2 } }, _id: 0 },
            { name: 1, _id: new Int32(0) }, { name: 1, _id: Long.ONE },
            { name: 1, _id: Decimal128.fromString('1E-6176') },
            { name: 1, _id: Decimal128.fromString('-0E-6176') },
            { name: 1, _id: 2n ** 64n },
        ];
        const input = [ids[2], ids[1], ids[0], ids[1], new ObjectId()];
        for (const projection of projections) {
            for (const accessor of [collection, model]) {
                const expected = [];
                for (const id of [ids[2], ids[1], ids[0]]) {
                    const row = await raw.findOne({ _id: id, ...(accessor === model ? { deletedAt: { $exists: false } } : {}) }, { projection });
                    if (row) expected.push(row);
                }
                const before = commands.filter((event) => event.commandName === 'find').length;
                const actual = await accessor.findByIds(input, { preserveOrder: true, project: projection, cache: 10000 });
                assert.deepEqual(plain(actual), plain(expected));
                assert.equal(commands.filter((event) => event.commandName === 'find').length - before, 1);
            }
        }
    });

    it('bypasses shared result caches for internal identities and retains native global windows', async () => {
        let cacheCalls = 0;
        const cache = { get: () => { cacheCalls++; }, set: () => { cacheCalls++; }, delPattern: () => { cacheCalls++; } } as any;
        const actual = await findByIdsDocuments(raw, [ids[0], ids[1], ids[2]], {
            preserveOrder: true, projection: { name: 1, _id: 0 }, sort: { score: -1 }, skip: 1, limit: 1, cache: 10000,
        } as any, {}, cache);
        assert.deepEqual(actual, [{ name: 'b' }]); assert.equal(cacheCalls, 0);
        await collection.findByIds(ids, { projection: { _id: 0 }, cache: 10000 });
        const ordered = await collection.findByIds([...ids].reverse(), { preserveOrder: true, projection: { _id: 0 }, cache: 10000 });
        assert.deepEqual(ordered.map((row: any) => row.name), ['deleted', 'b', 'a']);
        const native = await collection.findByIds(ids, { projection: { _id: 0 }, cache: 10000 });
        assert.equal(native.length, 3); assert.equal(native.some((row: any) => '_id' in row), false);
    });

    it('rejects unsupported identity projections before cache or driver access', async () => {
        const unexpected = () => { throw new Error('unexpected cache or driver access'); };
        const fakeCollection = { find: unexpected } as any;
        const cache = { get: unexpected, set: unexpected, delPattern: unexpected } as any;
        for (const options of [
            { projection: { _id: { $slice: 1 } } }, { projection: { _id: { $elemMatch: { x: 1 } } } },
            { projection: { _id: { $meta: 'indexKey' } } }, { projection: { _id: { x: 0 } } },
            { projection: { '_id.x': 1 } }, { projection: { _id: undefined } }, { returnKey: true },
            { returnKey: true, hint: '_id_', sort: { score: 1 }, projection: { _id: { $meta: 'sortKey' } } },
            { raw: true }, { fieldsAsRaw: { _id: true }, projection: { _id: { $literal: { shown: true } } } },
            { fieldsAsRaw: { value: true }, projection: { _id: { $literal: [{ shown: true }] } } },
            { fieldsAsRaw: Object.create({ other: true }), projection: { _id: { $literal: 'display' } } },
        ]) {
            await assert.rejects(() => findByIdsDocuments(fakeCollection, ids, { ...options, preserveOrder: true, cache: 10000 } as any, {}, cache), { code: 'INVALID_OPERATION' });
        }
        const options = { projection: { _id: { $meta: 'indexKey' } }, hint: '_id_', preserveOrder: false };
        assert.deepEqual(plain(await collection.findByIds(ids, options)), plain(await raw.find({ _id: { $in: ids } }, options).toArray()));
    });

    it('honors inherited BSON decoding boundaries and explicit per-call overrides', async () => {
        const projection = { name: 1, _id: { $literal: [{ shown: true }] } };
        for (const bsonOptions of [{ raw: true }, { fieldsAsRaw: { _id: true } }, { fieldsAsRaw: { value: true } }]) {
            const inherited = nativeDb.collection('items', bsonOptions);
            await assert.rejects(() => findByIdsDocuments(inherited, ids, { projection, preserveOrder: true } as any), { code: 'INVALID_OPERATION' });
            const options = { projection, preserveOrder: true, raw: false, fieldsAsRaw: {} };
            const actual = await findByIdsDocuments(inherited, [ids[1], ids[0]], options as any);
            const expected = await Promise.all([ids[1], ids[0]].map((_id) => inherited.findOne({ _id }, options)));
            assert.deepEqual(actual, expected);
        }
        for (const fieldsAsRaw of [
            Object.defineProperty({}, 'value', { value: true }),
            Object.defineProperty({}, '_id', { value: true }),
        ]) {
            await assert.rejects(() => findByIdsDocuments(raw, ids, { projection, fieldsAsRaw, preserveOrder: true } as any), { code: 'INVALID_OPERATION' });
        }
        const rawRows = await findByIdsDocuments(nativeDb.collection('items', { raw: true }), ids);
        assert.ok(rawRows.every(Buffer.isBuffer));
    });

    it('isolates cached native BSON result modes from ordered documents', async () => {
        const entries = new Map<string, unknown>();
        const cache = { get: (key: string) => entries.get(key), set: (key: string, value: unknown) => { entries.set(key, value); } };
        const inheritedRaw = nativeDb.collection('items', { raw: true });
        const input = [ids[1], ids[0], ids[2]];
        for (const warmRawFirst of [true, false]) {
            entries.clear();
            const readRaw = () => findByIdsDocuments(inheritedRaw, input, { cache: 10000 } as any, {}, cache);
            const readOrdered = () => findByIdsDocuments(raw, input, { preserveOrder: true, cache: 10000 } as any, {}, cache);
            if (warmRawFirst) assert.ok((await readRaw()).every(Buffer.isBuffer));
            assert.deepEqual((await readOrdered()).map((row: any) => row.name), ['b', 'a', 'deleted']);
            assert.ok((await readRaw()).every(Buffer.isBuffer));
            assert.equal(entries.size, 2);
        }
        await raw.updateOne({ _id: ids[0] }, { $set: { payload: [{ shown: true }] } });
        entries.clear();
        const projection = { payload: 1 };
        const decoded = await findByIdsDocuments(raw, [ids[0]], { projection, cache: 10000 } as any, {}, cache);
        const rawFields = Object.defineProperty({}, 'payload', { value: true });
        const encoded = await findByIdsDocuments(raw, [ids[0]], { projection, fieldsAsRaw: rawFields, cache: 10000 } as any, {}, cache);
        assert.deepEqual(decoded[0].payload, [{ shown: true }]);
        assert.ok(Buffer.isBuffer(encoded[0].payload[0])); assert.equal(entries.size, 2);
    });

    it('shares captured projection keys with exact write invalidation', async () => {
        const options = { preserveOrder: true, projection: { toBSON: () => ({ name: 1 }) }, cache: 10000 };
        await collection.findByIds(ids, options);
        const before = commands.filter((event) => event.commandName === 'find').length;
        await collection.findByIds(ids, options);
        assert.equal(commands.filter((event) => event.commandName === 'find').length, before);
        await collection.updateOne({ _id: ids[0] }, { $set: { name: 'fresh' } }, {
            cache: { autoInvalidate: false, invalidate: [{ operation: 'findByIds', ids, options }] },
        });
        const result = await collection.findByIds(ids, options);
        assert.equal(result[0].name, 'fresh');
        assert.equal(commands.filter((event) => event.commandName === 'find').length, before + 1);
    });

    it('keeps the caller session when restoring a computed identity in one native query', async () => {
        const session = raw.client.startSession();
        try {
            for (const accessor of [collection, model]) {
                const input = [ids[1], ids[0]];
                commands.length = 0;
                const result = await accessor.findByIds(input, { preserveOrder: true,
                    projection: { name: 1, _id: { $literal: 'replacement' } }, session, cache: 10000 });
                assert.deepEqual(result.map((row: any) => row.name), ['b', 'a']);
                assert.ok(result.every((row: any) => row._id === 'replacement'));
                const finds = commands.filter((event) => event.commandName === 'find');
                assert.equal(finds.length, 1); assert.deepEqual(finds[0].command.lsid, session.id);
            }
        } finally { await session.endSession(); }
    });

    it('restores internal identities even when the caller mutates its original order flag', async () => {
        for (const projection of [{ name: 1, _id: 0 }, { name: 1, _id: { $literal: 'display' } }]) {
            const options: any = { preserveOrder: true, projection };
            const reading = collection.findByIds([ids[1], ids[0]], options);
            options.preserveOrder = false;
            const result = await reading;
            assert.deepEqual(result.map((row: any) => row.name), ['b', 'a']);
            assert.ok(result.every((row: any) => projection._id === 0 ? !('_id' in row) : row._id === 'display'));
        }
        const options: any = { preserveOrder: false, projection: { _id: 0 } };
        const reading = collection.findByIds([ids[1], ids[0]], options); options.preserveOrder = true;
        assert.equal((await reading).length, 2);
    });

    it('retains native rejection of illegal mixed projections', async () => {
        for (const projection of [{ name: 1, secret: 0, _id: 0 }, { name: 1, secret: 0, _id: { $literal: 'display' } }]) {
            await assert.rejects(() => raw.find({ _id: { $in: ids } }, { projection }).toArray());
            await assert.rejects(() => collection.findByIds(ids, { projection, preserveOrder: true }));
        }
    });

    it('evaluates literal and predicate DSL roles with the native expression engine', async () => {
        const [row] = await collection.aggregate([{ $limit: 1 }, { $project: { _id: 0,
            quoted: MonSQLize.expr('"$name"'), literal: MonSQLize.expr('LITERAL("$name")'), field: MonSQLize.expr('$name'),
        } }]);
        assert.deepEqual(row, { quoted: '$name', literal: '$name', field: 'a' });
        const root = await collection.aggregate([{ $match: MonSQLize.expr('score > 1') }]);
        const nested = await collection.aggregate([{ $match: { $expr: MonSQLize.expr('score > 1') } }]);
        assert.deepEqual(root.map((doc: any) => doc.name), ['b', 'deleted']);
        assert.deepEqual(nested.map((doc: any) => doc.name), ['b', 'deleted']);
        assert.throws(() => collection.aggregate([{ $match: { score: MonSQLize.expr('score > 1') } }]), { code: 'INVALID_EXPRESSION' });
    });
});
