import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    countOnlyDeletedDocuments,
    countWithDeletedDocuments,
    findOneOnlyDeletedDocument,
    findOneWithDeletedDocument,
    findOnlyDeletedDocuments,
    findWithDeletedDocuments,
    forceDeleteDocument,
    forceDeleteManyDocuments,
    restoreManySoftDeletedDocuments,
    restoreSoftDeletedDocuments,
} from '../../../src/capabilities/model/model-soft-delete-helpers';
import {
    orchestrateModelDeleteMany,
    orchestrateModelDeleteOne,
    orchestrateModelFindOneAndReplace,
    orchestrateModelFindOneAndUpdate,
    orchestrateModelIncrementOne,
    orchestrateModelInsertBatch,
    orchestrateModelInsertMany,
    orchestrateModelInsertOne,
    orchestrateModelReplaceOne,
    orchestrateModelUpdateBatch,
    orchestrateModelUpdateMany,
    orchestrateModelUpdateOne,
    orchestrateModelUpsertOne,
    type ModelMutationContext,
} from '../../../src/capabilities/model/model-mutation-orchestrator';
import { HealthChecker } from '../../../src/capabilities/pool/pool-health-checker';
import { MemoryCache } from '../../../src/capabilities/cache';
import { CountQueue } from '../../../src/capabilities/count-queue';
import { Logger } from '../../../src/core/logger';
import { compileInnerExpression } from '../../../src/core/expression/expression-compiler';
import { createRuntimeAdapterBridge } from '../../../src/entry/runtime-admin-bridge';
import { normalizeRuntimeCache } from '../../../src/entry/runtime-cache-normalizer';
import { SSHTunnelSSH2, parseHostFromUri, parseMongoHostTokens, parsePortFromUri, rewriteMongoUriForSshTunnel } from '../../../src/capabilities/ssh';
import { ResumeTokenStore, ChangeStreamSyncManager, validateResumeTokenConfig, validateSyncConfig, validateTargetConfig } from '../../../src/capabilities/sync';
import { SlowQueryLogMemoryStorage, MongoDBSlowQueryLogStorage } from '../../../src/capabilities/slow-query-log/slow-query-log-storage';
import { encodeCursor, decodeCursor } from '../../../src/utils/cursor';
import { makePageResult } from '../../../src/utils/page-result';
import { validatePositiveInteger, validateRange } from '../../../src/utils/validation';
import {
    aggregateDocuments,
    countDocuments,
    createAggregateChain,
    createFindChain,
    distinctValues,
    explainDocuments,
    findAndCountDocuments,
    findDocuments,
    findOneDocument,
    streamDocuments,
    watchDocuments,
} from '../../../src/adapters/mongodb/queries';
import {
    buildAggregateDriverOptions,
    buildCollectionCacheNamespace,
    buildCursorFilter,
    buildEffectiveProjection,
    buildFindDriverOptions,
    decodeCursor as decodePageCursor,
    encodeCursor as encodePageCursor,
    getSortValues,
    normalizeIdentifier,
    normalizeCursorValue,
    normalizeQueryFilter,
    normalizeSortShape,
    parseRequiredObjectId,
    reverseSort,
    stableCacheKeyString,
} from '../../../src/adapters/mongodb/queries/query-helpers';
import { executeFindPage } from '../../../src/adapters/mongodb/queries/find-page';
import {
    deleteManyForAccessor,
    deleteOneForAccessor,
    findOneAndDeleteForAccessor,
    findOneAndReplaceForAccessor,
    findOneAndUpdateForAccessor,
    insertManyForAccessor,
    insertOneForAccessor,
    replaceOneForAccessor,
    updateManyForAccessor,
    updateOneForAccessor,
    upsertOneForAccessor,
} from '../../../src/adapters/mongodb/common/collection-accessor-write-helpers';
import {
    deleteBatchDocuments,
    insertBatchDocuments,
    updateBatchDocuments,
} from '../../../src/adapters/mongodb/writes/write-batch';
import {
    collModForAccessor,
    convertToCappedForAccessor,
    createCollectionForAccessor,
    createViewForAccessor,
    dropCollectionForAccessor,
    getValidatorForAccessor,
    indexStatsForAccessor,
    renameCollectionForAccessor,
    setValidationActionForAccessor,
    setValidationLevelForAccessor,
    setValidatorForAccessor,
    statsForAccessor,
} from '../../../src/adapters/mongodb/common/collection-accessor-management-helpers';

type Call = { method: string; args: unknown[] };

type FakeCollection = { calls: Call[] } & Record<
    'find' | 'findOne' | 'count' | 'updateOne' | 'updateMany' | 'deleteOne' | 'deleteMany' | 'insertOne' | 'insertMany' |
    'replaceOne' | 'findOneAndUpdate' | 'findOneAndDelete' | 'upsertOne' | 'incrementOne' | 'insertBatch' | 'updateBatch' |
    'findOneAndReplace',
    (...args: unknown[]) => Promise<unknown>
>;

function createCollection(): FakeCollection {
    const calls: Call[] = [];
    const record = (method: string, result: unknown) => async (...args: unknown[]) => {
        calls.push({ method, args });
        return result;
    };
    return {
        calls,
        find: record('find', [{ id: 1 }, { id: 2 }]),
        findOne: record('findOne', { id: 1 }),
        count: record('count', 2),
        updateOne: record('updateOne', { matchedCount: 1, modifiedCount: 1 }),
        updateMany: record('updateMany', { modifiedCount: 2 }),
        deleteOne: record('deleteOne', { deletedCount: 1 }),
        deleteMany: record('deleteMany', { deletedCount: 2 }),
        insertOne: record('insertOne', { acknowledged: true, insertedId: 'new-id' }),
        insertMany: record('insertMany', { insertedCount: 2 }),
        replaceOne: record('replaceOne', { matchedCount: 1, modifiedCount: 1 }),
        findOneAndUpdate: record('findOneAndUpdate', { id: 3 }),
        findOneAndDelete: record('findOneAndDelete', { id: 4 }),
        upsertOne: record('upsertOne', { upsertedCount: 1 }),
        incrementOne: record('incrementOne', { modifiedCount: 1 }),
        insertBatch: record('insertBatch', { insertedCount: 2 }),
        updateBatch: record('updateBatch', { modifiedCount: 2 }),
        findOneAndReplace: record('findOneAndReplace', { id: 5 }),
    };
}

function createMutationContext(overrides: Partial<ModelMutationContext<Record<string, unknown>>> = {}) {
    const collection = createCollection();
    const hookCalls: Array<{ hookName: string; payload: unknown }> = [];
    const now = new Date('2026-01-02T03:04:05.000Z');
    const context: ModelMutationContext<Record<string, unknown>> = {
        collectionName: 'users',
        collection: collection as never,
        extendedCollection: () => collection as never,
        applyDefaults: (document = {}) => ({ active: true, ...document }),
        nowDate: () => now,
        timestampsConfig: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
        softDeleteConfig: { enabled: true, field: 'deletedAt', type: 'date', ttl: null },
        versionConfig: { enabled: true, field: '__v', updateMany: 'counter' },
        validateEnabled: true,
        schemaCache: { validate: () => true },
        schemaValidateFn: () => ({ valid: true, errors: [] }),
        hooksFactory: null,
        runHook: async (hookName, payload) => {
            hookCalls.push({ hookName, payload });
        },
        ...overrides,
    };
    return { context, collection, hookCalls, now };
}

function createSoftDeleteContext(enabled = true) {
    const collection = createCollection();
    const populateCalls: unknown[] = [];
    const context = {
        collection,
        softDeleteConfig: enabled ? { enabled: true, field: 'deletedAt', type: 'date', ttl: null } : null,
        hydrateDocuments: (docs: Array<Record<string, unknown>>) => docs.map((doc) => ({ ...doc, hydrated: true })),
        hydrateDocument: (doc: Record<string, unknown> | null) => doc ? { ...doc, hydrated: true } : null,
        populateDocuments: async (docs: Array<Record<string, unknown>>, paths: unknown[]) => {
            populateCalls.push(paths);
            return docs.map((doc) => ({ ...doc, populated: paths.length }));
        },
        populateSingle: async (doc: Record<string, unknown> | null, paths: unknown[]) => {
            populateCalls.push(paths);
            return doc ? { ...doc, populated: paths.length } : null;
        },
    };
    return { context, collection, populateCalls };
}

