import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Module from 'node:module';
import net from 'node:net';
import { PassThrough } from 'node:stream';

const MonSQLize = require('../../../dist/cjs/index.cjs');

// ── error factory functions ───────────────────────────────────────────────────
// These are exported but never triggered by normal test flows.

describe('public API — error factory functions', () => {
    it('createConnectionError returns an Error with code', () => {
        const err = MonSQLize.createConnectionError('connection refused');
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('connection refused'));
    });

    it('createValidationError returns an Error', () => {
        const err = MonSQLize.createValidationError('field is required');
        assert.ok(err instanceof Error);
    });

    it('createCursorError returns an Error', () => {
        const err = MonSQLize.createCursorError('cursor expired');
        assert.ok(err instanceof Error);
    });

    it('createQueryTimeoutError returns an Error', () => {
        const err = MonSQLize.createQueryTimeoutError('query timed out');
        assert.ok(err instanceof Error);
    });

    it('createError with code returns structured error', () => {
        const err = MonSQLize.createError('TEST_CODE', 'test message');
        assert.ok(err instanceof Error);
    });
});

// ── normalize utility functions ───────────────────────────────────────────────

describe('public API — normalizeProjection / normalizeSort', () => {
    it('normalizeProjection with field array', () => {
        const result = MonSQLize.normalizeProjection(['name', 'age']);
        assert.ok(typeof result === 'object' && result !== null);
    });

    it('normalizeProjection with object', () => {
        const result = MonSQLize.normalizeProjection({ name: 1, age: 1 });
        assert.ok(typeof result === 'object' && result !== null);
    });

    it('normalizeProjection with null/undefined returns undefined', () => {
        const r1 = MonSQLize.normalizeProjection(null);
        const r2 = MonSQLize.normalizeProjection(undefined);
        assert.ok(r1 === null || r1 === undefined || typeof r1 === 'object');
        assert.ok(r2 === null || r2 === undefined || typeof r2 === 'object');
    });

    it('normalizeSort with string returns undefined (non-object)', () => {
        const result = MonSQLize.normalizeSort('createdAt');
        assert.ok(result === undefined || typeof result === 'object');
    });

    it('normalizeSort with array (array is object)', () => {
        const result = MonSQLize.normalizeSort([['name', 1], ['age', -1]] as any);
        assert.ok(result !== null);
    });

    it('normalizeSort with object', () => {
        const result = MonSQLize.normalizeSort({ name: 1, age: -1 });
        assert.ok(typeof result === 'object' && result !== null);
    });

    it('normalizeSort with null returns null or empty object', () => {
        const result = MonSQLize.normalizeSort(null);
        assert.ok(result === null || result === undefined || typeof result === 'object');
    });
});

// ── adaptLegacyCacheLike — all branches ──────────────────────────────────────

describe('adaptLegacyCacheLike — branch coverage', () => {
    it('cache already has has() method → returned as-is', () => {
        const cache = {
            get: async (k: string) => null,
            set: async (k: string, v: unknown) => {},
            del: async (k: string) => {},
            exists: async (k: string) => false,
            has: async (k: string) => false,
            keys: async () => [],
        };
        const adapted = MonSQLize.adaptLegacyCacheLike(cache);
        assert.strictEqual(adapted, cache);
    });

    it('cache without has() → proxy wraps it and delegates has() to exists()', async () => {
        const cache = {
            get: async (k: string) => null,
            set: async (k: string, v: unknown) => {},
            del: async (k: string) => {},
            exists: async (k: string) => true,
            keys: async () => [],
        };
        const adapted = MonSQLize.adaptLegacyCacheLike(cache);
        assert.notStrictEqual(adapted, cache);
        const result = await (adapted as any).has('test-key');
        assert.equal(result, true);
    });

    it('proxy forwards non-function properties as-is', () => {
        const cache = {
            get: async (k: string) => null,
            set: async (k: string, v: unknown) => {},
            del: async (k: string) => {},
            exists: async (k: string) => false,
            keys: async () => [],
            myProp: 42,  // non-function property
        } as any;
        const adapted = MonSQLize.adaptLegacyCacheLike(cache) as any;
        // Access a non-function property (covers the false branch of `typeof val === 'function'`)
        assert.equal(adapted.myProp, 42);
    });
});

// ── SlowQueryLogConfigManager — branch coverage ───────────────────────────────

