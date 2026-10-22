import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryServerBootstrap } from '../../bootstrap/memory-server';

const MonSQLize = require('../../../dist/cjs/index.cjs');

describe('P3-C model features', () => {
    const bootstrap = createMemoryServerBootstrap();
    const activeRuntimes = new Set<{ close(): Promise<void> }>();
    let uri = '';

    before(async () => {
        const context = await bootstrap.setup();
        uri = context.uri;
    });

    after(async () => {
        MonSQLize.Model._clear();
        await bootstrap.teardown();
    });

    beforeEach(() => {
        MonSQLize.Model._clear();
    });

    afterEach(async () => {
        const runtimes = [...activeRuntimes];
        activeRuntimes.clear();
        await Promise.all(runtimes.map((runtime) => runtime.close()));
    });

    it('AR04 protects the hook-selected target and preserves soft/force delete hook contracts', async (t) => {
        let targetId: unknown;
        let finalSession: any;
        let beforeCalls = 0;
        let afterCalls = 0;
        MonSQLize.Model.define('ar04_targets', {
            schema: {},
            options: { softDelete: true, autoIndex: false },
            hooks: () => ({
                delete: {
                    before(_context: unknown, _filter: unknown, options: any) {
                        beforeCalls++;
                        return [{ _id: targetId }, { ...options, session: finalSession, _forceDelete: true }];
                    },
                    after(_context: unknown, result: any) {
                        afterCalls++;
                        assert.equal(result.matchedCount, 1);
                        assert.equal('usage' in result, false);
                        return { ...result, hookResult: true };
                    },
                },
            }),
        });
        MonSQLize.Model.define('ar04_refs', {
            schema: {},
            options: { autoIndex: false },
            relations: { target: { from: 'ar04_targets', localField: 'targetId', foreignField: '_id' } },
        });
        const runtime = new MonSQLize({ type: 'mongodb', databaseName: 'ar04_models', config: { uri, options: { monitorCommands: true } } });
        activeRuntimes.add(runtime);
        await runtime.connect();
        const client = runtime._adapter.db.client;
        const originalSession = client.startSession();
        finalSession = client.startSession();
        t.after(async () => { await originalSession.endSession(); await finalSession.endSession(); });
        const protectedCommands: any[] = [];
        let checking = false;
        client.on('commandStarted', (event: any) => {
            if (checking && ['find', 'aggregate', 'update'].includes(event.commandName)) protectedCommands.push(event.command);
        });
        const model = runtime.model('ar04_targets');
        const rawTargets = runtime.collection('ar04_targets');
        const refs = runtime.collection('ar04_refs');
        const a = await model.insertOne({ name: 'a' });
        const b = await model.insertOne({ name: 'b' });
        targetId = b.insertedId;
        await refs.insertOne({ targetId });
        checking = true;
        await assert.rejects(
            () => model.deleteOneWithRelations({ _id: a.insertedId }, { session: originalSession }),
            { code: 'RELATION_IN_USE' },
        );
        checking = false;
        assert.equal((await rawTargets.findOne({ _id: a.insertedId })).deletedAt, undefined);
        assert.equal((await rawTargets.findOne({ _id: b.insertedId })).deletedAt, undefined);
        assert.equal(beforeCalls, 1);
        assert.equal(afterCalls, 0);

        await refs.deleteMany({});
        checking = true;
        const deleted = await model.deleteOneWithRelations({ _id: a.insertedId }, { session: originalSession });
        checking = false;
        assert.ok(protectedCommands.length >= 3);
        assert.ok(protectedCommands.some(command => command.update === 'ar04_targets'));
        for (const command of protectedCommands) assert.deepEqual(command.lsid, finalSession.id);
        assert.equal(deleted.result.hookResult, true);
        assert.equal(deleted.usage.used, false);
        assert.ok((await rawTargets.findOne({ _id: b.insertedId })).deletedAt instanceof Date);
        assert.equal((await rawTargets.findOne({ _id: a.insertedId })).deletedAt, undefined);
        assert.equal(beforeCalls, 2);
        assert.equal(afterCalls, 1);

        await model.forceDeleteWithRelations({ _id: a.insertedId });
        assert.equal(await rawTargets.findOne({ _id: a.insertedId }), null);
        assert.equal(beforeCalls, 2);
        assert.equal(afterCalls, 1);
    });

    it('AR03 filters before computed projection and isolates model visibility caches', async () => {
        MonSQLize.Model.define('ar03_projection', { schema: {}, options: { softDelete: { field: 'removed', type: 'boolean' }, autoIndex: false } });
        const runtime = new MonSQLize({ type: 'mongodb', databaseName: 'ar03_models', config: { uri, options: { monitorCommands: true } } });
        activeRuntimes.add(runtime);
        await runtime.connect();
        const model = runtime.model('ar03_projection');
        const raw = runtime.collection('ar03_projection');
        const a = await raw.insertOne({ name: 'live', removed: false, values: [1, 2, 3] });
        const b = await raw.insertOne({ name: 'gone', removed: true, values: [4, 5, 6] });
        const ids = [b.insertedId, a.insertedId, a.insertedId];
        const projection = Object.freeze({ _id: 1, label: { $literal: 'computed' }, removed: { $literal: false } });
        const options = Object.freeze({ projection, cache: 10000, preserveOrder: true });
        let calls = 0;
        const projections: unknown[] = [];
        const client = runtime._adapter.db.client;
        const onCommand = (event: any) => {
            if (event.commandName !== 'find' || event.command.find !== 'ar03_projection') return;
            calls++;
            projections.push(event.command.projection);
        };
        client.on('commandStarted', onCommand);
        try {
            assert.equal((await raw.findByIds(ids, options)).length, 2);
            const visible = await model.findByIds(ids, options);
            assert.equal(visible.length, 1);
            assert.equal(String(visible[0]._id), String(a.insertedId));
            const deleted = await model.findByIds(ids, { ...options, onlyDeleted: true });
            assert.equal(deleted.length, 1);
            assert.equal(String(deleted[0]._id), String(b.insertedId));
            assert.equal(deleted[0].removed, false, 'computed marker is preserved');
            assert.equal((await model.findByIds(ids, { ...options, withDeleted: true })).length, 2);
            assert.equal(calls, 3, 'raw/all, visible, and deleted use separate single-query entries');
            await model.findByIds(ids, options);
            assert.equal(calls, 3);
            await raw.updateOne({ _id: a.insertedId }, { $set: { touched: true } }, {
                cache: { invalidate: [{ operation: 'findByIds', ids, options }] },
            });
            await model.findByIds(ids, options);
            assert.equal(calls, 4, 'exact invalidation also clears model variants');
            const session = runtime._adapter.db.client.startSession();
            try {
                await model.findByIds(ids, { ...options, session });
                await model.findByIds(ids, { ...options, session });
                assert.equal(calls, 6);
            } finally { await session.endSession(); }
        } finally { client.off('commandStarted', onCommand); }
        for (const actualProjection of projections) assert.deepEqual(actualProjection, projection);
        const sliced = await model.findByIds(ids, { project: Object.freeze({ values: { $slice: 1 }, removed: 0 }) });
        assert.equal(sliced.length, 1);
        assert.deepEqual(sliced[0].values, [1]);
        assert.equal(sliced[0].removed, undefined);
        for (const projectionOptions of [{ project: ['name'] }, { projection: ['name'] }]) {
            const cacheOptions = { ...projectionOptions, cache: 10000 };
            await model.findByIds(ids, cacheOptions);
            const nextName = 'fresh-' + Object.keys(projectionOptions)[0];
            await raw.updateOne({ _id: a.insertedId }, { $set: { name: nextName } }, {
                cache: { invalidate: [{ operation: 'findByIds', ids, options: cacheOptions }] },
            });
            assert.equal((await model.findByIds(ids, cacheOptions))[0].name, nextName);
        }
        assert.deepEqual(await model.findByIds([]), []);
        await assert.rejects(async () => await model.findByIds(['invalid']), { code: 'INVALID_ARGUMENT' });
        await assert.rejects(async () => await model.findByIds(ids, { onlyDeleted: 'invalid' }), { code: 'INVALID_ARGUMENT' });
    });

    it('AR03 uses final before options and preserves after replacement with a nested marker', async () => {
        MonSQLize.Model.define('ar03_hooks', {
            schema: {}, options: { softDelete: { field: 'meta.removed', type: 'timestamp' }, autoIndex: false },
            hooks: () => ({ find: {
                before(_context: unknown, ids: unknown) { return [ids, { onlyDeleted: true, projection: { name: 1 } }]; },
                after(_context: unknown, rows: any[]) {
                    assert.deepEqual(rows.map(row => row.name), ['gone']);
                    return [{ name: 'replacement', meta: { removed: null } }];
                },
            } }),
        });
        const runtime = new MonSQLize({ type: 'mongodb', databaseName: 'ar03_models', config: { uri } });
        activeRuntimes.add(runtime);
        await runtime.connect();
        const raw = runtime.collection('ar03_hooks');
        const a = await raw.insertOne({ name: 'live' });
        const b = await raw.insertOne({ name: 'gone', meta: { removed: new Date() } });
        const rows = await runtime.model('ar03_hooks').findByIds([a.insertedId, b.insertedId], Object.freeze({ withDeleted: true }));
        assert.equal(rows.length, 1);
        assert.equal(rows[0].name, 'replacement');
        assert.equal(rows[0].meta.removed, null);
    });

    it('RF13 isolates invalid page descriptors and preserves successful ordinary and aggregate writes', async () => {
        const name = 'rf13_bad_descriptor';
        MonSQLize.Model.define(name, { schema: {}, options: { softDelete: true, autoIndex: false } });
        const runtime = new MonSQLize({ type: 'mongodb', databaseName: name, config: { uri } });
        activeRuntimes.add(runtime); await runtime.connect();
        const model = runtime.model(name), raw = runtime.collection(name).raw();
        await raw.deleteMany({}); await raw.insertOne({ n: 1, label: 'old', deletedAt: null });
        const good = { query: { n: 1 }, sort: { n: 1 }, limit: 1, totals: false };
        const unused = { ...good, query: { n: 2 } };
        const cache = runtime.getCache(), get = cache.get;
        let hits = 0;
        cache.get = function (...args: any[]) {
            const result = get.apply(this, args);
            const record = (value: any) => { if (value !== null && value !== undefined) hits++; return value; };
            return result && typeof result.then === 'function' ? result.then(record) : record(result);
        };
        try {
            for (const operation of ['updateOne', 'aggregate']) {
                await model.findPage({ ...good, cache: 60000 });
                await model.findPage({ ...unused, cache: 60000 });
                const invalidate = [{ operation: 'findPage', options: { projection: { toBSON() { throw new Error('Bad descriptor'); } } } },
                    { operation: 'findPage', options: good }];
                if (operation === 'updateOne') {
                    const result = await model.updateOne({ n: 1 }, { $set: { label: operation } }, { cache: { invalidate } });
                    assert.equal(result.modifiedCount, 1);
                } else await model.aggregate([{ $set: { label: operation } },
                    { $merge: { into: name, on: '_id', whenMatched: 'merge', whenNotMatched: 'discard' } }], { cache: { invalidate } });
                assert.equal((await raw.findOne({ n: 1 })).label, operation);
                const hot = await model.findPage({ ...good, cache: 60000 });
                const cold = await model.findPage({ ...good, cache: 0 });
                assert.equal(hot.items[0].label, operation); assert.deepEqual(hot.items, cold.items);
                let before = hits; await model.findPage({ ...good, cache: 60000 }); assert.ok(hits > before);
                before = hits; await model.findPage({ ...unused, cache: 60000 }); assert.ok(hits > before);
            }
        } finally { cache.get = get; }
    });

    it('RF13 invalidates exact Model pages on soft delete and restore with custom markers', async () => {
        for (const type of ['timestamp', 'boolean']) {
            const name = 'rf13_pages_' + type;
            MonSQLize.Model.define(name, { schema: {}, options: { softDelete: { field: 'meta.removed', type }, autoIndex: false } });
            const runtime = new MonSQLize({ type: 'mongodb', databaseName: 'rf13_models', config: { uri, options: { monitorCommands: true } } });
            activeRuntimes.add(runtime); await runtime.connect();
            const model = runtime.model(name), raw = runtime.collection(name);
            const { insertedId } = await model.insertOne({ name: 'A' });
            const variants = [{}, { withDeleted: true }, { onlyDeleted: true }, { pipeline: [{ $match: { name: 'A' } }] },
                { query: { name: 'A', 'meta.removed': type === 'boolean' ? { $ne: true } : null } }];
            for (const variant of variants) {
                const page = { query: { name: 'A' }, sort: { _id: 1 }, limit: 10, cache: 10000, ...variant };
                const writeOptions = { cache: { invalidate: [{ operation: 'findPage', options: page }] } };
                for (const action of ['deleteOne', 'restore']) {
                    await runtime.getCache().clear();
                    const before = await model.findPage(page); await raw.findPage(page);
                    await model[action]({ _id: insertedId }, writeOptions);
                    const hot = await model.findPage(page), cold = await model.findPage({ ...page, cache: 0 });
                    const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
                    assert.deepEqual(plain(hot.items), plain(cold.items), `${type}/${action}/${JSON.stringify(variant)}`);
                    assert.notDeepEqual(plain(before.items), plain(cold.items), 'the mutation changes this visibility or marker');
                    const rawHot = await raw.findPage(page), rawCold = await raw.findPage({ ...page, cache: 0 });
                    assert.deepEqual(plain(rawHot.items), plain(rawCold.items), 'raw descriptor entry is invalidated too');
                }
            }
        }
    });

    it('B05 filters id-only soft-delete projections without exposing the marker', async () => {
        for (const type of ['timestamp', 'boolean']) {
            const name = 'b05_' + type;
            MonSQLize.Model.define(name, { schema: {}, options: { softDelete: { field: 'removed', type }, autoIndex: false } });
            const runtime = new MonSQLize({ type: 'mongodb', databaseName: 'b05_models', config: { uri } });
            activeRuntimes.add(runtime);
            await runtime.connect();
            const model = runtime.model(name);
            const first = await model.insertOne({ name: 'visible' });
            const second = await model.insertOne({ name: 'deleted' });
            await model.deleteOne({ _id: second.insertedId });
            for (const projection of [{ _id: 1 }, { _id: true }, ['_id']]) {
                const visible = await model.findByIds([first.insertedId, second.insertedId], { projection });
                assert.equal(visible.length, 1);
                assert.deepEqual(Object.keys(visible[0]), ['_id']);
                const deleted = await model.findByIds([first.insertedId, second.insertedId], { projection, onlyDeleted: true });
                assert.equal(deleted.length, 1);
                assert.equal(String(deleted[0]._id), String(second.insertedId));
                assert.equal(Object.prototype.hasOwnProperty.call(deleted[0], 'removed'), false);
                assert.equal((await model.findByIds([first.insertedId, second.insertedId], { projection, withDeleted: true })).length, 2);
            }
            const excluded = await model.findByIds([first.insertedId], { projection: { _id: 1, name: 0 } });
            assert.equal(excluded[0].name, undefined);
            assert.equal(excluded[0].removed, undefined);
            const markerExcluded = await model.findByIds([first.insertedId, second.insertedId], { projection: { _id: 1, removed: 0 } });
            assert.equal(markerExcluded.length, 1);
            assert.equal(markerExcluded[0].name, 'visible');
            assert.equal(markerExcluded[0].removed, undefined);
        }
    });

    it('B06 passes the public model and preserves mutation hook replacement and failure semantics', async () => {
        let model: any;
        let rejectBefore = false;
        let rejectAfter = false;
        let defaultCalls = 0;
        const contexts: Array<Record<string, unknown>> = [];
        MonSQLize.Model.define('b06_hooks', {
            schema: {},
            defaults: { sequence: () => ++defaultCalls },
            hooks: (instance: any) => {
                assert.strictEqual(instance, model);
                assert.equal(instance.getNamespace().collection, 'b06_hooks');
                assert.equal(typeof instance.findByIds, 'function');
                return {
                    update: {
                        before: (context: any, filter: unknown, _update: unknown, options: unknown) => {
                            context.shared = 'update';
                            return [filter, { $set: { updatedByHook: true } }, options];
                        },
                        after: (context: any, result: any) => {
                            assert.equal(context.shared, 'update');
                            return { ...result, updateReplaced: true };
                        },
                    },
                    insert: {
                        before: (context: any, document: any, options: unknown) => {
                            if (rejectBefore) throw new Error('before blocked');
                            context.shared = 'insert';
                            contexts.push(context);
                            return [{ ...document, changed: true }, options];
                        },
                        after: (context: any, result: any) => {
                            assert.strictEqual(context, contexts[contexts.length - 1]);
                            assert.equal(context.shared, 'insert');
                            if (rejectAfter) throw new Error('after ignored');
                            return { ...result, replaced: true };
                        },
                    },
                };
            },
        });
        const runtime = new MonSQLize({ type: 'mongodb', databaseName: 'b06_models', config: { uri } });
        activeRuntimes.add(runtime);
        await runtime.connect();
        model = runtime.model('b06_hooks');
        const inserted = await model.insertOne({ name: 'first' });
        assert.equal(inserted.replaced, true);
        assert.equal(defaultCalls, 1);
        assert.equal((await model.findOne({ _id: inserted.insertedId })).changed, true);
        const updated = await model.updateOne({ _id: inserted.insertedId }, { $set: { ignored: true } });
        assert.equal(updated.updateReplaced, true);
        const changed = await model.findOne({ _id: inserted.insertedId });
        assert.equal(changed.updatedByHook, true);
        assert.equal(changed.ignored, undefined);
        assert.equal(defaultCalls, 1);
        rejectBefore = true;
        await assert.rejects(model.insertOne({ name: 'blocked' }), /before blocked/);
        assert.equal(await model.count({ name: 'blocked' }), 0);
        rejectBefore = false;
        rejectAfter = true;
        const retained = await model.insertOne({ name: 'retained' });
        assert.equal(await model.count({ _id: retained.insertedId }), 1);
    });

    it('B06 preserves the shared standard hook context across canonical and alias names', async () => {
        let beforeContext: any;
        let afterContext: any;
        MonSQLize.Model.define('b06_standard', {
            schema: {},
            hooks: {
                beforeCreate: (context: any) => { beforeContext = context; context.audit = 'before'; },
                beforeInsert: (context: any) => { assert.strictEqual(context, beforeContext); assert.equal(context.audit, 'before'); },
                afterCreate: (context: any) => { afterContext = context; context.audit = 'after'; },
                afterInsert: (context: any) => { assert.strictEqual(context, afterContext); assert.equal(context.audit, 'after'); },
            },
        });
        const runtime = new MonSQLize({ type: 'mongodb', databaseName: 'b06_models', config: { uri } });
        activeRuntimes.add(runtime);
        await runtime.connect();
        const inserted = await runtime.model('b06_standard').insertOne({ value: 1 });
        assert.equal(await runtime.model('b06_standard').count({ _id: inserted.insertedId }), 1);
    });

    it('binds a registered descriptor through direct and scoped model accessors', async () => {
        const User = MonSQLize.defineModel('typed_descriptor_users', {
            schema: {
                email: 'email!',
                age: 'number?',
            },
        });

        const runtime = new MonSQLize({ type: 'mongodb', databaseName: 'p3c_typed_descriptor_models', config: { uri } });
        activeRuntimes.add(runtime);
        await runtime.connect();

        assert.throws(() => runtime.model(User), /MODEL_NOT_DEFINED|not defined/);
        MonSQLize.Model.define(User);
        const users = runtime.model(User);
        assert.ok(users instanceof MonSQLize.ModelInstance);
        const tenantUsers = runtime.use('typed_descriptor_tenant').model(User);
        assert.equal(users.collectionName, 'typed_descriptor_users');
        assert.equal(tenantUsers.dbName, 'typed_descriptor_tenant');

        await users.insertOne({ email: 'ada@example.com', age: 35 });
        const found = await users.findOne({ email: 'ada@example.com' });
        assert.equal(found?.email, 'ada@example.com');
        assert.equal(found?.age, 35);

    });

    it('restores model registry, instance cache, relations/virtuals/populate, and scoped routing', async () => {
        MonSQLize.Model.define('comments', {
            schema: {},
            methods: {
                summary(this: any) {
                    return `${this.body}`;
                },
            },
        });
        MonSQLize.Model.define('posts', {
            schema: {},
            defaults: { status: 'draft' },
            virtuals: {
                titleWithStatus: {
                    get(this: any) {
                        return `${this.title}:${this.status}`;
                    },
                },
            },
            relations: {
                comments: {
                    from: 'comments',
                    localField: '_id',
                    foreignField: 'postId',
                },
            },
        });
        MonSQLize.Model.define('users', {
            schema: {},
            methods: {
                greet(this: any) {
                    return `Hello ${this.firstName}`;
                },
            },
            virtuals: {
                displayName: {
                    get(this: any) {
                        return `${this.firstName} ${this.lastName}`.trim();
                    },
                },
            },
            relations: {
                posts: {
                    from: 'posts',
                    localField: '_id',
                    foreignField: 'authorId',
                },
            },
        });

        const runtime = new MonSQLize({ type: 'mongodb', databaseName: 'p3c_models', config: { uri } });
        activeRuntimes.add(runtime);
        await runtime.connect();

        const users = runtime.model('users');
        const usersAgain = runtime.model('users');
        const tenantUsers = runtime.use('tenant_reporting').model('users');
        assert.strictEqual(users, usersAgain);
        assert.notStrictEqual(users, tenantUsers);
        assert.equal(tenantUsers.dbName, 'tenant_reporting');
        assert.equal(tenantUsers.getNamespace().db, 'tenant_reporting');

        const createdUser = await users.insertOne({ firstName: 'Ada', lastName: 'Lovelace' });
        const adaId = createdUser.insertedId;

        const posts = runtime.model('posts');
        const comments = runtime.model('comments');
        const compiler = await posts.insertOne({ title: 'Compiler', authorId: adaId });
        const engine = await posts.insertOne({ title: 'Engine', authorId: adaId, status: 'published' });
        await comments.insertOne({ postId: compiler.insertedId, body: 'First comment' });
        await comments.insertOne({ postId: engine.insertedId, body: 'Second comment' });

        const populatedUser = await users.findOne({ _id: adaId }).populate({ path: 'posts', sort: { title: 1 }, populate: 'comments' });

        assert.equal(populatedUser.displayName, 'Ada Lovelace');
        assert.equal(populatedUser.greet(), 'Hello Ada');
        assert.equal(populatedUser.posts.length, 2);
        assert.equal(populatedUser.posts[0].title, 'Compiler');
        assert.equal(populatedUser.posts[0].titleWithStatus, 'Compiler:draft');
        assert.equal(populatedUser.posts[0].comments[0].summary(), 'First comment');
        assert.equal(populatedUser.posts[1].comments[0].body, 'Second comment');

        const byIds = await posts.findByIds([compiler.insertedId, engine.insertedId]).populate({ path: 'comments', select: ['body'] });
        assert.equal(byIds[0].comments[0].body.includes('comment'), true);
        assert.equal(Object.prototype.hasOwnProperty.call(byIds[0].comments[0], '_id'), false);

        assert.equal(typeof users.findOneById, 'function');
        const byId = await users.findOneById(adaId).populate('posts');
        assert.equal(byId.posts.length, 2);

        const counted = await users.findAndCount({ firstName: 'Ada' }).populate('posts');
        assert.equal(counted.total, 1);
        assert.equal(counted.data[0].posts.length, 2);

        const page = await users.findPage({ page: 1, limit: 10 }).populate('posts');
        assert.equal(page.items.length, 1);
        assert.equal(page.items[0].posts.length, 2);
        assert.equal(typeof page.pageInfo.endCursor, 'string');

        const doc = await users.findOne({ _id: adaId });
        doc.nickname = 'Countess';
        await doc.save();
        const reloaded = await users.findOneById(adaId);
        assert.equal(reloaded.nickname, 'Countess');
        const validateResult = await reloaded.validate();
        assert.equal(validateResult.valid, true);
        assert.deepEqual(validateResult.errors, []);

        MonSQLize.Model.redefine('users', {
            schema: {},
            virtuals: {
                displayName: {
                    get(this: any) {
                        return `${this.lastName}, ${this.firstName}`;
                    },
                },
            },
        });
        const refreshedUsers = runtime.model('users');
        assert.notStrictEqual(refreshedUsers, users);
        const refreshedDoc = await refreshedUsers.findOneById(adaId);
        assert.equal(refreshedDoc.displayName, 'Lovelace, Ada');

    });

    it('keeps model config initialization and v1-compatible injection stable', async () => {
        let beforeInsertCalls = 0;
        let afterInsertCalls = 0;

        MonSQLize.Model.define('accounts', {
            enums: {
                role: 'admin|user',
            },
            schema(this: any, dsl: any) {
                return dsl({
                    name: 'string!',
                    role: dsl(this.enums.role).default('user'),
                });
            },
            options: {
                timestamps: true,
                softDelete: {
                    enabled: true,
                    field: 'deletedAt',
                    type: 'timestamp',
                    ttl: 3600,
                },
                version: true,
            },
            hooks() {
                return {
                    insert: {
                        before(_ctx: unknown, payload: Record<string, unknown>) {
                            beforeInsertCalls += 1;
                            return { ...payload, hooked: true };
                        },
                        after() {
                            afterInsertCalls += 1;
                        },
                    },
                };
            },
            methods(instance: any) {
                return {
                    instance: {
                        isHooked(this: any) {
                            return this.hooked === true;
                        },
                    },
                    static: {
                        getCollectionName() {
                            return instance.collectionName;
                        },
                    },
                };
            },
        });

        const runtime = new MonSQLize({ type: 'mongodb', databaseName: 'p3c_model_wiring', config: { uri } });
        activeRuntimes.add(runtime);
        await runtime.connect();

        const accounts = runtime.model('accounts');
        assert.equal(typeof accounts.getCollectionName, 'function');
        assert.equal(accounts.getCollectionName(), 'accounts');
        assert.equal(accounts.softDeleteConfig?.field, 'deletedAt');
        assert.equal(Boolean(accounts.getEnums().role), true);

        const created = await accounts.insertOne({ name: 'Ada' });
        const stored = await accounts.findOneById(created.insertedId);

        assert.equal(beforeInsertCalls, 1);
        assert.equal(afterInsertCalls, 1);
        assert.equal(stored.hooked, true);
        assert.equal(stored.role, 'user');
        assert.equal(stored.version, 0);
        assert.equal(typeof stored.isHooked, 'function');
        assert.equal(stored.isHooked(), true);
        assert.equal(stored.createdAt instanceof Date, true);
        assert.equal(stored.updatedAt instanceof Date, true);

    });
});
