import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Timestamp } from 'mongodb';
import { createInitialSyncCheckpoint, decodeStoredSyncCheckpoint } from '../../../src/capabilities/sync/resume-token-store';

const MonSQLize = require('../../../dist/cjs/index.cjs');

type ChangeEvent = {
    _id: { token: number };
    operationType: string;
    ns: { db: string; coll: string };
    documentKey: { _id: number };
    fullDocument: { _id: number; name: string };
};

function wait(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function mockHello() {
    return Promise.resolve({ operationTime: new Timestamp({ t: 1792377444, i: 42 }) });
}

function isInitialCheckpoint(value: unknown): boolean {
    return value !== null && typeof value === 'object'
        && (value as Record<string, unknown>).__monsqlizeSyncCheckpoint === 1;
}

function checkpointHarness(initial: unknown = null, config: Record<string, unknown> = {}) {
    const calls: string[] = [];
    const watchOptions: Record<string, unknown>[] = [];
    let stored = initial;
    const stream = new EventEmitter() as EventEmitter & { close(): Promise<boolean> };
    stream.close = async () => true;
    const store = {
        load: async () => { calls.push('load'); return stored; },
        save: async (value: unknown) => { calls.push('save'); stored = JSON.parse(JSON.stringify(value)); },
        clear: async () => { calls.push('clear'); stored = null; },
    };
    const db: any = {
        databaseName: 'b02_source',
        command: async () => { calls.push('hello'); return mockHello(); },
        watch: (_pipeline: unknown, options: Record<string, unknown>) => {
            calls.push('watch'); watchOptions.push(options);
            return options.maxAwaitTimeMS === 1 ? { close: async () => true } : stream;
        },
    };
    const manager = new MonSQLize.ChangeStreamSyncManager({
        db, tokenStore: store,
        config: { enabled: true, targets: [{ name: 'target', apply: async () => undefined }], ...config },
    });
    return { manager, db, store, stream, calls, watchOptions, stored: () => stored };
}

describe('P4-C sync', () => {
    it('AR07 encodes collision-free opaque tuples and preserves raw key TTL and mark modes', async () => {
        for (const markMode of ['start', 'success']) {
            const h = checkpointHarness();
            const prefix = 'prefix:\u4e2d"';
            const entries = new Map<string, unknown>([[prefix + ':a:b:c', true]]);
            const keys: string[] = [];
            const event = { _id: { token: 7 }, operationType: 'insert', ns: { db: 'source', coll: 'events' }, documentKey: { _id: 1 }, fullDocument: { _id: 1 } };
            const manager = new MonSQLize.ChangeStreamSyncManager({
                db: h.db, tokenStore: h.store,
                config: {
                    enabled: true,
                    idempotency: { enabled: true, keyPrefix: prefix, ttl: 1234, markMode,
                        keyBuilder: (received: unknown, name: string) => { assert.strictEqual(received, event); return name === 'a:b' ? 'c' : 'b:c'; },
                        store: { get: (key: string) => entries.get(key), set: (key: string, value: any, ttl: number) => {
                            assert.equal(ttl, 1234); assert.equal(value.phase, markMode); entries.set(key, value);
                        } },
                    },
                    targets: ['a:b', 'a'].map(name => ({ name, apply: async (_event: unknown, _doc: unknown, context: any) => {
                        const key = context.idempotencyKey;
                        assert.deepEqual(JSON.parse(key), ['v2', prefix, name, name === 'a:b' ? 'c' : 'b:c']);
                        assert.equal(entries.has(key), markMode === 'start'); keys.push(key);
                    } })),
                },
            });
            await manager.start();
            h.stream.emit('change', event);
            h.stream.emit('change', event);
            await manager.stop();
            assert.equal(new Set(keys).size, 2);
            assert.equal(entries.size, 3, 'ambiguous legacy markers are retained but not trusted');
            assert.equal(manager.getStats().duplicateTargetCount, 2);
            assert.equal(manager.getStats().syncedCount, 2);
        }
        for (const rawKey of [null, undefined, '']) {
            const h = checkpointHarness({ _data: 'legacy' }, {
                idempotency: { enabled: true, keyBuilder: () => rawKey, store: { get: () => assert.fail('disabled key read'), set: () => assert.fail('disabled key write') } },
                targets: [{ name: 'no-key', apply: async (_event: unknown, _doc: unknown, context: any) => assert.equal(context.idempotencyKey, undefined) }],
            });
            await h.manager.start();
            h.stream.emit('change', { _id: { token: 1 }, operationType: 'insert', ns: { coll: 'events' }, fullDocument: {} });
            await h.manager.stop();
            assert.equal(h.manager.getStats().syncedCount, 1);
        }
    });

    it('B15 rejects exact duplicate target names before opening connections or watches', () => {
        for (const enabled of [false, true]) {
            let opened = 0;
            const options = {
                db: { command: () => { opened++; }, watch: () => { opened++; } },
                clientFactory: () => { opened++; },
                config: { enabled: true, idempotency: { enabled }, targets: [
                    { name: 'same', uri: 'mongodb://target' },
                    { name: 'same', apply: async () => undefined },
                ] },
            };
            assert.throws(() => new MonSQLize.ChangeStreamSyncManager(options), (error: any) => error.code === 'INVALID_CONFIG' && /duplicate target name/.test(error.message));
            assert.equal(opened, 0);
            assert.doesNotThrow(() => MonSQLize.validateSyncConfig({
                enabled: true, idempotency: { enabled }, targets: [
                    { name: 'same', apply: async () => undefined },
                    { name: 'Same', apply: async () => undefined },
                    { name: ' same', apply: async () => undefined },
                ],
            }));
        }
    });

    it('B02 persists the initial checkpoint before any watch and without counting an event', async () => {
        const h = checkpointHarness();
        let release!: () => void;
        let entered!: () => void;
        const pending = new Promise<void>((resolve) => { release = resolve; });
        const saving = new Promise<void>((resolve) => { entered = resolve; });
        let checkpoint: unknown;
        h.store.save = async (value) => { h.calls.push('save'); checkpoint = value; entered(); await pending; };
        const starting = h.manager.start();
        try {
            await saving;
            assert.deepEqual(h.calls, ['load', 'hello', 'save']);
            assert.equal(h.watchOptions.length, 0);
            assert.equal(h.manager.getStats().eventCount, 0);
            assert.equal(h.manager.getStats().syncedCount, 0);
            release();
            await starting;
            assert.equal(isInitialCheckpoint(checkpoint), true);
            const options = h.watchOptions[h.watchOptions.length - 1]!;
            assert.ok(options.startAtOperationTime instanceof Timestamp);
            assert.equal('resumeAfter' in options, false);
            assert.equal('startAfter' in options, false);
        } finally {
            release();
            await starting.catch(() => undefined);
            await h.manager.stop();
        }
    });

    it('B02 round trips initial checkpoints and legacy tokens through file Redis and JSON stores', async () => {
        const file = path.join(os.tmpdir(), `monsqlize-b02-${process.pid}-${Date.now()}.json`);
        let redisValue: string | null = null;
        let customValue: string | null = null;
        const stores = [
            new MonSQLize.ResumeTokenStore({ storage: 'file', path: file }),
            new MonSQLize.ResumeTokenStore({ storage: 'redis', redis: {
                get: async () => redisValue,
                set: async (_key: string, value: string) => { redisValue = value; },
                del: async () => { redisValue = null; },
            } }),
            { load: async () => customValue === null ? null : JSON.parse(customValue),
                save: async (value: unknown) => { customValue = JSON.stringify(value); },
                clear: async () => { customValue = null; } },
        ];
        try {
            for (const store of stores) {
                const initial = createInitialSyncCheckpoint(new Timestamp({ t: 1792377444, i: 42 }));
                await store.save(initial);
                const decoded = decodeStoredSyncCheckpoint(await store.load());
                assert.ok('startAtOperationTime' in decoded);
                assert.ok(decoded.startAtOperationTime instanceof Timestamp);
                assert.ok(decoded.startAtOperationTime.equals(new Timestamp({ t: 1792377444, i: 42 })));
                const rawToken = { _data: 'legacy-token', metadata: 7 };
                await store.save(rawToken);
                assert.deepEqual(decodeStoredSyncCheckpoint(await store.load()), { resumeAfter: rawToken });
                await store.clear();
            }
        } finally {
            await fs.rm(file, { force: true });
            await fs.rm(`${file}.bak`, { force: true });
        }
    });

    it('B02 restarts directly from the persisted operation time without resetting it', async () => {
        const initial = JSON.parse(JSON.stringify(createInitialSyncCheckpoint(new Timestamp({ t: 1792377444, i: 42 }))));
        const h = checkpointHarness(initial);
        try {
            await h.manager.start();
            assert.deepEqual(h.calls, ['load', 'watch', 'watch']);
            const operationTime = h.watchOptions[h.watchOptions.length - 1]!.startAtOperationTime as Timestamp;
            assert.ok(operationTime.equals(new Timestamp({ t: 1792377444, i: 42 })));
            assert.equal(h.watchOptions[h.watchOptions.length - 1]!.resumeAfter, undefined);
        } finally { await h.manager.stop(); }
    });

    it('B02 preserves raw legacy resume tokens without obtaining a new operation time', async () => {
        const token = { _data: 'legacy-token' };
        const h = checkpointHarness(token);
        await h.manager.start();
        try {
            assert.deepEqual(h.calls, ['load', 'watch', 'watch']);
            assert.strictEqual(h.watchOptions[h.watchOptions.length - 1]!.resumeAfter, token);
            assert.equal('startAtOperationTime' in h.watchOptions[h.watchOptions.length - 1]!, false);
        } finally { await h.manager.stop(); }
    });

    it('B02 validates checkpoint envelopes even when best-effort loading was requested', async () => {
        const valid = createInitialSyncCheckpoint(new Timestamp({ t: 10, i: 1 }));
        const malformed = [
            { ...valid, __monsqlizeSyncCheckpoint: 2 }, { ...valid, kind: 'unknown' },
            { ...valid, value: undefined }, { ...valid, value: { $timestamp: { t: '10', i: 1 } } },
            ...[-1, 1.5, 0x100000000].map(t => ({ ...valid, value: { $timestamp: { t, i: 1 } } })),
            { ...valid, value: { $timestamp: { t: 10, i: -1 } } },
        ];
        for (const value of malformed) {
            const h = checkpointHarness(value, { resumeToken: { strictLoad: false } });
            await assert.rejects(() => h.manager.start(), /invalid persisted operation-time checkpoint/);
            assert.deepEqual(h.calls, ['load']);
            await h.manager.stop();
        }
    });

    it('B02 accepts only server BSON timestamps and fails before watch on strict store errors', async () => {
        const fallback = checkpointHarness();
        fallback.db.command = async () => ({ operationTime: 'invalid', $clusterTime: { clusterTime: new Timestamp({ t: 10, i: 2 }) } });
        await fallback.manager.start();
        assert.ok(fallback.watchOptions[fallback.watchOptions.length - 1]!.startAtOperationTime instanceof Timestamp);
        await fallback.manager.stop();
        for (const failure of ['time', 'load', 'save']) {
            const h = checkpointHarness();
            if (failure === 'time') h.db.command = async () => ({ operationTime: new Date() });
            if (failure === 'load') h.store.load = async () => { throw new Error('strict load failed'); };
            if (failure === 'save') h.store.save = async () => { throw new Error('strict save failed'); };
            await assert.rejects(() => h.manager.start(), /valid BSON operation time|strict (load|save) failed/);
            assert.equal(h.watchOptions.length, 0);
            await h.manager.stop();
        }
    });

    it('B02 preserves explicit best-effort store behavior without claiming durable progress', async () => {
        let attempts = 0;
        const store = new MonSQLize.ResumeTokenStore({
            storage: 'redis', strictLoad: false, strictSave: false, saveRetries: 0,
            logger: { warn: () => undefined, error: () => undefined },
            redis: {
                get: async () => { throw new Error('offline'); },
                set: async () => { attempts += 1; throw new Error('offline'); },
                del: async () => undefined,
            },
        });
        const h = checkpointHarness();
        h.store.load = () => store.load();
        h.store.save = value => store.save(value);
        await h.manager.start();
        try {
            assert.equal(attempts, 1);
            assert.equal(h.watchOptions.length, 2);
            assert.equal(h.manager.getStats().syncedCount, 0);
            assert.equal(h.stored(), null);
        } finally { await h.manager.stop(); }
    });

    it('B02 retains the persisted point after history errors instead of clearing or resetting it', async () => {
        const initial = createInitialSyncCheckpoint(new Timestamp({ t: 10, i: 1 }));
        const h = checkpointHarness(JSON.parse(JSON.stringify(initial)));
        await h.manager.start();
        h.stream.emit('error', Object.assign(new Error('ChangeStreamHistoryLost'), { code: 286 }));
        await h.manager.stop();
        assert.equal(h.manager.getStats().isRunning, false);
        assert.deepEqual(h.stored(), initial);
        await h.manager.start();
        await h.manager.stop();
        assert.equal(h.calls.includes('clear'), false);
        assert.equal(h.calls.includes('hello'), false);
        assert.equal(h.calls.includes('save'), false);
        assert.ok(h.watchOptions.filter(o => 'startAtOperationTime' in o).length >= 2);
    });

    it('B02 stops startup before watch when stop supersedes an initial save', async () => {
        const h = checkpointHarness();
        let entered!: () => void;
        let release!: () => void;
        const saving = new Promise<void>(resolve => { entered = resolve; });
        const pending = new Promise<void>(resolve => { release = resolve; });
        h.store.save = async () => { entered(); await pending; };
        const starting = h.manager.start();
        const rejected = assert.rejects(starting, /superseded/);
        await saving;
        const stopping = h.manager.stop();
        release();
        await Promise.all([rejected, stopping]);
        assert.equal(h.watchOptions.length, 0);
    });
    it('supports ResumeTokenStore file read/write round trip', async () => {
        const tokenPath = path.join(os.tmpdir(), `monsqlize-sync-${Date.now()}.json`);
        const store = new MonSQLize.ResumeTokenStore({
            storage: 'file',
            path: tokenPath,
        });

        await store.save({ token: 1 });
        assert.deepEqual(await store.load(), { token: 1 });
        await store.clear();
        assert.equal(await store.load(), null);
        await fs.rm(tokenPath, { force: true });
    });

    it('keeps a backup and rejects corrupted file tokens in strict mode', async () => {
        const tokenPath = path.join(os.tmpdir(), `monsqlize-sync-atomic-${Date.now()}.json`);
        const store = new MonSQLize.ResumeTokenStore({
            storage: 'file',
            path: tokenPath,
            logger: { warn: () => undefined, error: () => undefined },
        });

        await store.save({ token: 1 });
        await store.save({ token: 2 });
        assert.deepEqual(await store.load(), { token: 2 });
        assert.deepEqual(JSON.parse(await fs.readFile(`${tokenPath}.bak`, 'utf8')), { token: 1 });

        await fs.writeFile(tokenPath, '{ invalid json', 'utf8');
        await assert.rejects(() => store.load(), /failed to load resume token/i);

        const legacyStore = new MonSQLize.ResumeTokenStore({
            storage: 'file',
            path: tokenPath,
            strictLoad: false,
            logger: { warn: () => undefined, error: () => undefined },
        });
        assert.equal(await legacyStore.load(), null);

        await fs.rm(tokenPath, { force: true });
        await fs.rm(`${tokenPath}.bak`, { force: true });
    });

    it('supports minimal Change Stream manager start, event handling, and stats', async () => {
        let watchCount = 0;
        const liveStream = new EventEmitter() as EventEmitter & { close(): Promise<boolean> };
        liveStream.close = () => Promise.resolve(true);
        const applied: Array<{ event: ChangeEvent; document: ChangeEvent['fullDocument'] }> = [];
        let savedToken: unknown = null;

        const db = {
            databaseName: 'source_db',
            command: mockHello,
            watch() {
                watchCount += 1;
                if (watchCount === 1) {
                    return {
                        close: () => Promise.resolve(true),
                    };
                }
                return liveStream;
            },
        };

        const manager = new MonSQLize.ChangeStreamSyncManager({
            db,
            config: {
                enabled: true,
                collections: ['users'],
                targets: [
                    {
                        name: 'backup-users',
                        apply: (event: ChangeEvent, document: ChangeEvent['fullDocument']) => {
                            applied.push({ event, document });
                            return Promise.resolve();
                        },
                    },
                ],
            },
            tokenStore: {
                load: () => Promise.resolve(savedToken),
                save: (token: unknown) => {
                    savedToken = token;
                    return Promise.resolve();
                },
                clear: () => {
                    savedToken = null;
                    return Promise.resolve();
                },
            },
        });

        await manager.start();
        liveStream.emit('change', {
            _id: { token: 1 },
            operationType: 'insert',
            ns: { db: 'source_db', coll: 'users' },
            documentKey: { _id: 1 },
            fullDocument: { _id: 1, name: 'Ada' },
        });

        await wait(20);

        const stats = manager.getStats();
        assert.equal(stats.isRunning, true);
        assert.equal(stats.eventCount, 1);
        assert.equal(stats.syncedCount, 1);
        assert.equal(applied.length, 1);
        assert.deepEqual(applied[0].document, { _id: 1, name: 'Ada' });
        assert.deepEqual(savedToken, { token: 1 });

        await manager.stop();
        assert.equal(manager.getStats().isRunning, false);
    });

    it('treats collections wildcard as all collections for pipelines and target filters', async () => {
        const liveStream = new EventEmitter() as EventEmitter & { close(): Promise<boolean> };
        liveStream.close = () => Promise.resolve(true);
        const pipelines: unknown[][] = [];
        const applied: string[] = [];
        let saved = 0;

        const db = {
            databaseName: 'source_db',
            command: mockHello,
            watch(pipeline: unknown[], options: Record<string, unknown>) {
                if (options?.maxAwaitTimeMS === 1) {
                    return { close: () => Promise.resolve(true) };
                }
                pipelines.push(pipeline);
                return liveStream;
            },
        };

        const manager = new MonSQLize.ChangeStreamSyncManager({
            db,
            config: {
                enabled: true,
                collections: ['*'],
                targets: [
                    {
                        name: 'all-target',
                        collections: ['*'],
                        apply: async (event: ChangeEvent) => {
                            applied.push(event.ns.coll);
                        },
                    },
                ],
            },
            tokenStore: {
                load: () => Promise.resolve(null),
                save: (token: unknown) => {
                    if (isInitialCheckpoint(token)) return Promise.resolve();
                    saved += 1;
                    return Promise.resolve();
                },
                clear: () => Promise.resolve(),
            },
        });

        await manager.start();
        liveStream.emit('change', {
            _id: { token: 9 },
            operationType: 'insert',
            ns: { db: 'source_db', coll: 'users' },
            documentKey: { _id: 1 },
            fullDocument: { _id: 1, name: 'Ada' },
        });

        await wait(20);
        await manager.stop();

        assert.deepEqual(pipelines[0], [
            {
                $match: {
                    operationType: {
                        $in: ['insert', 'update', 'replace', 'delete'],
                    },
                },
            },
        ]);
        assert.deepEqual(applied, ['users']);
        assert.equal(saved, 1);
    });

    it('marks the manager stopped when the live change stream closes unexpectedly', async () => {
        let watchCount = 0;
        const liveStream = new EventEmitter() as EventEmitter & { close(): Promise<boolean> };
        liveStream.close = () => Promise.resolve(true);

        const db = {
            databaseName: 'source_db',
            command: mockHello,
            watch() {
                watchCount += 1;
                if (watchCount === 1) {
                    return {
                        close: () => Promise.resolve(true),
                    };
                }
                return liveStream;
            },
        };

        const manager = new MonSQLize.ChangeStreamSyncManager({
            db,
            config: {
                enabled: true,
                targets: [
                    {
                        name: 'backup-users',
                        apply: () => Promise.resolve(),
                    },
                ],
            },
            tokenStore: {
                load: () => Promise.resolve(null),
                save: () => Promise.resolve(),
                clear: () => Promise.resolve(),
            },
            logger: { warn: () => undefined, error: () => undefined, info: () => undefined, debug: () => undefined },
        });

        await manager.start();
        liveStream.emit('close');

        const stats = manager.getStats();
        assert.equal(stats.isRunning, false);
        assert.equal(stats.errorCount, 1);
        assert.match(stats.lastError?.message ?? '', /closed unexpectedly/i);

        await manager.stop();
    });

    it('processes change events serially before saving resume tokens', async () => {
        const liveStream = new EventEmitter() as EventEmitter & { close(): Promise<boolean> };
        liveStream.close = () => Promise.resolve(true);
        const applied: number[] = [];
        const savedTokens: number[] = [];

        const db = {
            databaseName: 'source_db',
            command: mockHello,
            watch(_pipeline: unknown[], options: Record<string, unknown>) {
                if (options?.maxAwaitTimeMS === 1) {
                    return { close: () => Promise.resolve(true) };
                }
                return liveStream;
            },
        };

        const manager = new MonSQLize.ChangeStreamSyncManager({
            db,
            config: {
                enabled: true,
                collections: ['users'],
                targets: [
                    {
                        name: 'ordered-target',
                        apply: async (event: ChangeEvent) => {
                            if (event._id.token === 1) {
                                await wait(30);
                            }
                            applied.push(event._id.token);
                        },
                    },
                ],
            },
            tokenStore: {
                load: () => Promise.resolve(null),
                save: (token: unknown) => {
                    if (isInitialCheckpoint(token)) return Promise.resolve();
                    savedTokens.push((token as ChangeEvent['_id']).token);
                    return Promise.resolve();
                },
                clear: () => Promise.resolve(),
            },
        });

        await manager.start();
        liveStream.emit('change', {
            _id: { token: 1 },
            operationType: 'insert',
            ns: { db: 'source_db', coll: 'users' },
            documentKey: { _id: 1 },
            fullDocument: { _id: 1, name: 'Ada' },
        });
        liveStream.emit('change', {
            _id: { token: 2 },
            operationType: 'update',
            ns: { db: 'source_db', coll: 'users' },
            documentKey: { _id: 1 },
            fullDocument: { _id: 1, name: 'Ada2' },
        });

        await manager.stop();
        assert.deepEqual(applied, [1, 2]);
        assert.deepEqual(savedTokens, [1, 2]);
    });

    it('does not save a shared resume token when any eligible target fails', async () => {
        const liveStream = new EventEmitter() as EventEmitter & { close(): Promise<boolean> };
        liveStream.close = () => Promise.resolve(true);
        const applied: string[] = [];
        const savedTokens: number[] = [];

        const db = {
            databaseName: 'source_db',
            command: mockHello,
            watch(_pipeline: unknown[], options: Record<string, unknown>) {
                if (options?.maxAwaitTimeMS === 1) {
                    return { close: () => Promise.resolve(true) };
                }
                return liveStream;
            },
        };

        const manager = new MonSQLize.ChangeStreamSyncManager({
            db,
            config: {
                enabled: true,
                collections: ['users'],
                targets: [
                    {
                        name: 'ok',
                        collections: ['users'],
                        apply: async () => {
                            applied.push('ok');
                        },
                    },
                    {
                        name: 'bad',
                        collections: ['users'],
                        apply: async () => {
                            throw new Error('target failed');
                        },
                    },
                    {
                        name: 'skipped',
                        collections: ['orders'],
                        apply: async () => {
                            applied.push('skipped');
                        },
                    },
                ],
            },
            tokenStore: {
                load: () => Promise.resolve(null),
                save: (token: unknown) => {
                    if (isInitialCheckpoint(token)) return Promise.resolve();
                    savedTokens.push((token as ChangeEvent['_id']).token);
                    return Promise.resolve();
                },
                clear: () => Promise.resolve(),
            },
            logger: { error: () => undefined, warn: () => undefined, info: () => undefined, debug: () => undefined },
        });

        await manager.start();
        liveStream.emit('change', {
            _id: { token: 3 },
            operationType: 'insert',
            ns: { db: 'source_db', coll: 'users' },
            documentKey: { _id: 1 },
            fullDocument: { _id: 1, name: 'Ada' },
        });

        await wait(20);
        await manager.stop();

        assert.deepEqual(applied, ['ok']);
        assert.deepEqual(savedTokens, []);
        const stats = manager.getStats();
        assert.equal(stats.syncedCount, 0);
        assert.equal(stats.errorCount, 1);
    });

    it('saves tokens for filtered events and events with no eligible target', async () => {
        const stream = new EventEmitter() as EventEmitter & { close(): Promise<boolean> };
        stream.close = async () => true;
        const saved: number[] = [];
        const manager = new MonSQLize.ChangeStreamSyncManager({
            db: {
                databaseName: 'source_db',
            command: mockHello,
                watch(_pipeline: unknown[], options: Record<string, unknown>) {
                    return options?.maxAwaitTimeMS === 1 ? { close: async () => true } : stream;
                },
            },
            config: {
                enabled: true,
                filter: (event: ChangeEvent) => event._id.token !== 1,
                targets: [{ name: 'orders-only', collections: ['orders'], apply: async () => undefined }],
            },
            tokenStore: {
                load: async () => null,
                save: async (token: unknown) => { if (!isInitialCheckpoint(token)) saved.push((token as ChangeEvent['_id']).token); },
                clear: async () => undefined,
            },
        });
        await manager.start();
        for (const token of [1, 2]) {
            stream.emit('change', {
                _id: { token }, operationType: 'insert', ns: { db: 'source_db', coll: 'users' },
                documentKey: { _id: token }, fullDocument: { _id: token, name: 'skip' },
            });
        }
        await manager.stop();
        assert.deepEqual(saved, [1, 2]);
        assert.equal(manager.getStats().syncedCount, 2);
    });

    it('cleans staged owned clients after a partial target failure and retries every target', async () => {
        const closed: string[] = [];
        let secondFails = true;
        const manager = new MonSQLize.ChangeStreamSyncManager({
            db: {
                databaseName: 'source_db',
            command: mockHello,
                watch(_pipeline: unknown[], options: Record<string, unknown>) {
                    if (options?.maxAwaitTimeMS === 1) return { close: async () => true };
                    const stream = new EventEmitter() as EventEmitter & { close(): Promise<boolean> };
                    stream.close = async () => true;
                    return stream;
                },
            },
            config: {
                enabled: true,
                targets: [
                    { name: 'first', uri: 'mongodb://first' },
                    { name: 'second', uri: 'mongodb://second' },
                ],
            },
            clientFactory: async (uri: string) => {
                if (uri.endsWith('second') && secondFails) {
                    secondFails = false;
                    throw new Error('second target unavailable');
                }
                return {
                    db: () => ({ collection: () => ({}) }),
                    close: async () => { closed.push(uri); },
                } as any;
            },
            tokenStore: { load: async () => null, save: async () => undefined, clear: async () => undefined },
        });
        await assert.rejects(() => manager.start(), /second target unavailable/);
        assert.deepEqual(closed, ['mongodb://first']);
        assert.equal(manager.getStats().targets.length, 0);
        await manager.start();
        assert.deepEqual(manager.getStats().targets.map((target: any) => target.name), ['first', 'second']);
        await manager.stop();
        assert.deepEqual(closed.sort(), ['mongodb://first', 'mongodb://first', 'mongodb://second']);
    });

    it('waits for a fatal stream close before starting the replacement stream', async () => {
        const streams: Array<EventEmitter & { close(): Promise<boolean> }> = [];
        let releaseFirstClose: (() => void) | undefined;
        let failOnce = true;
        const db = {
            databaseName: 'source_db',
            command: mockHello,
            watch(_pipeline: unknown[], options: Record<string, unknown>) {
                if (options?.maxAwaitTimeMS === 1) return { close: () => Promise.resolve(true) };
                const stream = new EventEmitter() as EventEmitter & { close(): Promise<boolean> };
                stream.close = streams.length === 0
                    ? () => new Promise<boolean>((resolve) => {
                        releaseFirstClose = () => resolve(true);
                    })
                    : () => Promise.resolve(true);
                streams.push(stream);
                return stream;
            },
        };
        const manager = new MonSQLize.ChangeStreamSyncManager({
            db,
            config: {
                enabled: true,
                collections: ['users'],
                targets: [{
                    name: 'flaky',
                    async apply() {
                        if (failOnce) {
                            failOnce = false;
                            throw new Error('target failed once');
                        }
                    },
                }],
            },
            tokenStore: {
                load: () => Promise.resolve(null),
                save: () => Promise.resolve(),
                clear: () => Promise.resolve(),
            },
            logger: { error: () => undefined, warn: () => undefined, info: () => undefined, debug: () => undefined },
        });

        await manager.start();
        streams[0].emit('change', {
            _id: { token: 1 },
            operationType: 'insert',
            ns: { db: 'source_db', coll: 'users' },
            documentKey: { _id: 1 },
            fullDocument: { _id: 1, name: 'Ada' },
        });
        await wait(20);
        assert.equal(manager.getStats().isRunning, false);

        const restart = manager.start();
        await wait(5);
        assert.equal(streams.length, 1);
        releaseFirstClose?.();
        await restart;
        assert.equal(streams.length, 2);
        assert.equal(manager.getStats().isRunning, true);

        streams[1].emit('change', {
            _id: { token: 2 },
            operationType: 'insert',
            ns: { db: 'source_db', coll: 'users' },
            documentKey: { _id: 2 },
            fullDocument: { _id: 2, name: 'Grace' },
        });
        await wait(20);
        assert.equal(manager.getStats().syncedCount, 1);
        await manager.stop();
    });

    it('does not let a queued token pass a transform failure during immediate restart', async () => {
        const streams: Array<EventEmitter & { close(): Promise<boolean> }> = [];
        const saved: number[] = [];
        const manager = new MonSQLize.ChangeStreamSyncManager({
            db: {
                databaseName: 'source_db',
            command: mockHello,
                watch(_pipeline: unknown[], options: Record<string, unknown>) {
                    if (options?.maxAwaitTimeMS === 1) return { close: async () => true };
                    const stream = new EventEmitter() as EventEmitter & { close(): Promise<boolean> };
                    stream.close = async () => true;
                    streams.push(stream);
                    return stream;
                },
            },
            config: {
                enabled: true,
                transform: (_document: unknown, event: ChangeEvent) => {
                    if (event._id.token === 1) throw new Error('transform A failed');
                    return event.fullDocument;
                },
                targets: [{ name: 'sink', apply: async () => undefined }],
            },
            tokenStore: {
                load: async () => null,
                save: async (token: unknown) => { if (!isInitialCheckpoint(token)) saved.push((token as ChangeEvent['_id']).token); },
                clear: async () => undefined,
            },
            logger: { error: () => undefined, warn: () => undefined, info: () => undefined, debug: () => undefined },
        });
        await manager.start();
        for (const token of [1, 2]) {
            streams[0].emit('change', {
                _id: { token }, operationType: 'insert', ns: { db: 'source_db', coll: 'users' },
                documentKey: { _id: token }, fullDocument: { _id: token, name: 'event' },
            });
        }
        await wait(5);
        assert.equal(manager.getStats().isRunning, false);
        await manager.start();
        assert.deepEqual(saved, []);
        streams[1].emit('change', {
            _id: { token: 3 }, operationType: 'insert', ns: { db: 'source_db', coll: 'users' },
            documentKey: { _id: 3 }, fullDocument: { _id: 3, name: 'recovered' },
        });
        await manager.stop();
        assert.deepEqual(saved, [3]);
    });

    it('skips already applied targets with sync idempotency on replay', async () => {
        const createLiveStream = () => {
            const liveStream = new EventEmitter() as EventEmitter & { close(): Promise<boolean> };
            liveStream.close = () => Promise.resolve(true);
            return liveStream;
        };
        const store = new Map<string, unknown>();
        const idempotencyStore = {
            get: (key: string) => store.get(key),
            set: (key: string, value: unknown) => {
                store.set(key, value);
            },
        };
        let applyCount = 0;
        const savedTokens: number[] = [];
        const makeDb = (liveStream: EventEmitter & { close(): Promise<boolean> }) => ({
            databaseName: 'source_db',
            command: mockHello,
            watch(_pipeline: unknown[], options: Record<string, unknown>) {
                if (options?.maxAwaitTimeMS === 1) {
                    return { close: () => Promise.resolve(true) };
                }
                return liveStream;
            },
        });
        const event = {
            _id: { token: 7 },
            operationType: 'insert',
            ns: { db: 'source_db', coll: 'users' },
            documentKey: { _id: 1 },
            fullDocument: { _id: 1, name: 'Ada' },
        };

        const firstStream = createLiveStream();
        const firstManager = new MonSQLize.ChangeStreamSyncManager({
            db: makeDb(firstStream),
            config: {
                enabled: true,
                collections: ['users'],
                idempotency: { enabled: true, store: idempotencyStore },
                targets: [
                    {
                        name: 'outbox',
                        apply: async (_event: ChangeEvent, _document: ChangeEvent['fullDocument'], context: { idempotencyKey?: string }) => {
                            assert.ok(context.idempotencyKey?.includes('outbox'));
                            applyCount += 1;
                        },
                    },
                ],
            },
            tokenStore: {
                load: () => Promise.resolve(null),
                save: async (token: unknown) => { if (!isInitialCheckpoint(token)) throw new Error('token store down'); },
                clear: () => Promise.resolve(),
            },
            logger: { error: () => undefined, warn: () => undefined, info: () => undefined, debug: () => undefined },
        });
        await firstManager.start();
        firstStream.emit('change', event);
        await wait(20);
        await firstManager.stop();

        assert.equal(applyCount, 1);
        assert.equal(store.size, 1);

        const secondStream = createLiveStream();
        const secondManager = new MonSQLize.ChangeStreamSyncManager({
            db: makeDb(secondStream),
            config: {
                enabled: true,
                collections: ['users'],
                idempotency: { enabled: true, store: idempotencyStore },
                targets: [
                    {
                        name: 'outbox',
                        apply: async () => {
                            applyCount += 1;
                        },
                    },
                ],
            },
            tokenStore: {
                load: () => Promise.resolve(null),
                save: (token: unknown) => {
                    if (isInitialCheckpoint(token)) return Promise.resolve();
                    savedTokens.push((token as ChangeEvent['_id']).token);
                    return Promise.resolve();
                },
                clear: () => Promise.resolve(),
            },
            logger: { error: () => undefined, warn: () => undefined, info: () => undefined, debug: () => undefined },
        });
        await secondManager.start();
        secondStream.emit('change', event);
        await wait(20);
        await secondManager.stop();

        assert.equal(applyCount, 1);
        assert.deepEqual(savedTokens, [7]);
        const stats = secondManager.getStats();
        assert.equal(stats.duplicateTargetCount, 1);
        assert.equal(stats.duplicateEventCount, 1);
    });

    it('warns when sync idempotency uses the in-memory fallback store', () => {
        const warnings: string[] = [];
        const db = {
            databaseName: 'source_db',
            command: mockHello,
            watch: () => ({ close: () => Promise.resolve(true) }),
        };

        new MonSQLize.ChangeStreamSyncManager({
            db,
            config: {
                enabled: true,
                idempotency: { enabled: true },
                targets: [{ name: 'target', apply: async () => undefined }],
            },
            logger: {
                warn: (message: string) => warnings.push(message),
                error: () => undefined,
                info: () => undefined,
                debug: () => undefined,
            },
        });

        assert.ok(warnings.some((message) => message.includes('memory fallback only protects replay within the current process')));
    });

    it('does not warn when sync idempotency receives an explicit store', () => {
        const warnings: string[] = [];
        const db = {
            databaseName: 'source_db',
            command: mockHello,
            watch: () => ({ close: () => Promise.resolve(true) }),
        };

        new MonSQLize.ChangeStreamSyncManager({
            db,
            config: {
                enabled: true,
                idempotency: {
                    enabled: true,
                    store: {
                        get: () => undefined,
                        set: () => undefined,
                    },
                },
                targets: [{ name: 'target', apply: async () => undefined }],
            },
            logger: {
                warn: (message: string) => warnings.push(message),
                error: () => undefined,
                info: () => undefined,
                debug: () => undefined,
            },
        });

        assert.equal(warnings.length, 0);
    });

    it('stops processing changes when resume token persistence fails', async () => {
        const liveStream = new EventEmitter() as EventEmitter & { close(): Promise<boolean> };
        let closed = false;
        liveStream.close = async () => {
            closed = true;
            return true;
        };
        const applied: number[] = [];

        const db = {
            databaseName: 'source_db',
            command: mockHello,
            watch(_pipeline: unknown[], options: Record<string, unknown>) {
                if (options?.maxAwaitTimeMS === 1) {
                    return { close: () => Promise.resolve(true) };
                }
                return liveStream;
            },
        };

        const manager = new MonSQLize.ChangeStreamSyncManager({
            db,
            config: {
                enabled: true,
                collections: ['users'],
                targets: [
                    {
                        name: 'strict-token-target',
                        apply: async (event: ChangeEvent) => {
                            applied.push(event._id.token);
                        },
                    },
                ],
            },
            tokenStore: {
                load: () => Promise.resolve(null),
                save: async (token: unknown) => { if (!isInitialCheckpoint(token)) throw new Error('token store down'); },
                clear: () => Promise.resolve(),
            },
            logger: { error: () => undefined, warn: () => undefined, info: () => undefined, debug: () => undefined },
        });

        await manager.start();
        liveStream.emit('change', {
            _id: { token: 6 },
            operationType: 'insert',
            ns: { db: 'source_db', coll: 'users' },
            documentKey: { _id: 1 },
            fullDocument: { _id: 1, name: 'Ada' },
        });
        await wait(20);
        liveStream.emit('change', {
            _id: { token: 7 },
            operationType: 'update',
            ns: { db: 'source_db', coll: 'users' },
            documentKey: { _id: 1 },
            fullDocument: { _id: 1, name: 'Ada2' },
        });
        await wait(20);

        const stats = manager.getStats();
        assert.deepEqual(applied, [6]);
        assert.equal(closed, true);
        assert.equal(stats.isRunning, false);
        assert.equal(stats.syncedCount, 0);
        assert.equal(stats.errorCount, 1);
        assert.equal(stats.tokenSaveErrorCount, 1);
        assert.ok(stats.lastTokenSaveError instanceof Error);

        await manager.stop();
    });

    it('applies the manager transform once and passes undefined documents for delete events', async () => {
        const liveStream = new EventEmitter() as EventEmitter & { close(): Promise<boolean> };
        liveStream.close = () => Promise.resolve(true);
        let transformCalls = 0;
        const seen: Array<{ target: string; document: unknown }> = [];

        const db = {
            databaseName: 'source_db',
            command: mockHello,
            watch(_pipeline: unknown[], options: Record<string, unknown>) {
                if (options?.maxAwaitTimeMS === 1) {
                    return { close: () => Promise.resolve(true) };
                }
                return liveStream;
            },
        };

        const manager = new MonSQLize.ChangeStreamSyncManager({
            db,
            config: {
                enabled: true,
                collections: ['users'],
                transform: (doc: unknown) => {
                    transformCalls += 1;
                    if (doc === undefined) {
                        return undefined;
                    }
                    return { ...(doc as Record<string, unknown>), transformed: true };
                },
                targets: [
                    {
                        name: 'a',
                        apply: async (_event: ChangeEvent, document: unknown) => {
                            seen.push({ target: 'a', document });
                        },
                    },
                    {
                        name: 'b',
                        apply: async (_event: ChangeEvent, document: unknown) => {
                            seen.push({ target: 'b', document });
                        },
                    },
                ],
            },
            tokenStore: {
                load: () => Promise.resolve(null),
                save: () => Promise.resolve(),
                clear: () => Promise.resolve(),
            },
        });

        await manager.start();
        liveStream.emit('change', {
            _id: { token: 4 },
            operationType: 'insert',
            ns: { db: 'source_db', coll: 'users' },
            documentKey: { _id: 1 },
            fullDocument: { _id: 1, name: 'Ada' },
        });
        liveStream.emit('change', {
            _id: { token: 5 },
            operationType: 'delete',
            ns: { db: 'source_db', coll: 'users' },
            documentKey: { _id: 1 },
            fullDocument: undefined as never,
        });

        await manager.stop();

        assert.equal(transformCalls, 2);
        assert.deepEqual(seen, [
            { target: 'a', document: { _id: 1, name: 'Ada', transformed: true } },
            { target: 'b', document: { _id: 1, name: 'Ada', transformed: true } },
            { target: 'a', document: undefined },
            { target: 'b', document: undefined },
        ]);
    });
});