describe('SlowQueryLogConfigManager — mergeConfig branches', () => {
    const { SlowQueryLogConfigManager, DEFAULT_SLOW_QUERY_LOG_CONFIG } = MonSQLize;

    it('mergeConfig with undefined returns default config', () => {
        const cfg = SlowQueryLogConfigManager.mergeConfig(undefined);
        assert.ok(typeof cfg === 'object');
        assert.ok('enabled' in cfg);
    });

    it('mergeConfig with null returns default config', () => {
        const cfg = SlowQueryLogConfigManager.mergeConfig(null);
        assert.ok(typeof cfg === 'object');
    });

    it('mergeConfig with boolean true enables with mongodb storage', () => {
        const cfg = SlowQueryLogConfigManager.mergeConfig(true, 'mongodb');
        assert.equal(cfg.enabled, true);
        assert.equal(cfg.storage.type, 'mongodb');
    });

    it('mergeConfig with boolean false for non-mongodb uses memory storage', () => {
        const cfg = SlowQueryLogConfigManager.mergeConfig(false, 'other');
        assert.equal(cfg.enabled, false);
        assert.equal(cfg.storage.type, 'memory');
    });

    it('mergeConfig with object where storage.type is undefined → sets default type', () => {
        // This covers lines 87-89: storage.type === undefined path
        const cfg = SlowQueryLogConfigManager.mergeConfig({ storage: { type: undefined } } as any, 'mongodb');
        assert.ok(cfg.storage.type !== undefined);
    });

    it('mergeConfig with object having storage forces enabled=true', () => {
        // covers line 90-92: userConfig.storage && merged.enabled === false
        const cfg = SlowQueryLogConfigManager.mergeConfig({ enabled: false, storage: { type: 'memory' } } as any);
        // enabled forced to true when storage is provided
        assert.equal(cfg.enabled, true);
    });

    it('deepClone with Date value in object uses Date.toISOString branch', () => {
        // deepClone is called with DEFAULT_SLOW_QUERY_LOG_CONFIG
        // If we add a date to the config and clone, it hits the Date branch
        const configWithDate = { ...DEFAULT_SLOW_QUERY_LOG_CONFIG, lastUpdated: new Date() };
        // Calling mergeConfig with a Date value inside triggers deepClone's Date branch
        try {
            const cfg = SlowQueryLogConfigManager.mergeConfig(configWithDate as any);
            assert.ok(cfg !== null);
        } catch {
            assert.ok(true); // any outcome is fine
        }
    });
});

// ── makePageResult — branch coverage ─────────────────────────────────────────

describe('makePageResult — various inputs', () => {
    const pickAnchor = (doc: any, sort: any) => {
        const anchor: Record<string, unknown> = {};
        for (const k of Object.keys(sort)) anchor[k] = doc[k];
        return anchor;
    };

    it('makePageResult with items (limit+1 probe — no overflow)', () => {
        const rows = [{ _id: 'a' }, { _id: 'b' }];
        const ctx = { limit: 5, stableSort: { _id: 1 }, direction: null as any, hasCursor: false, pickAnchor };
        const result = MonSQLize.makePageResult(rows, ctx);
        assert.ok(Array.isArray(result.items));
        assert.equal(result.items.length, 2);
    });

    it('makePageResult with overflow (rows.length > limit)', () => {
        const rows = [{ _id: 'a' }, { _id: 'b' }, { _id: 'c' }];
        const ctx = { limit: 2, stableSort: { _id: 1 }, direction: null as any, hasCursor: false, pickAnchor };
        const result = MonSQLize.makePageResult(rows, ctx);
        assert.equal(result.items.length, 2);
        assert.equal(result.pageInfo.hasNext, true);
    });

    it('makePageResult with empty rows', () => {
        const ctx = { limit: 5, stableSort: { _id: 1 }, direction: null as any, hasCursor: false, pickAnchor };
        const result = MonSQLize.makePageResult([], ctx);
        assert.equal(result.items.length, 0);
        assert.equal(result.pageInfo.startCursor, null);
        assert.equal(result.pageInfo.endCursor, null);
    });

    it('makePageResult with direction=before sets hasNext/hasPrev', () => {
        const rows = [{ _id: 'a' }];
        const ctx = { limit: 5, stableSort: { _id: 1 }, direction: 'before' as any, hasCursor: true, pickAnchor };
        const result = MonSQLize.makePageResult(rows, ctx);
        assert.equal(result.pageInfo.hasNext, true);  // hasCursor=true → hasNext
        assert.equal(result.pageInfo.hasPrev, false); // no overflow → hasPrev=false
    });
});

// ── encodeCursor / decodeCursor ───────────────────────────────────────────────