describe('coverage core helpers', () => {
    it('covers soft-delete query, restore, and force-delete helpers', async () => {
        const { context, collection, populateCalls } = createSoftDeleteContext();

        assert.equal((await findWithDeletedDocuments(context as never, { role: 'admin' }).populate('team')).length, 2);
        assert.equal((await findOnlyDeletedDocuments(context as never, { role: 'admin' }).populate({ path: 'team' })).length, 2);
        assert.deepEqual(await findOneWithDeletedDocument(context as never, { id: 1 }), { id: 1, hydrated: true, populated: 0 });
        assert.deepEqual(await findOneOnlyDeletedDocument(context as never, { id: 1 }), { id: 1, hydrated: true, populated: 0 });
        assert.equal(await countWithDeletedDocuments(context as never, { role: 'admin' }), 2);
        assert.equal(await countOnlyDeletedDocuments(context as never, { role: 'admin' }), 2);
        assert.deepEqual(await restoreSoftDeletedDocuments(context as never, { id: 1 }), { matchedCount: 1, modifiedCount: 1 });
        assert.deepEqual(await restoreManySoftDeletedDocuments(context as never, { org: 'acme' }), { modifiedCount: 2 });
        assert.deepEqual(await forceDeleteDocument(context as never, { id: 1 }), { deletedCount: 1 });
        assert.deepEqual(await forceDeleteManyDocuments(context as never, { org: 'acme' }), { deletedCount: 2 });

        const restoreOneCall = collection.calls.find((call) => call.method === 'updateOne');
        assert.deepEqual(restoreOneCall?.args[0], { id: 1, deletedAt: { $ne: null } });
        assert.equal(populateCalls.length, 4);

        const disabled = createSoftDeleteContext(false);
        assert.deepEqual(await restoreSoftDeletedDocuments(disabled.context as never, { id: 1 }), { modifiedCount: 0 });
        assert.deepEqual(await restoreManySoftDeletedDocuments(disabled.context as never, { id: 1 }), { modifiedCount: 0 });
    });

    it('covers model mutation orchestration with standard hooks', async () => {
        const { context, collection, hookCalls, now } = createMutationContext();

        assert.deepEqual(await orchestrateModelInsertOne(context, { name: 'Ada' }), { acknowledged: true, insertedId: 'new-id' });
        assert.deepEqual(await orchestrateModelInsertMany(context, [{ name: 'Ada' }, { name: 'Lin' }]), { insertedCount: 2 });
        assert.deepEqual(await orchestrateModelUpdateOne(context, { id: 1, __v: 0 }, { $set: { name: 'Grace' } }), { matchedCount: 1, modifiedCount: 1 });
        assert.deepEqual(await orchestrateModelUpdateMany({ ...context, versionConfig: null }, { org: 'acme' }, { $set: { active: false } }), { modifiedCount: 2 });
        assert.deepEqual(await orchestrateModelReplaceOne(context, { id: 1, __v: 0 }, { name: 'New' }), { matchedCount: 1, modifiedCount: 1 });
        assert.deepEqual(await orchestrateModelFindOneAndUpdate(context, { id: 1, __v: 0 }, { $set: { name: 'N' } }), { id: 3 });
        assert.deepEqual(await orchestrateModelFindOneAndReplace(context, { id: 1, __v: 0 }, { name: 'R' }), { id: 5 });
        assert.deepEqual(await orchestrateModelUpsertOne(context, { id: 1 }, { $set: { name: 'U' } }), { upsertedCount: 1 });
        assert.deepEqual(await orchestrateModelIncrementOne(context, { id: 1 }, 'visits', 1, { $set: { source: 'test' } }), { modifiedCount: 1 });
        assert.deepEqual(await orchestrateModelInsertBatch(context, [{ a: 1 }, { b: 2 }]), { insertedCount: 2 });
        assert.deepEqual(await orchestrateModelUpdateBatch(context, { org: 'acme' }, { $set: { x: 1 } }), { modifiedCount: 2 });
        assert.deepEqual(await orchestrateModelDeleteOne(context, { id: 1 }), { matchedCount: 1, modifiedCount: 1 });
        assert.deepEqual(await orchestrateModelDeleteMany(context, { org: 'acme' }), { modifiedCount: 2 });
        assert.deepEqual(await orchestrateModelDeleteOne(context, { id: 1 }, { _forceDelete: true }), { deletedCount: 1 });
        assert.deepEqual(await orchestrateModelDeleteMany(context, { org: 'acme' }, { _forceDelete: true }), { deletedCount: 2 });

        const insertCall = collection.calls.find((call) => call.method === 'insertOne');
        assert.deepEqual(insertCall?.args[0], { active: true, name: 'Ada', createdAt: now, updatedAt: now, __v: 0 });
        const incrementCall = collection.calls.find((call) => call.method === 'incrementOne');
        assert.deepEqual(incrementCall?.args[3], { $set: { source: 'test', updatedAt: now } });
        assert.ok(hookCalls.some((call) => call.hookName === 'beforeCreate'));
        assert.ok(hookCalls.some((call) => call.hookName === 'afterDelete'));
    });

    it('covers v1 hook mutation branches and after-hook isolation', async () => {
        const calls: string[] = [];
        const { context } = createMutationContext({
            hooksFactory: () => ({
                find: undefined,
                insert: {
                    before: async (_hookContext: unknown, payload: unknown) => {
                        calls.push('insert:before');
                        return { ...(payload as Record<string, unknown>), fromHook: true };
                    },
                    after: async () => {
                        calls.push('insert:after');
                        throw new Error('ignored');
                    },
                },
                update: {
                    before: async () => { calls.push('update:before'); },
                    after: async () => { calls.push('update:after'); },
                },
                delete: {
                    before: async () => { calls.push('delete:before'); },
                    after: async () => { calls.push('delete:after'); },
                },
            }),
        });

        await orchestrateModelInsertOne(context, { name: 'Ada' });
        await orchestrateModelUpdateOne(context, { id: 1, __v: 0 }, { $set: { name: 'Grace' } });
        await orchestrateModelDeleteOne(context, { id: 1 });

        assert.deepEqual(calls, ['insert:before', 'insert:after', 'update:before', 'update:after', 'delete:before', 'delete:after']);
    });

    it('covers slow query memory and mongodb storage paths with fake clients', async () => {
        const memory = new SlowQueryLogMemoryStorage();
        await memory.initialize();
        await memory.save({ database: 'db', collection: 'users', operation: 'find', durationMs: 20, query: { a: 1 }, timestamp: new Date('2026-01-01T00:00:00.000Z') });
        await memory.saveBatch([
            { database: 'db', collection: 'users', operation: 'find', durationMs: 30, query: { a: 1 }, timestamp: new Date('2026-01-01T00:00:01.000Z') },
            { database: 'db', collection: 'orders', operation: 'insert', durationMs: 40, query: { b: 1 } },
        ]);
        const rows = await memory.query({ database: 'db' }, { sort: { totalTimeMs: -1 }, limit: 2 });
        assert.equal(rows.length, 2);
        assert.equal(rows[0].totalTimeMs, 50);
        await memory.close();

        const collectionCalls: Call[] = [];
        const fakeCollection = {
            createIndex: async (...args: unknown[]) => { collectionCalls.push({ method: 'createIndex', args }); },
            updateOne: async (...args: unknown[]) => { collectionCalls.push({ method: 'updateOne', args }); },
            bulkWrite: async (...args: unknown[]) => { collectionCalls.push({ method: 'bulkWrite', args }); },
            find: () => {
                const cursor = {
                    sort: () => cursor,
                    skip: () => cursor,
                    limit: () => cursor,
                    toArray: async () => [{ queryHash: 'hash', database: 'db', collection: 'users', operation: 'find', count: 2, totalTimeMs: 10, maxTimeMs: 7, minTimeMs: 3, firstSeen: new Date(), lastSeen: new Date() }],
                };
                return cursor;
            },
        };
        const fakeClient = {
            db: () => ({ collection: () => fakeCollection }),
            close: async () => { collectionCalls.push({ method: 'close', args: [] }); },
        };
        const storage = new MongoDBSlowQueryLogStorage({ type: 'mongodb', useBusinessConnection: false, uri: 'mongodb://localhost:27017', ttl: 60 }, null, null, async () => fakeClient as never);
        await storage.initialize();
        await storage.initialize();
        await storage.save({ database: 'db', collection: 'users', operation: 'find', durationMs: 10 });
        await storage.saveBatch([]);
        await storage.saveBatch([{ database: 'db', collection: 'users', operation: 'find', durationMs: 11 }]);
        await storage.saveBatch([
            { database: 'db', collection: 'users', operation: 'find', durationMs: 12 },
            { database: 'db', collection: 'users', operation: 'find', durationMs: 13 },
        ]);
        assert.equal((await storage.query({ database: 'db' }, { skip: 1, limit: 1 })).length, 1);
        await storage.close();
        await assert.rejects(() => new MongoDBSlowQueryLogStorage({ type: 'mongodb', useBusinessConnection: false }).initialize(), /slowQueryLog\.storage\.uri/);
        assert.ok(collectionCalls.some((call) => call.method === 'createIndex'));
        assert.ok(collectionCalls.some((call) => call.method === 'bulkWrite'));
        assert.ok(collectionCalls.some((call) => call.method === 'close'));
    });

    it('covers health checker registration, status transitions, and ping variants', async () => {
        const logs: string[] = [];
        const checker = new HealthChecker({ logger: { info: (message) => logs.push(String(message)) } });
        checker.register({ name: 'primary', healthCheck: { retries: 1, timeout: 100 } }, { db: () => ({ command: async () => ({ ok: 1 }) }) });
        await checker.checkPool('primary');
        assert.equal(checker.getStatus('primary')?.status, 'up');

        checker.register({ name: 'secondary', healthCheck: { retries: 1, timeout: 100 } }, { db: () => ({ admin: () => ({ ping: async () => ({ ok: 1 }) }) }) });
        await checker.checkPool('secondary');
        assert.equal(checker.getStatus('secondary')?.status, 'up');

        checker.register('missing', { retries: 1, timeout: 1 });
        await checker.checkPool('missing');
        assert.equal(checker.getStatus('missing')?.status, 'down');
        assert.ok(checker.getStatus('missing')?.lastError instanceof Error);
        assert.equal(checker.getAllStatus().size, 3);

        checker.start();
        checker.start();
        checker.stop();
        checker.stop();
        checker.unregister('missing');
        assert.equal(checker.getStatus('missing'), null);
        assert.ok(logs.some((message) => message.includes('started')));
        assert.ok(logs.some((message) => message.includes('stopped')));
    });

    it('covers cursor, page result, validation, cache normalization, and ssh utility branches', async () => {
        const cursor = encodeCursor({ s: { createdAt: -1 }, a: { createdAt: '2026-01-01' }, d: 'after' });
        assert.deepEqual(decodeCursor(cursor), { v: 1, s: { createdAt: -1 }, a: { createdAt: '2026-01-01' }, d: 'after' });
        assert.throws(() => encodeCursor({ s: {}, a: null as never }), /requires sort/);
        assert.throws(() => decodeCursor('not-a-valid-cursor'), (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'INVALID_CURSOR'));

        const page = makePageResult([{ id: 1 }, { id: 2 }, { id: 3 }], {
            limit: 2,
            stableSort: { id: 1 },
            direction: 'after',
            hasCursor: true,
            pickAnchor: (doc) => ({ id: (doc as { id: number }).id }),
        });
        assert.equal(page.items.length, 2);
        assert.equal(page.pageInfo.hasNext, true);
        assert.equal(page.pageInfo.hasPrev, true);
        const beforePage = makePageResult([{ id: 1 }, { id: 2 }, { id: 3 }], {
            limit: 2,
            stableSort: { id: 1 },
            direction: 'before',
            hasCursor: false,
            pickAnchor: (doc) => ({ id: (doc as { id: number }).id }),
        });
        assert.equal(beforePage.pageInfo.hasNext, false);
        assert.equal(beforePage.pageInfo.hasPrev, true);

        assert.equal(validateRange(5, 1, 10, 'limit'), 5);
        assert.equal(validatePositiveInteger(3, 'page'), 3);
        assert.throws(() => validateRange(Number.NaN, 1, 10, 'limit'), /valid number/);
        assert.throws(() => validateRange(Infinity, 1, 10, 'limit'), /finite number/);
        assert.throws(() => validateRange(20, 1, 10, 'limit'), /between/);
        assert.throws(() => validatePositiveInteger(0, 'page'), /positive integer/);

        const memory = new MemoryCache();
        assert.equal(normalizeRuntimeCache(memory), memory);
        const cacheLike = { get: async () => 'hit', set: async () => undefined, del: async () => undefined };
        assert.equal(normalizeRuntimeCache(cacheLike), cacheLike);
        const plain = normalizeRuntimeCache({ maxSize: 10, ttl: 100, enableStats: true });
        await plain.set('key', 'value');
        assert.equal(await plain.get('key'), 'value');
        const multi = normalizeRuntimeCache({ local: { maxSize: 10, ttl: 100 }, remote: { maxEntries: 10, ttl: 100 }, policy: { writePolicy: 'both', backfillLocalOnRemoteHit: false } });
        await multi.set('multi-key', 'multi-value');
        assert.equal(await multi.get('multi-key'), 'multi-value');
        const vextMemory = normalizeRuntimeCache({ memory: { maxSize: 10, ttl: 20 }, redis: { enabled: false } });
        await vextMemory.set('ttl-key', 'value');
        assert.equal(await vextMemory.get('ttl-key'), 'value');
        await new Promise((resolve) => setTimeout(resolve, 35));
        assert.equal(await vextMemory.get('ttl-key'), undefined);

        const remoteStore = new Map<string, unknown>();
        const remoteCalls: Array<{ method: string; key: string; ttl?: number }> = [];
        const vextRemote = {
            prefix: 'vext:',
            ttl: 1234,
            get: async (key: string) => remoteStore.get(key),
            set: async (key: string, value: unknown, ttl?: number) => {
                remoteCalls.push({ method: 'set', key, ttl });
                remoteStore.set(key, value);
            },
            del: async (key: string) => remoteStore.delete(key),
            exists: async (key: string) => remoteStore.has(key),
            has: async (key: string) => remoteStore.has(key),
            clear: async () => remoteStore.clear(),
            getMany: async (keys: string[]) => Object.fromEntries(keys.filter((key) => remoteStore.has(key)).map((key) => [key, remoteStore.get(key)])),
            setMany: async (entries: Record<string, unknown>, ttl?: number) => {
                for (const [key, value] of Object.entries(entries)) {
                    remoteCalls.push({ method: 'setMany', key, ttl });
                    remoteStore.set(key, value);
                }
                return true;
            },
            delMany: async (keys: string[]) => keys.filter((key) => remoteStore.delete(key)).length,
            delPattern: async () => 0,
            keys: async () => Array.from(remoteStore.keys()),
        };
        const vextRemoteCache = normalizeRuntimeCache({ memory: { enabled: false }, redis: vextRemote });
        await vextRemoteCache.set('remote-key', 'remote-value');
        assert.deepEqual(remoteCalls[0], { method: 'set', key: 'vext:remote-key', ttl: 1234 });
        assert.equal(await vextRemoteCache.get('remote-key'), 'remote-value');

        assert.equal(parseHostFromUri('mongodb://user:pass@example.com:27018/db'), 'example.com');
        assert.equal(parseHostFromUri('mongodb+srv://cluster.example.com/db'), 'cluster.example.com');
        assert.equal(parseHostFromUri('not-a-mongo-uri'), 'localhost');
        assert.equal(parsePortFromUri('mongodb://example.com:27018/db'), 27018);
        assert.equal(parsePortFromUri('mongodb://example.com/db'), 27017);

        const tunnel = new SSHTunnelSSH2({ host: 'bastion', username: 'deploy', privateKey: Buffer.from('key'), passphrase: 'pw' }, 'mongo.internal', 27017, { name: 'primary' });
        assert.deepEqual(tunnel._buildAuthConfig(), { host: 'bastion', port: 22, username: 'deploy', readyTimeout: 20000, keepaliveInterval: 30000, privateKey: Buffer.from('key'), passphrase: 'pw' });
        assert.throws(() => new SSHTunnelSSH2({ host: '', username: 'deploy', password: 'pw' }, 'mongo.internal', 27017)._buildAuthConfig(), /requires/);
        assert.throws(() => new SSHTunnelSSH2({ host: 'bastion', username: 'deploy' }, 'mongo.internal', 27017)._buildAuthConfig(), /authentication/);
        tunnel.isConnected = true;
        tunnel.localPort = 37017;
        assert.equal(tunnel.getTunnelUri('mongodb', 'mongodb://mongo.internal:27017/app'), 'mongodb://localhost:37017/app');
        assert.equal(tunnel.getTunnelUri('mongodb', 'mongodb://mongo.internal/app'), 'mongodb://localhost:37017/app');
        assert.equal(
            rewriteMongoUriForSshTunnel('mongodb://mongo.internal:secret@mongo.internal/app', 'localhost:37017'),
            'mongodb://mongo.internal:secret@localhost:37017/app',
        );
        assert.deepEqual(parseMongoHostTokens('mongodb://user:pass@a:27017,b:27018/db'), ['a:27017', 'b:27018']);
        assert.throws(
            () => tunnel.getTunnelUri('mongodb', 'mongodb://mongo.internal:27017,mongo2.internal:27017/app'),
            /single MongoDB host/i,
        );
        assert.throws(
            () => tunnel.getTunnelUri('mongodb+srv', 'mongodb+srv://cluster.example.com/app'),
            /single MongoDB host/i,
        );
        assert.equal(tunnel.getLocalAddress(), 'localhost:37017');
        await tunnel.close();
        assert.equal(tunnel.isConnected, false);
    });

    it('covers ssh auth variants, disconnected guards, and close cleanup branches', async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msq-ssh-'));
        const keyPath = path.join(tmpDir, 'id_rsa');
        fs.writeFileSync(keyPath, 'private-key-data');

        const passwordTunnel = new SSHTunnelSSH2(
            { host: 'bastion', username: 'deploy', password: 'pw', port: 2222, readyTimeout: 1234, keepaliveInterval: 5678 },
            'mongo.internal',
            27017,
        );
        assert.deepEqual(passwordTunnel._buildAuthConfig(), {
            host: 'bastion',
            port: 2222,
            username: 'deploy',
            password: 'pw',
            readyTimeout: 1234,
            keepaliveInterval: 5678,
        });

        const keyFileTunnel = new SSHTunnelSSH2(
            { host: 'bastion', username: 'deploy', privateKeyPath: keyPath, passphrase: 'secret' },
            'mongo.internal',
            27017,
        );
        assert.deepEqual(keyFileTunnel._buildAuthConfig(), {
            host: 'bastion',
            port: 22,
            username: 'deploy',
            readyTimeout: 20000,
            keepaliveInterval: 30000,
            privateKey: Buffer.from('private-key-data'),
            passphrase: 'secret',
        });

        assert.throws(
            () => new SSHTunnelSSH2({ host: 'bastion', username: 'deploy', password: 'pw' }, 'mongo.internal', 27017).getTunnelUri('mongodb', 'mongodb://mongo.internal:27017/app'),
            /not connected/,
        );
        assert.throws(
            () => new SSHTunnelSSH2({ host: 'bastion', username: 'deploy', password: 'pw' }, 'mongo.internal', 27017).getLocalAddress(),
            /not connected/,
        );

        let serverClosed = false;
        let sshEnded = false;
        const closableTunnel = new SSHTunnelSSH2({ host: 'bastion', username: 'deploy', password: 'pw' }, 'mongo.internal', 27017);
        closableTunnel.server = {
            close(callback?: () => void) {
                serverClosed = true;
                callback?.();
                return this;
            },
        } as never;
        closableTunnel.sshClient = {
            end() {
                sshEnded = true;
            },
        } as never;
        closableTunnel.isConnected = true;
        closableTunnel.localPort = 37017;

        await closableTunnel.close();
        assert.equal(serverClosed, true);
        assert.equal(sshEnded, true);

        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('covers query helper normalization, cursor, projection, and driver option branches', () => {
        const hex = '64b64c0f0000000000000001';
        assert.equal(normalizeSortShape([['createdAt', 'desc']]).createdAt, -1);
        assert.equal(normalizeSortShape({ score: 'descending' as never }).score, -1);
        assert.equal(parseRequiredObjectId(hex).toHexString(), hex);
        assert.equal(parseRequiredObjectId({ toHexString: () => hex }).toHexString(), hex);
        assert.equal(parseRequiredObjectId({ toString: () => hex }).toHexString(), hex);
        assert.throws(() => parseRequiredObjectId('bad'), /invalid ObjectId/);
        assert.throws(() => parseRequiredObjectId(null), /id is required/);
        assert.equal(normalizeIdentifier(hex, false), hex);
        assert.equal(typeof normalizeIdentifier(hex), 'object');

        const normalized = normalizeQueryFilter({
            ownerId: hex,
            keepId: hex,
            $or: [{ nestedId: hex }, 'raw'],
            tags: { $in: [hex, 'plain'], $eq: hex, $elemMatch: { childId: hex } },
            untouched: { value: hex },
        }, { keepId: false });
        assert.equal(typeof normalized.ownerId, 'object');
        assert.equal(normalized.keepId, hex);
        assert.equal(Array.isArray(normalized.$or), true);
        const escaped = normalizeQueryFilter({ token: hex, userId: hex }, true, '', 0);
        assert.equal(typeof escaped.token, 'object');
        assert.equal(typeof escaped.userId, 'object');
        const excluded = normalizeQueryFilter({ token: hex, userId: hex }, { excludeFields: ['token'] });
        assert.equal(excluded.token, hex);
        assert.equal(typeof excluded.userId, 'object');
        const deepExcluded = normalizeQueryFilter({ a: { b: [{ c: hex }] }, ownerId: hex }, { excludeFields: ['b'] });
        assert.equal(((deepExcluded.a as { b: Array<{ c: unknown }> }).b[0] as { c: unknown }).c, hex);
        assert.equal(typeof deepExcluded.ownerId, 'object');
        assert.notEqual(
            stableCacheKeyString({ name: /ada/i }),
            stableCacheKeyString({ name: /grace/i }),
        );
        assert.equal(
            buildCollectionCacheNamespace({ namespace: 'db.users' } as never, { namespace: { instanceId: 'tenant-a' } }),
            'tenant-a:db.users',
        );

        const signed = encodePageCursor([hex, new Date('2026-01-01T00:00:00.000Z')], 'secret');
        assert.equal(decodePageCursor(signed, 'secret').length, 2);
        assert.throws(() => decodePageCursor(signed.replace(/.$/, 'x'), 'secret'), /signature invalid/);
        assert.throws(() => decodePageCursor(`${signed.split('.')[0]}.short`, 'secret'), /signature invalid/);
        assert.throws(() => decodePageCursor('bad'), /Invalid pagination cursor/);
        assert.deepEqual(reverseSort({ createdAt: -1, _id: 1 }), { createdAt: 1, _id: -1 });
        assert.deepEqual(buildCursorFilter({ createdAt: -1, _id: 1 }, ['2026-01-01T00:00:00.000Z', hex], 'after'), {
            $or: [
                { $expr: { $lt: ['$createdAt', { $literal: new Date('2026-01-01T00:00:00.000Z') }] } },
                { createdAt: new Date('2026-01-01T00:00:00.000Z'), $expr: { $gt: ['$_id', { $literal: parseRequiredObjectId(hex) }] } },
            ],
        });
        assert.equal(normalizeCursorValue('2026-01-01T00:00:00.000Z', 'token', { cursorTypes: { token: 'string' } }), '2026-01-01T00:00:00.000Z');
        assert.ok(normalizeCursorValue(hex, '_id', { cursorTypes: { _id: 'objectId' } }) instanceof Object);
        assert.equal(normalizeCursorValue('42', 'score', { cursorTypes: { score: 'number' } }), 42);
        assert.equal(normalizeCursorValue('true', 'active', { cursorTypes: { active: 'boolean' } }), true);
        assert.equal(normalizeCursorValue('x', 'custom', { cursorValueNormalizer: (field, value) => `${field}:${String(value)}` }), 'custom:x');
        assert.deepEqual(buildCursorFilter({ token: 1 }, ['2026-01-01T00:00:00.000Z'], 'after', { cursorTypes: { token: 'string' } }), {
            $expr: { $gt: ['$token', { $literal: '2026-01-01T00:00:00.000Z' }] },
        });
        assert.deepEqual(getSortValues({ nested: { rank: 2 }, _id: 'b' }, { 'nested.rank': 1, _id: 1 }), [2, 'b']);
        assert.deepEqual(buildEffectiveProjection(['name'], { createdAt: -1 }), { name: 1, createdAt: 1 });
        assert.deepEqual(buildEffectiveProjection({ name: 0, createdAt: 0 }, { createdAt: -1 }), { name: 0 });
        assert.deepEqual(buildFindDriverOptions({ projection: { name: 1 }, sort: { name: 1 }, skip: 1, limit: 2, hint: 'idx', collation: { locale: 'en' }, maxTimeMS: 10, batchSize: 5, comment: 'q', session: 's', ignored: true, cache: 1000, explain: true }), { projection: { name: 1 }, sort: { name: 1 }, skip: 1, limit: 2, hint: 'idx', collation: { locale: 'en' }, maxTimeMS: 10, batchSize: 5, comment: 'q', session: 's', ignored: true });
        assert.deepEqual(buildFindDriverOptions({ project: ['name'], cache: 1000 }), { projection: { name: 1 } });
        assert.deepEqual(buildAggregateDriverOptions({ hint: 'idx', collation: { locale: 'en' }, comment: 'agg', maxTimeMS: 10, allowDiskUse: true, batchSize: 5, session: 's', ignored: true, stream: true }), { hint: 'idx', collation: { locale: 'en' }, comment: 'agg', maxTimeMS: 10, allowDiskUse: true, batchSize: 5, session: 's', ignored: true });
    });

    it('query helpers forward session options while stripping monSQLize controls', async () => {
        const findOneCalls: unknown[] = [];
        const findAndCountCalls: Array<{ method: string; args: unknown[] }> = [];
        const collection = {
            namespace: 'db.users',
            collectionName: 'users',
            findOne: async (...args: unknown[]) => {
                findOneCalls.push(args);
                return null;
            },
            find: (...args: unknown[]) => {
                findAndCountCalls.push({ method: 'find', args });
                return { toArray: async () => [] };
            },
            countDocuments: async (...args: unknown[]) => {
                findAndCountCalls.push({ method: 'countDocuments', args });
                return 0;
            },
        };

        await findOneDocument(collection as never, { active: true }, { session: 'session-1', readConcern: { level: 'majority' }, project: ['name'], withDeleted: true, cache: 1000 } as never);
        assert.deepEqual((findOneCalls[0] as unknown[])[1], { session: 'session-1', readConcern: { level: 'majority' }, projection: { name: 1 } });

        await findAndCountDocuments(collection as never, { active: true } as never, {
            session: 'session-2',
            collation: { locale: 'en', strength: 2 },
            project: { name: 1 },
            limit: 5,
            skip: 10,
            withDeleted: true,
        } as never);
        const findOptions = findAndCountCalls.find((call) => call.method === 'find')?.args[1] as Record<string, unknown>;
        const countOptions = findAndCountCalls.find((call) => call.method === 'countDocuments')?.args[1] as Record<string, unknown>;
        assert.equal(findOptions.session, 'session-2');
        assert.equal(findOptions.limit, 5);
        assert.equal(findOptions.skip, 10);
        assert.deepEqual(findOptions.projection, { name: 1 });
        assert.equal('project' in findOptions, false);
        assert.equal(countOptions.session, 'session-2');
        assert.deepEqual(countOptions.collation, { locale: 'en', strength: 2 });
        assert.equal('limit' in countOptions, false);
        assert.equal('skip' in countOptions, false);
        assert.equal('withDeleted' in countOptions, false);
    });

    it('covers batch write helpers with retry, progress, collect, and validation branches', async () => {
        const ids = [{ _id: 1 }, { _id: 2 }, { _id: 3 }];
        let insertAttempts = 0;
        let deleteAttempts = 0;
        const progress: unknown[] = [];
        const retries: unknown[] = [];
        const idCursor = (items: Array<{ _id: number }>) => ({
            async *[Symbol.asyncIterator]() {
                for (const item of items) {
                    yield item;
                }
            },
            close: async () => true,
        });
        const collection = {
            insertMany: async (docs: unknown[]) => {
                insertAttempts += 1;
                if (insertAttempts === 1) throw new Error('insert transient');
                return { insertedCount: docs.length, insertedIds: Object.fromEntries(docs.map((_doc, index) => [index, `id-${index}`])) };
            },
            find: () => idCursor(ids),
            countDocuments: async () => ids.length,
            updateMany: async (_filter: unknown, _update: unknown) => ({ matchedCount: 2, modifiedCount: 2, upsertedCount: 0 }),
            deleteMany: async () => {
                deleteAttempts += 1;
                if (deleteAttempts === 1) throw new Error('delete transient');
                return { deletedCount: 2 };
            },
        };

        const inserted = await insertBatchDocuments(collection as never, [{ a: 1 }, { a: 2 }] as never, { batchSize: 2, onError: 'retry', retryAttempts: 1, onProgress: (info: unknown) => progress.push(info), onRetry: (info: unknown) => retries.push(info) } as never);
        assert.equal(inserted.insertedCount, 2);
        assert.equal(retries.length, 1);
        assert.equal(progress.length, 1);
        const updated = await updateBatchDocuments(collection as never, { active: true } as never, { $set: { active: false } } as never, { batchSize: 2, onProgress: (info) => progress.push(info) });
        assert.equal(updated.modifiedCount, 4);
        const deleted = await deleteBatchDocuments(collection as never, { active: false } as never, { batchSize: 2, onError: 'retry', retryAttempts: 1, estimateProgress: true, onRetry: (info) => retries.push(info), onProgress: (info) => progress.push(info) });
        assert.equal(deleted.deletedCount, 4);

        await assert.rejects(() => insertBatchDocuments(collection as never, [] as never), /must not be empty/);
        await assert.rejects(() => insertBatchDocuments(collection as never, {} as never), /must be an array/);
        await assert.rejects(() => insertBatchDocuments(collection as never, [{ a: 1 }] as never, { concurrency: -1 } as never), /concurrency/);
        await assert.rejects(() => insertBatchDocuments(collection as never, [{ a: 1 }] as never, { onError: 'bad' } as never), /onError/);
        await assert.rejects(() => updateBatchDocuments(collection as never, null as never, { $set: { a: 1 } } as never), /filter/);
        await assert.rejects(() => updateBatchDocuments(collection as never, { a: 1 } as never, {} as never), /update operators/);
        await assert.rejects(() => updateBatchDocuments(collection as never, { a: 1 } as never, { $set: { a: 1 } } as never, { upsert: true } as never), /does not support upsert/);
        await assert.rejects(() => updateBatchDocuments(collection as never, { a: 1 } as never, { $inc: { count: 1 } } as never, { onError: 'retry' } as never), /idempotent update/);
        await assert.rejects(() => deleteBatchDocuments(collection as never, [] as never), /filter/);
        await assert.rejects(() => deleteBatchDocuments(collection as never, { a: 1 } as never, { onError: 'bad' as never }), /onError/);
    });

    it('insertBatch honors concurrency for unordered batches', async () => {
        let active = 0;
        let maxActive = 0;
        const collection = {
            insertMany: async (docs: unknown[]) => {
                active += 1;
                maxActive = Math.max(maxActive, active);
                await new Promise((resolve) => setTimeout(resolve, 5));
                active -= 1;
                return { insertedCount: docs.length, insertedIds: Object.fromEntries(docs.map((_doc, index) => [index, `id-${index}`])) };
            },
        };

        const result = await insertBatchDocuments(collection as never, [{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }] as never, {
            batchSize: 1,
            concurrency: 2,
            ordered: false,
        } as never);

        assert.equal(result.insertedCount, 4);
        assert.equal(maxActive, 2);
    });

    it('insertBatch retries only failed unordered items after partial success', async () => {
        const insertCalls: unknown[][] = [];
        const collection = {
            insertMany: async (docs: unknown[]) => {
                insertCalls.push(docs);
                if (insertCalls.length === 1) {
                    throw Object.assign(new Error('partial insert failure'), {
                        writeErrors: [{ index: 1 }],
                        insertedIds: { 0: 'id-a', 2: 'id-c' },
                    });
                }
                return { insertedCount: docs.length, insertedIds: { 0: 'id-b' } };
            },
        };

        const result = await insertBatchDocuments(collection as never, [{ name: 'a' }, { name: 'b' }, { name: 'c' }] as never, {
            batchSize: 3,
            ordered: false,
            onError: 'retry',
            retryAttempts: 1,
            retryDelay: 0,
        } as never);

        assert.equal(insertCalls.length, 2);
        assert.equal(insertCalls[1].length, 1);
        assert.deepEqual(insertCalls[1][0], { name: 'b' });
        assert.equal(result.insertedCount, 3);
        assert.deepEqual(result.insertedIds, { 0: 'id-a', 1: 'id-b', 2: 'id-c' });
    });

    it('covers collection management helper validation and command branches', async () => {
        const commands: unknown[] = [];
        const db = {
            createCollection: async (...args: unknown[]) => { commands.push(['createCollection', ...args]); },
            command: async (command: unknown) => { commands.push(command); return { ok: 1 }; },
            listCollections: () => ({ toArray: async () => [{ options: { validator: { $jsonSchema: {} }, validationLevel: 'moderate', validationAction: 'warn' } }] }),
        };
        const collection = {
            db,
            drop: async () => true,
            aggregate: () => ({ toArray: async () => [{ ns: 'db.users', storageStats: { count: 3, size: 10, storageSize: 12, totalIndexSize: 4, nindexes: 2, avgObjSize: 3, scaleFactor: 1 } }] }),
            rename: async (...args: unknown[]) => { commands.push(['rename', ...args]); },
        };

        assert.equal(await dropCollectionForAccessor(collection as never), true);
        assert.equal(await createCollectionForAccessor(collection as never, 'users', undefined, undefined, { capped: false }), true);
        assert.equal(await createViewForAccessor(collection as never, undefined, 'activeUsers', 'users', [{ $match: { active: true } }]), true);
        assert.deepEqual(await indexStatsForAccessor(collection as never), [{ ns: 'db.users', storageStats: { count: 3, size: 10, storageSize: 12, totalIndexSize: 4, nindexes: 2, avgObjSize: 3, scaleFactor: 1 } }]);
        assert.deepEqual(await setValidatorForAccessor(collection as never, 'users', undefined, {}, {}), { ok: 1, collection: 'users' });
        assert.deepEqual(await setValidationLevelForAccessor(collection as never, 'users', undefined, 'moderate'), { ok: 1, validationLevel: 'moderate' });
        assert.deepEqual(await setValidationActionForAccessor(collection as never, 'users', undefined, 'warn'), { ok: 1, validationAction: 'warn' });
        assert.deepEqual(await getValidatorForAccessor(collection as never, 'users'), { validator: { $jsonSchema: {} }, validationLevel: 'moderate', validationAction: 'warn' });
        assert.deepEqual(await statsForAccessor(collection as never, 'db', 'users'), { ns: 'db.users', count: 3, size: 10, storageSize: 12, totalIndexSize: 4, nindexes: 2, avgObjSize: 3, scaleFactor: 1 });
        assert.deepEqual(await renameCollectionForAccessor(collection as never, 'users', 'members', { dropTarget: true }), { renamed: true, from: 'users', to: 'members' });
        assert.deepEqual(await collModForAccessor(collection as never, 'users', undefined, { expireAfterSeconds: 60 }), { ok: 1 });
        assert.deepEqual(await convertToCappedForAccessor(collection as never, 'users', undefined, 1024, { max: 100 }), { ok: 1, collection: 'users', capped: true, size: 1024 });

        await assert.rejects(() => setValidatorForAccessor(collection as never, 'users', undefined, null), /Validator/);
        await assert.rejects(() => setValidationLevelForAccessor(collection as never, 'users', undefined, 'bad'), /Invalid validation level/);
        await assert.rejects(() => setValidationActionForAccessor(collection as never, 'users', undefined, 'bad'), /Invalid validation action/);
        await assert.rejects(() => renameCollectionForAccessor(collection as never, 'users', ''), /New collection name/);
        await assert.rejects(() => collModForAccessor(collection as never, 'users', undefined, null), /Modifications/);
        await assert.rejects(() => convertToCappedForAccessor(collection as never, 'users', undefined, 'bad'), /Size must be a number/);
        await assert.rejects(() => convertToCappedForAccessor(collection as never, 'users', undefined, 0), /positive/);
        assert.ok(commands.length > 0);
    });

    it('covers count queue execution, queueing, clear, rejection, timeout, and stats reset branches', async () => {
        const queue = new CountQueue({ concurrency: 1, maxQueueSize: 1, timeout: 20 });
        let releaseFirst!: () => void;
        const first = queue.execute(async () => new Promise<string>((resolve) => {
            releaseFirst = () => resolve('first');
        }));
        const second = queue.execute(async () => 'second');
        await assert.rejects(() => queue.execute(async () => 'third'), /Count queue is full/);
        assert.equal(queue.getStats().queuedNow, 1);
        releaseFirst();
        assert.equal(await first, 'first');
        assert.equal(await second, 'second');
        assert.equal(queue.getStats().executed, 2);
        assert.equal(queue.getStats().rejected, 1);

        const clearQueue = new CountQueue({ concurrency: 1, maxQueueSize: 2, timeout: 100 });
        let releaseClear!: () => void;
        const running = clearQueue.execute(async () => new Promise<string>((resolve) => {
            releaseClear = () => resolve('running');
        }));
        const cleared = clearQueue.execute(async () => 'cleared');
        clearQueue.clear();
        releaseClear();
        assert.equal(await running, 'running');
        await assert.rejects(() => cleared, /Count queue was cleared/);

        const timeoutQueue = new CountQueue({ concurrency: 1, maxQueueSize: 1, timeout: 1 });
        await assert.rejects(() => timeoutQueue.execute(async () => new Promise((resolve) => setTimeout(resolve, 20))), /Count execution timeout/);
        timeoutQueue.resetStats();
        assert.equal(timeoutQueue.getStats().executed, 0);
    });

    it('covers logger structured, plain, silent, timestamp, and trace branches', async () => {
        const calls: Array<{ level: string; args: unknown[] }> = [];
        const sink = {
            debug: (...args: unknown[]) => calls.push({ level: 'debug', args }),
            info: (...args: unknown[]) => calls.push({ level: 'info', args }),
            warn: (...args: unknown[]) => calls.push({ level: 'warn', args }),
            error: (...args: unknown[]) => calls.push({ level: 'error', args }),
        };
        const logger = Logger.create(sink, { structured: true, enableTraceId: true });
        await Logger.withTraceId?.(async () => {
            logger.info('message', { ok: true });
            assert.equal(Logger.getTraceId?.(), 'trace-1');
        }, 'trace-1');
        const parsed = JSON.parse(String(calls[0].args[0])) as Record<string, unknown>;
        assert.equal(parsed.level, 'INFO');
        assert.equal(parsed.traceId, 'trace-1');

        const plain = Logger.create(sink);
        plain.debug('debug');
        plain.warn('warn', { code: 1 });
        plain.error('error');
        assert.equal(Logger.isValidLogger(sink), true);
        assert.equal(Logger.isValidLogger({ info: () => undefined }), false);
        Logger.create(null).info('noop');
        Logger.createSilent().error('ignored');
        const timed = Logger.createWithTimestamp(sink);
        timed.info('timed');
        assert.equal(Logger.generateTraceId().length, 16);
        assert.ok(calls.some((call) => call.level === 'warn'));
    });

    it('covers expression compiler operators, function dispatch, and error branches', () => {
        assert.deepEqual(compileInnerExpression('age >= 18 && status === "active"'), { $and: [{ $gte: ['$age', 18] }, { $eq: ['$status', 'active'] }] });
        assert.deepEqual(compileInnerExpression('score > 90 || vip === true'), { $or: [{ $gt: ['$score', 90] }, { $eq: ['$vip', true] }] });
        assert.deepEqual(compileInnerExpression('active ? "yes" : "no"'), { $cond: { if: '$active', then: 'yes', else: 'no' } });
        assert.deepEqual(compileInnerExpression('name ?? "unknown"'), { $ifNull: ['$name', 'unknown'] });
        assert.deepEqual(compileInnerExpression('price * quantity'), { $multiply: ['$price', '$quantity'] });
        const cases: Array<[string, unknown]> = [
            ['CONCAT(first, " ", last)', { $concat: ['$first', ' ', '$last'] }],
            ['UPPER(name)', { $toUpper: '$name' }],
            ['LOWER(name)', { $toLower: '$name' }],
            ['TRIM(name)', { $trim: { input: '$name' } }],
            ['LENGTH(name)', { $strLenCP: '$name' }],
            ['SUBSTR(name, 0, 2)', { $substr: ['$name', 0, 2] }],
            ['SPLIT(tags, ",")', { $split: ['$tags', ','] }],
            ['REPLACE(name, "a", "b")', { $replaceOne: { input: '$name', find: 'a', replacement: 'b' } }],
            ['INDEX_OF_STR(name, "a", 1)', { $indexOfCP: ['$name', 'a', 1] }],
            ['LTRIM(name)', { $ltrim: { input: '$name' } }],
            ['RTRIM(name)', { $rtrim: { input: '$name' } }],
            ['SUBSTR_CP(name, 1, 3)', { $substrCP: ['$name', 1, 3] }],
            ['STR_LEN_BYTES(name)', { $strLenBytes: '$name' }],
            ['STR_LEN_CP(name)', { $strLenCP: '$name' }],
            ['SUBSTR_BYTES(name, 1, 3)', { $substrBytes: ['$name', 1, 3] }],
            ['ABS(amount)', { $abs: '$amount' }],
            ['CEIL(amount)', { $ceil: '$amount' }],
            ['FLOOR(amount)', { $floor: '$amount' }],
            ['ROUND(amount, 2)', { $round: ['$amount', 2] }],
            ['SQRT(amount)', { $sqrt: '$amount' }],
            ['POW(amount, 2)', { $pow: ['$amount', 2] }],
            ['LOG(amount, 10)', { $log: ['$amount', 10] }],
            ['LOG10(amount)', { $log10: '$amount' }],
            ['SIZE(items)', { $size: '$items' }],
            ['IN(status, allowed)', { $in: ['$status', '$allowed'] }],
            ['SLICE(items, 2)', { $slice: ['$items', 2] }],
            ['FIRST(items)', { $first: '$items' }],
            ['LAST(items)', { $last: '$items' }],
            ['ARRAY_ELEM_AT(items, 1)', { $arrayElemAt: ['$items', 1] }],
            ['INDEX_OF(items, value)', { $indexOfArray: ['$items', '$value'] }],
            ['CONCAT_ARRAYS(a, b)', { $concatArrays: ['$a', '$b'] }],
            ['TYPE(value)', { $type: '$value' }],
            ['NOT(active)', { $not: ['$active'] }],
            ['EXISTS(name)', { $ne: ['$name', null] }],
            ['IS_NUMBER(age)', { $isNumber: '$age' }],
            ['IS_ARRAY(tags)', { $isArray: '$tags' }],
            ['TO_INT(age)', { $toInt: '$age' }],
            ['TO_STRING(age)', { $toString: '$age' }],
            ['OBJECT_TO_ARRAY(obj)', { $objectToArray: '$obj' }],
            ['ARRAY_TO_OBJECT(entries)', { $arrayToObject: '$entries' }],
            ['TO_BOOL(flag)', { $toBool: '$flag' }],
            ['TO_DATE(ts)', { $toDate: '$ts' }],
            ['TO_DOUBLE(price)', { $toDouble: '$price' }],
            ['TO_DECIMAL(price)', { $toDecimal: '$price' }],
            ['TO_LONG(count)', { $toLong: '$count' }],
            ['TO_OBJECT_ID(id)', { $toObjectId: '$id' }],
            ['SUM(amount)', { $sum: '$amount' }],
            ['AVG(amount)', { $avg: '$amount' }],
            ['MAX(amount)', { $max: '$amount' }],
            ['MIN(amount)', { $min: '$amount' }],
            ['COUNT(*)', { $sum: 1 }],
            ['PUSH(name)', { $push: '$name' }],
            ['ADD_TO_SET(name)', { $addToSet: '$name' }],
            ['YEAR(ts)', { $year: '$ts' }],
            ['MONTH(ts)', { $month: '$ts' }],
            ['DAY_OF_MONTH(ts)', { $dayOfMonth: '$ts' }],
            ['HOUR(ts)', { $hour: '$ts' }],
            ['MINUTE(ts)', { $minute: '$ts' }],
            ['SECOND(ts)', { $second: '$ts' }],
            ['REGEX(name, "^a")', { $regexMatch: { input: '$name', regex: '^a' } }],
            ['SET_UNION([1], [2])', { $setUnion: [[1], [2]] }],
            ['ALL_ELEMENTS_TRUE(flags)', { $allElementsTrue: ['$flags'] }],
            ['ANY_ELEMENT_TRUE(flags)', { $anyElementTrue: ['$flags'] }],
            ['IF_NULL(name, "n/a")', { $ifNull: ['$name', 'n/a'] }],
            ['GET_FIELD("name")', { $getField: 'name' }],
            ['SET_DIFFERENCE(a, b)', { $setDifference: ['$a', '$b'] }],
            ['SET_EQUALS(a, b)', { $setEquals: ['$a', '$b'] }],
            ['SET_INTERSECTION(a, b)', { $setIntersection: ['$a', '$b'] }],
            ['SET_IS_SUBSET(a, b)', { $setIsSubset: ['$a', '$b'] }],
            ['LITERAL(name)', { $literal: '$name' }],
            ['RAND()', { $rand: {} }],
            ['SAMPLE_RATE(rate)', { $sampleRate: '$rate' }],
        ];
        for (const [source, expected] of cases) {
            assert.deepEqual(compileInnerExpression(source), expected, source);
        }
        assert.throws(() => compileInnerExpression('UNKNOWN(value)'), /Unsupported expression function/);
        assert.throws(() => compileInnerExpression('COND(a, b)'), /COND requires 3/);
        assert.throws(() => compileInnerExpression('SWITCH(a)'), /SWITCH requires/);
        assert.throws(() => compileInnerExpression('LET(a, b)'), /LET requires/);
    });

    it('covers findPage cursor, offset, totals, explain, stream, and validation branches', async () => {
        const rows = [{ _id: 'a', createdAt: 1 }, { _id: 'b', createdAt: 2 }, { _id: 'c', createdAt: 3 }];
        const calls: Call[] = [];
        const makeCursor = <T>(items: T[] = rows as unknown as T[]) => ({
            toArray: async () => items,
            explain: async (verbosity: unknown) => ({ verbosity }),
            stream: () => ({ streamed: true }),
        });
        const collection = {
            namespace: { db: 'app' },
            collectionName: 'items',
            find: (...args: unknown[]) => {
                calls.push({ method: 'find', args });
                return makeCursor();
            },
            aggregate: (...args: unknown[]) => {
                calls.push({ method: 'aggregate', args });
                return makeCursor(rows.slice(0, 2));
            },
            countDocuments: async (...args: unknown[]) => {
                calls.push({ method: 'countDocuments', args });
                return 42;
            },
            estimatedDocumentCount: async (...args: unknown[]) => {
                calls.push({ method: 'estimatedDocumentCount', args });
                return 50;
            },
        };

        const first = await executeFindPage(collection as never, { limit: 2, totals: { mode: 'sync' }, meta: { level: 'sub' }, sort: { createdAt: 1 } }, { findPageMaxLimit: 2, maxTimeMS: 12, namespace: { instanceId: 'iid' } });
        assert.equal(first.items.length, 2);
        assert.equal(first.totals?.total, 42);
        assert.equal(first.meta?.ns.iid, 'iid');

        const nestedRows = [{ _id: 'a', nested: { rank: 1 } }, { _id: 'b', nested: { rank: 2 } }, { _id: 'c', nested: { rank: 3 } }];
        const nestedCollection = {
            ...collection,
            find: (...args: unknown[]) => {
                calls.push({ method: 'findNested', args });
                return makeCursor(nestedRows);
            },
        };
        const nested = await executeFindPage(nestedCollection as never, { limit: 2, sort: { 'nested.rank': 1 }, project: { name: 1 } } as never, {});
        assert.deepEqual(decodePageCursor(nested.pageInfo.endCursor as string), [2, 'b']);
        const nestedFindOptions = calls.find((call) => call.method === 'findNested')?.args[1] as Record<string, unknown>;
        assert.deepEqual(nestedFindOptions.projection, { name: 1, 'nested.rank': 1, _id: 1 });

        const approx = await executeFindPage(collection as never, { limit: 2, offsetJump: { enable: true }, page: 2, totals: { mode: 'approx' }, pipeline: [{ $project: { _id: 1 } }] } as never, {});
        assert.equal(approx.totals?.total, 50);
        assert.ok(calls.some((call) => call.method === 'aggregate'));

        const cursor = encodePageCursor([2]);
        await assert.rejects(
            () => executeFindPage(collection as never, { limit: 1 }, { requireCursorSecret: true }),
            /requires cursorSecret/,
        );
        const after = await executeFindPage(collection as never, { after: cursor, limit: 1, sort: { createdAt: 1 } }, {});
        assert.equal(after.pageInfo.hasPrev, true);
        const before = await executeFindPage(collection as never, { before: cursor, limit: 1, sort: { createdAt: 1 } }, {});
        assert.equal(before.pageInfo.hasNext, true);

        const explained = await executeFindPage(collection as never, { explain: 'executionStats', page: 2, offsetJump: { enable: true }, limit: 1 } as never, {});
        assert.deepEqual(explained, { verbosity: 'executionStats' });
        calls.length = 0;
        await executeFindPage(collection as never, { page: 2, limit: 1, offsetJump: { enable: true, maxSkip: 0 }, sort: { createdAt: 1 } } as never, { findMaxSkip: 5 });
        assert.equal(calls.some((call) => {
            const options = call.args[1] as Record<string, unknown> | undefined;
            return options?.skip !== undefined;
        }), false);
        await assert.rejects(
            () => executeFindPage(collection as never, { page: 2, limit: 1, offsetJump: { enable: true, maxSkip: 6 } } as never, { findMaxSkip: 5 }),
            /offsetJump\.maxSkip/,
        );
        const streamed = await executeFindPage(collection as never, { stream: true, limit: 1 } as never, {});
        assert.deepEqual(streamed, { streamed: true });

        await assert.rejects(() => executeFindPage(collection as never, { page: 0 }, {}), /page must be a positive integer/);
        await assert.rejects(() => executeFindPage(collection as never, { after: cursor, page: 2 }, {}), /page cannot be used/);
        await assert.rejects(() => executeFindPage(collection as never, { stream: true, totals: { mode: 'sync' } } as never, {}), /totals cannot/);
        await assert.rejects(() => executeFindPage(collection as never, { page: 5, jump: { step: 1, maxHops: 1 } } as never, {}), /Page jump exceeds/);
    });

    it('covers query facade chain, aggregate, count, distinct, watch, stream, and explain branches', async () => {
        const calls: Call[] = [];
        const cursor = {
            toArray: async () => [{ id: 1 }],
            explain: async (verbosity: unknown) => ({ explain: verbosity }),
            stream: () => ({ stream: true }),
            limit: () => cursor,
        };
        const collection = {
            namespace: 'db.items',
            collectionName: 'items',
            find: (...args: unknown[]) => { calls.push({ method: 'find', args }); return cursor; },
            findOne: async (...args: unknown[]) => { calls.push({ method: 'findOne', args }); return { id: 1 }; },
            aggregate: (...args: unknown[]) => { calls.push({ method: 'aggregate', args }); return cursor; },
            countDocuments: async (...args: unknown[]) => { calls.push({ method: 'countDocuments', args }); return 3; },
            estimatedDocumentCount: async (...args: unknown[]) => { calls.push({ method: 'estimatedDocumentCount', args }); return 4; },
            distinct: async (...args: unknown[]) => { calls.push({ method: 'distinct', args }); return ['a']; },
            watch: (...args: unknown[]) => { calls.push({ method: 'watch', args }); return { watch: true }; },
        };
        const cache = new MemoryCache({ maxEntries: 10 });
        assert.deepEqual(await createFindChain(collection as never, { _id: '507f1f77bcf86cd799439011' } as never, { cache: 100, limit: 1 } as never, { autoConvertObjectId: true, maxTimeMS: 5 }, cache).then((value) => value), [{ id: 1 }]);
        assert.deepEqual(await createFindChain(collection as never, {}, { cache: 100 } as never, {}, cache).then((value) => value), [{ id: 1 }]);
        assert.deepEqual(await createFindChain(collection as never).limit(0).then((value) => value), [{ id: 1 }]);
        calls.length = 0;
        await createFindChain(collection as never, {}, { project: ['id'] } as never).toArray();
        const projectAliasOptions = calls.find((call) => call.method === 'find')?.args[1] as Record<string, unknown>;
        assert.deepEqual(projectAliasOptions.projection, { id: 1 });
        assert.equal('project' in projectAliasOptions, false);
        assert.throws(() => createFindChain(collection as never).limit(-1), /non-negative/);
        assert.throws(() => createFindChain(collection as never).skip(-1), /non-negative/);
        assert.throws(() => createFindChain(collection as never).limit(Number.NaN), /non-negative integer/);
        assert.throws(() => createFindChain(collection as never, {}, {}, { findMaxLimit: 5 }).limit(6), /findMaxLimit/);
        assert.throws(() => createFindChain(collection as never, {}, {}, { findMaxSkip: 5 }).skip(6), /findMaxSkip/);
        await assert.rejects(createFindChain(collection as never, {}, { limit: 6 } as never, { findMaxLimit: 5 }).toArray(), /findMaxLimit/);
        await assert.rejects(createFindChain(collection as never, {}, { skip: 6 } as never, { findMaxSkip: 5 }).toArray(), /findMaxSkip/);
        assert.deepEqual(await createFindChain(collection as never, {}, { explain: true } as never).then((value) => value), { explain: 'queryPlanner' });
        assert.deepEqual(await createAggregateChain(collection as never, [{ $match: { ok: true } }], { stream: true } as never).then((value) => value), { stream: true });
        let streamInvalidations = 0;
        const aggregateStream = new EventEmitter() as NodeJS.ReadableStream;
        const streamCollection = {
            ...collection,
            aggregate: (...args: unknown[]) => {
                calls.push({ method: 'aggregateStream', args });
                return { ...cursor, stream: () => aggregateStream };
            },
        };
        const writeStream = await createAggregateChain(streamCollection as never, [{ $merge: 'out' }], { stream: true } as never, {}, null, {
            onWriteComplete: () => { streamInvalidations += 1; },
        }).then((value) => value);
        assert.equal(writeStream, aggregateStream);
        aggregateStream.emit('end');
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(streamInvalidations, 1);
        assert.deepEqual(await aggregateDocuments(collection as never, [{ $match: { ok: true } }]), [{ id: 1 }]);
        assert.deepEqual(await findDocuments(collection as never, {}), [{ id: 1 }]);
        assert.deepEqual(await findOneDocument(collection as never, {}, { explain: true } as never), { explain: 'queryPlanner' });
        assert.equal(await countDocuments(collection as never, {}, { maxTimeMS: 1, comment: 'c' } as never), 4);
        assert.deepEqual(await countDocuments(collection as never, { a: 1 }, { explain: true, hint: 'a_1', collation: { locale: 'en' }, comment: 'c' } as never), { explain: 'queryPlanner' });
        assert.deepEqual(await distinctValues(collection as never, 'name'), ['a']);
        assert.deepEqual(streamDocuments(collection as never, {}, {}, { findLimit: 1 }), { stream: true });
        assert.deepEqual(await explainDocuments(collection as never, {}, { explain: 'allPlansExecution' } as never), { explain: 'allPlansExecution' });
        assert.deepEqual(watchDocuments(collection as never, [{ $match: { ok: true } }]), { watch: true });
        assert.ok(calls.length > 8);
    });

    it('covers collection accessor write helper success, cache invalidation, and validation branches', async () => {
        let invalidated = 0;
        const warns: unknown[] = [];
        const collection = {
            insertOne: async () => ({ insertedId: 'a' }),
            insertMany: async (_docs: unknown[]) => ({ insertedCount: 2, insertedIds: { 0: 'a', 1: 'b' } }),
            updateOne: async () => ({ modifiedCount: 1, upsertedId: null }),
            updateMany: async () => ({ modifiedCount: 2, upsertedId: null }),
            replaceOne: async () => ({ modifiedCount: 1 }),
            findOneAndReplace: async () => ({ id: 1 }),
            findOneAndUpdate: async () => ({ id: 2 }),
            findOneAndDelete: async () => ({ id: 3 }),
            deleteOne: async () => ({ deletedCount: 1 }),
            deleteMany: async () => ({ deletedCount: 2 }),
        };
        const context = {
            dbName: 'db',
            collectionName: 'items',
            collectionRef: collection,
            defaults: { slowQueryMs: -1 },
            logger: { warn: (...args: unknown[]) => warns.push(args) },
            cvFilter: <T>(value: T) => value,
            cvDoc: <T>(value: T) => value,
            cvUpdate: <T>(value: T) => value,
            invalidateAll: async () => { invalidated += 1; return invalidated; },
        };
        await insertOneForAccessor(context as never, { a: 1 } as never, { comment: 'insert' } as never);
        await insertManyForAccessor(context as never, [{ a: 1 }, { a: 2 }] as never, { ordered: false } as never);
        await updateOneForAccessor(context as never, { id: 1 } as never, { $set: { a: 2 } } as never);
        await updateManyForAccessor(context as never, { id: 1 } as never, [{ $set: { a: 3 } }] as never);
        await replaceOneForAccessor(context as never, { id: 1 } as never, { a: 3 } as never);
        await findOneAndReplaceForAccessor(context as never, { id: 1 } as never, { a: 4 } as never);
        await findOneAndUpdateForAccessor(context as never, { id: 1 } as never, { $inc: { n: 1 } } as never);
        await findOneAndDeleteForAccessor(context as never, { id: 1 } as never);
        await upsertOneForAccessor(context as never, { id: 1 } as never, { a: 5 } as never);
        await deleteOneForAccessor(context as never, { id: 1 } as never);
        await deleteManyForAccessor(context as never, { id: 1 } as never);
        assert.equal(invalidated, 11);
        assert.ok(warns.length >= 2);
        await assert.rejects(() => insertOneForAccessor(context as never, null as never), /document must be an object/);
        await assert.rejects(() => insertManyForAccessor(context as never, [] as never), /must not be empty/);
        await assert.rejects(() => updateOneForAccessor(context as never, {}, {} as never), /must not be an empty object/);
        await assert.rejects(() => updateOneForAccessor(context as never, {}, { a: 1 } as never), /must use update operators/);
        await assert.rejects(() => updateManyForAccessor(context as never, {}, [] as never), /must not be an empty array/);
        await assert.rejects(() => updateManyForAccessor(context as never, {}, [{ a: 1 }] as never), /operator must start/);
        await assert.rejects(() => replaceOneForAccessor(context as never, {}, { $set: { a: 1 } } as never), /must not contain update operators/);
    });

    it('updateOneForAccessor routes update documents through context.cvUpdate', async () => {
        const hex = '507f1f77bcf86cd799439011';
        let capturedUpdate: unknown;
        let cvUpdateCalls = 0;
        const collection = {
            updateOne: async (_filter: unknown, update: unknown) => {
                capturedUpdate = update;
                return { modifiedCount: 0, upsertedId: null };
            },
        };
        const context = {
            dbName: 'db',
            collectionName: 'items',
            collectionRef: collection,
            cvFilter: <T>(value: T) => value,
            cvDoc: <T>(value: T) => value,
            cvUpdate: <T>(value: T) => {
                cvUpdateCalls += 1;
                return value;
            },
            invalidateAll: async () => 0,
        };

        await updateOneForAccessor(context as never, { name: 'Alice' } as never, { $set: { userId: hex } } as never);

        assert.equal(cvUpdateCalls, 1);
        assert.equal(((capturedUpdate as Record<string, unknown>).$set as Record<string, unknown>).userId, hex);
    });

    it('covers runtime adapter bridge admin methods, safeguards, dynamic properties, and slow-query collection proxy', async () => {
        const emitted: Array<{ event: string; payload: unknown }> = [];
        const saved: unknown[] = [];
        const nativeCollection = {
            find: () => ({ toArray: async () => [{ id: 1 }] }),
            findOne: async () => ({ id: 1 }),
            insertOne: async () => ({ insertedId: 'a' }),
            insertMany: async () => ({ insertedCount: 1 }),
            updateOne: async () => ({ modifiedCount: 1 }),
            updateMany: async () => ({ modifiedCount: 2 }),
            deleteOne: async () => ({ deletedCount: 1 }),
            deleteMany: async () => ({ deletedCount: 2 }),
            aggregate: () => ({ toArray: async () => [{ a: 1 }] }),
            countDocuments: async () => 1,
            drop: async () => true,
        };
        const host = {
            options: { slowQueryMs: 0 },
            _defaultDb: { raw: () => ({ raw: true }) },
            _client: { db: () => ({ collection: () => nativeCollection, dropDatabase: async () => true }) },
            _iidCache: null,
            _runtimeDefaults: { namespace: { instanceId: 'iid' } },
            _logger: { warn: () => undefined },
            _slowQueryLogManager: { save: async (entry: unknown) => saved.push(entry) },
            resolveAdapterCache: () => null,
            setAdapterCache: (value: unknown) => { host.cache = value; },
            cache: null as unknown,
            initializeSlowQueryLogManager: () => host._slowQueryLogManager,
            ensureConnected: () => undefined,
            db: () => ({
                admin: () => ({ ping: async () => true, buildInfo: async () => ({ version: 'x' }), serverStatus: async () => ({ ok: 1 }), stats: async () => ({ collections: 1 }) }),
                listDatabases: async () => [{ name: 'db' }],
                listCollections: async () => [{ name: 'items' }],
                runCommand: async (cmd: unknown) => ({ cmd }),
                dropDatabase: async (options: { confirm?: boolean; allowProduction?: boolean } = {}) => {
                    if (!options.confirm) {
                        throw new Error('dropDatabase requires explicit confirmation. Pass { confirm: true } to proceed.');
                    }
                    if (['production', 'prod', 'live'].includes(process.env['NODE_ENV'] ?? '') && !options.allowProduction) {
                        throw new Error('dropDatabase is blocked in production. Pass { allowProduction: true } to override.');
                    }
                    return { dropped: true, database: 'db', timestamp: new Date() };
                },
            }),
            emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
        };
        const bridge = createRuntimeAdapterBridge(host as never);
        assert.deepEqual(bridge.db, { raw: true });
        bridge.cache = new MemoryCache({ maxEntries: 1 }) as never;
        assert.ok(host.cache);
        bridge._iidCache = new MemoryCache({ maxEntries: 1 }) as never;
        assert.ok(host._iidCache);
        assert.equal(bridge.instanceId, 'iid');
        assert.equal(await bridge.ping(), true);
        assert.deepEqual(await bridge.buildInfo(), { version: 'x' });
        assert.deepEqual(await bridge.serverStatus({ scale: 1 }), { ok: 1 });
        assert.deepEqual(await bridge.stats({ scale: 1 }), { collections: 1 });
        assert.deepEqual(await bridge.listDatabases({ nameOnly: true }), [{ name: 'db' }]);
        assert.deepEqual(await bridge.listCollections({ nameOnly: true } as never), ['items']);
        assert.deepEqual(await bridge.runCommand({ ping: 1 }), { cmd: { ping: 1 } });
        await assert.rejects(() => bridge.dropDatabase('', { confirm: true }), /Database name is required/);
        await assert.rejects(() => bridge.dropDatabase('db'), /requires explicit confirmation/);
        const previousNodeEnv = process.env['NODE_ENV'];
        try {
            process.env['NODE_ENV'] = 'production';
            await assert.rejects(() => bridge.dropDatabase('db', { confirm: true }), /blocked in production/);
            process.env['NODE_ENV'] = 'prod';
            await assert.rejects(() => bridge.dropDatabase('db', { confirm: true }), /blocked in production/);
            process.env['NODE_ENV'] = 'live';
            await assert.rejects(() => bridge.dropDatabase('db', { confirm: true }), /blocked in production/);
            process.env['NODE_ENV'] = 'test';
            assert.equal((await bridge.dropDatabase('db', { confirm: true, allowProduction: true })).dropped, true);
        } finally {
            if (previousNodeEnv === undefined) {
                delete process.env['NODE_ENV'];
            } else {
                process.env['NODE_ENV'] = previousNodeEnv;
            }
        }
        await bridge.collection('db', 'items').find({ a: 1 });
        await bridge.collection('db', 'items').insertOne({ a: 1 });
        assert.ok(saved.length >= 2);
        assert.ok(emitted.some((entry) => entry.event === 'slow-query'));
    });

    it('covers sync validation, resume token stores, lifecycle, target filtering, and error stats', async () => {
        assert.throws(() => validateTargetConfig(null, 0), /must be an object/);
        assert.throws(() => validateTargetConfig({ name: '' } as never, 0), /name must/);
        assert.throws(() => validateTargetConfig({ name: 'x' } as never, 0), /requires one/);
        assert.throws(() => validateResumeTokenConfig({ storage: 'redis' } as never), /redis is required/);
        assert.throws(() => validateSyncConfig({ enabled: true, targets: [] } as never), /targets must/);
        validateSyncConfig({ enabled: false } as never);

        const redisStore: Record<string, string> = {};
        const redis = { get: async (key: string) => redisStore[key] ?? null, set: async (key: string, value: string) => { redisStore[key] = value; }, del: async (key: string) => { delete redisStore[key]; } };
        const store = new ResumeTokenStore({ storage: 'redis', redis, key: 'k' });
        await store.save({ token: 1 });
        assert.deepEqual(await store.load(), { token: 1 });
        await store.clear();
        assert.equal(await store.load(), null);

        const listeners: Record<string, (payload?: unknown) => void> = {};
        const stream = { on: (event: string, fn: (payload?: unknown) => void) => { listeners[event] = fn; return stream; }, close: async () => undefined };
        const applied: unknown[] = [];
        const errors: unknown[] = [];
        const manager = new ChangeStreamSyncManager({
            db: { databaseName: 'db', watch: () => stream } as never,
            config: {
                enabled: true,
                collections: ['items'],
                filter: (event) => event.operationType !== 'delete',
                transform: (doc) => ({ ...doc, transformed: true }),
                resumeToken: { storage: 'file', path: '.generated/test-sync-token.json' },
                targets: [
                    { name: 'apply-ok', collections: ['items'], apply: async (event, doc) => { applied.push({ event, doc }); } },
                    { name: 'apply-fail', collections: ['items'], apply: async () => { throw new Error('apply failed'); } },
                    { name: 'skip', collections: ['other'], apply: async () => { applied.push('skip'); } },
                ],
            },
            tokenStore: { load: async () => ({ resume: 1 }), save: async (token) => { applied.push({ token }); }, clear: async () => undefined },
            logger: { error: (...args: unknown[]) => errors.push(args), warn: (...args: unknown[]) => errors.push(args), info: () => undefined, debug: () => undefined },
        });
        await manager.start();
        assert.equal(manager.getStats().isRunning, true);
        listeners['change']?.({ _id: { t: 1 }, operationType: 'insert', ns: { coll: 'items' }, fullDocument: { _id: 1 } });
        await new Promise((resolve) => setImmediate(resolve));
        listeners['error']?.(new Error('stream'));
        listeners['close']?.();
        const stats = manager.getStats();
        assert.equal(stats.eventCount, 1);
        assert.equal(stats.errorCount, 2);
        assert.equal(stats.isRunning, false);
        assert.match(stats.lastError?.message ?? '', /stream|apply failed/);
        assert.equal(stats.targets.length, 3);
        assert.deepEqual(applied, [{
            event: { _id: { t: 1 }, operationType: 'insert', ns: { coll: 'items' }, fullDocument: { _id: 1 } },
            doc: { _id: 1, transformed: true },
        }]);
        assert.ok(errors.length >= 2);
        await manager.stop();
        assert.equal(manager.getStats().isRunning, false);
        await manager.start();
        await manager.stop();
    });

    it('covers extra sync validation, file resume-token storage, and target resolution branches', async () => {
        assert.throws(() => validateTargetConfig({ name: 'x', uri: '', apply: async () => undefined } as never, 0), /uri must/);
        assert.throws(() => validateTargetConfig({ name: 'x', pool: '', apply: async () => undefined } as never, 0), /pool must/);
        assert.throws(() => validateTargetConfig({ name: 'x', apply: 'nope' as never, uri: 'mongodb://example.com' } as never, 0), /apply must/);
        assert.throws(() => validateTargetConfig({ name: 'x', databaseName: '', apply: async () => undefined } as never, 0), /databaseName must/);
        assert.throws(() => validateTargetConfig({ name: 'x', collections: [], apply: async () => undefined } as never, 0), /collections must/);
        assert.throws(() => validateResumeTokenConfig({ storage: 'memory' as never }), /must be file or redis/);
        assert.throws(() => validateResumeTokenConfig({ storage: 'file', path: 123 as never }), /path must be a string/);
        assert.throws(() => validateResumeTokenConfig({ storage: 'redis', redis: 'bad' as never }), /redis must be an object/);
        assert.throws(() => validateSyncConfig({ enabled: true, targets: [{ name: 'x', apply: async () => undefined }], collections: [] } as never), /collections must/);
        assert.throws(() => validateSyncConfig({ enabled: true, targets: [{ name: 'x', apply: async () => undefined }], filter: 'bad' as never } as never), /filter must/);
        assert.throws(() => validateSyncConfig({ enabled: true, targets: [{ name: 'x', apply: async () => undefined }], transform: 'bad' as never } as never), /transform must/);

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msq-sync-'));
        const tokenPath = path.join(tmpDir, 'resume-token.json');
        const warnings: unknown[] = [];
        const fileStore = new ResumeTokenStore({
            storage: 'file',
            path: tokenPath,
            strictLoad: false,
            logger: { warn: (...args: unknown[]) => warnings.push(args), error: () => undefined },
        });
        await fileStore.save({ token: 2 });
        assert.deepEqual(await fileStore.load(), { token: 2 });
        fs.writeFileSync(tokenPath, '{bad json', 'utf8');
        assert.equal(await fileStore.load(), null);
        assert.equal(warnings.length >= 1, true);
        await fileStore.clear();
        assert.equal(fs.existsSync(tokenPath), false);

        const manager = new ChangeStreamSyncManager({
            db: {
                databaseName: 'app',
                watch: () => ({ close: async () => undefined }),
            } as never,
            config: {
                enabled: true,
                collections: ['items'],
                targets: [{ name: 'apply-only', apply: async () => undefined }],
            },
            logger: { warn: () => undefined, error: () => undefined },
            tokenStore: { load: async () => null, save: async () => undefined, clear: async () => undefined },
        });
        const privateManager = manager as unknown as {
            buildPipeline(): unknown[];
            validateEnvironment(): Promise<void>;
            resolveTarget(target: unknown): Promise<{
                apply(event: unknown, document: unknown): Promise<void>;
                close(): Promise<void>;
            }>;
            clientFactory: (uri: string, options?: unknown) => Promise<unknown>;
        };

        assert.deepEqual(privateManager.buildPipeline(), [
            { $match: { 'ns.coll': { $in: ['items'] } } },
            { $match: { operationType: { $in: ['insert', 'update', 'replace', 'delete'] } } },
        ]);

        await assert.rejects(
            () => privateManager.validateEnvironment.call({
                db: { watch: () => { throw new Error('standalone'); } },
            }),
            /replica set or sharded cluster/,
        );

        await assert.rejects(
            () => privateManager.resolveTarget({ name: 'pool-target', pool: 'analytics' }),
            /requires poolManager/,
        );

        let closed = false;
        const replaceCalls: unknown[] = [];
        const deleteCalls: unknown[] = [];
        privateManager.clientFactory = async () => ({
            db: () => ({
                collection: () => ({
                    replaceOne: async (...args: unknown[]) => { replaceCalls.push(args); },
                    deleteOne: async (...args: unknown[]) => { deleteCalls.push(args); },
                }),
            }),
            close: async () => { closed = true; },
        });

        const poolManager = {
            selectPool() {
                return {
                    client: {
                        db: () => ({
                            collection: () => ({
                                replaceOne: async (...args: unknown[]) => { replaceCalls.push(args); },
                                deleteOne: async (...args: unknown[]) => { deleteCalls.push(args); },
                            }),
                        }),
                    },
                };
            },
        };
        const poolBacked = new ChangeStreamSyncManager({
            db: { databaseName: 'app', watch: () => ({ close: async () => undefined }) } as never,
            poolManager: poolManager as never,
            config: {
                enabled: true,
                targets: [{ name: 'pool-target', pool: 'analytics', databaseName: 'audit' }],
            },
            tokenStore: { load: async () => null, save: async () => undefined, clear: async () => undefined },
        });
        const poolPrivateManager = poolBacked as unknown as {
            resolveTarget(target: unknown): Promise<{
                apply(event: unknown, document: unknown): Promise<void>;
                close(): Promise<void>;
            }>;
        };

        const fileTarget = await poolPrivateManager.resolveTarget({ name: 'pool-target', pool: 'analytics', databaseName: 'audit' });
        await fileTarget.apply({ operationType: 'delete', ns: { coll: 'items' }, documentKey: { _id: 1 } } as never, undefined);
        await fileTarget.apply({ operationType: 'insert', ns: { coll: 'items' }, documentKey: { _id: 2 } } as never, { _id: 2, ok: true });
        await fileTarget.apply({ operationType: 'insert', ns: { coll: 'items' }, documentKey: {} } as never, undefined);
        assert.equal(deleteCalls.length, 1);
        assert.equal(replaceCalls.length, 1);

        const uriManager = new ChangeStreamSyncManager({
            db: { databaseName: 'app', watch: () => ({ close: async () => undefined }) } as never,
            config: {
                enabled: true,
                targets: [{ name: 'uri-target', uri: 'mongodb://example.com:27017', databaseName: 'audit' }],
            },
            clientFactory: async () => ({
                db: () => ({
                    collection: () => ({
                        replaceOne: async (...args: unknown[]) => { replaceCalls.push(args); },
                        deleteOne: async (...args: unknown[]) => { deleteCalls.push(args); },
                    }),
                }),
                close: async () => { closed = true; },
            }) as never,
            tokenStore: { load: async () => null, save: async () => undefined, clear: async () => undefined },
        });
        const uriPrivateManager = uriManager as unknown as {
            resolveTarget(target: unknown): Promise<{ close(): Promise<void> }>;
        };
        const ownedTarget = await uriPrivateManager.resolveTarget({ name: 'uri-target', uri: 'mongodb://example.com:27017', databaseName: 'audit' });
        await ownedTarget.close();
        assert.equal(closed, true);

        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
});
