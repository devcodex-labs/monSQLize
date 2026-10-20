import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

const MonSQLize = require('../../../dist/cjs/index.cjs');

// The root export already exposes PoolStatsManager; this test still goes through
// ConnectionPoolManager._stats to keep the real wiring path covered.
function createStatsMgr() {
    const cpm = new MonSQLize.ConnectionPoolManager({
        clientFactory: () => Promise.reject(new Error('not needed')),
    });
    return cpm._stats;
}

describe('PoolStatsManager (via ConnectionPoolManager._stats)', () => {

    it('B27 tracks CMAP identities across addresses and removes only owned listeners', async () => {
        const clients: EventEmitter[] = [];
        const manager = new MonSQLize.ConnectionPoolManager({
            poolStrategy: 'leastConnections',
            clientFactory: async () => {
                const client = Object.assign(new EventEmitter(), { close: async () => undefined, db: () => ({}) });
                clients.push(client); return client;
            },
        });
        try {
            await manager.addPool({ name: 'a', role: 'primary', uri: 'mongodb://a' });
            await manager.addPool({ name: 'b', role: 'primary', uri: 'mongodb://b' });
            const external = () => undefined;
            clients[0].on('connectionCreated', external);
            for (const address of ['host-a', 'host-b']) {
                clients[0].emit('connectionCreated', { address, connectionId: 1 });
                clients[0].emit('connectionReady', { address, connectionId: 1 });
            }
            clients[1].emit('connectionCreated', { address: 'host-b', connectionId: 1 });
            clients[1].emit('connectionReady', { address: 'host-b', connectionId: 1 });
            clients[0].emit('connectionCheckOutStarted', { address: 'host-a' });
            assert.equal(manager.getPoolStats().a.waiting, 1);
            clients[0].emit('connectionCheckedOut', { address: 'host-a', connectionId: 1 });
            assert.equal(manager.getPoolStats().a.available, 1);
            assert.equal(manager.getPoolStats().a.waiting, 0);
            assert.equal(manager.selectPool('write').name, 'b');
            clients[0].emit('connectionClosed', { address: 'host-a', connectionId: 1, serviceId: 'service' });
            clients[0].emit('connectionClosed', { address: 'host-a', connectionId: 1 });
            clients[0].emit('connectionCheckedIn', { address: 'host-a', connectionId: 1 });
            assert.equal(manager.getPoolStats().a.connections, 1);
            assert.equal(manager.getPoolStats().a.available, 1);
            await manager.removePool('a');
            assert.equal(clients[0].listenerCount('connectionCreated'), 1);
            assert.strictEqual(clients[0].listeners('connectionCreated')[0], external);
            assert.equal(clients[0].listenerCount('connectionClosed'), 0);
        } finally { await manager.close(); }
        assert.equal(clients[1].listenerCount('connectionCreated'), 0);
    });

    it('recordSelection increments totalRequests', () => {
        const mgr = createStatsMgr();
        mgr.recordSelection('pool-a', 'read');
        mgr.recordSelection('pool-a', 'write');
        const stats = mgr.getStats('pool-a');
        assert.ok(stats.totalRequests >= 2);
        mgr.close();
    });

    it('recordRequest tracks success/failure and avgResponseTime (flushed via recordSelection)', () => {
        const mgr = createStatsMgr();
        mgr.recordRequest('p1', 100, true);
        mgr.recordRequest('p1', 200, false);
        mgr.recordSelection('p1', 'read'); // triggers _flush()
        const stats = mgr.getStats('p1');
        assert.ok(stats.totalRequests >= 3);
        assert.ok(stats.avgResponseTime > 0);
        assert.ok(stats.errorRate > 0);
        mgr.close();
    });

    it('recordQuery is equivalent to recordRequest + flush', async () => {
        const mgr = createStatsMgr();
        await mgr.recordQuery('p2', 50, null);
        await mgr.recordQuery('p2', 75, new Error('fail'));
        const stats = mgr.getStats('p2');
        assert.ok(stats.totalRequests >= 2);
        mgr.close();
    });

    it('recordConnections updates connections count', () => {
        const mgr = createStatsMgr();
        mgr.recordConnections('p3', 5);
        const stats = mgr.getStats('p3');
        assert.equal(stats.connections, 5);
        mgr.close();
    });

    it('getAllStats returns snapshot of all pool stats', () => {
        const mgr = createStatsMgr();
        mgr.recordSelection('x1', 'read');
        mgr.recordSelection('x2', 'write');
        const all = mgr.getAllStats();
        assert.ok('x1' in all);
        assert.ok('x2' in all);
        mgr.close();
    });

    it('reset(poolName) clears specific pool stats', () => {
        const mgr = createStatsMgr();
        mgr.recordSelection('del-pool', 'read');
        mgr.reset('del-pool');
        const stats = mgr.getStats('del-pool');
        assert.equal(stats.totalRequests, 0);
        mgr.close();
    });

    it('resetAll() clears all stats and buffer', () => {
        const mgr = createStatsMgr();
        mgr.recordSelection('a', 'read');
        mgr.recordSelection('b', 'read');
        mgr.resetAll();
        const all = mgr.getAllStats();
        assert.deepEqual(all, {});
        mgr.close();
    });

    it('close() stops the batch interval without error', () => {
        const mgr = createStatsMgr();
        mgr.recordSelection('c', 'read');
        mgr.close();
        mgr.close(); // double-close is safe
    });

    it('getStats() returns empty stats for unknown pool', () => {
        const mgr = createStatsMgr();
        const stats = mgr.getStats('nonexistent');
        assert.equal(stats.totalRequests, 0);
        assert.equal(stats.connections, 0);
        mgr.close();
    });
});

