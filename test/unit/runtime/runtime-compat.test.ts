import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MongoCollectionAccessor } from '../../../src/adapters/mongodb/common/collection-accessor';
import { ObjectId } from 'mongodb';

const MonSQLize = require('../../../dist/cjs/index.cjs');

function resolved<T>(value?: T): Promise<T | undefined> {
    return Promise.resolve(value);
}

function createLoggerCapture() {
    const warnings: unknown[][] = [];
    return {
        warnings,
        logger: {
            debug: () => {},
            info: () => {},
            warn: (...args: unknown[]) => warnings.push(args),
            error: () => {},
        },
    };
}

function createMockCollection(name: string) {
    return {
        getNamespace() {
            return { iid: `mock:${name}`, type: 'mongodb', db: 'compat_db', collection: name };
        },
        raw() { return {}; },
        find: () => resolved([]),
        findOne: () => resolved(null),
        findOneById: () => resolved(null),
        findByIds: () => resolved([]),
        findPage: () => resolved({ items: [], pageInfo: { hasNext: false, hasPrev: false, startCursor: null, endCursor: null } }),
        findAndCount: () => resolved({ data: [], total: 0 }),
        count: () => resolved(0),
        insertOne: () => resolved({ acknowledged: true, insertedId: 1 }),
        insertMany: () => resolved({ acknowledged: true, insertedCount: 0, insertedIds: {} }),
        updateOne: () => resolved({ acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null }),
        updateMany: () => resolved({ acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null }),
        replaceOne: () => resolved({ acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null }),
        findOneAndUpdate: () => resolved(null),
        findOneAndReplace: () => resolved(null),
        findOneAndDelete: () => resolved(null),
        upsertOne: () => resolved({ acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: 1 }),
        deleteOne: () => resolved({ acknowledged: true, deletedCount: 0 }),
        deleteMany: () => resolved({ acknowledged: true, deletedCount: 0 }),
        incrementOne: () => resolved({ acknowledged: true, matchedCount: 0, modifiedCount: 0, value: null }),
        insertBatch: () => resolved({ acknowledged: true, totalCount: 0, insertedCount: 0, batchCount: 0, insertedIds: {}, errors: [] }),
        updateBatch: () => resolved({ acknowledged: true, totalCount: 0, matchedCount: 0, modifiedCount: 0, upsertedCount: 0, batchCount: 0, errors: [], retries: [] }),
        deleteBatch: () => resolved({ acknowledged: true, totalCount: 0, deletedCount: 0, batchCount: 0, errors: [], retries: [] }),
        createIndex: () => resolved('idx'),
        createIndexes: () => resolved(['idx']),
        listIndexes: () => resolved([]),
        dropIndex: () => resolved({}),
        dropIndexes: () => resolved({}),
        distinct: () => resolved([]),
        aggregate: () => resolved([]),
        watch: () => ({ close: () => resolved() }),
    };
}

