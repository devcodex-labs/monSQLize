import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectId } from 'mongodb';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const { createRuntime } = require('schema-dsl/runtime');
import { createMemoryServerBootstrap } from '../../bootstrap/memory-server';
const MonSQLize = require('../../../dist/cjs/index.cjs');

describe('review model mutation, population and extension contracts', () => {
    const bootstrap = createMemoryServerBootstrap();
    const runtimes = new Set<any>();
    let uri: string;
    before(async () => { uri = (await bootstrap.setup()).uri; });
    afterEach(async () => {
        try { for (const runtime of runtimes) await runtime.close(); }
        finally { runtimes.clear(); MonSQLize.Model._clear(); }
    });
    after(async () => { await bootstrap.teardown(); });
    const connect = async (databaseName: string) => {
        const runtime = new MonSQLize({ type: 'mongodb', databaseName, config: { uri, options: { monitorCommands: true } } });
        runtimes.add(runtime); await runtime.connect(); return runtime;
    };

    it('invalidates both Collection and soft-delete Model aggregate descriptors for all visibility modes', async () => {
        MonSQLize.Model.define('items', { schema: {}, options: { softDelete: true, autoIndex: false } });
        const runtime = await connect('repair_model_aggregate_visibility');
        const collection = runtime.collection('items'), model = runtime.model('items'), raw = collection.raw();
        const pipeline = [{ $sort: { _id: 1 } }, { $project: { _id: 0, score: MonSQLize.expr('score+1') } }];
        for (const visibility of [{}, { withDeleted: true }, { onlyDeleted: true }]) {
            await raw.deleteMany({}); await runtime.getCache().clear();
            await raw.insertMany([{ _id: 1, score: 1, deletedAt: null }, { _id: 2, score: 2, deletedAt: new Date(1) }]);
            await model.aggregate(pipeline, { ...visibility, cache: 10000 });
            await collection.aggregate(pipeline, { ...visibility, cache: 10000 });
            await runtime.getCache().set('unrelated-control', 1, 10000);
            const options = Object.freeze({ withDeleted: true, cache: Object.freeze({ invalidate: Object.freeze([
                Object.freeze({ operation: 'aggregate', pipeline, options: Object.freeze({ ...visibility }) }),
            ]) }) });
            await model.updateMany({}, { $set: { score: 9 } }, options);
            const expected = visibility.withDeleted ? [{ score: 10 }, { score: 10 }] : [{ score: 10 }];
            assert.deepEqual(await model.aggregate(pipeline, { ...visibility, cache: 10000 }), expected);
            assert.deepEqual(await collection.aggregate(pipeline, { ...visibility, cache: 10000 }), [{ score: 10 }, { score: 10 }]);
            assert.equal(await runtime.getCache().get('unrelated-control'), 1);
        }
    });

    it('keeps explicit invalidation controls and aligns soft-delete, restore, hooks and aggregate writes', async () => {
        let inject = false;
        const pipeline = [{ $project: { _id: 0, score: 1 } }];
        const control = { cache: { invalidate: [{ operation: 'aggregate', pipeline }] } };
        MonSQLize.Model.define('items', { schema: {}, options: { softDelete: true, autoIndex: false },
            hooks: () => ({ update: { before(_context: unknown, filter: unknown, update: unknown, options: unknown) {
                return inject ? [filter, update, control] : [filter, update, options];
            } } }),
        });
        const runtime = await connect('repair_model_aggregate_writes');
        const model = runtime.model('items'), collection = runtime.collection('items'), raw = collection.raw();
        await raw.deleteMany({}); await raw.insertOne({ _id: 1, score: 1, deletedAt: null });
        assert.deepEqual(await model.aggregate(pipeline, { cache: 10000 }), [{ score: 1 }]);
        for (const options of [undefined, { cache: { invalidate: false } }, { cache: { invalidate: [] } }]) {
            await model.updateOne({ _id: 1 }, { $set: { score: 2 } }, options);
            assert.deepEqual(await model.aggregate(pipeline, { cache: 10000 }), [{ score: 1 }]);
        }
        inject = true; await model.updateOne({ _id: 1 }, { $set: { score: 3 } }); inject = false;
        assert.deepEqual(await model.aggregate(pipeline, { cache: 10000 }), [{ score: 3 }]);
        await model.deleteOne({ _id: 1 }, control); assert.deepEqual(await model.aggregate(pipeline, { cache: 10000 }), []);
        await model.restore({ _id: 1 }, control); assert.deepEqual(await model.aggregate(pipeline, { cache: 10000 }), [{ score: 3 }]);
        await model.aggregate([{ $set: { score: 4 } }, { $merge: 'items' }], control);
        assert.deepEqual(await model.aggregate(pipeline, { cache: 10000 }), [{ score: 4 }]);
        const target = runtime.collection('visibility_output');
        await target.aggregate(pipeline, { cache: 10000 }); await target.find({}, { cache: 10000 });
        await model.aggregate([], { out: 'visibility_output', ...control });
        assert.deepEqual(await target.aggregate(pipeline, { cache: 10000 }), [{ score: 4 }]);
        assert.deepEqual(await target.find({}, { cache: 10000 }), []);
    });

    it('matches uppercase converted relation keys without changing binary string matching or parent array order', async () => {
        const first = 'ABCDEFABCDEFABCDEFABCDEF', second = 'FEDCBAFEDCBAFEDCBAFEDCBA';
        for (const conversion of [false, { enabled: true, excludeFields: ['key'] }, { enabled: true, excludeFields: ['owner', 'key'] }]) {
            MonSQLize.Model._clear();
            MonSQLize.Model.define('parents', { schema: {}, options: { autoIndex: false }, relations: {
                children: { from: 'children', localField: 'key', foreignField: 'owner' },
            } });
            const runtime = new MonSQLize({ type: 'mongodb', databaseName: 'repair_uppercase_relations', autoConvertObjectId: conversion, config: { uri } });
            runtimes.add(runtime); await runtime.connect();
            const parents = runtime.collection('parents').raw(), children = runtime.collection('children').raw();
            await parents.deleteMany({}); await children.deleteMany({});
            await parents.insertMany([{ _id: 1, key: [first, second] }, { _id: 2, key: new ObjectId(first) }]);
            await children.insertMany([{ owner: new ObjectId(second), n: 2 }, { owner: new ObjectId(first), n: 1 }, { owner: first, n: 3 }]);
            const rows = await runtime.model('parents').find({}, { sort: { _id: 1 } }).populate({ path: 'children', select: ['n'] });
            const enabled = typeof conversion === 'object' && !conversion.excludeFields.includes('owner');
            assert.deepEqual(rows[0].children.map((row: any) => row.n), enabled ? [1, 2] : [3]);
            assert.deepEqual(rows[1].children.map((row: any) => row.n), [1]);
            assert.ok(rows.every((row: any) => row.children.every((child: any) => !('owner' in child))));
            await parents.insertMany([{ _id: 3, key: [first, first] }, { _id: 4, key: [first, first.toLowerCase()] }]);
            const repeated = await runtime.model('parents').find({ _id: { $in: [3, 4] } }, { sort: { _id: 1 } }).populate('children');
            assert.deepEqual(repeated.map((row: any) => row.children.map((child: any) => child.n)), enabled ? [[1], [1]] : [[3], [3]]);
        }
    });

    it('uses native collation equality for unsorted string relations in the selected database', async () => {
        const targetDb = 'repair_populate_collation_target';
        MonSQLize.Model.define('children', { schema: {}, connection: { database: targetDb }, options: { autoIndex: false } });
        MonSQLize.Model.define('parents', { schema: {}, options: { autoIndex: false },
            relations: { children: { from: 'children', localField: 'key', foreignField: 'owner' },
                binary: { from: 'binary_children', localField: 'key', foreignField: 'owner' } },
        });
        const runtime = await connect('repair_populate_collation_source');
        const client = runtime._adapter.db.client;
        const db = client.db(targetDb), source = runtime._adapter.db;
        if (!(await db.listCollections({ name: 'children' }).toArray()).length) {
            await db.createCollection('children', { collation: { locale: 'en', strength: 2 } });
        }
        await db.collection('children').deleteMany({}); await source.collection('parents').deleteMany({});
        await source.collection('binary_children').deleteMany({});
        await db.collection('children').insertMany([{ owner: 'a', n: 1 }, { owner: 'B', n: 2 }]);
        await source.collection('binary_children').insertMany([{ owner: 'A', n: 3 }, { owner: 'b', n: 4 }]);
        await source.collection('parents').insertMany([{ key: 'A' }, { key: 'b' }, { key: ['A', 'b'] }]);
        const commands: any[] = [];
        client.on('commandStarted', (event: any) => commands.push(event));
        const rows = await runtime.model('parents').find({}).populate('children');
        assert.deepEqual(rows.map((row: any) => row.children.map((child: any) => child.n)), [[1], [2], [1, 2]]);
        const metadata = commands.filter((event) => event.commandName === 'listCollections' && event.command.$db === targetDb);
        assert.equal(metadata.length, 1);
        assert.equal(commands.filter((event) => event.commandName === 'find' && event.command.find === 'children').length, 3);
        commands.length = 0;
        const binary = await runtime.model('parents').find({}).populate('binary');
        assert.deepEqual(binary.map((row: any) => row.binary.map((child: any) => child.n)), [[3], [4], [3, 4]]);
        assert.equal(commands.filter((event) => event.commandName === 'find' && event.command.find === 'binary_children').length, 1);
        const scoped = runtime.scopedCollection;
        for (const behavior of ['missing', 'throw']) {
            runtime.scopedCollection = function (...args: any[]) {
                const collection = scoped.apply(this, args);
                if (args[0] === 'children') collection[Symbol.for('monsqlize.internal.model-collection-collation.v1')]
                    = behavior === 'missing' ? undefined : async () => { throw new Error('catalog unavailable'); };
                return collection;
            };
            try {
                const fallback = await runtime.model('parents').find({}).populate('children');
                assert.deepEqual(fallback.map((row: any) => row.children.map((child: any) => child.n)), [[1], [2], [1, 2]]);
            } finally { runtime.scopedCollection = scoped; }
        }
    });

    it('matches colliding relation key types with native MongoDB before lossy grouping', async () => {
        MonSQLize.Model.define('parents', { schema: {}, options: { autoIndex: false },
            relations: { children: { from: 'children', localField: 'key', foreignField: 'owner' } } });
        const id = new ObjectId();
        const pairs: unknown[][] = [[1, '1'], [true, 'true'], [new Date(123), new Date(123).toISOString()],
            [id, id.toHexString()], [{ n: 1 }, { n: 2 }]];
        for (const mode of [{ label: 'disabled', options: false, convertHex: false }, { label: 'enabled', options: true, convertHex: true },
            { label: 'excluded', options: { enabled: true, excludeFields: ['owner'] }, convertHex: false }]) {
            const runtime = new MonSQLize({ type: 'mongodb', databaseName: `repair_typed_relations_${mode.label}`,
                autoConvertObjectId: mode.options, config: { uri, options: { monitorCommands: true } } });
            runtimes.add(runtime); await runtime.connect();
            const db = runtime._adapter.db, events: any[] = [];
            db.client.on('commandStarted', (event: any) => events.push(event));
            for (const pair of pairs) for (const values of [pair, [...pair].reverse()]) {
                await db.collection('parents').deleteMany({}); await db.collection('children').deleteMany({});
                await db.collection('children').insertMany(values.map((owner, index) => ({ owner, index })));
                await db.collection('parents').insertMany([{ order: 0, key: values[0] }, { order: 1, key: values[1] }, { order: 2, key: values }]);
                events.length = 0;
                const rows = await runtime.model('parents').find({}, { sort: { order: 1 } }).populate({ path: 'children', select: ['index'] });
                assert.equal(events.filter((event) => event.commandName === 'find' && event.command.find === 'children').length, 3);
                assert.equal(events.filter((event) => event.commandName === 'listCollections').length, 0);
                for (const row of rows) {
                    const rawKeys = Array.isArray(row.key) ? row.key : [row.key];
                    const queryKeys = rawKeys.map((key: unknown) => mode.convertHex && typeof key === 'string' && /^[a-f\d]{24}$/i.test(key) ? new ObjectId(key) : key);
                    const expected = await db.collection('children').find({ owner: { $in: queryKeys } }).toArray();
                    assert.deepEqual(row.children.map((child: any) => child.index).sort(), expected.map((child: any) => child.index).sort());
                    assert.ok(row.children.every((child: any) => !Object.prototype.hasOwnProperty.call(child, 'owner')));
                    assert.ok(row.children.every((child: any) => !Object.prototype.hasOwnProperty.call(child, '_id')));
                }
            }
            await db.collection('parents').deleteMany({}); await db.collection('children').deleteMany({});
            const ids = [new ObjectId(), new ObjectId()];
            await db.collection('parents').insertMany(ids.map((key) => ({ key: key.toHexString() })));
            await db.collection('children').insertMany(ids.map((owner) => ({ owner })));
            events.length = 0;
            const binary = await runtime.model('parents').find({}).populate('children');
            assert.deepEqual(binary.map((row: any) => row.children.length), mode.convertHex ? [1, 1] : [0, 0]);
            assert.equal(events.filter((event) => event.commandName === 'find' && event.command.find === 'children').length, 1);
            assert.equal(events.filter((event) => event.commandName === 'listCollections').length, 1);
            await runtime.close(); runtimes.delete(runtime);
        }
    });

    it('retains collation metadata routing through a pool and an ESM accessor used by CJS Model', async () => {
        const ESM = await import(pathToFileURL(path.join(process.cwd(), 'dist/esm/index.mjs')).href);
        const targetDb = 'repair_populate_pool_target';
        MonSQLize.Model.define('children', { schema: {}, connection: { database: targetDb, pool: 'analytics' }, options: { autoIndex: false } });
        MonSQLize.Model.define('parents', { schema: {}, options: { autoIndex: false },
            relations: { children: { from: 'children', localField: 'key', foreignField: 'owner' } } });
        const options = { type: 'mongodb', databaseName: 'repair_populate_pool_source', config: { uri },
            pools: [{ name: 'analytics', uri, role: 'analytics', options: { monitorCommands: true } }, { name: 'primary', uri, role: 'primary' }],
        };
        const cjs = new MonSQLize(options), esm = new ESM.default(options);
        runtimes.add(cjs); runtimes.add(esm); await cjs.connect(); await esm.connect();
        const related = esm.pool('analytics').use(targetDb).collection('children');
        const db = related.raw().client.db(targetDb);
        if (!(await db.listCollections({ name: 'children' }).toArray()).length) {
            await db.createCollection('children', { collation: { locale: 'en', strength: 2 } });
        }
        await db.collection('children').deleteMany({}); await db.collection('children').insertOne({ owner: 'a' });
        await cjs.collection('parents').deleteMany({}); await cjs.collection('parents').insertOne({ key: 'A' });
        const scoped = cjs.scopedCollection;
        const metadata: any[] = [];
        related.raw().client.on('commandStarted', (event: any) => { if (event.commandName === 'listCollections') metadata.push(event); });
        cjs.scopedCollection = function (name: string, scope: any) {
            if (name === 'children') { assert.equal(scope.pool, 'analytics'); assert.equal(scope.database, targetDb); return related; }
            return scoped.call(this, name, scope);
        };
        try {
            const [row] = await cjs.model('parents').find({}).populate('children');
            assert.equal(row.children.length, 1); assert.equal(row.children[0].owner, 'a');
            assert.equal(related.getNamespace().pool, 'analytics');
            assert.equal(metadata.length, 1); assert.equal(metadata[0].command.$db, targetDb);
        } finally { cjs.scopedCollection = scoped; }
    });

    it('uses native null, BSON, array and collection-collation ordering for sorted population', async () => {
        MonSQLize.Model.define('parents', { schema: {}, options: { autoIndex: false },
            relations: { children: { from: 'children', localField: 'childIds', foreignField: '_id' } },
        });
        const runtime = await connect('repair_populate_contracts');
        const db = runtime._adapter.db;
        const existing = await db.listCollections({ name: 'children' }).toArray();
        if (!existing.length) await db.createCollection('children', { collation: { locale: 'en', strength: 2 } });
        const children = db.collection('children'), parents = db.collection('parents');
        await children.deleteMany({}); await parents.deleteMany({});
        const ranks: unknown[] = [undefined, null, 1, 'Z', 'a', ['b', 'a'], new Date(1), false];
        const docs = Array.from({ length: 206 }, (_, index) => ({ _id: new ObjectId(), name: `child-${index}`,
            ...(ranks[index % ranks.length] === undefined ? {} : { rank: ranks[index % ranks.length] }),
        }));
        await children.insertMany(docs);
        await parents.insertMany([0, 1, 2].map((index) => ({ parent: index, childIds: docs.slice(index, 205 + index).map((doc) => doc._id) })));
        const commands: any[] = [], catalog: any[] = [];
        runtime._adapter.db.client.on('commandStarted', (event: any) => { if (event.commandName === 'find' && event.command.find === 'children') commands.push(event); });
        runtime._adapter.db.client.on('commandStarted', (event: any) => { if (event.commandName === 'listCollections') catalog.push(event); });
        for (const direction of [1, -1]) {
            commands.length = 0;
            const populated = await runtime.model('parents').find({}, { sort: { parent: 1 } })
                .populate({ path: 'children', sort: { rank: direction, _id: 1 } });
            assert.equal(commands.length, 3);
            for (const parent of populated) {
                const expected = await children.find({ _id: { $in: parent.childIds } }).sort({ rank: direction as 1 | -1, _id: 1 }).toArray();
                assert.deepEqual(parent.children.map((row: any) => String(row._id)), expected.map((row: any) => String(row._id)));
            }
        }
        commands.length = 0;
        const unsorted = await runtime.model('parents').find({}).populate('children');
        assert.equal(commands.length, 2);
        assert.equal(catalog.length, 0);
        for (const parent of unsorted) assert.deepEqual(parent.children.map((row: any) => String(row._id)), parent.childIds.map(String));
        const limited = await runtime.model('parents').findOne({ parent: 0 })
            .populate({ path: 'children', sort: { rank: 1, _id: 1 }, skip: 1, limit: 2, select: ['name'] });
        const expected = await children.find({ _id: { $in: limited.childIds } }).sort({ rank: 1, _id: 1 }).skip(1).limit(2).toArray();
        assert.deepEqual(limited.children.map((row: any) => row.name), expected.map((row: any) => row.name));
    });

    it('updates soft-delete timestamps once across four primitives and protected delete', async () => {
        let before = 0, after = 0, updateHooks = 0;
        MonSQLize.Model.define('items', { schema: {}, options: { autoIndex: false, softDelete: true,
            timestamps: { createdAt: 'created', updatedAt: 'changed' }, version: { field: '__v' } },
            hooks: () => ({ delete: { before() { before++; }, after() { after++; } }, update: { before() { updateHooks++; } } }),
        });
        const runtime = await connect('repair_soft_delete_contracts');
        const raw = runtime._adapter.db.collection('items'), model = runtime.model('items');
        await raw.deleteMany({});
        for (const method of ['deleteOne', 'deleteMany', 'findOneAndDelete', 'deleteBatch', 'deleteOneWithRelations']) {
            const _id = new ObjectId(); await raw.insertOne({ _id, created: new Date(1), changed: new Date(1), __v: 0 });
            const previous = { before, after };
            await model[method]({ _id });
            const row = await raw.findOne({ _id });
            assert.ok(row.deletedAt instanceof Date); assert.ok(row.changed instanceof Date);
            assert.equal(row.changed.getTime(), row.deletedAt.getTime());
            assert.equal(row.created.getTime(), 1); assert.ok(row.changed.getTime() > 1);
            assert.equal(row.__v, 1); assert.equal(before - previous.before, 1); assert.equal(after - previous.after, 1);
            const changed = row.changed.getTime(); await model[method]({ _id });
            assert.equal((await raw.findOne({ _id })).changed.getTime(), changed);
        }
        assert.equal(updateHooks, 0);
    });

    it('respects disabled update timestamps and boolean deletion markers', async () => {
        MonSQLize.Model.define('items', { schema: {}, options: { autoIndex: false,
            timestamps: { createdAt: false, updatedAt: false }, softDelete: { field: 'removed', type: 'boolean' } },
        });
        const runtime = await connect('repair_disabled_timestamps');
        const raw = runtime._adapter.db.collection('items'); await raw.deleteMany({});
        const { insertedId } = await raw.insertOne({ removed: false, updatedAt: new Date(1) });
        await runtime.model('items').deleteOne({ _id: insertedId });
        const row = await raw.findOne({ _id: insertedId });
        assert.equal(row.removed, true); assert.equal(row.updatedAt.getTime(), 1);
    });

    it('rejects different captured factories after block, catch, loop and class shadows end', async () => {
        const makers = [
            ...['\r', '\n', '\u2028', '\u2029', '\r\n'].flatMap((lt) => [
                (value: string) => new Function('captured', 'return () => {// comment' + lt + 'return {type:"string",pattern:captured};}')(value),
                (value: string) => new Function('async', 'return () => {const result=async/*' + lt + '*/function local(){} return {type:"string",pattern:result};}')(value),
                (value: string) => new Function('captured', 'return () => ({type:"string",pattern:`${(()=>{// comment' + lt + 'return captured;})()}`})')(value),
            ]),
            (Load: string) => ({ functionLoad() { return { type: 'string', const: Load }; } }).functionLoad,
            (get: string) => () => ({ type: 'string', const: get }),
            (set: string) => () => ({ type: 'string', const: set }),
            (of: string) => () => ({ type: 'string', const: of }),
            (async: string) => () => ({ type: 'string', const: async }),
            (value: string) => { const load = () => value; return ({ factory({ pattern = load() } = {}) { return { type: 'string', pattern }; } }).factory; },
            (value: string) => { const load = () => value; return function factory({ pattern = load() } = {}) { return { type: 'string', pattern }; }; },
            (value: string) => { const load = () => value; return () => { function factory({ pattern = load() } = {}) { return pattern; } return { type: 'string', pattern: factory() }; }; },
            ...[
                'return function factory({pattern=load()}={}) {const load=()=>"local";void load;return {type:"string",pattern};};',
                'return ({pattern=load()}={}) => {const load=()=>"local";void load;return {type:"string",pattern};};',
                'return ({factory({pattern=load()}={}) {const load=()=>"local";void load;return {type:"string",pattern};}}).factory;',
                'return function factory({pattern=load()}={}) {var load=()=>"local";void load;return {type:"string",pattern};};',
                'return function factory({pattern=load()}={}) {function load(){return "local";}void load;return {type:"string",pattern};};',
                'return () => {function factory({pattern=load()}={}) {const load=()=>"local";void load;return pattern;}return {type:"string",pattern:factory()};};',
                'return () => {const factory=({pattern=load()}={})=>{const load=()=>"local";void load;return pattern;};return {type:"string",pattern:factory()};};',
                'return () => {const tools={factory({pattern=load()}={}) {const load=()=>"local";void load;return pattern;}};return {type:"string",pattern:tools.factory()};};',
                'return () => {class Tools {factory({pattern=load()}={}) {const load=()=>"local";void load;return pattern;}}return {type:"string",pattern:new Tools().factory()};};',
                'return function factory({pattern=`${load()}`}={}) {const load=()=>"local";void load;return {type:"string",pattern};};',
                'return function factory(){ tag`${load()}`\n {}\n var text; function tag(strings,value){ text=value; } return {type:"string",pattern:text}; };',
            ].map((source) => (value: string) => new Function('load', source)(() => value)),
            (factory: string) => ({ factory: () => ({ type: 'string', const: factory }) }).factory,
            (factory: string) => ({ factory() { return { type: 'string', const: factory }; } }).factory,
            (factory: string) => ({ factory() { const apply = () => factory; return { type: 'string', const: apply() }; } }).factory,
            (factory: string) => ({ factory() { const held = factory; const apply = () => held; return { type: 'string', const: apply() }; } }).factory,
            (pattern: string) => () => ({ type: 'string', const: pattern }),
            (pattern: string) => () => { const f = function pattern() { return 1; }; void f; return { type: 'string', pattern }; },
            (pattern: string) => () => { { function pattern() { return 1; } void pattern; } return { type: 'string', pattern }; },
            (pattern: string) => () => { { const pattern = 'local'; void pattern; } return { type: 'string', pattern }; },
            (pattern: string) => () => { try { throw 1; } catch (pattern) { void pattern; } return { type: 'string', pattern }; },
            (pattern: string) => () => { for (const pattern of []) { void pattern; } return { type: 'string', pattern }; },
            (pattern: string) => () => { { class pattern {} void pattern; } return { type: 'string', pattern }; },
        ];
        for (const [index, make] of makers.entries()) {
            const shared = createRuntime();
            const extension = (pattern: string) => ({ type: 'customType', literal: `review-${index}`, factoryName: `reviewFactory${index}`,
                schema: { type: 'string' }, factory: make(pattern) });
            const runtime = (pattern: string) => new MonSQLize({ type: 'mongodb', databaseName: 'repair_schema_scopes',
                config: { uri: 'mongodb://127.0.0.1:1', options: { serverSelectionTimeoutMS: 50 } },
                schemaDsl: { runtime: shared, extensions: [extension(pattern)] },
            });
            const first = runtime('^first$'), second = runtime('^second$');
            try {
                await assert.rejects(() => first.connect(), /Failed to connect to MongoDB database/);
                await assert.rejects(() => second.connect(), /Extension (?:literal|factory) .+ already exists|factory already exists|Cannot register namespace factory/);
            } finally { await first.close().catch(() => {}); await second.close().catch(() => {}); shared.dispose(); }
        }
    });

    it('permits stable ASI and Unicode factories on a shared runtime without losing expression closures', async () => {
        const sources = [
            ...['\r', '\n', '\u2028', '\u2029', '\r\n'].flatMap((lt) => [
                'function factory(){const pattern="stable";// comment' + lt + 'return {type:"string",pattern};}',
                'function factory(){const a="stable"/*' + lt + '*/const pattern=a;return {type:"string",pattern};}',
                'function factory(){const pattern=`first' + lt + 'second`;return {type:"string",pattern};}',
                'function factory(){const local="stable";return {type:"string",pattern:`a' + lt + '${(()=>`${local}`)()}' + lt + 'b`};}',
                'function factory(){const pattern=`stable`' + lt + 'function local(){return pattern;}return {type:"string",pattern:local()};}',
            ]),
            ...['\u2028', '\u2029'].flatMap((lt) => [
                'function factory(){const pattern="a' + lt + 'b";return {type:"string",pattern};}',
                'function factory(pattern="a' + lt + 'b"){return {type:"string",pattern};}',
            ]),
            'function factory(load = () => "stable", { pattern = load() } = {}) { return { type: "string", pattern }; }',
            'function factory(a = 1, b = a) { return { type: "number", const: b }; }',
            'function factory(a = factory) { void a; return { type: "string" }; }',
            'function factory() { const pattern = "stable"; return { type: "string", pattern: `${pattern}` }; }',
            'function factory() { { const pattern = "stable"; return { type: "string", pattern: `${pattern}` }; } }',
            '() => { const pattern = "stable"; return { type: "string", pattern: `${(() => `${pattern}`)()}` }; }',
            'function factory() { const pattern = `stable`\n function local() { return pattern; } return { type: "string", pattern: local() }; }',
            '() => { const target = [0], index = 0; for (target[index] of [1]) {} return { type: "number", const: target[0] }; }',
            'function factory({ pattern = (() => "^stable$")() } = {}) { return { type: "string", pattern }; }',
            '() => { const tools = { get value() { return 1; }, set value(v) { void v; }, async run() { return 1; } }; for (const x of [1]) { void x; } void tools; return { type: "string" }; }',
            '({ factory: () => { const tools = { async*factory() { yield 1; } }; void tools; return { type: "string" }; } }).factory',
            '({ factory() { const apply = value => value; return { type: "string", const: apply("stable") }; } }).factory',
            'function factory() { const again = factory; void again; return { type: "string" }; }',
            '() => { const pattern = "^stable$"\n function local() { return pattern; }\n return { type: "string", pattern: local() }; }',
            '() => { let n = 0; n++\n function local() { return n; }\n return { type: "string", minLength: local() }; }',
            '() => { let n = 2; n--\n function local() { return n; }\n return { type: "string", minLength: local() }; }',
            '() => { const async = 1; const f = async\n function local() { return f; }\n return { type: "string", minLength: local() }; }',
            '() => { const 𐐀 = 1; return { type: "string", minLength: 𐐀 }; }',
        ];
        for (const [index, source] of sources.entries()) {
            const shared = createRuntime();
            const make = () => new MonSQLize({ type: 'mongodb', databaseName: 'repair_asi_schema_scopes', config: { uri },
                schemaDsl: { runtime: shared, extensions: [{ type: 'customType', literal: `review-asi-${index}`,
                    factoryName: `reviewAsiFactory${index}`, schema: { type: 'string' }, factory: new Function(`return (${source})`)() }] },
            });
            const first = make(), second = make();
            try { await first.connect(); await second.connect(); }
            finally { await first.close(); await second.close(); shared.dispose(); }
        }
    });

    it('permits independently created stable block-local factories on a shared runtime', async () => {
        const shared = createRuntime();
        const makeFactory = () => () => { { const pattern = '^stable$'; function local() { return pattern; } return { type: 'string', pattern: local() }; } };
        const make = () => new MonSQLize({ type: 'mongodb', databaseName: 'repair_stable_schema_scopes', config: { uri },
            schemaDsl: { runtime: shared, extensions: [{ type: 'customType', literal: 'review-stable',
                factoryName: 'reviewStableFactory', schema: { type: 'string' }, factory: makeFactory() }] },
        });
        const first = make(), second = make();
        try { await first.connect(); await second.connect(); }
        finally { await first.close(); await second.close(); shared.dispose(); }
    });
});
