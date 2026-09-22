import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { initializeDistributedCacheInvalidator } from '../../../src/entry/capability-wiring';

const { DistributedCacheInvalidator, MemoryCache, MultiLevelCache } = require('../../../dist/cjs/index.cjs');

function receiveOnly(cache: any) {
    return Object.assign(cache, {
        async invalidateFromRemote(kind: 'pattern' | 'key', value: string) {
            const targets = [cache.local, cache.remote].filter(Boolean);
            if (targets.length === 0) targets.push(cache);
            for (const target of targets) {
                if (kind === 'pattern') await target.delPattern?.(value);
                else if (typeof target.del === 'function') await target.del(value);
                else await target.delete?.(value);
            }
        },
    });
}

function makeMockConnection() {
    const subscribers: Record<string, ((ch: string, msg: string) => void)[]> = {};
    return {
        subscribe: (_ch: string, cb: () => void) => cb(),
        on: (event: string, cb: (...args: unknown[]) => void) => {
            if (!subscribers[event]) subscribers[event] = [];
            subscribers[event].push(cb as (ch: string, msg: string) => void);
        },
        publish: async (_ch: string, _msg: string) => {},
        quit: async () => {},
        unsubscribe: async () => {},
        duplicate: () => makeMockConnection(),
        _emit: (event: string, ...args: unknown[]) => {
            (subscribers[event] ?? []).forEach((cb) => cb(...args as [string, string]));
        },
    };
}

function buildInvalidator(cacheOverride?: unknown) {
    const pub = makeMockConnection();
    const sub = makeMockConnection();
    const cache = receiveOnly(cacheOverride ?? { delPattern: async (_pattern: string) => {} });
    const inv = new DistributedCacheInvalidator({
        cache,
        _connections: { pub, sub },
    });
    return { inv, pub, sub };
}

