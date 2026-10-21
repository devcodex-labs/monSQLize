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
