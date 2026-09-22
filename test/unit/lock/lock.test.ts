import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DistributedCacheLockManager } from '../../../src/capabilities/lock';

const MonSQLize = require('../../../dist/cjs/index.cjs');

describe('P4-A lock', () => {
    afterEach(() => {
        const manager = new MonSQLize.LockManager();
        manager.clear();
        manager.close();
    });

    it('supports tryAcquireLock / acquireLock / release / renew / stats', async () => {
        const manager = new MonSQLize.LockManager({ lockKeyPrefix: 'test:lock:' });

        const first = await manager.tryAcquireLock('inventory:sku-1', { ttl: 200 });
        assert.ok(first);
        assert.equal(manager.isLocked('inventory:sku-1'), true);

        const second = await manager.tryAcquireLock('inventory:sku-1');
        assert.equal(second, null);

        assert.equal(await first.renew(300), true);
        assert.equal(first.isHeld(), true);
        assert.ok(first.getHoldTime() >= 0);

        const stats = manager.getStats();
        assert.equal(stats.locksAcquired >= 1, true);
        assert.equal(stats.activeLocks, 1);

        assert.equal(await first.release(), true);
        assert.equal(await first.release(), false);
        assert.equal(manager.isLocked('inventory:sku-1'), false);
        assert.equal(manager.getStats().locksReleased >= 1, true);

        manager.close();
    });

    it('supports withLock and fallbackToNoLock', async () => {
        const manager = new MonSQLize.LockManager({ lockKeyPrefix: 'test:lock:' });
        const steps: string[] = [];

        const held = await manager.tryAcquireLock('cron:daily-report');
        assert.ok(held);

        await assert.rejects(
            () => manager.acquireLock('cron:daily-report', { retryTimes: 0, retryDelay: 1 }),
            (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'LOCK_TIMEOUT'),
        );

        const value = await manager.withLock('cron:sync', () => {
            steps.push('inside');
            return Promise.resolve(42);
        });
        assert.equal(value, 42);
        assert.deepEqual(steps, ['inside']);

        const fallback = await manager.acquireLock('cron:daily-report', {
            retryTimes: 0,
            fallbackToNoLock: true,
        });
        assert.ok(fallback);
        assert.equal(fallback.key.includes('cron:daily-report'), true);
        assert.equal(await fallback.release(), true);

        await held.release();
        manager.close();
    });
});

describe('DistributedCacheLockManager.withLock', () => {
    it('does not replay a callback that throws a Redis-like connection error', async () => {
        let calls = 0;
        let releases = 0;
        const manager = new DistributedCacheLockManager({
            redis: {
                on: () => undefined,
                set: async () => 'OK',
                eval: async () => { releases += 1; return 1; },
            },
        });
        await assert.rejects(
            () => manager.withLock('once', async () => {
                calls += 1;
                throw new Error('ETIMEDOUT from business callback');
            }, { fallbackToNoLock: true, retryTimes: 0 }),
            /ETIMEDOUT from business callback/,
        );
        assert.equal(calls, 1);
        assert.equal(releases, 1);
    });
});
