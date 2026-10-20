import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId, Int32, Long, Decimal128 } from 'mongodb';
import { createMemoryServerBootstrap } from '../../bootstrap/memory-server';
import { findByIdsDocuments } from '../../../src/adapters/mongodb/queries/find-by-id';

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
        ids = [new ObjectId(), new ObjectId(), new ObjectId()];
        await raw.insertMany([
            { _id: ids[0], name: 'a', score: 1, secret: 'hidden', arr: [1, 2], active: true },
            { _id: ids[1], name: 'b', score: 2, secret: 'hidden', arr: [2, 3], active: true },
            { _id: ids[2], name: 'deleted', score: 3, secret: 'hidden', arr: [3], active: false, deletedAt: new Date(1) },
        ]);
        commands.length = 0;
    });

    it('rejects every top-level pagination write before executing a Mongo command', async () => {
        const hidden = Object.defineProperty({ $match: {} }, '$out', { value: 'blocked_output', enumerable: false });
        const converted = { toBSON: () => ({ $merge: 'blocked_output' }) };
        for (const stage of [{ $out: '' }, { $merge: { into: 'blocked_output' } }, hidden, converted]) {
            for (const accessor of [collection, model]) {
                await assert.rejects(() => accessor.findPage({ pipeline: [stage], cache: 10000 }), { code: 'INVALID_OPERATION' });
            }
        }
        assert.equal(commands.filter((event) => event.commandName === 'aggregate').length, 0);
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