describe('PoolSelector — extended strategy coverage', () => {

    it('weighted strategy distributes by weight', () => {
        const selector = new MonSQLize.PoolSelector({ strategy: 'weighted' });
        const pools = [
            { name: 'heavy', role: 'primary', weight: 10 },
            { name: 'light', role: 'secondary', weight: 1 },
        ];
        const counts: Record<string, number> = { heavy: 0, light: 0 };
        for (let i = 0; i < 50; i++) {
            const pick = selector.select(pools, {});
            counts[pick] = (counts[pick] ?? 0) + 1;
        }
        assert.ok(counts.heavy > counts.light, `Expected heavy > light, got ${JSON.stringify(counts)}`);
    });

    it('manual strategy returns first pool', () => {
        const selector = new MonSQLize.PoolSelector({ strategy: 'manual' });
        const pools = [
            { name: 'first', role: 'primary', weight: 1 },
            { name: 'second', role: 'analytics', weight: 1 },
        ];
        assert.equal(selector.select(pools, {}), 'first');
    });

    it('setStrategy() switches strategy at runtime', () => {
        const selector = new MonSQLize.PoolSelector({ strategy: 'roundRobin' });
        selector.setStrategy('manual');
        const pools = [{ name: 'only', role: 'primary', weight: 1 }];
        assert.equal(selector.select(pools, {}), 'only');
    });

    it('unknown strategy falls back to auto without throwing', () => {
        const selector = new MonSQLize.PoolSelector({ strategy: 'bogus' as any });
        const pools = [{ name: 'p', role: 'primary', weight: 1 }];
        assert.doesNotThrow(() => selector.select(pools, {}));
    });

    it('throws when pool list is empty', () => {
        const selector = new MonSQLize.PoolSelector({ strategy: 'auto' });
        assert.throws(() => selector.select([], {}), /No available pools/);
    });

    it('auto strategy selects by poolPreference tags (single tag)', () => {
        const selector = new MonSQLize.PoolSelector({ strategy: 'auto' });
        const pools = [
            { name: 'reporting', role: 'analytics', weight: 1, tags: ['reporting'] },
            { name: 'primary', role: 'primary', weight: 1, tags: ['prod'] },
        ];
        const result = selector.select(pools, { poolPreference: { tags: ['reporting'] } });
        assert.equal(result, 'reporting');
    });

    it('auto strategy lets explicit preference override read defaults', () => {
        const selector = new MonSQLize.PoolSelector({ strategy: 'auto' });
        const pools = [
            { name: 'secondary', role: 'secondary', weight: 1, tags: ['read'] },
            { name: 'analytics', role: 'analytics', weight: 1, tags: ['reporting'] },
            { name: 'primary', role: 'primary', weight: 1, tags: ['write'] },
        ];
        const result = selector.select(pools, {
            operation: 'read',
            poolPreference: { role: 'analytics' },
        });
        assert.equal(result, 'analytics');
    });

    it('auto strategy selects by poolPreference role', () => {
        const selector = new MonSQLize.PoolSelector({ strategy: 'auto' });
        const pools = [
            { name: 'sec', role: 'secondary', weight: 1, tags: [] },
            { name: 'pri', role: 'primary', weight: 1, tags: [] },
        ];
        const result = selector.select(pools, { poolPreference: { role: 'secondary' } });
        assert.equal(result, 'sec');
    });

    it('roundRobin iterates across all pools', () => {
        const selector = new MonSQLize.PoolSelector({ strategy: 'roundRobin' });
        const pools = [
            { name: 'r1', role: 'primary', weight: 1 },
            { name: 'r2', role: 'primary', weight: 1 },
            { name: 'r3', role: 'primary', weight: 1 },
        ];
        const picks = new Set([
            selector.select(pools, {}),
            selector.select(pools, {}),
            selector.select(pools, {}),
        ]);
        assert.equal(picks.size, 3);
    });
});
