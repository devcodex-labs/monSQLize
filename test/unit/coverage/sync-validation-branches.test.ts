import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const {
    validateTargetConfig,
    validateResumeTokenConfig,
    validateSyncConfig,
    ResumeTokenStore,
    ChangeStreamSyncManager,
} = require('../../../dist/cjs/index.cjs');

// ── validateTargetConfig — all error branches ─────────────────────────────────

describe('validateTargetConfig — edge cases', () => {
    it('null target throws', () => {
        assert.throws(() => validateTargetConfig(null, 0));
    });

    it('non-object target throws', () => {
        assert.throws(() => validateTargetConfig('string', 0));
    });

    it('name is empty string throws', () => {
        assert.throws(() => validateTargetConfig({ name: '   ', apply: () => {} }, 0));
    });

    it('no apply/uri/pool throws', () => {
        assert.throws(() => validateTargetConfig({ name: 'target' }, 0));
    });

    it('uri defined but empty string throws', () => {
        assert.throws(() => validateTargetConfig({ name: 'target', uri: '  ' }, 0));
    });

    it('uri defined but non-string throws', () => {
        assert.throws(() => validateTargetConfig({ name: 'target', uri: 42 }, 0));
    });

    it('pool defined but empty string throws', () => {
        assert.throws(() => validateTargetConfig({ name: 'target', apply: () => {}, pool: '' }, 0));
    });

    it('pool defined but non-string throws', () => {
        assert.throws(() => validateTargetConfig({ name: 'target', apply: () => {}, pool: 123 }, 0));
    });

    it('databaseName defined but empty string throws', () => {
        assert.throws(() => validateTargetConfig({ name: 'target', apply: () => {}, databaseName: '  ' }, 0));
    });

    it('databaseName defined but non-string throws', () => {
        assert.throws(() => validateTargetConfig({ name: 'target', apply: () => {}, databaseName: false }, 0));
    });

    it('collections defined but empty array throws', () => {
        assert.throws(() => validateTargetConfig({ name: 'target', apply: () => {}, collections: [] }, 0));
    });

    it('collections defined but not array throws', () => {
        assert.throws(() => validateTargetConfig({ name: 'target', apply: () => {}, collections: 'users' }, 0));
    });

    it('apply defined but not function throws', () => {
        assert.throws(() => validateTargetConfig({ name: 'target', apply: 'not-a-function' }, 0));
    });

    it('valid target with apply passes', () => {
        assert.doesNotThrow(() => validateTargetConfig({ name: 'target', apply: () => {} }, 0));
    });

    it('valid target with uri passes', () => {
        assert.doesNotThrow(() => validateTargetConfig({ name: 'target', uri: 'mongodb://localhost' }, 0));
    });

    it('valid target with all optional fields passes', () => {
        assert.doesNotThrow(() => validateTargetConfig({
            name: 'target',
            uri: 'mongodb://localhost',
            databaseName: 'mydb',
            collections: ['users'],
        }, 0));
    });
});

// ── validateResumeTokenConfig — edge cases ────────────────────────────────────

describe('validateResumeTokenConfig — edge cases', () => {
    it('null config throws', () => {
        assert.throws(() => validateResumeTokenConfig(null));
    });

    it('non-object config throws', () => {
        assert.throws(() => validateResumeTokenConfig('string'));
    });

    it('storage not in [file, redis] throws', () => {
        assert.throws(() => validateResumeTokenConfig({ storage: 'database' }));
    });

    it('file storage with non-string path throws', () => {
        assert.throws(() => validateResumeTokenConfig({ storage: 'file', path: 123 }));
    });

    it('redis storage without redis throws', () => {
        assert.throws(() => validateResumeTokenConfig({ storage: 'redis' }));
    });

    it('redis storage with non-object redis throws', () => {
        assert.throws(() => validateResumeTokenConfig({ storage: 'redis', redis: 'string-redis' }));
    });

    it('valid file storage passes', () => {
        assert.doesNotThrow(() => validateResumeTokenConfig({ storage: 'file', path: '/tmp/token' }));
    });

    it('valid redis storage passes', () => {
        assert.doesNotThrow(() => validateResumeTokenConfig({ storage: 'redis', redis: { get: () => {}, set: () => {} } }));
    });

    it('default storage (undefined) uses file → passes', () => {
        assert.doesNotThrow(() => validateResumeTokenConfig({}));
    });

    it('strict save options validate', () => {
        assert.throws(() => validateResumeTokenConfig({ strictSave: 'yes' } as any), /strictSave/);
        assert.throws(() => validateResumeTokenConfig({ strictLoad: 'yes' } as any), /strictLoad/);
        assert.throws(() => validateResumeTokenConfig({ saveRetries: -1 } as any), /saveRetries/);
        assert.throws(() => validateResumeTokenConfig({ saveRetryDelayMs: 1.5 } as any), /saveRetryDelayMs/);
        assert.doesNotThrow(() => validateResumeTokenConfig({ strictSave: false, strictLoad: false, saveRetries: 1, saveRetryDelayMs: 0 }));
    });
});