describe('DistributedCacheInvalidator — branch coverage', () => {
    it('capability wiring handles disabled, invalid, usable, and failed subscriptions', async () => {
        const logger = { warnings: [] as unknown[], warn(...args: unknown[]) { this.warnings.push(args); } };
        const runtimeCache = {
            delPattern: async () => undefined,
            invalidateFromRemote: async () => undefined,
        };

        assert.equal(await initializeDistributedCacheInvalidator({} as any, runtimeCache as any, logger), null);
        assert.equal(await initializeDistributedCacheInvalidator({ cache: [] } as any, runtimeCache as any, logger), null);
        assert.equal(await initializeDistributedCacheInvalidator({ cache: { get: () => undefined } } as any, runtimeCache as any, logger), null);
        assert.equal(await initializeDistributedCacheInvalidator({ cache: { distributed: null } } as any, runtimeCache as any, logger), null);
        assert.equal(await initializeDistributedCacheInvalidator({ cache: { distributed: [] } } as any, runtimeCache as any, logger), null);
        assert.equal(await initializeDistributedCacheInvalidator({ cache: { distributed: { enabled: false } } } as any, runtimeCache as any, logger), null);

        const redis = {
            subscribe: (_channel: string, callback: () => void) => callback(),
            on: () => undefined,
            publish: async () => undefined,
            unsubscribe: async () => undefined,
            quit: async () => undefined,
            duplicate: () => ({
                subscribe: (_channel: string, callback: () => void) => callback(),
                on: () => undefined,
                publish: async () => undefined,
                unsubscribe: async () => undefined,
                quit: async () => undefined,
            }),
        };
        const invalidator = await initializeDistributedCacheInvalidator({ cache: { distributed: { redis, channel: 'test-channel' } } } as any, runtimeCache as any, logger);
        assert.ok(invalidator);
        await invalidator?.close();

        await assert.rejects(
            () => initializeDistributedCacheInvalidator({ cache: { distributed: { redis, channel: 'test-channel' } } } as any, { delPattern: async () => undefined } as any, logger),
            (error: unknown) => (error as { code?: string }).code === 'INVALID_CONFIG',
        );

        await assert.rejects(
            () => initializeDistributedCacheInvalidator({ cache: { distributed: { enabled: true } } } as any, runtimeCache as any, logger),
            (error: unknown) => (error as { code?: string }).code === 'INVALID_CONFIG',
        );
        const failingRedis = {
            ...redis,
            duplicate: () => ({
                ...redis,
                subscribe: () => { throw new Error('subscription failed'); },
            }),
        };
        assert.equal(await initializeDistributedCacheInvalidator({ cache: { distributed: { redis: failingRedis } } } as any, runtimeCache as any, logger), null);
        assert.equal(logger.warnings.length, 1);
    });

    it('rejects an external cache without an explicit receive-only invalidation method', () => {
        assert.throws(
            () => new DistributedCacheInvalidator({
                cache: { delPattern: async () => undefined },
                _connections: { pub: makeMockConnection(), sub: makeMockConnection() },
            }),
            /receive-only cache invalidation/,
        );
    });

    it('invalidates a MultiLevelCache leaf without publishing an inbound message again', async () => {
        const local = new MemoryCache();
        let rootPublishes = 0;
        const cache = new MultiLevelCache({ local, publish: () => { rootPublishes += 1; } });
        await cache.set('loop:key', 1);
        const pub = makeMockConnection();
        let outbound = 0;
        pub.publish = async () => { outbound += 1; };
        const sub = makeMockConnection();
        const inv = new DistributedCacheInvalidator({ cache, _connections: { pub, sub } });
        const before = rootPublishes;
        sub._emit('message', inv.channel, JSON.stringify({
            type: 'invalidateKey', key: 'loop:key', instanceId: 'peer',
        }));
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(await local.get('loop:key'), undefined);
        assert.equal(outbound, 0);
        assert.equal(rootPublishes, before);
        await inv.invalidateKey('active:key');
        assert.equal(outbound, 1);
    });
    it('throws when no cache provided', () => {
        assert.throws(
            () => new DistributedCacheInvalidator({ cache: null, _connections: { pub: makeMockConnection(), sub: makeMockConnection() } }),
            /requires a cache/,
        );
    });

    it('throws when no redis/redisUrl/_connections', () => {
        assert.throws(
            () => new DistributedCacheInvalidator({ cache: receiveOnly({}) }),
            /requires either redis or redisUrl/,
        );
    });

    it('uses _connections.pub and sub when provided', () => {
        const { inv } = buildInvalidator();
        assert.ok(inv.pub !== null);
        assert.ok(inv.sub !== null);
    });

    it('uses options.redis when _connections not provided', () => {
        const pub = makeMockConnection();
        const inv = new DistributedCacheInvalidator({ cache: receiveOnly({}), redis: pub });
        assert.equal(inv.pub, pub);
        assert.notEqual(inv.sub, pub);
    });

    it('rejects a Redis client that cannot provide an independent subscriber', () => {
        const redis = { ...makeMockConnection(), duplicate: undefined };
        assert.throws(
            () => new DistributedCacheInvalidator({ cache: receiveOnly({}), redis }),
            /redis\.duplicate\(\)/,
        );
    });

    it('reports subscription failures before processing any invalidation', () => {
        const errors: string[] = [];
        const pub = makeMockConnection();
        const sub = {
            ...makeMockConnection(),
            subscribe: (_channel: string, callback: (error: Error) => void) => callback(new Error('subscription unavailable')),
        };
        const inv = new DistributedCacheInvalidator({
            cache: receiveOnly({}),
            _connections: { pub, sub },
            logger: { error: (message: string) => errors.push(message) },
        });
        assert.equal(inv.getStats().errors, 1);
        assert.match(errors[0], /subscription unavailable/);
    });

    it('uses custom channel from options', () => {
        const { inv } = buildInvalidator();
        const customInv = new DistributedCacheInvalidator({
            cache: receiveOnly({}),
            _connections: { pub: makeMockConnection(), sub: makeMockConnection() },
            channel: 'my:custom:channel',
        });
        assert.equal(customInv.channel, 'my:custom:channel');
    });

    it('uses custom instanceId from options', () => {
        const customInv = new DistributedCacheInvalidator({
            cache: receiveOnly({}),
            _connections: { pub: makeMockConnection(), sub: makeMockConnection() },
            instanceId: 'fixed-instance-id',
        });
        assert.equal(customInv.instanceId, 'fixed-instance-id');
    });

    it('message on different channel is ignored', async () => {
        const pub = makeMockConnection();
        const sub = makeMockConnection();
        const inv = new DistributedCacheInvalidator({ cache: receiveOnly({ delPattern: async () => {} }), _connections: { pub, sub } });
        const before = inv.getStats().messagesReceived;
        sub._emit('message', 'other:channel', JSON.stringify({ type: 'invalidate', instanceId: 'other', pattern: 'test' }));
        await new Promise((r) => setImmediate(r));
        assert.equal(inv.getStats().messagesReceived, before);
    });

    it('invalid JSON in message increments error count', async () => {
        const pub = makeMockConnection();
        const sub = makeMockConnection();
        const inv = new DistributedCacheInvalidator({ cache: receiveOnly({ delPattern: async () => {} }), _connections: { pub, sub } });
        const channel = inv.channel;
        sub._emit('message', channel, 'not-valid-json{{{');
        await new Promise((r) => setImmediate(r));
        assert.equal(inv.getStats().errors, 1);
    });

    it('message type !== invalidate is ignored', async () => {
        const pub = makeMockConnection();
        const sub = makeMockConnection();
        const inv = new DistributedCacheInvalidator({ cache: receiveOnly({ delPattern: async () => {} }), _connections: { pub, sub } });
        const channel = inv.channel;
        sub._emit('message', channel, JSON.stringify({ type: 'other', instanceId: 'other' }));
        await new Promise((r) => setImmediate(r));
        assert.equal(inv.getStats().messagesReceived, 0);
    });

    it('ignores a message without a type before counting it as received', async () => {
        const { inv, sub } = buildInvalidator();
        sub._emit('message', inv.channel, JSON.stringify({ instanceId: 'peer', pattern: 'ignored:*' }));
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(inv.getStats().messagesReceived, 0);
        assert.equal(inv.getStats().invalidationsTriggered, 0);
    });

    it('message from same instanceId is ignored (own message)', async () => {
        const pub = makeMockConnection();
        const sub = makeMockConnection();
        const inv = new DistributedCacheInvalidator({ cache: receiveOnly({ delPattern: async () => {} }), _connections: { pub, sub } });
        const channel = inv.channel;
        const instanceId = inv.instanceId;
        sub._emit('message', channel, JSON.stringify({ type: 'invalidate', instanceId, pattern: 'test' }));
        await new Promise((r) => setImmediate(r));
        assert.equal(inv.getStats().messagesReceived, 0);
    });

    it('valid message from other instance triggers cache invalidation', async () => {
        const invalidated: string[] = [];
        const pub = makeMockConnection();
        const sub = makeMockConnection();
        const inv = new DistributedCacheInvalidator({
            cache: receiveOnly({ delPattern: async (p: string) => { invalidated.push(p); } }),
            _connections: { pub, sub },
        });
        const channel = inv.channel;
        sub._emit('message', channel, JSON.stringify({ type: 'invalidate', instanceId: 'other', pattern: 'test:*' }));
        await new Promise((r) => setImmediate(r));
        assert.ok(invalidated.includes('test:*'));
        assert.equal(inv.getStats().invalidationsTriggered, 1);
    });

    it('accepts legacy key invalidation messages without publishing them again', async () => {
        const cache = new MemoryCache();
        await cache.set('legacy:one', 1);
        await cache.set('legacy:two', 2);
        await cache.set('legacy:three', 3);
        const pub = makeMockConnection();
        const sub = makeMockConnection();
        let published = 0;
        pub.publish = async () => { published += 1; };
        const inv = new DistributedCacheInvalidator({ cache, _connections: { pub, sub } });
        for (const [type, key] of [
            ['invalidateKey', 'legacy:one'],
            ['del', 'legacy:two'],
            ['delete', 'legacy:three'],
        ]) {
            sub._emit('message', inv.channel, JSON.stringify({ type, key, instanceId: 'peer' }));
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(await cache.get('legacy:one'), undefined);
        assert.equal(await cache.get('legacy:two'), undefined);
        assert.equal(await cache.get('legacy:three'), undefined);
        assert.equal(inv.getStats().invalidationsTriggered, 3);
        assert.equal(published, 0);
    });

    it('cache invalidation error increments error stats', async () => {
        const pub = makeMockConnection();
        const sub = makeMockConnection();
        const inv = new DistributedCacheInvalidator({
            cache: receiveOnly({
                delPattern: async () => { throw new Error('redis error'); },
            }),
            _connections: { pub, sub },
        });
        const channel = inv.channel;
        sub._emit('message', channel, JSON.stringify({ type: 'invalidate', instanceId: 'other', pattern: 'x:*' }));
        await new Promise((r) => setImmediate(r));
        assert.equal(inv.getStats().errors, 1);
    });

    it('_getTargetCaches includes cache.local and cache.remote when they have delPattern', async () => {
        const invalidatedLocal: string[] = [];
        const invalidatedRemote: string[] = [];
        const pub = makeMockConnection();
        const sub = makeMockConnection();
        const cache = {
            local: { delPattern: async (p: string) => { invalidatedLocal.push(p); } },
            remote: { delPattern: async (p: string) => { invalidatedRemote.push(p); } },
        };
        const inv = new DistributedCacheInvalidator({ cache: receiveOnly(cache), _connections: { pub, sub } });
        const channel = inv.channel;
        sub._emit('message', channel, JSON.stringify({ type: 'invalidate', instanceId: 'other', pattern: 'k:*' }));
        await new Promise((r) => setImmediate(r));
        assert.ok(invalidatedLocal.includes('k:*'));
        assert.ok(invalidatedRemote.includes('k:*'));
    });

    it('_getTargetCaches: cache has delPattern directly', async () => {
        const invalidated: string[] = [];
        const pub = makeMockConnection();
        const sub = makeMockConnection();
        const cache = { delPattern: async (p: string) => { invalidated.push(p); } };
        const inv = new DistributedCacheInvalidator({ cache: receiveOnly(cache), _connections: { pub, sub } });
        const channel = inv.channel;
        sub._emit('message', channel, JSON.stringify({ type: 'invalidate', instanceId: 'other', pattern: 'z:*' }));
        await new Promise((r) => setImmediate(r));
        assert.ok(invalidated.includes('z:*'));
    });

    it('invalidate() with empty pattern returns early', async () => {
        const { inv } = buildInvalidator();
        await inv.invalidate('');
        assert.equal(inv.getStats().messagesSent, 0);
    });

    it('invalidate() publishes message and increments messagesSent', async () => {
        const published: unknown[] = [];
        const pub = makeMockConnection();
        pub.publish = async (_ch: string, msg: string) => { published.push(msg); };
        const sub = makeMockConnection();
        const inv = new DistributedCacheInvalidator({ cache: receiveOnly({}), _connections: { pub, sub } });
        await inv.invalidate('test:*');
        assert.equal(inv.getStats().messagesSent, 1);
        assert.ok(published.length === 1);
    });

    it('invalidate() error propagates and increments errors', async () => {
        const pub = makeMockConnection();
        pub.publish = async () => { throw new Error('publish error'); };
        const sub = makeMockConnection();
        const inv = new DistributedCacheInvalidator({ cache: receiveOnly({}), _connections: { pub, sub } });
        await assert.rejects(() => inv.invalidate('x:*'), /publish error/);
        assert.equal(inv.getStats().errors, 1);
    });

    it('logs inbound and outbound pattern and key invalidations without rebroadcasting inbound messages', async () => {
        const debug: string[] = [];
        const invalidated: Array<[string, string]> = [];
        const published: string[] = [];
        const pub = makeMockConnection();
        pub.publish = async (_channel: string, message: string) => { published.push(message); };
        const sub = makeMockConnection();
        const inv = new DistributedCacheInvalidator({
            cache: { invalidateFromRemote: async (kind: string, value: string) => { invalidated.push([kind, value]); } },
            _connections: { pub, sub },
            logger: { debug: (message: string) => { debug.push(message); } },
        });
        sub._emit('message', inv.channel, JSON.stringify({ type: 'delPattern', pattern: 'remote:*', instanceId: 'peer' }));
        sub._emit('message', inv.channel, JSON.stringify({ type: 'invalidateKey', key: 'remote:key', instanceId: 'peer' }));
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(invalidated, [['pattern', 'remote:*'], ['key', 'remote:key']]);
        assert.equal(published.length, 0);
        await inv.invalidate('local:*');
        await inv.invalidateKey('local:key');
        assert.equal(published.length, 2);
        assert.ok(debug.some((entry) => entry.includes('remote:*')));
        assert.ok(debug.some((entry) => entry.includes('remote:key')));
        assert.ok(debug.some((entry) => entry.includes('local:*')));
        assert.ok(debug.some((entry) => entry.includes('local:key')));
    });

    it('invalidateKey ignores an empty key and reports publish failures', async () => {
        const pub = makeMockConnection();
        pub.publish = async () => { throw new Error('key publish failed'); };
        const sub = makeMockConnection();
        const inv = new DistributedCacheInvalidator({ cache: receiveOnly({}), _connections: { pub, sub } });
        await inv.invalidateKey('');
        assert.equal(inv.getStats().messagesSent, 0);
        await assert.rejects(() => inv.invalidateKey('active:key'), /key publish failed/);
        assert.equal(inv.getStats().errors, 1);
    });

    it('getStats returns structured stats with instanceId and channel', () => {
        const { inv } = buildInvalidator();
        const stats = inv.getStats();
        assert.ok('messagesSent' in stats);
        assert.ok('instanceId' in stats);
        assert.ok('channel' in stats);
    });

    it('close() succeeds without errors', async () => {
        const { inv } = buildInvalidator();
        await assert.doesNotReject(() => inv.close());
    });

    it('close() with error swallows it when logger is null', async () => {
        const pub = makeMockConnection();
        pub.quit = async () => { throw new Error('quit error'); };
        const sub = makeMockConnection();
        const inv = new DistributedCacheInvalidator({ cache: receiveOnly({}), _connections: { pub, sub } });
        await assert.doesNotReject(() => inv.close());
    });

    it('close() with error logs it when logger is provided', async () => {
        const errors: unknown[] = [];
        const pub = makeMockConnection();
        pub.quit = async () => { throw new Error('quit error'); };
        const sub = makeMockConnection();
        const inv = new DistributedCacheInvalidator({
            cache: receiveOnly({}),
            _connections: { pub, sub },
            logger: { error: (...args: unknown[]) => errors.push(args), debug: () => {} },
        });
        await assert.doesNotReject(() => inv.close());
        assert.ok(errors.length > 0);
    });
});
