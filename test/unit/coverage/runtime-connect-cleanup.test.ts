import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MongoClient } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { createConnection } from 'node:net';
import { cleanupFailedRuntimeConnection } from '../../../src/entry/runtime-connect-cleanup';

const MonSQLize = require('../../../dist/cjs/index.cjs');

describe('failed runtime connection cleanup', () => {
    it('B13 retains a failed managed-memory stop and releases the owned server on retry', async (t) => {
        const originalStop = MongoMemoryReplSet.prototype.stop;
        let stopCalls = 0;
        MongoMemoryReplSet.prototype.stop = async function (...args: Parameters<typeof originalStop>) {
            if (++stopCalls === 1) return false;
            return originalStop.apply(this, args);
        };
        let throwLogs = false;
        const runtime = new MonSQLize({
            type: 'mongodb', databaseName: 'b13_memory_owner',
            config: { useMemoryServer: true },
            logger: { info: () => { if (throwLogs) throw new Error('logger unavailable'); }, warn: () => undefined },
        });
        try {
            await runtime.connect();
            const address = runtime._client.options.hosts[0];
            t.diagnostic('Owned managed-memory MongoDB address: ' + address.toString());
            throwLogs = true;
            await runtime.close();
            assert.equal(stopCalls, 1);
            assert.ok(runtime._client, 'failed stop retains its owner for retry');
            await runtime.close();
            assert.equal(stopCalls, 2);
            assert.equal(runtime._client, null);
            await new Promise<void>((resolve, reject) => {
                const socket = createConnection({ host: address.host, port: address.port });
                socket.setTimeout(1000);
                socket.once('connect', () => { socket.destroy(); reject(new Error('owned MongoDB port is still listening')); });
                socket.once('error', (error: NodeJS.ErrnoException) => {
                    socket.destroy();
                    if (error.code === 'ECONNREFUSED') resolve(); else reject(error);
                });
                socket.once('timeout', () => { socket.destroy(); reject(new Error('port release verification timed out')); });
            });
        } finally {
            MongoMemoryReplSet.prototype.stop = originalStop;
            await runtime.close();
        }
    });

    it('B12 joins startup cleanup and fences a late client when close overlaps connect', async () => {
        const originalConnect = MongoClient.prototype.connect;
        const originalClose = MongoClient.prototype.close;
        let release!: () => void;
        let entered!: () => void;
        const opened = new Promise<void>((resolve) => { entered = resolve; });
        const gate = new Promise<void>((resolve) => { release = resolve; });
        let closes = 0;
        MongoClient.prototype.connect = async function () { entered(); await gate; return this; };
        MongoClient.prototype.close = async function () { closes++; };
        const runtime = new MonSQLize({ type: 'mongodb', databaseName: 'b12', config: { uri: 'mongodb://localhost:27017' } });
        try {
            const first = runtime.connect();
            const joined = runtime.connect();
            const outcomes = Promise.allSettled([first, joined]);
            await opened;
            let finished = false;
            const closing = runtime.close().then(() => { finished = true; });
            await Promise.resolve();
            assert.equal(finished, false);
            release();
            for (const outcome of await outcomes) assert.equal(outcome.status, 'rejected');
            await closing;
            assert.equal(closes, 1);
            assert.equal(runtime._connected, false);
            assert.equal(runtime._client, null);
        } finally {
            release();
            await runtime.close();
            MongoClient.prototype.connect = originalConnect;
            MongoClient.prototype.close = originalClose;
        }
    });

    it('B13 owns partially started pools and retains failed cleanup for a later close', async () => {
        const originalConnect = MongoClient.prototype.connect;
        const originalClose = MongoClient.prototype.close;
        const opened: MongoClient[] = [];
        const closes = new Map<MongoClient, number>();
        MongoClient.prototype.connect = async function () {
            opened.push(this);
            if (opened.length === 3) throw new Error('second pool startup failed');
            return this;
        };
        MongoClient.prototype.close = async function () {
            const count = (closes.get(this) ?? 0) + 1;
            closes.set(this, count);
            if (this === opened[1] && count === 1) throw new Error('first pool close failed');
        };
        const runtime = new MonSQLize({
            type: 'mongodb', databaseName: 'b13', config: { uri: 'mongodb://localhost:27017' },
            pools: [{ name: 'first', uri: 'mongodb://localhost:27018' }, { name: 'second', uri: 'mongodb://localhost:27019' }],
        });
        try {
            await assert.rejects(runtime.connect(), /second pool startup failed/);
            assert.ok(runtime._poolManager);
            assert.equal(closes.get(opened[0]), 1);
            await runtime.close();
            assert.equal(runtime._poolManager, null);
            assert.equal(closes.get(opened[1]), 2);
            assert.equal(closes.get(opened[0]), 1);
        } finally {
            await runtime.close();
            MongoClient.prototype.connect = originalConnect;
            MongoClient.prototype.close = originalClose;
        }
    });

    it('cleans every initialized resource', async () => {
        const calls: string[] = [];
        const closeable = (name: string) => ({ close: async () => { calls.push(name); } });

        await cleanupFailedRuntimeConnection({
            client: closeable('client'),
            pool: closeable('pool'),
            tunnel: closeable('tunnel'),
            invalidator: closeable('invalidator'),
            sync: { stop: async () => { calls.push('sync'); } },
            slowQuery: closeable('slowQuery'),
            transaction: { abortAll: async () => { calls.push('transaction'); } },
            lock: closeable('lock'),
        }, {});

        assert.deepEqual(calls, [
            'lock',
            'sync',
            'slowQuery',
            'transaction',
            'pool',
            'invalidator',
            'client',
            'tunnel',
        ]);
    });

    it('accepts a connection failure before any resource was initialized', async () => {
        await assert.doesNotReject(() => cleanupFailedRuntimeConnection({
            client: null,
            pool: null,
            tunnel: null,
            invalidator: null,
            sync: null,
            slowQuery: null,
            transaction: null,
            lock: null,
        }, {}));
    });

    it('collects synchronous and asynchronous cleanup failures without rejecting', async () => {
        const warnings: unknown[][] = [];
        const rejected = (name: string) => ({ close: async () => { throw new Error(name); } });

        await assert.doesNotReject(() => cleanupFailedRuntimeConnection({
            client: rejected('client'),
            pool: rejected('pool'),
            tunnel: rejected('tunnel'),
            invalidator: rejected('invalidator'),
            sync: { stop: async () => { throw new Error('sync'); } },
            slowQuery: rejected('slowQuery'),
            transaction: { abortAll: async () => { throw new Error('transaction'); } },
            lock: { close: () => { throw new Error('lock'); } },
        }, { warn: (...args: unknown[]) => { warnings.push(args); } }));

        assert.equal(warnings.length, 8);
        assert.match(String(warnings[0]?.[0]), /lock cleanup error/);
        assert.ok(warnings.slice(1).every(([message]) => String(message).includes('cleanup error after failed connect')));
    });

    it('does not require a warning logger while swallowing cleanup failures', async () => {
        await assert.doesNotReject(() => cleanupFailedRuntimeConnection({
            client: { close: async () => { throw new Error('client'); } },
            pool: null,
            tunnel: null,
            invalidator: null,
            sync: null,
            slowQuery: null,
            transaction: null,
            lock: { close: () => { throw new Error('lock'); } },
        }, {}));
    });
});