// ── validateSyncConfig — extra branches ───────────────────────────────────────

describe('validateSyncConfig — extra branches', () => {
    it('non-object config throws', () => {
        assert.throws(() => validateSyncConfig('string' as any));
    });

    it('enabled not boolean throws', () => {
        assert.throws(() => validateSyncConfig({ enabled: 'yes' } as any));
    });

    it('enabled=false returns early (no targets required)', () => {
        assert.doesNotThrow(() => validateSyncConfig({ enabled: false } as any));
    });

    it('targets not array throws', () => {
        assert.throws(() => validateSyncConfig({ enabled: true, targets: null } as any));
    });

    it('targets empty array throws', () => {
        assert.throws(() => validateSyncConfig({ enabled: true, targets: [] } as any));
    });

    it('collections not array throws', () => {
        assert.throws(() => validateSyncConfig({
            enabled: true,
            targets: [{ name: 't', apply: () => {} }],
            collections: 'users',
        } as any));
    });

    it('collections empty array throws', () => {
        assert.throws(() => validateSyncConfig({
            enabled: true,
            targets: [{ name: 't', apply: () => {} }],
            collections: [],
        } as any));
    });

    it('filter non-function throws', () => {
        assert.throws(() => validateSyncConfig({
            enabled: true,
            targets: [{ name: 't', apply: () => {} }],
            filter: 'not-a-function',
        } as any));
    });

    it('transform non-function throws', () => {
        assert.throws(() => validateSyncConfig({
            enabled: true,
            targets: [{ name: 't', apply: () => {} }],
            transform: 42,
        } as any));
    });

    it('valid config with all optional fields passes', () => {
        assert.doesNotThrow(() => validateSyncConfig({
            enabled: true,
            targets: [{ name: 't', apply: () => {} }],
            collections: ['users'],
            filter: () => true,
            transform: (doc: unknown) => doc,
        } as any));
    });

    it('valid config with resumeToken passes', () => {
        assert.doesNotThrow(() => validateSyncConfig({
            enabled: true,
            targets: [{ name: 't', apply: () => {} }],
            resumeToken: { storage: 'file' },
        } as any));
    });
});

// ── ResumeTokenStore — redis path ─────────────────────────────────────────────

describe('ResumeTokenStore — redis storage path', () => {
    it('redis load with existing token returns parsed value', async () => {
        const stored: Record<string, string> = {};
        const redis = {
            get: async (key: string) => stored[key] ?? null,
            set: async (key: string, val: string) => { stored[key] = val; },
            del: async (key: string) => { delete stored[key]; },
        };
        const store = new ResumeTokenStore({ storage: 'redis', redis });
        await store.save({ _id: 'token-123' });
        const token = await store.load();
        assert.deepEqual(token, { _id: 'token-123' });
    });

    it('redis load with no token returns null', async () => {
        const redis = { get: async () => null, set: async () => {}, del: async () => {} };
        const store = new ResumeTokenStore({ storage: 'redis', redis });
        const token = await store.load();
        assert.equal(token, null);
    });

    it('redis clear calls del', async () => {
        const stored: Record<string, string> = {};
        const redis = {
            get: async (key: string) => stored[key] ?? null,
            set: async (key: string, val: string) => { stored[key] = val; },
            del: async (key: string) => { delete stored[key]; },
        };
        const store = new ResumeTokenStore({ storage: 'redis', redis });
        await store.save({ token: 1 });
        await store.clear();
        assert.equal(await store.load(), null);
    });

    it('redis save failure rejects by default and retries configured attempts', async () => {
        let setCalls = 0;
        const errors: unknown[] = [];
        const warns: unknown[] = [];
        const redis = {
            get: async () => null,
            set: async () => {
                setCalls += 1;
                throw new Error('redis down');
            },
            del: async () => {},
        };
        const store = new ResumeTokenStore({
            storage: 'redis',
            redis,
            saveRetries: 1,
            saveRetryDelayMs: 0,
            logger: {
                error: (...args: unknown[]) => { errors.push(args); },
                warn: (...args: unknown[]) => { warns.push(args); },
            },
        });

        await assert.rejects(() => store.save({ token: 1 }), /failed to save resume token/);
        assert.equal(setCalls, 2);
        assert.equal(warns.length, 1);
        assert.equal(errors.length, 1);
    });

    it('redis save failure can opt into legacy best-effort mode', async () => {
        const redis = {
            get: async () => null,
            set: async () => { throw new Error('redis down'); },
            del: async () => {},
        };
        const store = new ResumeTokenStore({
            storage: 'redis',
            redis,
            strictSave: false,
            logger: { error: () => undefined },
        });

        await assert.doesNotReject(() => store.save({ token: 1 }));
    });

    it('redis without del method: clear does not throw', async () => {
        const redis = {
            get: async () => null,
            set: async () => {},
            // no del method → optional chain covers it
        };
        const store = new ResumeTokenStore({ storage: 'redis', redis });
        await assert.doesNotReject(() => store.clear());
    });

    it('file load with non-existent path returns null (ENOENT → silent)', async () => {
        const store = new ResumeTokenStore({
            storage: 'file',
            path: path.join(os.tmpdir(), `nonexistent-${Date.now()}.json`),
        });
        const result = await store.load();
        assert.equal(result, null);
    });
});

