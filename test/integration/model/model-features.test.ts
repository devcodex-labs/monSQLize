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
