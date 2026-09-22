import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const MonSQLize = require('../../../dist/cjs/index.cjs');

function hasErrorCode(error: unknown, code: string): boolean {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}

function deferred<T = void>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

describe('CountQueue', () => {
    const CountQueue: new (opts?: { concurrency?: number; maxQueueSize?: number; timeout?: number }) => any = MonSQLize.CountQueue;

    // ── basic execution ───────────────────────────────────────────────────────

    it('execute() returns the function result', async () => {
        const q = new CountQueue({ concurrency: 2 });
        const result = await q.execute(() => Promise.resolve(42));
        assert.equal(result, 42);
    });

    it('multiple tasks under concurrency limit all complete', async () => {
        const q = new CountQueue({ concurrency: 3 });
        const results = await Promise.all([
            q.execute(() => Promise.resolve(1)),
            q.execute(() => Promise.resolve(2)),
            q.execute(() => Promise.resolve(3)),
        ]);
        assert.deepEqual(results.sort((a: number, b: number) => a - b), [1, 2, 3]);
    });

    it('tasks beyond concurrency are queued and complete in order', async () => {
        const q = new CountQueue({ concurrency: 1 });
        const d = deferred<number>();

        const p1 = q.execute(() => d.promise);
        await new Promise<void>((r) => setImmediate(r));

        const p2 = q.execute(() => Promise.resolve(99));
        await new Promise<void>((r) => setImmediate(r));

        assert.equal(q.getStats().queuedNow, 1);

        d.resolve(10);
        const [r1, r2] = await Promise.all([p1, p2]);
        assert.equal(r1, 10);
        assert.equal(r2, 99);
    });

    // ── queue full rejection ──────────────────────────────────────────────────

    it('throws INVALID_OPERATION when queue is full', async () => {
        const q = new CountQueue({ concurrency: 1, maxQueueSize: 1 });
        const d = deferred<number>();

        const p1 = q.execute(() => d.promise);
        await new Promise<void>((r) => setImmediate(r));

        const p2 = q.execute(() => Promise.resolve(1));
        await new Promise<void>((r) => setImmediate(r));

        await assert.rejects(
            () => q.execute(() => Promise.resolve(2)),
            (e: unknown) => hasErrorCode(e, 'INVALID_OPERATION'),
        );

        d.resolve(0);
        await Promise.all([p1, p2]);
    });

    // ── execution timeout ─────────────────────────────────────────────────────

    it('throws OPERATION_TIMEOUT when execution exceeds timeout', async () => {
        const q = new CountQueue({ concurrency: 2, timeout: 20 });
        await assert.rejects(
            () => q.execute(() => new Promise<never>(() => {})),
            (e: unknown) => hasErrorCode(e, 'OPERATION_TIMEOUT'),
        );
    });

    it('passes an AbortSignal and aborts it when execution times out', async () => {
        const q = new CountQueue({ concurrency: 1, timeout: 20 });
        let observedSignal: AbortSignal | undefined;
        let observedAbort = false;

        await assert.rejects(
            () => q.execute((signal?: AbortSignal) => {
                observedSignal = signal;
                signal?.addEventListener('abort', () => { observedAbort = true; });
                return new Promise<never>(() => {});
            }),
            (e: unknown) => hasErrorCode(e, 'OPERATION_TIMEOUT'),
        );

        assert.equal(observedSignal?.aborted, true);
        assert.equal(observedAbort, true);
        assert.equal(q.getStats().timeout, 1);
    });

    it('holds the running slot until a timed-out task actually settles', async () => {
        const q = new CountQueue({ concurrency: 1, timeout: 20 });
        const work = deferred<number>();
        let secondStarted = false;
        await assert.rejects(() => q.execute(() => work.promise), /timeout/);
        const second = q.execute(() => { secondStarted = true; return Promise.resolve(2); });
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(q.getStats().running, 1);
        assert.equal(q.getStats().queuedNow, 1);
        assert.equal(secondStarted, false);
        work.resolve(1);
        assert.equal(await second, 2);
        assert.equal(secondStarted, true);
        assert.equal(q.getStats().running, 0);
    });

    it('removes an aborted queued caller without starting its task', async () => {
        const q = new CountQueue({ concurrency: 1 });
        const work = deferred<number>();
        const first = q.execute(() => work.promise);
        const controller = new AbortController();
        let started = false;
        const second = q.execute(() => { started = true; return Promise.resolve(2); }, { signal: controller.signal });
        assert.equal(q.getStats().queuedNow, 1);
        controller.abort();
        await assert.rejects(() => second, /aborted/);
        assert.equal(q.getStats().queuedNow, 0);
        assert.equal(started, false);
        work.resolve(1);
        await first;
    });

    it('propagates caller abort to a running task but retains its slot until settlement', async () => {
        const q = new CountQueue({ concurrency: 1 });
        const work = deferred<number>();
        const controller = new AbortController();
        let observed: AbortSignal | undefined;
        const first = q.execute((signal?: AbortSignal) => { observed = signal; return work.promise; }, { signal: controller.signal });
        controller.abort();
        await assert.rejects(() => first, /aborted/);
        assert.equal(observed?.aborted, true);
        assert.equal(q.getStats().running, 1);
        work.resolve(1);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(q.getStats().running, 0);
    });

    // ── stats tracking ────────────────────────────────────────────────────────

    it('getStats().executed increments per completed task', async () => {
        const q = new CountQueue({ concurrency: 2 });
        await q.execute(() => Promise.resolve(1));
        await q.execute(() => Promise.resolve(2));
        assert.equal(q.getStats().executed, 2);
    });

    it('getStats().queued increments when tasks are enqueued', async () => {
        const q = new CountQueue({ concurrency: 1 });
        const d = deferred<number>();

        const p1 = q.execute(() => d.promise);
        await new Promise<void>((r) => setImmediate(r));

        const p2 = q.execute(() => Promise.resolve(1));
        await new Promise<void>((r) => setImmediate(r));

        assert.equal(q.getStats().queued, 1);

        d.resolve(0);
        await Promise.all([p1, p2]);
    });

    it('getStats().rejected increments on queue-full rejection', async () => {
        const q = new CountQueue({ concurrency: 1, maxQueueSize: 0 });
        const d = deferred<number>();

        const p1 = q.execute(() => d.promise);
        await new Promise<void>((r) => setImmediate(r));

        await q.execute(() => Promise.resolve(1)).catch(() => {});
        await q.execute(() => Promise.resolve(2)).catch(() => {});

        assert.equal(q.getStats().rejected, 2);

        d.resolve(0);
        await p1;
    });

    it('getStats() returns live running and queuedNow', async () => {
        const q = new CountQueue({ concurrency: 1 });
        const d = deferred<number>();

        const p1 = q.execute(() => d.promise);
        await new Promise<void>((r) => setImmediate(r));

        assert.equal(q.getStats().running, 1);
        assert.equal(q.getStats().queuedNow, 0);

        const p2 = q.execute(() => Promise.resolve(1));
        await new Promise<void>((r) => setImmediate(r));

        assert.equal(q.getStats().running, 1);
        assert.equal(q.getStats().queuedNow, 1);

        d.resolve(0);
        await Promise.all([p1, p2]);

        assert.equal(q.getStats().running, 0);
        assert.equal(q.getStats().queuedNow, 0);
    });

    it('getStats() exposes concurrency and maxQueueSize', () => {
        const q = new CountQueue({ concurrency: 8, maxQueueSize: 200 });
        const stats = q.getStats();
        assert.equal(stats.concurrency, 8);
        assert.equal(stats.maxQueueSize, 200);
    });

    // ── resetStats ────────────────────────────────────────────────────────────

    it('resetStats() clears cumulative counters', async () => {
        const q = new CountQueue({ concurrency: 2 });
        await q.execute(() => Promise.resolve(1));
        await q.execute(() => Promise.resolve(2));
        assert.equal(q.getStats().executed, 2);

        q.resetStats();
        const stats = q.getStats();
        assert.equal(stats.executed, 0);
        assert.equal(stats.queued, 0);
        assert.equal(stats.rejected, 0);
        assert.equal(stats.timeout, 0);
        assert.equal(stats.avgWaitTime, 0);
        assert.equal(stats.maxWaitTime, 0);
    });

    // ── clear() ───────────────────────────────────────────────────────────────

    it('clear() rejects queued tasks before they run', async () => {
        const q = new CountQueue({ concurrency: 1 });
        const d = deferred<number>();

        const p1 = q.execute(() => d.promise);
        await new Promise<void>((r) => setImmediate(r));

        let ranTask2 = false;
        const p2 = q.execute(() => { ranTask2 = true; return Promise.resolve(1); });
        await new Promise<void>((r) => setImmediate(r));

        assert.equal(q.getStats().queuedNow, 1);
        q.clear();
        assert.equal(q.getStats().queuedNow, 0);

        await assert.rejects(
            () => p2,
            (e: unknown) => hasErrorCode(e, 'INVALID_OPERATION'),
        );
        assert.equal(ranTask2, false);

        d.resolve(10);
        await p1;
    });

    it('rejects invalid constructor options', () => {
        assert.throws(() => new CountQueue({ concurrency: 0 }), /positive integer/);
        assert.throws(() => new CountQueue({ maxQueueSize: -1 }), /non-negative integer/);
        assert.throws(() => new CountQueue({ timeout: 0 }), /positive integer/);
    });
});