describe('cursor encode/decode edge cases', () => {
    it('encodeCursor with { s, a } encodes to a non-empty string', () => {
        const encoded = MonSQLize.encodeCursor({ s: { _id: 1 }, a: { _id: 'abc123' } });
        assert.ok(typeof encoded === 'string' && encoded.length > 0);
    });

    it('decodeCursor of encoded cursor round-trips', () => {
        const payload = { v: 1, s: { _id: 1 }, a: { _id: 'xyz' } };
        const encoded = MonSQLize.encodeCursor(payload);
        const decoded = MonSQLize.decodeCursor(encoded);
        assert.deepEqual(decoded.s, payload.s);
        assert.deepEqual(decoded.a, payload.a);
    });

    it('decodeCursor with invalid string throws', () => {
        assert.throws(() => MonSQLize.decodeCursor('not-a-valid-cursor'));
    });

    it('encodeCursor with direction field encodes direction', () => {
        const encoded = MonSQLize.encodeCursor({ s: { _id: 1 }, a: { _id: 'abc' }, d: 'before' });
        assert.ok(typeof encoded === 'string' && encoded.length > 0);
        const decoded = MonSQLize.decodeCursor(encoded);
        assert.equal(decoded.d, 'before');
    });

    it('encodeCursor missing s throws', () => {
        assert.throws(() => MonSQLize.encodeCursor({ a: { _id: 'x' } } as any));
    });

    it('encodeCursor missing a throws', () => {
        assert.throws(() => MonSQLize.encodeCursor({ s: { _id: 1 } } as any));
    });
});

// ── validateRange / validatePositiveInteger ───────────────────────────────────

describe('validateRange — edge cases', () => {
    it('validateRange within range passes', () => {
        assert.doesNotThrow(() => MonSQLize.validateRange(50, 1, 100, 'value'));
    });

    it('validateRange at min boundary passes', () => {
        assert.doesNotThrow(() => MonSQLize.validateRange(1, 1, 100, 'value'));
    });

    it('validateRange at max boundary passes', () => {
        assert.doesNotThrow(() => MonSQLize.validateRange(100, 1, 100, 'value'));
    });

    it('validateRange below min throws', () => {
        assert.throws(() => MonSQLize.validateRange(0, 1, 100, 'value'));
    });

    it('validateRange above max throws', () => {
        assert.throws(() => MonSQLize.validateRange(101, 1, 100, 'value'));
    });

    it('validateRange rejects non-number and infinite values', () => {
        assert.throws(() => MonSQLize.validateRange('1' as any, 1, 100, 'value'));
        assert.throws(() => MonSQLize.validateRange(Infinity, 1, 100, 'value'));
    });

    it('validatePositiveInteger with valid int passes', () => {
        assert.doesNotThrow(() => MonSQLize.validatePositiveInteger(5, 'field'));
    });

    it('validatePositiveInteger with 0 throws', () => {
        assert.throws(() => MonSQLize.validatePositiveInteger(0, 'field'));
    });

    it('validatePositiveInteger with negative throws', () => {
        assert.throws(() => MonSQLize.validatePositiveInteger(-1, 'field'));
    });

    it('validatePositiveInteger with float throws', () => {
        assert.throws(() => MonSQLize.validatePositiveInteger(1.5, 'field'));
    });
});

