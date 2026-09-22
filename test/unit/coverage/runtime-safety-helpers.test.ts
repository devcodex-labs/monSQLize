import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { describe, it } from 'node:test';
import { isProductionEnvironment } from '../../../src/adapters/mongodb/common/drop-database-safety';
import { Logger } from '../../../src/core/logger';
import {
    buildCacheInvalidationBarrierKey,
    clearCacheInvalidationBarrier,
    extractCacheInvalidationBarrierNamespaces,
    isCacheInvalidationBarrierActive,
    markCacheInvalidationBarrier,
} from '../../../src/core/cache-invalidation-barrier';
import { createRuntimeAccessors, createRuntimeDbFacade } from '../../../src/entry/runtime-db-facade';
import { disposeRuntimeSchemaDslEngine } from '../../../src/entry/runtime-schema-dsl';
import { prepareSshTunnelConnectConfig } from '../../../src/entry/runtime-ssh';
import { SSHTunnelSSH2 } from '../../../src/capabilities/ssh';

describe('runtime safety helpers', () => {
    it('normalizes production-like environment names', () => {
        assert.equal(isProductionEnvironment(42), false);
        assert.equal(isProductionEnvironment(' PROD '), true);
        assert.equal(isProductionEnvironment('live'), true);
        assert.equal(isProductionEnvironment('staging'), false);
    });

    it('extracts direct namespaces and supported wildcard cache patterns', () => {
        assert.deepEqual(extractCacheInvalidationBarrierNamespaces([
            '',
            'db.items',
            'find:db.items:*',
            'count:db.items:*',
            'unsupported:db.other:*',
            'invalid*pattern',
        ]), ['db.items']);
        assert.equal(buildCacheInvalidationBarrierKey('db.items'), 'cacheDirty:db.items');
    });

    it('marks barriers only when the cache supports set', async () => {
        assert.deepEqual(await markCacheInvalidationBarrier(null, ['db.items']), []);
        assert.deepEqual(await markCacheInvalidationBarrier({}, ['db.items']), []);

        const writes: Array<[string, unknown, number]> = [];
        const namespaces = await markCacheInvalidationBarrier({
            set: async (key, value, ttl) => { writes.push([key, value, ttl]); },
        }, ['find:db.items:*', 'db.other'], 1234);

        assert.deepEqual(namespaces, ['db.items', 'db.other']);
        assert.equal(writes.length, 2);
        assert.deepEqual(writes.map(([key, , ttl]) => [key, ttl]), [
            ['cacheDirty:db.items', 1234],
            ['cacheDirty:db.other', 1234],
        ]);
    });

    it('clears barriers through del or delete and accepts incapable caches', async () => {
        await assert.doesNotReject(() => clearCacheInvalidationBarrier(null, ['db.items']));
        await assert.doesNotReject(() => clearCacheInvalidationBarrier({}, ['db.items']));

        const deleted: string[] = [];
        await clearCacheInvalidationBarrier({ del: async (key) => { deleted.push(`del:${key}`); } }, ['db.items']);
        await clearCacheInvalidationBarrier({ delete: async (key) => { deleted.push(`delete:${key}`); } }, ['count:db.other:*']);
        assert.deepEqual(deleted, ['del:cacheDirty:db.items', 'delete:cacheDirty:db.other']);
    });

    it('detects only truthy barrier markers', async () => {
        assert.equal(await isCacheInvalidationBarrierActive(null, ['db.items']), false);
        assert.equal(await isCacheInvalidationBarrierActive({}, ['db.items']), false);

        const values = new Map<string, unknown>([
            ['cacheDirty:db.undefined', undefined],
            ['cacheDirty:db.null', null],
            ['cacheDirty:db.false', false],
            ['cacheDirty:db.active', { dirty: true }],
        ]);
        const cache = { get: async (key: string) => values.get(key) };
        assert.equal(await isCacheInvalidationBarrierActive(cache, ['db.undefined', 'db.null', 'db.false']), false);
        assert.equal(await isCacheInvalidationBarrierActive(cache, ['db.undefined', 'db.active', 'db.false']), true);
    });

    it('contains schema runtime disposal errors with or without a warning sink', () => {
        const warnings: unknown[][] = [];
        const engine = { dispose: () => { throw new Error('dispose failed'); } };
        assert.doesNotThrow(() => disposeRuntimeSchemaDslEngine(engine as never, {
            warn: (...args: unknown[]) => { warnings.push(args); },
        }, 'during close'));
        assert.equal(warnings.length, 1);
        assert.doesNotThrow(() => disposeRuntimeSchemaDslEngine(engine as never, {}, 'before reconnect'));
    });

    it('keeps missing SSH configuration unchanged', async () => {
        const logger = Logger.create(null);
        assert.deepEqual(await prepareSshTunnelConnectConfig(undefined, 'db', logger), {
            connectConfig: undefined,
            tunnel: null,
        });
        const config = { uri: 'mongodb://localhost:27017' };
        assert.deepEqual(await prepareSshTunnelConnectConfig(config, 'db', logger), {
            connectConfig: config,
            tunnel: null,
        });
    });

    it('rejects a wrong SSH host fingerprint and closes the local listener', async () => {
        const { privateKey } = generateKeyPairSync('rsa', {
            modulusLength: 2048,
            privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
            publicKeyEncoding: { type: 'spki', format: 'pem' },
        });
        interface ServerClient {
            on(event: 'authentication', handler: (context: { accept(): void }) => void): this;
            on(event: 'error', handler: (error: Error) => void): this;
        }
        const SshServer = (require('ssh2') as {
            Server: new (options: object, handler: (client: ServerClient) => void) => Server;
        }).Server;
        const sshServer = new SshServer({ hostKeys: [privateKey] }, (client) => {
            client.on('authentication', (context) => context.accept()).on('error', () => undefined);
        });
        await new Promise<void>((resolve) => sshServer.listen(0, '127.0.0.1', resolve));
        const port = (sshServer.address() as AddressInfo).port;
        let verifierCalled = false;
        const tunnel = new SSHTunnelSSH2({
            host: '127.0.0.1', port, username: 'user', password: 'password', readyTimeout: 3000,
            hostHash: 'sha256', hostVerifier: () => { verifierCalled = true; return false; },
        }, '127.0.0.1', 27017);
        try {
            const error = await tunnel.connect().then(() => null, (cause: unknown) => cause);
            assert.ok(error instanceof Error);
            assert.equal(verifierCalled, true, error.message);
            assert.equal(tunnel.isConnected, false);
            assert.equal(tunnel.localPort, null);
            assert.equal(tunnel.server, null);
        } finally {
            await tunnel.close();
            await new Promise<void>((resolve) => sshServer.close(() => resolve()));
        }
    });

    it('cleans up after the SSH socket closes during handshake', async () => {
        const sshServer = createServer((socket) => socket.destroy());
        await new Promise<void>((resolve) => sshServer.listen(0, '127.0.0.1', resolve));
        const port = (sshServer.address() as AddressInfo).port;
        const tunnel = new SSHTunnelSSH2({
            host: '127.0.0.1', port, username: 'user', password: 'password', readyTimeout: 1000,
        }, '127.0.0.1', 27017);
        try {
            await assert.rejects(() => tunnel.connect());
            assert.equal(tunnel.isConnected, false);
            assert.equal(tunnel.localPort, null);
            assert.equal(tunnel.server, null);
        } finally {
            await tunnel.close();
            await new Promise<void>((resolve) => sshServer.close(() => resolve()));
        }
    });

    it('normalizes cache auto-invalidation options for database facades', () => {
        const database = { collection: () => ({}) };
        const host = (options: Record<string, unknown>) => ({
            options,
            _client: { db: () => database },
            _logger: Logger.create(null),
            _runtimeDefaults: {},
            resolveAdapterCache: () => null,
        });

        assert.ok(createRuntimeDbFacade(host({ cache: { autoInvalidate: true } }) as never, 'db'));
        assert.ok(createRuntimeDbFacade(host({ cache: [], cacheAutoInvalidate: true }) as never, 'db'));
        assert.ok(createRuntimeDbFacade(host({ cache: 'legacy', cacheAutoInvalidate: false }) as never, 'db'));
    });

    it('rejects every invalid collection-name shape from runtime accessors', () => {
        const accessors = createRuntimeAccessors({
            defaultDb: { collection: () => ({}) } as never,
            runtime: {},
            db: () => ({}) as never,
            use: () => ({}) as never,
            getIidCache: () => null,
            setIidCache: () => undefined,
        });

        for (const name of ['', 42, '   ']) {
            assert.throws(
                () => accessors.collection(name as string),
                (error: unknown) => error instanceof Error && (error as Error & { code?: string }).code === 'INVALID_COLLECTION_NAME',
            );
        }
    });
});
