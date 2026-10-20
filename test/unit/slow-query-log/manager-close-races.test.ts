import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { SlowQueryLogManager } = require('../../../dist/cjs/index.cjs');
const log = { database: 'app', collection: 'items', operation: 'find', durationMs: 600 };

function gate() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    return { promise, release };
}

describe('SlowQueryLogManager accepted-operation lifecycle', { timeout: 10000 }, () => {
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