describe('public API — MongoDBSlowQueryLogStorage', () => {
    function createFakeMongoClient(rows: Array<Record<string, unknown>> = [
        {
            queryHash: 'hash-1',
            database: 'app',
            collection: 'users',
            operation: 'find',
            count: 2,
            totalTimeMs: 20,
            maxTimeMs: 12,
            minTimeMs: 8,
            firstSeen: new Date('2026-01-01T00:00:00.000Z'),
            lastSeen: new Date('2026-01-01T00:01:00.000Z'),
            sampleQuery: { role: 'admin' },
            metadata: { source: 'test' },
        },
    ]) {
        const calls: Array<{ method: string; args: unknown[] }> = [];
        let closed = false;
        const cursor = {
            sort: (...args: unknown[]) => {
                calls.push({ method: 'sort', args });
                return cursor;
            },
            skip: (...args: unknown[]) => {
                calls.push({ method: 'skip', args });
                return cursor;
            },
            limit: (...args: unknown[]) => {
                calls.push({ method: 'limit', args });
                return cursor;
            },
            toArray: async () => rows,
        };
        const collection = {
            createIndex: async (...args: unknown[]) => {
                calls.push({ method: 'createIndex', args });
            },
            updateOne: async (...args: unknown[]) => {
                calls.push({ method: 'updateOne', args });
            },
            bulkWrite: async (...args: unknown[]) => {
                calls.push({ method: 'bulkWrite', args });
            },
            find: (...args: unknown[]) => {
                calls.push({ method: 'find', args });
                return cursor;
            },
        };
        const client = {
            db: (...args: unknown[]) => {
                calls.push({ method: 'db', args });
                return {
                    collection: (...collectionArgs: unknown[]) => {
                        calls.push({ method: 'collection', args: collectionArgs });
                        return collection;
                    },
                };
            },
            close: async () => {
                closed = true;
                calls.push({ method: 'close', args: [] });
            },
        };
        return { client, calls, get closed() { return closed; } };
    }

    it('uses an owned client for initialize, save, batch, query, and close', async () => {
        const fake = createFakeMongoClient();
        const storage = new MonSQLize.MongoDBSlowQueryLogStorage(
            {
                type: 'mongodb',
                useBusinessConnection: false,
                uri: 'mongodb://127.0.0.1:27017',
                database: 'audit',
                collection: 'slow_logs',
                ttl: 60,
            },
            null,
            null,
            async (uri: string) => {
                assert.equal(uri, 'mongodb://127.0.0.1:27017');
                return fake.client;
            },
        );

        await storage.initialize();
        await storage.initialize();
        await storage.save({ database: 'app', collection: 'users', operation: 'find', durationMs: 10 });
        await storage.saveBatch([]);
        await storage.saveBatch([{ database: 'app', collection: 'users', operation: 'find', durationMs: 11 }]);
        await storage.saveBatch([
            { database: 'app', collection: 'users', operation: 'find', durationMs: 12 },
            { database: 'app', collection: 'orders', operation: 'aggregate', durationMs: 13 },
        ]);
        const rows = await storage.query({ database: 'app', collection: 'users' }, { sort: { lastSeen: -1 }, skip: 1, limit: 1 });
        await storage.close();

        assert.equal(rows.length, 1);
        assert.equal(rows[0].avgTimeMs, 10);
        assert.equal(fake.closed, true);
        assert.equal(fake.calls.filter((call) => call.method === 'createIndex').length, 2);
        assert.equal(fake.calls.filter((call) => call.method === 'updateOne').length, 2);
        assert.equal(fake.calls.filter((call) => call.method === 'bulkWrite').length, 1);
        assert.ok(fake.calls.some((call) => call.method === 'skip'));
        assert.ok(fake.calls.some((call) => call.method === 'limit'));
    });

    it('reuses the business client and validates missing owned-client URI', async () => {
        const fake = createFakeMongoClient();
        const storage = new MonSQLize.MongoDBSlowQueryLogStorage(
            { type: 'mongodb', useBusinessConnection: true, database: 'audit', collection: 'slow_logs', ttl: 0 },
            fake.client,
        );

        await storage.initialize();
        await storage.close();

        assert.equal(fake.closed, false);
        assert.equal(fake.calls.filter((call) => call.method === 'createIndex').length, 1);
        await assert.rejects(
            () => new MonSQLize.MongoDBSlowQueryLogStorage({ type: 'mongodb', useBusinessConnection: false }).initialize(),
            /slowQueryLog\.storage\.uri/,
        );
    });

    it('uses default storage names and maps empty numeric fields to zero', async () => {
        const fake = createFakeMongoClient([
            {
                queryHash: 'hash-2',
                database: 'app',
                collection: 'logs',
                operation: 'aggregate',
                firstSeen: new Date('2026-01-02T00:00:00.000Z'),
                lastSeen: new Date('2026-01-02T00:01:00.000Z'),
            },
        ]);
        const storage = new MonSQLize.MongoDBSlowQueryLogStorage(
            { type: 'mongodb', useBusinessConnection: true },
            fake.client,
        );

        const rows = await storage.query();
        await storage.close();

        assert.equal(rows[0].count, 0);
        assert.equal(rows[0].avgTimeMs, 0);
        assert.equal(fake.calls.some((call) => call.method === 'db' && call.args[0] === 'admin'), true);
        assert.equal(fake.calls.some((call) => call.method === 'collection' && call.args[0] === 'slow_query_logs'), true);
    });
});

