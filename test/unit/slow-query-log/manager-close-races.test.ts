import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { SlowQueryLogManager, BatchQueue } = require('../../../dist/cjs/index.cjs');
const log = { database: 'app', collection: 'items', operation: 'find', durationMs: 600 };

function gate() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    return { promise, release };
}

describe('SlowQueryLogManager accepted-operation lifecycle', { timeout: 10000 }, () => {
    for (const synchronous of [true, false]) {
        it(`recovers a queue after ${synchronous ? 'synchronous throw' : 'asynchronous rejection'}`, async () => {
            let calls = 0;
            const queue = new BatchQueue({ saveBatch() {
                if (++calls === 1) {
                    if (synchronous) throw new Error('sync failure');
                    return Promise.reject(new Error('async failure'));
                }
                return Promise.resolve();
            } }, { size: 1 }, null, 'silent');
            await queue.add(log); await queue.add(log);
            // Fail before close on the old implementation, which could starve the event loop.
            assert.equal(calls, 2);
            await queue.close();
        });
    }

    it('serializes pending flushes and drains entries accepted during a flush', async () => {
        const entered = gate(), release = gate(); let active = 0, maximum = 0, saved = 0;
        const queue = new BatchQueue({ async saveBatch(rows: unknown[]) {
            active++; maximum = Math.max(maximum, active);
            entered.release(); await release.promise; saved += rows.length; active--;
        } }, { size: 1 });
        const adding = queue.add(log); await entered.promise; await queue.add(log);
        const closing = queue.close(); release.release(); await adding; await closing;
        assert.equal(saved, 2); assert.equal(maximum, 1);
    });

    for (const phase of ['initialize', 'write']) for (const policy of ['log', 'silent', 'throw']) {
        it(`preserves ${policy} policy with a throwing diagnostic sink (${phase})`, async () => {
            const failure = new Error('storage failure'); let diagnostics = 0, receivedError: unknown;
            const manager = new SlowQueryLogManager({ enabled: true, batch: { enabled: false }, advanced: { errorHandling: policy } },
                null, 'mongodb', { error(_message: unknown, error: unknown) { diagnostics++; receivedError = error; throw new Error('sink failure'); } },
                { storage: {
                    initialize: async () => { if (phase === 'initialize') throw failure; },
                    save: async () => { throw failure; }, saveBatch: async () => {}, query: async () => [], close: async () => {},
                } });
            try {
                if (policy === 'throw') await assert.rejects(manager.save(log), (error: unknown) => error === failure);
                else await manager.save(log);
                assert.equal(diagnostics, policy === 'log' ? 1 : 0);
                if (policy === 'log') assert.equal(receivedError, failure);
            } finally { await manager.close(); }
        });
    }
    for (const policy of ['log', 'silent', 'throw']) {
        for (const batch of [false, true]) {
            for (const phase of ['initialize', 'write']) {
                it(`drains an accepted ${phase} operation (${policy}, batch=${batch})`, async () => {
                    const entered = gate(), release = gate();
                    const events: string[] = []; let logged = 0;
                    const write = async () => {
                        events.push('write');
                        if (phase === 'write') { entered.release(); await release.promise; }
                    };
                    const storage = {
                        initialize: async () => {
                            events.push('initialize');
                            if (phase === 'initialize') { entered.release(); await release.promise; }
                        },
                        save: write, saveBatch: write,
                        query: async () => [], close: async () => { events.push('close'); },
                    };
                    const manager = new SlowQueryLogManager({ enabled: true, storage: { type: 'memory' },
                        batch: { enabled: batch, size: 1 }, advanced: { errorHandling: policy },
                    }, null, 'mongodb', { error: () => { logged++; } }, { storage });
                    try {
                        const saving = manager.save(log);
                        let closing: Promise<void>;
                        if (phase === 'initialize') closing = manager.close();
                        else { await entered.promise; closing = manager.close(); }
                        await entered.promise;
                        assert.equal(events.includes('close'), false);
                        if (policy === 'throw') await assert.rejects(manager.save(log), { code: 'CONNECTION_CLOSED' });
                        else await manager.save(log);
                        await assert.rejects(manager.query(), { code: 'CONNECTION_CLOSED' });
                        await assert.rejects(manager.initialize(), { code: 'CONNECTION_CLOSED' });
                        assert.equal(logged, policy === 'log' ? 1 : 0);
                        release.release(); await saving; await closing;
                        assert.deepEqual(events, ['initialize', 'write', 'close']);
                        await manager.save(log);
                        assert.deepEqual(events, ['initialize', 'write', 'close', 'initialize', 'write']);
                    } finally { release.release(); await manager.close(); }
                });
            }
        }
    }

    it('waits for an accepted query and coalesces concurrent close calls', async () => {
        const entered = gate(), release = gate(); let closed = 0;
        const rows = [{ queryHash: 'query' }];
        const manager = new SlowQueryLogManager({ enabled: true, storage: { type: 'memory' }, batch: { enabled: false } }, null, 'mongodb', null, { storage: {
            initialize: async () => undefined, save: async () => undefined, saveBatch: async () => undefined,
            query: async () => { entered.release(); await release.promise; return rows; },
            close: async () => { closed++; },
        } });
        try {
            const querying = manager.query(); await entered.promise;
            const first = manager.close(), second = manager.close();
            assert.equal(closed, 0);
            release.release(); assert.equal(await querying, rows);
            await Promise.all([first, second]); assert.equal(closed, 1);
        } finally { release.release(); await manager.close(); }
    });

    it('waits for a queued flush before closing storage', async () => {
        const entered = gate(), release = gate(); const events: string[] = [];
        const manager = new SlowQueryLogManager({ enabled: true, storage: { type: 'memory' },
            batch: { enabled: true, size: 50, interval: 60000 }, advanced: { errorHandling: 'silent' },
        }, null, 'mongodb', null, { storage: {
            initialize: async () => undefined, save: async () => undefined,
            saveBatch: async () => { events.push('flush'); entered.release(); await release.promise; },
            query: async () => [], close: async () => { events.push('close'); },
        } });
        try {
            await manager.save(log); const closing = manager.close();
            await entered.promise; assert.deepEqual(events, ['flush']);
            release.release(); await closing; assert.deepEqual(events, ['flush', 'close']);
        } finally { release.release(); await manager.close(); }
    });

    it('retains the cleanup gate after failure and permits an explicit retry', async () => {
        let closeCalls = 0, initCalls = 0, writes = 0;
        const failure = new Error('owned cleanup failed');
        const manager = new SlowQueryLogManager({ enabled: true, storage: { type: 'memory' }, batch: { enabled: false },
            advanced: { errorHandling: 'throw' },
        }, null, 'mongodb', null, { storage: {
            initialize: async () => { initCalls++; }, save: async () => { writes++; }, saveBatch: async () => undefined,
            query: async () => [], close: async () => { if (++closeCalls === 1) throw failure; },
        } });
        try {
            await manager.save(log);
            await assert.rejects(manager.close(), (error: unknown) => error === failure);
            await assert.rejects(manager.save(log), { code: 'CONNECTION_CLOSED' });
            await assert.rejects(manager.initialize(), { code: 'CONNECTION_CLOSED' });
            assert.equal(initCalls, 1); assert.equal(writes, 1);
            await manager.close(); await manager.save(log);
            assert.equal(initCalls, 2); assert.equal(writes, 2);
        } finally { await manager.close(); }
    });

    it('attempts queue and storage cleanup and preserves both failures', async () => {
        const errors = [new Error('queue cleanup'), new Error('storage cleanup')];
        let storageClosed = 0, fail = true;
        const manager = new SlowQueryLogManager({ enabled: true, storage: { type: 'memory' }, batch: { enabled: true },
            advanced: { errorHandling: 'silent' },
        }, null, 'mongodb', null, { storage: {
            initialize: async () => undefined, save: async () => undefined, saveBatch: async () => undefined,
            query: async () => [], close: async () => { storageClosed++; if (fail) throw errors[1]; },
        } });
        const closeQueue = manager.queue.close.bind(manager.queue);
        manager.queue.close = async () => { await closeQueue(); if (fail) throw errors[0]; };
        try {
            await assert.rejects(manager.close(), (error: unknown) => {
                assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, errors); return true;
            });
            assert.equal(storageClosed, 1);
            fail = false; await manager.close(); assert.equal(storageClosed, 2);
        } finally { fail = false; await manager.close(); }
    });
});