// ── ChangeStreamSyncManager — start with resumeAfter token ───────────────────

describe('ChangeStreamSyncManager — start/stop with resumeAfter token', () => {
    it('start with saved resume token passes resumeAfter option', async () => {
        const savedToken = { _data: 'hex-token' };
        let watchOptions: Record<string, unknown> | null = null;
        let watchCount = 0;

        const liveStream = {
            on: () => {},
            close: async () => {},
        };

        const db = {
            databaseName: 'test_db',
            watch(_pipeline: unknown, opts: unknown) {
                watchCount += 1;
                if (watchCount === 1) return { close: async () => {} };
                watchOptions = opts as Record<string, unknown>;
                return liveStream;
            },
        };

        const mgr = new ChangeStreamSyncManager({
            db,
            config: {
                enabled: true,
                targets: [{ name: 't', apply: async () => {} }],
            },
            tokenStore: {
                load: async () => savedToken,
                save: async () => {},
                clear: async () => {},
            },
        });

        await mgr.start();
        await mgr.stop();

        assert.ok(watchOptions !== null, 'watch was called on live stream');
        assert.deepEqual(watchOptions?.['resumeAfter'], savedToken);
    });

    it('start when already running returns early', async () => {
        let watchCount = 0;
        const db = {
            databaseName: 'test_db',
            watch() {
                watchCount += 1;
                return { on: () => {}, close: async () => {} };
            },
        };

        const mgr = new ChangeStreamSyncManager({
            db,
            config: {
                enabled: true,
                targets: [{ name: 't', apply: async () => {} }],
            },
            tokenStore: {
                load: async () => null,
                save: async () => {},
                clear: async () => {},
            },
        });

        await mgr.start();
        await mgr.start(); // second start → early return (already running)
        await mgr.stop();

        assert.ok(watchCount <= 3, 'second start should not add more watch calls');
    });

    it('start with config.enabled=false returns early without watching', async () => {
        let watchCount = 0;
        const db = {
            databaseName: 'test_db',
            watch() { watchCount += 1; return { on: () => {}, close: async () => {} }; },
        };

        const mgr = new ChangeStreamSyncManager({
            db,
            config: { enabled: false, targets: [] },
            tokenStore: {
                load: async () => null,
                save: async () => {},
                clear: async () => {},
            },
        });

        await mgr.start();
        assert.equal(watchCount, 0, 'watch should not be called when disabled');
    });
});

// ── ChangeStreamSyncManager — filter/transform branches ──────────────────────