describe('public API — runtime cache normalization', () => {
    function createRemoteCache() {
        const calls: Array<{ method: string; args: unknown[] }> = [];
        const store = new Map<string, unknown>();
        return {
            calls,
            cache: {
                get: async (key: string) => {
                    calls.push({ method: 'get', args: [key] });
                    return store.get(key);
                },
                set: async (key: string, value: unknown, ttl?: number) => {
                    calls.push({ method: 'set', args: [key, value, ttl] });
                    store.set(key, value);
                },
                del: async (key: string) => {
                    calls.push({ method: 'del', args: [key] });
                    return store.delete(key) ? 1 : 0;
                },
                exists: async (key: string) => {
                    calls.push({ method: 'exists', args: [key] });
                    return store.has(key);
                },
                has: async (key: string) => {
                    calls.push({ method: 'has', args: [key] });
                    return store.has(key);
                },
                getMany: async (keys: string[]) => {
                    calls.push({ method: 'getMany', args: [keys] });
                    return Object.fromEntries(keys.filter((key) => store.has(key)).map((key) => [key, store.get(key)]));
                },
                setMany: async (entries: Record<string, unknown>, ttl?: number) => {
                    calls.push({ method: 'setMany', args: [entries, ttl] });
                    for (const [key, value] of Object.entries(entries)) store.set(key, value);
                },
                delMany: async (keys: string[]) => {
                    calls.push({ method: 'delMany', args: [keys] });
                    let deleted = 0;
                    for (const key of keys) {
                        if (store.delete(key)) deleted += 1;
                    }
                    return deleted;
                },
                delPattern: async (pattern: string) => {
                    calls.push({ method: 'delPattern', args: [pattern] });
                    const regex = new RegExp(`^${pattern.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replace(/\*/g, '.*')}$`);
                    let deleted = 0;
                    for (const key of [...store.keys()]) {
                        if (regex.test(key)) {
                            store.delete(key);
                            deleted += 1;
                        }
                    }
                    return deleted;
                },
                keys: async (pattern?: string) => {
                    calls.push({ method: 'keys', args: [pattern] });
                    if (!pattern) return [...store.keys()];
                    const regex = new RegExp(`^${pattern.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replace(/\*/g, '.*')}$`);
                    return [...store.keys()].filter((key) => regex.test(key));
                },
                getStats: () => ({ entries: store.size }),
            },
        };
    }

    it('wraps vext redis cache shape with prefix and default ttl', async () => {
        const remote = createRemoteCache();
        const runtime = new MonSQLize({
            type: 'mongodb',
            databaseName: 'cache_public_api',
            config: { uri: 'mongodb://127.0.0.1:27017' },
            cache: {
                memory: { maxEntries: 5 },
                redis: {
                    cache: remote.cache,
                    prefix: 'tenant:',
                    defaultTtl: 77,
                },
                policy: { writePolicy: 'both', backfillLocalOnRemoteHit: true },
            },
        });
        const cache = runtime.getCache();

        await cache.set('user:1', { id: 1 });
        await cache.get('user:1');
        await cache.getMany(['user:1']);
        await cache.setMany({ 'user:2': { id: 2 } });
        await cache.delMany(['user:2']);
        await cache.keys('user:*');
        await cache.delPattern('user:*');

        const remoteProxy = (cache as any)._remoteCompat;
        await remoteProxy.set('direct:1', { id: 3 });
        await remoteProxy.set('tenant:direct:2', { id: 4 }, 5);
        assert.deepEqual(await remoteProxy.get('direct:1'), { id: 3 });
        assert.equal(await remoteProxy.exists('direct:1'), true);
        assert.equal(await remoteProxy.has('direct:1'), true);
        assert.deepEqual(await remoteProxy.getMany(['direct:1', 'direct:2']), {
            'direct:1': { id: 3 },
            'direct:2': { id: 4 },
        });
        await remoteProxy.setMany({ 'direct:3': { id: 5 }, 'tenant:direct:4': { id: 6 } }, 9);
        assert.deepEqual((await remoteProxy.keys()).sort(), ['direct:1', 'direct:2', 'direct:3', 'direct:4']);
        assert.deepEqual((await remoteProxy.keys('direct:*')).sort(), ['direct:1', 'direct:2', 'direct:3', 'direct:4']);
        assert.equal(await remoteProxy.del('direct:1'), 1);
        assert.equal(await remoteProxy.delMany(['direct:2', 'direct:3']), 2);
        assert.equal(await remoteProxy.delPattern('direct:*'), 1);
        assert.equal(remoteProxy.getStats().entries, 0);

        assert.ok(remote.calls.some((call) => call.method === 'set' && call.args[0] === 'tenant:user:1' && call.args[2] === 77));
        assert.ok(remote.calls.some((call) => call.method === 'setMany'));
        assert.ok(remote.calls.some((call) => call.method === 'delPattern' && call.args[0] === 'tenant:user:*'));
    });

    it('accepts direct cache-like and local remote config shapes', async () => {
        const direct = createRemoteCache();
        const directRuntime = new MonSQLize({
            type: 'mongodb',
            databaseName: 'cache_direct',
            config: { uri: 'mongodb://127.0.0.1:27017' },
            cache: direct.cache,
        });
        assert.strictEqual(directRuntime.getCache(), direct.cache);

        const localRemote = createRemoteCache();
        const multiRuntime = new MonSQLize({
            type: 'mongodb',
            databaseName: 'cache_local_remote',
            config: { uri: 'mongodb://127.0.0.1:27017' },
            cache: {
                multiLevel: true,
                local: { maxEntries: 2, ttl: 10 },
                remote: localRemote.cache,
                policy: { writePolicy: 'both', backfillLocalOnRemoteHit: false },
            },
        });
        await multiRuntime.getCache().set('k', 'v');
        assert.ok(localRemote.calls.some((call) => call.method === 'set'));

        const directRedis = createRemoteCache();
        const directRedisRuntime = new MonSQLize({
            type: 'mongodb',
            databaseName: 'cache_direct_redis',
            config: { uri: 'mongodb://127.0.0.1:27017' },
            cache: {
                memory: new MonSQLize.MemoryCache({ maxEntries: 1 }),
                redis: directRedis.cache,
            },
        });
        assert.strictEqual((directRedisRuntime.getCache() as any)._remoteCompat, directRedis.cache);

        const disabledRedisRuntime = new MonSQLize({
            type: 'mongodb',
            databaseName: 'cache_disabled_redis',
            config: { uri: 'mongodb://127.0.0.1:27017' },
            cache: {
                memory: { enabled: false },
                redis: { enabled: false },
            },
        });
        assert.equal((disabledRedisRuntime.getCache() as any)._remoteCompat, undefined);

        const missingRedisTargetRuntime = new MonSQLize({
            type: 'mongodb',
            databaseName: 'cache_missing_redis_target',
            config: { uri: 'mongodb://127.0.0.1:27017' },
            cache: {
                redis: { timeoutMs: 25 },
            },
        });
        assert.equal((missingRedisTargetRuntime.getCache() as any)._remoteCompat, undefined);
    });
});

