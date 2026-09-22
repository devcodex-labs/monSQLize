import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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

describe('P4-C sync', () => {
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
        let savedToken: ChangeEvent['_id'] | null = null;

        const db = {
            databaseName: 'source_db',
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
                save: (token: ChangeEvent['_id']) => {
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
                save: () => {
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
                save: (token: ChangeEvent['_id']) => {
                    savedTokens.push(token.token);
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
                save: (token: ChangeEvent['_id']) => {
                    savedTokens.push(token.token);
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
                save: async (token: ChangeEvent['_id']) => { saved.push(token.token); },
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
                save: async (token: ChangeEvent['_id']) => { saved.push(token.token); },
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
                save: () => Promise.reject(new Error('token store down')),
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
                save: (token: ChangeEvent['_id']) => {
                    savedTokens.push(token.token);
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
                save: () => Promise.reject(new Error('token store down')),
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