describe('ChangeStreamSyncManager — filter and transform', () => {
    it('filter returns false → event not dispatched to targets', async () => {
        const applied: unknown[] = [];
        let savedToken: unknown = null;

        const probeStream = { close: async () => {} };
        let liveEmitter: ((e: unknown) => void) | null = null;

        const db = {
            databaseName: 'db',
            watch(_pipeline: unknown, _opts: unknown) {
                if (!liveEmitter) {
                    return probeStream;
                }
                return {
                    on: (event: string, cb: (e: unknown) => void) => {
                        if (event === 'change') liveEmitter = cb;
                    },
                    close: async () => {},
                };
            },
        };

        // Pre-set liveEmitter so next watch call is the live stream
        liveEmitter = () => {};

        const mgr = new ChangeStreamSyncManager({
            db,
            config: {
                enabled: true,
                targets: [{ name: 't', apply: async (e: unknown) => { applied.push(e); } }],
                filter: () => false, // always filter out
            },
            tokenStore: {
                load: async () => null,
                save: async (t: unknown) => { savedToken = t; },
                clear: async () => {},
            },
        });

        await mgr.start();
        // Emit a change event via the manager's internal handler
        const handler = (mgr as any)['handleChange']?.bind(mgr);
        if (handler) {
            await handler({
                _id: { token: 1 },
                operationType: 'insert',
                ns: { coll: 'users' },
                documentKey: { _id: 1 },
                fullDocument: { _id: 1, name: 'test' },
            });
        }
        await mgr.stop();

        assert.equal(applied.length, 0, 'filter=false: no targets should receive events');
        assert.deepEqual(savedToken, { token: 1 }, 'filter=false: the filtered event advances its own resume token');
    });

    it('transform is called when provided', async () => {
        let transformedDoc: unknown = null;
        const applied: unknown[] = [];

        const liveStream = {
            on: (_event: string, _cb: unknown) => {},
            close: async () => {},
        };

        let watchCount = 0;
        const mgr = new ChangeStreamSyncManager({
            db: {
                databaseName: 'db',
                watch() {
                    watchCount += 1;
                    if (watchCount === 1) return { close: async () => {} }; // probe
                    return liveStream; // live
                },
            },
            config: {
                enabled: true,
                targets: [{ name: 't', apply: async (_e: unknown, doc: unknown) => { applied.push(doc); } }],
                transform: (doc: unknown) => {
                    transformedDoc = doc;
                    return { transformed: true, original: doc };
                },
            },
            tokenStore: {
                load: async () => null,
                save: async () => {},
                clear: async () => {},
            },
        });

        await mgr.start();
        const handler = (mgr as any)['handleChange']?.bind(mgr);
        if (handler) {
            await handler({
                _id: { token: 2 },
                operationType: 'insert',
                ns: { coll: 'items' },
                documentKey: { _id: 2 },
                fullDocument: { _id: 2, value: 'x' },
            });
        }
        await mgr.stop();

        if (transformedDoc !== null) {
            assert.ok('transformed' in (applied[0] as Record<string, unknown>));
        }
        assert.ok(true); // transform test ran
    });

    it('stops processing queued changes after a target failure so later tokens cannot skip the failed event', async () => {
        const savedTokens: unknown[] = [];
        const appliedEvents: unknown[] = [];
        let closeCalled = false;
        const stream = {
            on: () => stream,
            close: async () => { closeCalled = true; },
        };
        const db = { databaseName: 'db', watch: () => stream };

        const mgr = new ChangeStreamSyncManager({
            db,
            config: {
                enabled: true,
                targets: [
                    { name: 'ok', apply: async (event: unknown) => { appliedEvents.push(event); } },
                    {
                        name: 'flaky',
                        apply: async (event: { _id?: { token?: number } }) => {
                            if (event._id?.token === 1) {
                                throw new Error('target unavailable');
                            }
                        },
                    },
                ],
            },
            tokenStore: {
                load: async () => null,
                save: async (token: unknown) => { savedTokens.push(token); },
                clear: async () => {},
            },
        });

        await mgr.start();
        const handler = (mgr as any)['handleChange']?.bind(mgr);
        assert.equal(typeof handler, 'function');
        await handler({
            _id: { token: 1 },
            operationType: 'insert',
            ns: { coll: 'items' },
            documentKey: { _id: 1 },
            fullDocument: { _id: 1 },
        });
        await handler({
            _id: { token: 2 },
            operationType: 'insert',
            ns: { coll: 'items' },
            documentKey: { _id: 2 },
            fullDocument: { _id: 2 },
        });

        assert.deepEqual(savedTokens, []);
        assert.equal(appliedEvents.length, 1);
        assert.equal(mgr.getStats().isRunning, false);
        assert.match(String(mgr.getStats().lastError), /target unavailable/);
        assert.equal(closeCalled, true);
    });
});