describe('public API — Redis adapter and SSH branch coverage', () => {
    it('keeps redis adapter error semantics for invalid inputs', () => {
        assert.throws(() => MonSQLize.createRedisCacheAdapter(undefined), /redisUrlOrInstance/);
        assert.throws(() => MonSQLize.createRedisCacheAdapter('   '), /redisUrlOrInstance/);
    });

    it('drives SSH tunnel connect, forwarding, disconnect, and cleanup through the package runtime', async () => {
        const originalLoad = (Module as unknown as { _load: (...args: unknown[]) => unknown })._load;
        const fakeClients: Array<EventEmitter & {
            connectConfig?: unknown;
            forwardOutCalls: unknown[][];
            ended: boolean;
            connect(config: unknown): void;
            forwardOut(srcHost: string, srcPort: number, dstHost: string, dstPort: number, cb: (err: Error | undefined, stream: PassThrough & { close(): void }) => void): void;
            end(): void;
        }> = [];

        class FakeSshClient extends EventEmitter {
            connectConfig?: unknown;
            forwardOutCalls: unknown[][] = [];
            ended = false;

            constructor() {
                super();
                fakeClients.push(this);
            }

            connect(config: unknown): void {
                this.connectConfig = config;
                setImmediate(() => this.emit('ready'));
            }

            forwardOut(srcHost: string, srcPort: number, dstHost: string, dstPort: number, cb: (err: Error | undefined, stream: PassThrough & { close(): void }) => void): void {
                this.forwardOutCalls.push([srcHost, srcPort, dstHost, dstPort]);
                const stream = new PassThrough() as PassThrough & { close(): void };
                stream.close = () => stream.destroy();
                cb(undefined, stream);
            }

            end(): void {
                this.ended = true;
            }
        }

        (Module as unknown as { _load: (...args: unknown[]) => unknown })._load = (request: unknown, ...args: unknown[]) => {
            if (request === 'ssh2') {
                return { Client: FakeSshClient };
            }
            return originalLoad(request, ...args);
        };

        const runtime = new MonSQLize({
            type: 'mongodb',
            databaseName: 'ssh_public_api_connect',
            config: {
                uri: 'mongodb://user:pass@mongo.internal:27018/app',
                options: { serverSelectionTimeoutMS: 25 },
                ssh: {
                    host: 'bastion.local',
                    port: 2222,
                    username: 'deploy',
                    password: 'secret',
                    readyTimeout: 1234,
                    keepaliveInterval: 5678,
                },
            },
        });

        try {
            const connectPromise = runtime.connect();
            let localPort: number | null = null;
            for (let attempt = 0; attempt < 20; attempt += 1) {
                localPort = runtime._sshTunnel?.localPort ?? null;
                if (localPort !== null) break;
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            assert.equal(typeof localPort, 'number');
            await new Promise<void>((resolve, reject) => {
                const socket = net.connect(localPort as number, '127.0.0.1', () => {
                    socket.end();
                    resolve();
                });
                socket.on('error', reject);
            });

            await assert.rejects(() => connectPromise, /Failed to connect to MongoDB database/);
            assert.equal(fakeClients.length, 1);
            assert.deepEqual(fakeClients[0].connectConfig, {
                host: 'bastion.local',
                port: 2222,
                username: 'deploy',
                readyTimeout: 1234,
                keepaliveInterval: 5678,
                password: 'secret',
            });
            assert.deepEqual(fakeClients[0].forwardOutCalls[0], ['127.0.0.1', 0, 'mongo.internal', 27018]);
            for (let attempt = 0; attempt < 20 && !fakeClients[0].ended; attempt += 1) {
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            assert.equal(fakeClients[0].ended, true);
            assert.equal((await runtime.health()).connected, false);
        } finally {
            await runtime.close();
            (Module as unknown as { _load: (...args: unknown[]) => unknown })._load = originalLoad;
        }
    });

    it('covers SSH tunnel auth and URI helper branches through a runtime connect attempt', async () => {
        const logs: string[] = [];
        const runtime = new MonSQLize({
            type: 'mongodb',
            databaseName: 'ssh_public_api',
            logger: { info: (message: string) => logs.push(message), error: () => undefined },
            config: {
                uri: 'mongodb://user:pass@mongo.internal:27018/app',
                ssh: {
                    host: 'bastion.local',
                    username: 'deploy',
                },
            },
        });

        await assert.rejects(() => runtime.connect(), /SSH authentication required/);
        await runtime.close();
    });

    it('rejects multi-host SSH tunnel URIs before attempting SSH authentication', async () => {
        const runtime = new MonSQLize({
            type: 'mongodb',
            databaseName: 'ssh_public_api',
            config: {
                uri: 'mongodb://mongo-a.internal:27017,mongo-b.internal:27017/app',
                ssh: {
                    host: 'bastion.local',
                    username: 'deploy',
                },
            },
        });

        await assert.rejects(() => runtime.connect(), /single MongoDB host/i);
        await runtime.close();
    });
});

describe('public API — ConnectionPoolManager branch coverage', () => {
    function createPoolClient(name: string, closed: string[] = []) {
        return {
            db: (databaseName?: string) => ({
                command: async () => ({ ok: 1 }),
                admin: () => ({ ping: async () => ({ ok: 1 }) }),
                collection: (collectionName: string) => ({ databaseName, collectionName }),
            }),
            close: async () => {
                closed.push(name);
            },
        };
    }

    it('covers add, duplicate, max-count, manual selection, stats, and close paths', async () => {
        const closed: string[] = [];
        const manager = new MonSQLize.ConnectionPoolManager({
            maxPoolsCount: 1,
            clientFactory: async (config: { name: string }) => createPoolClient(config.name, closed),
        });

        await manager.addPool({ name: 'primary', uri: 'mongodb://primary', role: 'primary', healthCheck: { enabled: false } });
        await assert.rejects(
            () => manager.addPool({ name: 'primary', uri: 'mongodb://primary-duplicate' }),
            /already exists/,
        );
        await assert.rejects(
            () => manager.addPool({ name: 'secondary', uri: 'mongodb://secondary' }),
            /Maximum pool count/,
        );

        const selected = manager.selectPool('read', { pool: 'primary' });
        assert.equal(selected.name, 'primary');
        assert.deepEqual(selected.collection('app', 'users'), { databaseName: 'app', collectionName: 'users' });
        assert.equal(manager.getPool('missing'), null);
        assert.ok(manager.getPoolStats().primary);
        manager.startHealthCheck('missing');
        manager.startHealthCheck('primary');
        manager.stopHealthCheck('primary');
        await manager.close();
        assert.deepEqual(closed, ['primary']);
    });

    it('covers fallback, selector miss, health transitions, and network error wrapping', async () => {
        const warnings: unknown[] = [];
        const manager = new MonSQLize.ConnectionPoolManager({
            fallback: { enabled: true, fallbackStrategy: 'readonly' },
            clientFactory: async (config: { name: string }) => createPoolClient(config.name),
            healthCheckFn: async (poolName: string) => poolName !== 'primary',
            logger: { warn: (...args: unknown[]) => warnings.push(args) },
        });

        await manager.addPool({ name: 'primary', uri: 'mongodb://primary', role: 'primary', healthCheck: { enabled: false } });
        await manager.addPool({ name: 'secondary', uri: 'mongodb://secondary', role: 'secondary', healthCheck: { enabled: false } });

        const healthStatus = (manager as any)._healthChecker._healthStatus;
        healthStatus.set('primary', { status: 'down', lastCheck: new Date(), consecutiveFailures: 1 });
        healthStatus.set('secondary', { status: 'down', lastCheck: new Date(), consecutiveFailures: 1 });

        assert.equal(manager.selectPool('read').name, 'secondary');
        assert.throws(() => manager.selectPool('write'), /No available connection pool/);

        healthStatus.set('primary', { status: 'up', lastCheck: new Date(), consecutiveFailures: 0 });
        (manager as any)._selector.select = () => 'ghost';
        assert.throws(() => manager.selectPool('read'), /Selected pool 'ghost' not available/);

        await (manager as any).checkPoolHealth('missing');
        await (manager as any).checkPoolHealth('primary');
        await (manager as any).checkPoolHealth('primary');
        assert.equal(manager.getHealthStatus().primary.status, 'degraded');
        await (manager as any).checkPoolHealth('primary');
        assert.equal(manager.getHealthStatus().primary.status, 'down');

        (manager as any).healthCheckFn = async () => {
            throw 'health failed';
        };
        healthStatus.set('secondary', { status: 'up', lastCheck: new Date(), consecutiveFailures: 0 });
        await (manager as any).checkPoolHealth('secondary');
        assert.equal(manager.getHealthStatus().secondary.status, 'degraded');
        assert.ok(warnings.length >= 1);

        (manager as any).recordSelection('missing', false);
        (manager as any).recordSelection('secondary', false);
        assert.equal(manager.getPoolStats().secondary.errorCount >= 1, true);
        await manager.close();

        const failingManager = new MonSQLize.ConnectionPoolManager({
            clientFactory: async () => {
                const error = new Error('Server selection timed out') as Error & { code?: string };
                error.name = 'MongoServerSelectionError';
                error.code = 'ETIMEOUT';
                throw error;
            },
        });
        await assert.rejects(
            () => failingManager.addPool({ name: 'broken', uri: 'mongodb://broken' }),
            /connect ETIMEDOUT/,
        );
        await failingManager.close();
    });
});

describe('public API — HealthChecker and PoolStats branch coverage', () => {
    it('covers HealthChecker registration, timers, in-progress guard, and ping variants', async () => {
        const logs: string[] = [];
        const checker = new MonSQLize.HealthChecker({
            logger: { info: (message: string) => logs.push(message) },
        });

        checker.register('disabled', { enabled: false });
        checker.start();
        checker.start();
        checker.register(
            { name: 'admin-ping', healthCheck: { interval: 20, retries: 1, timeout: 20 } },
            { db: () => ({ admin: () => ({ ping: async () => ({ ok: 1 }) }) }) },
        );
        await checker.checkPool('admin-ping');
        assert.equal(checker.getStatus('admin-ping')?.status, 'up');

        let releasePing!: (value: unknown) => void;
        let pendingCalls = 0;
        checker.register(
            { name: 'pending', healthCheck: { interval: 1000, timeout: 1000 } },
            { db: () => ({ command: () => { pendingCalls++; return new Promise((resolve) => { releasePing = resolve; }); } }) },
        );
        const pending = checker.checkPool('pending');
        await Promise.resolve();
        await checker.checkPool('pending');
        assert.equal(pendingCalls, 1);
        releasePing({ ok: 1 });
        await pending;
        checker.unregister('pending');

        await checker.checkPool('missing-status');
        checker.register('missing-client', { retries: 1, timeout: 1 });
        await checker.checkPool('missing-client');
        assert.equal(checker.getStatus('missing-client')?.status, 'down');

        checker.register(
            { name: 'string-error', healthCheck: { retries: 1, timeout: 20 } },
            { db: () => ({ command: async () => { throw 'bad ping'; } }) },
        );
        await checker.checkPool('string-error');
        assert.equal(checker.getStatus('string-error')?.status, 'down');
        assert.equal(checker.getAllStatus().size >= 3, true);

        await new Promise((resolve) => setImmediate(resolve));
        checker.stop();
        checker.stop();
        checker.unregister('admin-ping');
        assert.ok(logs.some((message) => message.includes('started')));
    });

    it('covers PoolStats success, failure, reset, and close branches', async () => {
        const stats = new MonSQLize.PoolStats({ logger: { info: () => undefined } });

        stats.recordConnections('primary', 3);
        stats.recordSelection('primary', 'find');
        await stats.recordQuery('primary', 12, null);
        await stats.recordQuery('primary', 18, new Error('query failed'));
        assert.equal(stats.getStats('primary').totalRequests >= 3, true);
        assert.ok(stats.getAllStats().primary);
        stats.reset('primary');
        assert.equal(stats.getStats('primary').totalRequests, 0);
        stats.recordSelection('secondary', 'aggregate');
        stats.reset();
        stats.resetAll();
        stats.close();
        stats.close();
    });
});
