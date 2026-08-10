import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const MonSQLize = require('../../../dist/cjs/index.cjs');

type FakeClient = {
    name: string;
    connect(): Promise<FakeClient>;
    db(databaseName: string): {
        databaseName: string;
        command(): Promise<{ ok: number }>;
        collection(collectionName: string): { databaseName: string; collectionName: string };
    };
    close(): Promise<boolean>;
};

function createFakeClient(name: string): FakeClient {
    return {
        name,
        connect() {
            return Promise.resolve(this);
        },
        db(databaseName: string) {
            return {
                databaseName,
                command: () => Promise.resolve({ ok: 1 }),
                collection(collectionName: string) {
                    return { databaseName, collectionName };
                },
            };
        },
        close() {
            return Promise.resolve(true);
        },
    };
}

describe('P4-B pool manager', () => {
    afterEach(async () => {
        // no-op, isolated instances per test
    });

    it('supports minimal add/remove/select/stats/health round trip', async () => {
        let unhealthy = false;
        const manager = new MonSQLize.ConnectionPoolManager({
            poolStrategy: 'roundRobin',
            clientFactory: (config: { name: string }) => Promise.resolve(createFakeClient(config.name)),
            healthCheckFn: (poolName: string) => Promise.resolve(!(unhealthy && poolName === 'analytics')),
        });

        await manager.addPool({
            name: 'primary',
            uri: 'mongodb://primary',
            role: 'primary',
            healthCheck: { interval: 5, retries: 1 },
        });
        await manager.addPool({
            name: 'analytics',
            uri: 'mongodb://analytics',
            role: 'analytics',
            weight: 2,
            healthCheck: { interval: 5, retries: 1 },
        });

        assert.ok(manager.getPool('primary'));
        assert.equal(manager.selectPool('write').name, 'primary');
        assert.equal(manager.selectPool('read').name, 'analytics');

        const readStats = manager.getPoolStats();
        assert.equal(readStats.primary.totalRequests >= 1, true);
        assert.equal(readStats.analytics.totalRequests >= 1, true);

        manager.startHealthCheck();
        await new Promise((resolve) => setTimeout(resolve, 20));
        let health = manager.getHealthStatus();
        assert.equal(health.primary.status, 'up');
        assert.equal(health.analytics.status, 'up');

        unhealthy = true;
        await new Promise((resolve) => setTimeout(resolve, 20));
        health = manager.getHealthStatus();
        assert.equal(['degraded', 'down'].includes(health.analytics.status), true);

        await manager.removePool('analytics');
        assert.equal(manager.getPool('analytics'), null);

        await manager.close();
    });

    it('keeps PoolSelector static export and strategy behavior stable', () => {
        const selector = new MonSQLize.PoolSelector({ strategy: 'auto' });
        const pools = [
            { name: 'primary', role: 'primary', weight: 1, tags: ['prod'] },
            { name: 'analytics', role: 'analytics', weight: 1, tags: ['olap'] },
            { name: 'secondary', role: 'secondary', weight: 2, tags: ['prod', 'read'] },
        ];

        assert.equal(selector.select(pools, { operation: 'write' }), 'primary');
        assert.equal(selector.select(pools, { poolPreference: { tags: ['olap'] } }), 'analytics');

        selector.setStrategy('leastConnections');
        assert.equal(selector.select(pools, {
            stats: {
                primary: { connections: 12 },
                analytics: { connections: 7 },
                secondary: { connections: 2 },
            },
        }), 'secondary');
    });

    it('rejects invalid addPool configs before opening a client', async () => {
        let factoryCalled = false;
        const manager = new MonSQLize.ConnectionPoolManager({
            clientFactory: async () => {
                factoryCalled = true;
                return createFakeClient('bad');
            },
        });

        await assert.rejects(
            () => manager.addPool({
                name: 'bad',
                uri: 'mongodb://bad',
                role: 'replica',
            }),
            /role must be one of/,
        );
        assert.equal(factoryCalled, false);

        await manager.close();
    });

    it('clears and unreferences HealthChecker ping timeout handles', async () => {
        const originalSetTimeout = globalThis.setTimeout;
        const originalClearTimeout = globalThis.clearTimeout;
        let unrefCalled = false;
        let clearCalled = false;

        const patchedSetTimeout = ((callback: Parameters<typeof setTimeout>[0], timeout?: number) => {
            const handle = originalSetTimeout(callback, timeout) as ReturnType<typeof setTimeout> & { unref?: () => unknown };
            const originalUnref = handle.unref?.bind(handle);
            handle.unref = () => {
                unrefCalled = true;
                return originalUnref?.() ?? handle;
            };
            return handle;
        }) as unknown as typeof setTimeout;
        Object.assign(patchedSetTimeout, { __promisify__: originalSetTimeout.__promisify__ });
        globalThis.setTimeout = patchedSetTimeout;
        globalThis.clearTimeout = ((handle: Parameters<typeof clearTimeout>[0]) => {
            clearCalled = true;
            return originalClearTimeout(handle);
        }) as typeof clearTimeout;

        try {
            const checker = new MonSQLize.HealthChecker({ logger: { info: () => undefined } });
            checker.register(
                { name: 'fast', healthCheck: { timeout: 1000, retries: 1 } },
                { db: () => ({ command: async () => ({ ok: 1 }) }) },
            );
            await checker.checkPool('fast');
            assert.equal(checker.getStatus('fast')?.status, 'up');
            assert.equal(unrefCalled, true);
            assert.equal(clearCalled, true);
        } finally {
            globalThis.setTimeout = originalSetTimeout;
            globalThis.clearTimeout = originalClearTimeout;
        }
    });

    it('forwards the manager logger to PoolSelector and HealthChecker', async () => {
        const entries: Array<{ level: 'info' | 'warn'; args: unknown[] }> = [];
        const logger = {
            info: (...args: unknown[]) => entries.push({ level: 'info', args }),
            warn: (...args: unknown[]) => entries.push({ level: 'warn', args }),
        };
        const manager = new MonSQLize.ConnectionPoolManager({ logger });

        try {
            manager._selector.setStrategy('roundRobin');
            manager._selector.setStrategy('unknown-strategy');
            manager._selector.select([{ name: 'primary' }], {});
            manager._healthChecker.start();
            manager._healthChecker.stop();

            assert.deepEqual(entries.map((entry) => entry.level), ['info', 'info', 'warn', 'info', 'info']);
            assert.match(String(entries[0].args[0]), /Strategy changed/);
            assert.match(String(entries[2].args[0]), /Unknown strategy/);
            assert.match(String(entries[3].args[0]), /Health check started/);
            assert.match(String(entries[4].args[0]), /Health check stopped/);
        } finally {
            await manager.close();
        }
    });

    it('stays silent when Pool logging is not configured', async () => {
        const consoleEvents: Array<{ level: 'info' | 'warn'; args: unknown[] }> = [];
        const originalInfo = console.info;
        const originalWarn = console.warn;
        console.info = (...args: unknown[]) => consoleEvents.push({ level: 'info', args });
        console.warn = (...args: unknown[]) => consoleEvents.push({ level: 'warn', args });

        const manager = new MonSQLize.ConnectionPoolManager();
        try {
            manager._selector.setStrategy('roundRobin');
            manager._selector.setStrategy('unknown-strategy');
            manager._selector.select([{ name: 'primary' }], {});
            manager._healthChecker.start();
            manager._healthChecker.stop();

            assert.deepEqual(consoleEvents, []);
        } finally {
            console.info = originalInfo;
            console.warn = originalWarn;
            await manager.close();
        }
    });
});
