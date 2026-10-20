import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { MongoClient } from 'mongodb';
import { createReplSetBootstrap } from '../../bootstrap/replset-server';

const MonSQLize = require('../../../dist/cjs/index.cjs');

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function insertOneWithRetry(uri: string, dbName: string, collectionName: string, document: Record<string, unknown>, timeoutMs = 10000, intervalMs = 250): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown = null;
    while (Date.now() < deadline) {
        const writer = new MongoClient(uri);
        try {
            await writer.connect();
            await writer.db(dbName).collection(collectionName).insertOne(document);
            return;
        } catch (error) {
            lastError = error;
            await sleep(intervalMs);
        } finally {
            await writer.close().catch(() => {});
        }
    }
    throw lastError ?? new Error('insert writer did not succeed in time');
}

async function waitFor<T>(check: () => T | null, message: string, timeoutMs = 5000, intervalMs = 25): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const result = check();
        if (result) {
            return result;
        }
        await sleep(intervalMs);
    }
    throw new Error(message);
}

function createResumeTokenPath(label: string): string {
    return path.join(os.tmpdir(), `monsqlize-sync-${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
}

describe('P4-C sync integration', () => {
    const bootstrap = createReplSetBootstrap({ dbName: 'monsqlize_p4c_sync' });
    let uri = '';
    const syncStatsIt = process.env.MONSQLIZE_MATRIX_MODE === '1' ? it.skip : it;

    before(async () => {
        const context = await bootstrap.setup();
        uri = context.uri;
    });

    after(async () => {
        await bootstrap.teardown();
    });

    it('B02 replays failed and offline events and validates the legacy rollback boundary', async () => {
        const resumeTokenPath = createResumeTokenPath('initial-checkpoint');
        const databaseName = `sync_checkpoint_${Date.now()}`;
        const collectionName = 'events';
        const seen = new Set<string>();
        let failOnce = true;
        const createRuntime = () => new MonSQLize({
            type: 'mongodb', databaseName, config: { uri },
            sync: {
                enabled: true, collections: [collectionName],
                resumeToken: { storage: 'file', path: resumeTokenPath },
                targets: [{ name: 'target', apply: async (_event: unknown, document: { name: string }) => {
                    if (failOnce) { failOnce = false; throw new Error('first target failure'); }
                    seen.add(document.name);
                } }],
            },
        });
        const first = createRuntime();
        let second: ReturnType<typeof createRuntime> | undefined;
        let third: ReturnType<typeof createRuntime> | undefined;
        try {
            await first.connect();
            const initial = JSON.parse(await fs.readFile(resumeTokenPath, 'utf8'));
            assert.equal(initial.__monsqlizeSyncCheckpoint, 1);
            assert.equal(initial.kind, 'operationTime');

            // An old reader passes the whole JSON value as resumeAfter; this must not be called safe rollback.
            const oldReader = new MongoClient(uri);
            try {
                await oldReader.connect();
                const oldStream = oldReader.db(databaseName).watch([], { resumeAfter: initial, maxAwaitTimeMS: 25 });
                try { await assert.rejects(() => oldStream.tryNext(), /resume|token|_data/i); }
                finally { await oldStream.close(); }
            } finally { await oldReader.close(); }
            assert.deepEqual(JSON.parse(await fs.readFile(resumeTokenPath, 'utf8')), initial);

            await insertOneWithRetry(uri, databaseName, collectionName, { name: 'failed' });
            await waitFor(() => {
                const stats = first.getSyncStats();
                return stats && !stats.isRunning && stats.errorCount >= 1 ? stats : null;
            }, 'first target failure was not observed', 10000);
            await first.close();
            assert.deepEqual(JSON.parse(await fs.readFile(resumeTokenPath, 'utf8')), initial);
            await insertOneWithRetry(uri, databaseName, collectionName, { name: 'offline' });
            second = createRuntime();
            await second.connect();
            await waitFor(() => {
                const stats = second?.getSyncStats();
                return seen.has('failed') && seen.has('offline') && stats && stats.syncedCount >= 2 ? stats : null;
            }, 'failed and offline events were not replayed', 10000);
            const saved = JSON.parse(await fs.readFile(resumeTokenPath, 'utf8'));
            assert.equal(saved.__monsqlizeSyncCheckpoint, undefined);
            assert.equal(typeof saved._data, 'string');
            await second.close();
            await insertOneWithRetry(uri, databaseName, collectionName, { name: 'legacy-offline' });
            third = createRuntime();
            await third.connect();
            await waitFor(() => seen.has('legacy-offline') ? true : null, 'raw legacy token did not resume offline events', 10000);
        } finally {
            const closed = await Promise.allSettled([first.close(), second?.close(), third?.close()]);
            for (const result of closed) assert.equal(result.status, 'fulfilled');
            await fs.rm(resumeTokenPath, { force: true });
            await fs.rm(`${resumeTokenPath}.bak`, { force: true });
        }
    });

    it('AR09 retains failed active and staged target owners and attempts every close', async () => {
        for (const failDuringStart of [false, true]) {
            const h = {
                db: { databaseName: 'cleanup_source', watch: () => ({ on() {}, close: async () => undefined }) },
                store: { load: async () => ({ _data: 'legacy' }), save: async () => undefined, clear: async () => undefined },
            };
            const closed: string[] = [];
            let factories = 0;
            let startupFailure = failDuringStart;
            let releaseFailure = true;
            const primary = new Error('primary startup failure');
            const manager = new MonSQLize.ChangeStreamSyncManager({
                db: h.db, tokenStore: h.store,
                config: { enabled: true, targets: [{ name: 'a', uri: 'mongodb://a' }, { name: 'b', uri: 'mongodb://b' }] },
                logger: { warn: () => { throw new Error('diagnostic logger failure'); } },
                clientFactory: async (uri: string) => {
                    factories++;
                    if (uri.endsWith('b') && startupFailure) { startupFailure = false; throw primary; }
                    return {
                        db: () => ({ collection: () => ({ replaceOne: async () => undefined }) }),
                        close: async () => {
                            closed.push(uri);
                            if (uri.endsWith('a') && releaseFailure) { releaseFailure = false; throw new Error('release failed'); }
                        },
                    };
                },
            });
            try {
                if (failDuringStart) await assert.rejects(manager.start(), error => error === primary);
                else { await manager.start(); await assert.rejects(manager.stop(), /release failed/); }
                assert.equal(manager.getStats().targets.length, 0, 'pending owners cannot receive events');
                assert.equal(closed.filter(uri => uri.endsWith('a')).length, 1);
                if (!failDuringStart) assert.equal(closed.filter(uri => uri.endsWith('b')).length, 1);
                const before = factories;
                await manager.stop();
                assert.equal(closed.filter(uri => uri.endsWith('a')).length, 2, 'next stop retries the retained owner');
                assert.equal(factories, before);
                await manager.start();
                assert.equal(factories, before + 2);
                assert.deepEqual(manager.getStats().targets.map((target: any) => target.name), ['a', 'b']);
            } finally { await manager.stop(); }
        }
    });

    it('AR07 delivers both formerly colliding targets and deduplicates replay after token-save failure', async () => {
        const source = new MongoClient(uri);
        await source.connect();
        const db = source.db('ar07_' + Date.now());
        const prefix = 'ar07:\u4e2d"';
        const entries = new Map<string, unknown>([[prefix + ':a:b:c', true]]);
        const applied: string[] = [];
        let stored: unknown = null;
        let failToken = true;
        const manager = new MonSQLize.ChangeStreamSyncManager({
            db,
            tokenStore: {
                load: async () => stored,
                save: async (value: any) => {
                    if (!value.__monsqlizeSyncCheckpoint && failToken) { failToken = false; throw new Error('token save failed once'); }
                    stored = JSON.parse(JSON.stringify(value));
                },
                clear: async () => { stored = null; },
            },
            config: { enabled: true, collections: ['events'],
                idempotency: { enabled: true, keyPrefix: prefix, keyBuilder: (_event: unknown, name: string) => name === 'a:b' ? 'c' : 'b:c',
                    store: { get: (key: string) => entries.get(key), set: (key: string, value: unknown) => entries.set(key, value) } },
                targets: ['a:b', 'a'].map(name => ({ name, apply: async (_event: unknown, _document: unknown, context: any) => {
                    assert.deepEqual(JSON.parse(context.idempotencyKey), ['v2', prefix, name, name === 'a:b' ? 'c' : 'b:c']); applied.push(name);
                } })),
            },
        });
        try {
            await manager.start();
            await db.collection('events').insertOne({ value: 1 });
            await waitFor(() => manager.getStats().tokenSaveErrorCount === 1 ? true : null, 'expected token save failure', 10000);
            await manager.stop();
            assert.deepEqual(applied, ['a:b', 'a']);
            assert.equal(entries.size, 3);
            await manager.start();
            await waitFor(() => manager.getStats().duplicateTargetCount === 2 ? true : null, 'both target markers must suppress replay', 10000);
            await manager.stop();
            assert.deepEqual(applied, ['a:b', 'a']);
            assert.equal(typeof (stored as any)._data, 'string');
        } finally { await manager.stop(); await source.close(); }
    });

    it('AR09 retries a real owned target after close failure and closes independent targets', async () => {
        const source = new MongoClient(uri);
        await source.connect();
        const clients: Array<{ client: MongoClient; close: () => Promise<void> }> = [];
        const counts = new Map<string, number>();
        let fail = true;
        let stored: unknown = null;
        const manager = new MonSQLize.ChangeStreamSyncManager({
            db: source.db('ar09_' + Date.now()),
            config: { enabled: true, targets: [{ name: 'a', uri }, { name: 'b', uri }] },
            tokenStore: { load: async () => stored, save: async (value: unknown) => { stored = value; }, clear: async () => undefined },
            clientFactory: async () => {
                const client = new MongoClient(uri);
                await client.connect();
                const name = clients.length === 0 ? 'a' : 'b';
                const close = client.close.bind(client);
                clients.push({ client, close });
                client.close = async () => {
                    counts.set(name, (counts.get(name) ?? 0) + 1);
                    if (name === 'a' && fail) { fail = false; throw new Error('owned close failed once'); }
                    await close();
                };
                return client;
            },
        });
        try {
            await manager.start();
            await assert.rejects(manager.stop(), /owned close failed once/);
            assert.equal(counts.get('a'), 1);
            assert.equal(counts.get('b'), 1);
            await manager.stop();
            assert.equal(counts.get('a'), 2);
            assert.equal(counts.get('b'), 1);
        } finally { await manager.stop(); await Promise.all(clients.map(entry => entry.close())); await source.close(); }
    });

    it('automatically starts and stops sync manager on a real replica set', async () => {
        const resumeTokenPath = createResumeTokenPath('lifecycle');
        const runtime = new MonSQLize({
            type: 'mongodb',
            databaseName: 'primary_app',
            config: { uri },
            sync: {
                enabled: true,
                collections: ['users'],
                resumeToken: { storage: 'file', path: resumeTokenPath },
                targets: [{ name: 'audit-target', apply: () => Promise.resolve() }],
            },
        });

        try {
            await runtime.connect();
            const manager = runtime.getSyncManager();
            assert.notEqual(manager, null);

            const startedStats = runtime.getSyncStats();
            assert.notEqual(startedStats, null);
            assert.equal(startedStats.isRunning, true);

            await runtime.stopSync();
            const stoppedStats = runtime.getSyncStats();
            assert.notEqual(stoppedStats, null);
            assert.equal(stoppedStats.isRunning, false);

            await runtime.startSync();
            const restartedStats = runtime.getSyncStats();
            assert.notEqual(restartedStats, null);
            assert.equal(restartedStats.isRunning, true);
        } finally {
            await runtime.close();
            await fs.rm(resumeTokenPath, { force: true });
            await fs.rm(`${resumeTokenPath}.bak`, { force: true });
        }
    });

    it('restarts after a fatal target failure without racing the previous stream close', async () => {
        const resumeTokenPath = createResumeTokenPath('fatal-restart');
        let failOnce = true;
        const runtime = new MonSQLize({
            type: 'mongodb',
            databaseName: 'sync_restart_app',
            config: { uri },
            sync: {
                enabled: true,
                collections: ['restart_events'],
                resumeToken: { storage: 'file', path: resumeTokenPath },
                targets: [{
                    name: 'flaky-target',
                    apply() {
                        if (failOnce) {
                            failOnce = false;
                            return Promise.reject(new Error('target failed once'));
                        }
                        return Promise.resolve();
                    },
                }],
            },
        });

        try {
            await runtime.connect();
            await insertOneWithRetry(uri, 'sync_restart_app', 'restart_events', { name: 'first' });
            await waitFor(() => {
                const stats = runtime.getSyncStats();
                return stats && stats.errorCount >= 1 && stats.isRunning === false ? stats : null;
            }, 'sync manager did not enter the failed state in time', 10000);

            await runtime.startSync();
            assert.equal(runtime.getSyncStats()?.isRunning, true);
            await insertOneWithRetry(uri, 'sync_restart_app', 'restart_events', { name: 'second' });
            const recovered = await waitFor(() => {
                const stats = runtime.getSyncStats();
                return stats && stats.syncedCount >= 1 && stats.targets[0]?.syncCount >= 1 ? stats : null;
            }, 'sync manager did not recover in time', 10000);
            assert.equal(recovered.isRunning, true);
        } finally {
            await runtime.close();
            await fs.rm(resumeTokenPath, { force: true });
            await fs.rm(`${resumeTokenPath}.bak`, { force: true });
        }
    });

    syncStatsIt('syncs change events to target and updates stats on a real replica set', async () => {
        const resumeTokenPath = createResumeTokenPath('target-stats');
        let resolveInsert: (value: any) => void = () => {};
        let rejectInsert: (error: Error) => void = () => {};
        const insertPromise = new Promise<any>((resolve, reject) => {
            resolveInsert = resolve;
            rejectInsert = reject;
        });
        const timeout = setTimeout(() => {
            rejectInsert(new Error('sync target did not receive insert event in time'));
        }, 10000);

        const runtime = new MonSQLize({
            type: 'mongodb',
            databaseName: 'primary_app',
            config: { uri },
            sync: {
                enabled: true,
                collections: ['users'],
                resumeToken: { storage: 'file', path: resumeTokenPath },
                targets: [
                    {
                        name: 'capture-target',
                        apply(event: any, document: any) {
                            if (event.operationType === 'insert') {
                                resolveInsert({ event, document });
                            }
                            return Promise.resolve();
                        },
                    },
                ],
            },
        });

        try {
            await runtime.connect();
            await waitFor(() => {
                const stats = runtime.getSyncStats();
                return stats && stats.isRunning && stats.targets.length === 1 ? stats : null;
            }, 'sync manager was not ready in time');
            await sleep(300);
            const expectedName = `Lin-${Date.now()}`;
            await insertOneWithRetry(uri, 'primary_app', 'users', { name: expectedName, role: 'writer' });

            const payload = await insertPromise;
            clearTimeout(timeout);

            assert.equal(payload.event.operationType, 'insert');
            assert.equal(payload.document.name, expectedName);

            const stats = await waitFor(() => {
                const current = runtime.getSyncStats();
                return current && current.syncedCount >= 1 && current.targets[0]?.syncCount >= 1 ? current : null;
            }, 'sync stats were not updated in time');
            assert.notEqual(stats, null);
            assert.equal(stats.eventCount >= 1, true);
            assert.equal(stats.syncedCount >= 1, true);
            assert.equal(stats.targets.length, 1);
            assert.equal(stats.targets[0].name, 'capture-target');
            assert.equal(stats.targets[0].syncCount >= 1, true);
            assert.equal(stats.targets[0].lastSyncTime instanceof Date, true);
        } finally {
            clearTimeout(timeout);
            await runtime.close();
            await fs.rm(resumeTokenPath, { force: true });
            await fs.rm(`${resumeTokenPath}.bak`, { force: true });
        }
    });
});