describe('P6 runtime compat mock path', () => {
    beforeEach(() => {
        MonSQLize.Model._clear();
    });

    it('db() rejects an inconsistent connected state without a client', () => {
        const runtime = new MonSQLize({ type: 'mongodb', databaseName: 'compat_db' });

        runtime._connected = true;
        runtime._client = null;

        assert.throws(
            () => runtime.db(),
            (err: unknown) => {
                assert.ok(err instanceof Error);
                assert.equal((err as NodeJS.ErrnoException).code, 'NOT_CONNECTED');
                return true;
            },
        );
    });

    it('validates runtime numeric limits during construction', () => {
        assert.doesNotThrow(() => new MonSQLize({
            type: 'mongodb',
            databaseName: 'compat_db',
            maxTimeMS: 100,
            findLimit: 50,
            findMaxLimit: 100,
            findMaxSkip: 500,
            findPageMaxLimit: 25,
        }));
        assert.throws(() => new MonSQLize({ type: 'mongodb', databaseName: 'compat_db', maxTimeMS: 0 }), /maxTimeMS/);
        assert.throws(() => new MonSQLize({ type: 'mongodb', databaseName: 'compat_db', findLimit: 0 }), /findLimit/);
        assert.throws(() => new MonSQLize({ type: 'mongodb', databaseName: 'compat_db', findMaxLimit: 0 }), /findMaxLimit/);
        assert.throws(() => new MonSQLize({ type: 'mongodb', databaseName: 'compat_db', findMaxSkip: -1 }), /findMaxSkip/);
        assert.throws(() => new MonSQLize({ type: 'mongodb', databaseName: 'compat_db', findMaxLimit: 100 }), /findMaxLimit/);
        assert.throws(() => new MonSQLize({ type: 'mongodb', databaseName: 'compat_db', findLimit: 20, findMaxLimit: 10 }), /findMaxLimit/);
        assert.throws(() => new MonSQLize({ type: 'mongodb', databaseName: 'compat_db', findPageMaxLimit: 0 }), /findPageMaxLimit/);
    });

    it('warns when transaction.distributedLock is configured because v2 transaction cache locks are process-local', () => {
        const { warnings, logger } = createLoggerCapture();

        assert.doesNotThrow(() => new MonSQLize({
            type: 'mongodb',
            databaseName: 'compat_db',
            logger,
            transaction: {
                distributedLock: {
                    redis: {},
                },
            },
        }));

        assert.ok(warnings.some(([message]) => String(message).includes('transaction.distributedLock')));
        assert.ok(warnings.some(([message]) => String(message).includes('process-local')));
    });

    it('keeps disabled transaction.distributedLock compatibility config silent', () => {
        const { warnings, logger } = createLoggerCapture();

        assert.doesNotThrow(() => new MonSQLize({
            type: 'mongodb',
            databaseName: 'compat_db',
            logger,
            transaction: {
                distributedLock: {
                    enabled: false,
                    redis: {},
                },
            },
        }));

        assert.equal(warnings.some(([message]) => String(message).includes('transaction.distributedLock')), false);
    });

    it('accepts a custom cache without a lock-manager hook', () => {
        const values = new Map<string, unknown>();
        const cache = {
            get: (key: string) => values.get(key),
            set: (key: string, value: unknown) => { values.set(key, value); },
            del: (key: string) => { values.delete(key); },
        };

        const runtime = new MonSQLize({
            type: 'mongodb',
            databaseName: 'compat_db',
            cache,
        });

        assert.strictEqual(runtime.getCache(), cache);
    });

    it('normalizes memory cache boolean and numeric options', () => {
        const runtime = new MonSQLize({
            type: 'mongodb',
            databaseName: 'compat_db',
            cache: {
                memory: {
                    enabled: true,
                    enableStats: true,
                    enableTags: false,
                    ttl: 100,
                    cleanupInterval: 1_000,
                },
            },
        });

        assert.equal(runtime.getCache().constructor.name, 'MultiLevelCache');
    });

    it('normalizes vext-style memory and Redis cache config with an injected Redis-like instance', () => {
        const remoteValues = new Map<string, string>();
        const redisLike = {
            get: async (key: string) => remoteValues.get(key) ?? null,
            set: async (key: string, value: string) => { remoteValues.set(key, value); return 'OK'; },
            del: async (key: string) => { remoteValues.delete(key); return 1; },
            keys: async () => [...remoteValues.keys()],
            scan: async () => ['0', [...remoteValues.keys()]],
        };

        const runtime = new MonSQLize({
            type: 'mongodb',
            databaseName: 'compat_db',
            cache: {
                memory: {},
                redis: {
                    enabled: true,
                    instance: redisLike,
                    prefix: 'compat:',
                    ttl: 1_000,
                },
            },
        });

        assert.equal(runtime.getCache().constructor.name, 'MultiLevelCache');
    });

    it('routes multi-level cache invalidation through the runtime distributed publish proxy', async () => {
        const runtime = new MonSQLize({
            type: 'mongodb',
            databaseName: 'compat_db',
            cache: {
                memory: {},
                distributed: {
                    redis: {},
                    channel: 'monsqlize:test:runtime-proxy',
                },
            },
        });

        const cache = runtime.getCache();
        assert.equal(cache.constructor.name, 'MultiLevelCache');
        await cache.delPattern('users:*');
    });

    it('pool management helpers fail clearly when pools are not configured', () => {
        const runtime = new MonSQLize({ type: 'mongodb', databaseName: 'compat_db' });

        assert.throws(
            () => runtime.getPoolNames(),
            /pool\(\) requires options\.pools configuration/i,
        );
    });

    it('collection() delegates through the dbInstance compatibility path before connect', () => {
        const runtime = new MonSQLize({ type: 'mongodb', databaseName: 'compat_db' });
        const collection = createMockCollection('users');

        Object.defineProperty(runtime, 'dbInstance', {
            configurable: true,
            value: {
                collection(collectionName: string) {
                    return collectionName === 'users' ? collection : createMockCollection(collectionName);
                },
                db() {
                    return {};
                },
            },
        });

        assert.strictEqual(runtime.collection('users'), collection);
    });

    it('scoped collection with database fails clearly when dbInstance is unavailable', () => {
        const runtime = new MonSQLize({ type: 'mongodb', databaseName: 'compat_db' });

        assert.throws(
            () => runtime._resolveModelCollection('users', { database: 'tenant_db' }),
            /NOT_CONNECTED|not connected/i,
        );
    });

    it('close() logs cleanup and invokes owned cache lifecycle', async () => {
        const warnings: unknown[][] = [];
        let cacheClosed = false;
        const runtime = new MonSQLize({
            type: 'mongodb',
            databaseName: 'compat_db',
            logger: {
                debug: () => {},
                info: () => {},
                warn: (...args: unknown[]) => warnings.push(args),
                error: () => {},
            },
        });

        runtime._syncManager = { stop: () => Promise.reject(new Error('sync cleanup failed')) };
        runtime._sshTunnel = { close: () => Promise.reject(new Error('ssh close failed')) };
        Object.defineProperty(runtime, '_cacheClose', {
            configurable: true,
            value: async () => {
                cacheClosed = true;
            },
        });

        await runtime.close();

        assert.equal(cacheClosed, true);
        assert.ok(warnings.some(([message]) => String(message).includes('cleanup error during close')));
        assert.ok(warnings.some(([message]) => String(message).includes('Error closing SSH tunnel')));
    });

    it('close() does not destroy externally supplied nested cache instances', async () => {
        const externalMemory = new MonSQLize.MemoryCache({ maxEntries: 1 });
        let externalDestroyed = false;
        const originalDestroy = externalMemory.destroy.bind(externalMemory);
        externalMemory.destroy = () => {
            externalDestroyed = true;
            originalDestroy();
        };
        const externalRemote = {
            get: async () => undefined,
            set: async () => undefined,
            del: async () => false,
            exists: async () => false,
            has: async () => false,
            getMany: async () => ({}),
            setMany: async () => true,
            delMany: async () => 0,
            delPattern: async () => 0,
            keys: async () => [],
            destroy: () => {
                throw new Error('external remote must not be destroyed');
            },
        };
        const runtime = new MonSQLize({
            type: 'mongodb',
            databaseName: 'compat_db',
            cache: {
                multiLevel: true,
                local: externalMemory,
                remote: externalRemote,
            },
        });

        await runtime.close();

        assert.equal(externalDestroyed, false);
        originalDestroy();
    });

    it('throws MODEL_NOT_DEFINED for pre-connect model lookup misses', () => {
        const runtime = new MonSQLize({ type: 'mongodb', databaseName: 'compat_db' });

        Object.defineProperty(runtime, 'dbInstance', {
            configurable: true,
            value: {
                collection(collectionName: string) {
                    return createMockCollection(collectionName);
                },
                db() {
                    return {};
                },
            },
        });

        assert.throws(() => runtime.model('missing'), /MODEL_NOT_DEFINED|not defined/);
        assert.throws(() => runtime.scopedModel('missing'), /MODEL_NOT_DEFINED|not defined/);
    });

    it('creates and caches model instances through the dbInstance compatibility path before connect', () => {
        const runtime = new MonSQLize({ type: 'mongodb', databaseName: 'compat_db' });
        const defaultCollection = createMockCollection('users');
        const scopedCollection = createMockCollection('audit_users');

        Object.defineProperty(runtime, 'dbInstance', {
            configurable: true,
            value: {
                collection(collectionName: string) {
                    return collectionName === 'audit_users' ? scopedCollection : defaultCollection;
                },
                db() {
                    return {};
                },
            },
        });
        Object.defineProperty(runtime, 'databaseName', {
            configurable: true,
            value: 'compat_db',
        });

        runtime._resolveModelCollection = (collectionName: string) => {
            return collectionName === 'audit_users' ? scopedCollection : defaultCollection;
        };

        MonSQLize.Model.define('users', { schema: {} });
        MonSQLize.Model.define('auditUsers', {
            collection: 'audit_users',
            schema: {},
            connection: { database: 'audit_db' },
        });

        const first = runtime.model('users');
        const second = runtime.model('users');
        assert.strictEqual(first, second);
        assert.equal(first.collectionName, 'users');
        assert.equal(first.dbName, 'compat_db');

        const scoped = runtime.model('auditUsers');
        assert.equal(scoped.collectionName, 'audit_users');
        assert.equal(scoped.dbName, 'compat_db');

        const scopedViaApi = runtime.scopedModel('users');
        assert.equal(scopedViaApi.collectionName, 'users');
        assert.equal(scopedViaApi.getNamespace().collection, 'users');
    });

    it('refreshes a cached pre-connect model instance after redefine', () => {
        const runtime = new MonSQLize({ type: 'mongodb', databaseName: 'compat_db' });

        Object.defineProperty(runtime, 'dbInstance', {
            configurable: true,
            value: {
                collection(collectionName: string) {
                    return createMockCollection(collectionName);
                },
                db() {
                    return {};
                },
            },
        });
        Object.defineProperty(runtime, 'databaseName', {
            configurable: true,
            value: 'compat_db',
        });

        MonSQLize.Model.define('users', { schema: {} });
        const first = runtime.model('users');

        MonSQLize.Model.redefine('users', {
            collection: 'users_archive',
            schema: {},
        });
        const second = runtime.model('users');

        assert.notStrictEqual(first, second);
        assert.equal(second.collectionName, 'users_archive');
    });

    it('supports the v1 find(query, projection, options) overload at runtime', async () => {
        let capturedQuery: unknown;
        let capturedOptions: Record<string, unknown> | undefined;

        const nativeCollection = {
            namespace: 'compat_db.users',
            find(query: unknown, options?: Record<string, unknown>) {
                capturedQuery = query;
                capturedOptions = options;
                return {
                    toArray: () => resolved([{ name: 'Ada' }]),
                };
            },
        };

        const accessor = new MongoCollectionAccessor(
            'compat_db',
            'users',
            nativeCollection as never,
        );

        const result = await accessor.find(
            { active: true },
            ['name', 'email'],
            { limit: 2 },
        );

        assert.deepEqual(result, [{ name: 'Ada' }]);
        assert.deepEqual(capturedQuery, { active: true });
        assert.deepEqual({ limit: capturedOptions?.limit, projection: capturedOptions?.projection }, {
            limit: 2,
            projection: { name: 1, email: 1 },
        });
        assert.equal(capturedOptions?.serializeFunctions, false);
        assert.equal(capturedOptions?.ignoreUndefined, false);
    });

    it('awaits async query-cache get/set across read helpers', async () => {
        const id = new ObjectId();
        const values = new Map<string, unknown>();
        const queryCache = {
            get: async (key: string) => values.get(key),
            set: async (key: string, value: unknown) => {
                values.set(key, value);
                return true;
            },
            delPattern: async () => 0,
        };
        const calls: Record<string, number> = {
            find: 0,
            findOne: 0,
            countDocuments: 0,
            distinct: 0,
        };
        const nativeCollection = {
            namespace: 'compat_db.users',
            dbName: 'compat_db',
            collectionName: 'users',
            find() {
                calls.find += 1;
                return {
                    toArray: () => resolved([{ _id: id, name: 'Ada' }]),
                };
            },
            findOne() {
                calls.findOne += 1;
                return resolved({ _id: id, name: 'Ada' });
            },
            countDocuments() {
                calls.countDocuments += 1;
                return resolved(1);
            },
            distinct() {
                calls.distinct += 1;
                return resolved(['Ada']);
            },
        };
        const accessor = new MongoCollectionAccessor(
            'compat_db',
            'users',
            nativeCollection as never,
            { queryCache, defaults: { findLimit: 500 } },
        );
        const cacheOptions = { cache: 1000 } as never;

        assert.deepEqual(await accessor.find({ active: true }, { cache: 1000, limit: 1 }), [{ _id: id, name: 'Ada' }]);
        assert.deepEqual(await accessor.find({ active: true }, { cache: 1000, limit: 1 }), [{ _id: id, name: 'Ada' }]);
        assert.deepEqual(await accessor.findOne({ active: true }, cacheOptions), { _id: id, name: 'Ada' });
        assert.deepEqual(await accessor.findOne({ active: true }, cacheOptions), { _id: id, name: 'Ada' });
        assert.deepEqual(await accessor.findOneById(id, cacheOptions), { _id: id, name: 'Ada' });
        assert.deepEqual(await accessor.findOneById(id, cacheOptions), { _id: id, name: 'Ada' });
        assert.deepEqual(await accessor.findByIds([id], cacheOptions), [{ _id: id, name: 'Ada' }]);
        assert.deepEqual(await accessor.findByIds([id], cacheOptions), [{ _id: id, name: 'Ada' }]);
        assert.equal(await accessor.count({ active: true }, { cache: 1000 } as never), 1);
        assert.equal(await accessor.count({ active: true }, { cache: 1000 } as never), 1);
        assert.deepEqual(await accessor.distinct('name', { active: true }, { cache: 1000 } as never), ['Ada']);
        assert.deepEqual(await accessor.distinct('name', { active: true }, { cache: 1000 } as never), ['Ada']);
        assert.deepEqual((await accessor.findPage({ query: { active: true }, limit: 1, cache: 1000, sort: { _id: 1 } })).items, [{ _id: id, name: 'Ada' }]);
        assert.deepEqual((await accessor.findPage({ query: { active: true }, limit: 1, cache: 1000, sort: { _id: 1 } })).items, [{ _id: id, name: 'Ada' }]);

        assert.equal(calls.find, 3, 'find, findByIds, and findPage should each hit the database once');
        assert.equal(calls.findOne, 2, 'findOne and findOneById should each hit the database once');
        assert.equal(calls.countDocuments, 1);
        assert.equal(calls.distinct, 1);
    });

    it('passes CountQueue AbortSignal into count driver options', async () => {
        const controller = new AbortController();
        let capturedOptions: Record<string, unknown> | undefined;
        const nativeCollection = {
            namespace: 'compat_db.users',
            countDocuments(_query: unknown, options?: Record<string, unknown>) {
                capturedOptions = options;
                return resolved(7);
            },
        };
        const accessor = new MongoCollectionAccessor(
            'compat_db',
            'users',
            nativeCollection as never,
            {
                defaults: {
                    countQueue: {
                        execute: <T>(fn: (signal?: AbortSignal) => Promise<T>) => fn(controller.signal),
                    },
                },
            },
        );

        assert.equal(await accessor.count({ active: true } as never), 7);
        assert.equal(capturedOptions?.signal, controller.signal);
    });

    it('records write cache invalidation on the active transaction session', async () => {
        const recorded: string[] = [];
        let deletedPatterns = 0;
        const session = {
            inTransaction: () => true,
            __monSQLizeTransaction: {
                recordInvalidation: async (pattern: string) => {
                    recorded.push(pattern);
                },
            },
        };
        const nativeCollection = {
            namespace: 'compat_db.users',
            insertOne: async () => ({ acknowledged: true, insertedId: new ObjectId() }),
        };
        const accessor = new MongoCollectionAccessor(
            'compat_db',
            'users',
            nativeCollection as never,
            {
                defaults: { namespace: { instanceId: 'tenant-a' } },
                queryCache: {
                    get: () => undefined,
                    set: () => true,
                    delPattern: () => {
                        deletedPatterns += 1;
                        return 1;
                    },
                },
            },
        );

        await accessor.insertOne({ name: 'Ada' } as never, { session, cache: { autoInvalidate: true } } as never);

        assert.equal(deletedPatterns, 0);
        assert.ok(recorded.includes('find:tenant-a:compat_db.users:*'));
        assert.ok(recorded.includes('find:compat_db.users:*'));
    });

    it('does not invalidate query cache by default on writes', async () => {
        let insertCalls = 0;
        let deletedPatterns = 0;
        const nativeCollection = {
            namespace: 'compat_db.users',
            insertOne: async () => {
                insertCalls += 1;
                return { acknowledged: true, insertedId: new ObjectId() };
            },
        };
        const accessor = new MongoCollectionAccessor(
            'compat_db',
            'users',
            nativeCollection as never,
            {
                queryCache: {
                    get: () => undefined,
                    set: () => true,
                    delPattern: () => {
                        deletedPatterns += 1;
                        return 1;
                    },
                },
            },
        );

        await accessor.insertOne({ name: 'Ada' } as never);

        assert.equal(insertCalls, 1);
        assert.equal(deletedPatterns, 0);
    });

    it('marks transaction writes even when cache invalidation is not configured', async () => {
        let writeOperationCount = 0;
        const recorded: string[] = [];
        const session = {
            inTransaction: () => true,
            __monSQLizeTransaction: {
                recordInvalidation: async (pattern: string) => {
                    recorded.push(pattern);
                },
                recordWriteOperation: () => {
                    writeOperationCount += 1;
                },
            },
        };
        const nativeCollection = {
            namespace: 'compat_db.users',
            insertOne: async () => ({ acknowledged: true, insertedId: new ObjectId() }),
        };
        const accessor = new MongoCollectionAccessor(
            'compat_db',
            'users',
            nativeCollection as never,
            {
                queryCache: {
                    get: () => undefined,
                    set: () => true,
                    delPattern: () => 1,
                },
            },
        );

        await accessor.insertOne({ name: 'Ada' } as never, { session } as never);

        assert.equal(writeOperationCount, 1);
        assert.deepEqual(recorded, []);
    });

    it('does not fail a completed write when transaction write-stat recording fails', async () => {
        let insertCalls = 0;
        const session = {
            inTransaction: () => true,
            __monSQLizeTransaction: {
                recordInvalidation: async () => {},
                recordWriteOperation: () => {
                    throw new Error('stats unavailable');
                },
            },
        };
        const nativeCollection = {
            namespace: 'compat_db.users',
            insertOne: async () => {
                insertCalls += 1;
                return { acknowledged: true, insertedId: new ObjectId() };
            },
        };
        const accessor = new MongoCollectionAccessor(
            'compat_db',
            'users',
            nativeCollection as never,
            {
                queryCache: {
                    get: () => undefined,
                    set: () => true,
                    delPattern: () => 1,
                },
            },
        );

        const result = await accessor.insertOne({ name: 'Ada' } as never, { session } as never);

        assert.equal(insertCalls, 1);
        assert.equal(result.acknowledged, true);
    });

    it('lets per-write empty invalidation override global autoInvalidate', async () => {
        let deletedPatterns = 0;
        const nativeCollection = {
            namespace: 'compat_db.users',
            insertOne: async () => ({ acknowledged: true, insertedId: new ObjectId() }),
        };
        const accessor = new MongoCollectionAccessor(
            'compat_db',
            'users',
            nativeCollection as never,
            {
                defaults: { cacheAutoInvalidate: true },
                queryCache: {
                    get: () => undefined,
                    set: () => true,
                    delPattern: () => {
                        deletedPatterns += 1;
                        return 1;
                    },
                },
            },
        );

        await accessor.insertOne({ name: 'Ada' } as never, { cache: { invalidate: [] } } as never);
        await accessor.insertOne({ name: 'Grace' } as never, { cache: { invalidate: false } } as never);

        assert.equal(deletedPatterns, 0);

        await accessor.insertOne({ name: 'Linus' } as never, { cache: { invalidate: true } } as never);

        assert.ok(deletedPatterns > 0);
    });

    it('supports exact cache invalidation descriptors without broad delPattern', async () => {
        const values = new Map<string, unknown>();
        const deletedKeys: string[] = [];
        let delCalls = 0;
        let delPatternCalls = 0;
        const queryCache = {
            get: async (key: string) => values.get(key),
            set: async (key: string, value: unknown) => {
                values.set(key, value);
                return true;
            },
            del: async (key: string) => {
                delCalls += 1;
                deletedKeys.push(key);
                values.delete(key);
                return true;
            },
            delPattern: async () => {
                delPatternCalls += 1;
                return 0;
            },
        };
        let currentValue = 1;
        let findOneCalls = 0;
        const nativeCollection = {
            namespace: 'compat_db.users',
            findOne: async () => {
                findOneCalls += 1;
                return { value: currentValue };
            },
            updateOne: async () => {
                currentValue = 2;
                return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedId: null };
            },
        };
        const accessor = new MongoCollectionAccessor(
            'compat_db',
            'users',
            nativeCollection as never,
            { queryCache },
        );

        assert.deepEqual(await accessor.findOne({ active: true } as never, { cache: 1000 } as never), { value: 1 });
        assert.equal(findOneCalls, 1);

        await accessor.updateOne(
            { active: true } as never,
            { $set: { active: false } } as never,
            {
                cache: {
                    invalidate: [{
                        operation: 'findOne',
                        query: { active: true },
                        options: { cache: 1000 },
                    }],
                },
            } as never,
        );

        assert.ok(deletedKeys.some((key) => key.startsWith('findOne:compat_db.users:')));
        assert.equal(delCalls, deletedKeys.length);
        assert.equal(delPatternCalls, 0);
        assert.deepEqual(await accessor.findOne({ active: true } as never, { cache: 1000 } as never), { value: 2 });
        assert.equal(findOneCalls, 2);
    });
});
