/**
 * MongoDB connection adapter layer.
 *
 * Description:
 * - Supports config.uri (production) and config.useMemoryServer (test environment, v1 compatible).
 * - When useMemoryServer is true, mongodb-memory-server starts automatically; no URI is required.
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { MongoClient, type MongoClientOptions } from 'mongodb';

import memoryServerPolicy from '../../../../config/mongodb-memory-server.json';
import { createConnectionError, createError, ErrorCodes, type MonSQLizeError } from '../../../core/errors';
import type { Logger } from '../../../core/logger';
import type { MongoConnectConfig, MongoConnectionState } from '../../../../types/mongodb';

export type { MongoConnectConfig, MongoConnectionState } from '../../../../types/mongodb';

const DEFAULT_MEMORY_SERVER_VERSION = memoryServerPolicy.defaultVersion;
const DEFAULT_MEMORY_SERVER_LAUNCH_TIMEOUT_MS = 30_000;
const MANAGED_DB_PATH_PREFIXES = memoryServerPolicy.managedDbPathKinds.map((kind) => `${kind}-`);

// Singleton memory server (v1 compatible: reuses an already-started instance)
let _memoryServerInstance: { getUri(): string; stop(cleanupOptions?: { doCleanup?: boolean; force?: boolean }): Promise<boolean | void> } | null = null;
let _memoryServerStartPromise: Promise<string> | null = null;
let _memoryServerStopPromise: Promise<void> | null = null;
let _memoryServerPendingConnections = 0;
let _memoryServerCleanupOptions: { doCleanup: true; force: boolean } = { doCleanup: true, force: true };
let _memoryServerDbPath: string | null = null;
const _memoryServerClients = new Set<MongoClient>();

function setDefaultEnv(name: string, value: string): void {
    if (!process.env[name]) {
        process.env[name] = value;
    }
}

function sanitizePathSegment(input: string): string {
    return input.replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
}

function parseManagedPathPid(name: string): number | null {
    if (!MANAGED_DB_PATH_PREFIXES.some((prefix) => name.startsWith(prefix))) {
        return null;
    }
    const match = /-(\d+)-[^-]+$/.exec(name);
    if (!match) {
        return null;
    }
    const pid = Number.parseInt(match[1], 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function isProcessAlive(pid: number): boolean {
    if (pid === process.pid) {
        return true;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as { code?: string }).code === 'EPERM';
    }
}

function pruneManagedDbRoot(dbRoot: string): void {
    let entries: Array<{ isDirectory(): boolean; name: string }>;
    try {
        entries = readdirSync(dbRoot, { withFileTypes: true });
    } catch {
        return;
    }

    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }
        const pid = parseManagedPathPid(entry.name);
        if (!pid || isProcessAlive(pid)) {
            continue;
        }
        try {
            rmSync(path.join(dbRoot, entry.name), { recursive: true, force: true });
        } catch {
            // Best-effort stale path cleanup. The current instance path still reports cleanup failure.
        }
    }
}

function resolveMemoryServerBinaryVersion(memoryServerOptions: MongoConnectConfig['memoryServerOptions'] = {}): string {
    return (
        memoryServerOptions?.binary?.version ||
        process.env.MONSQLIZE_REPLSET_BINARY_VERSION ||
        process.env.MONSQLIZE_MEMORY_MONGO_BINARY_VERSION ||
        process.env.MONGOMS_VERSION ||
        DEFAULT_MEMORY_SERVER_VERSION
    );
}

function resolveMemoryServerPolicy(binaryVersion: string): { downloadDir: string; dbRoot: string } {
    const cacheRoot = path.resolve(process.env.MONSQLIZE_MEMORY_SERVER_CACHE_DIR || path.join(process.cwd(), '.cache', 'mongodb-memory-server'));
    const downloadDir = path.resolve(process.env.MONGOMS_DOWNLOAD_DIR || path.join(cacheRoot, 'binaries'));
    const dbRoot = path.resolve(process.env.MONSQLIZE_MEMORY_SERVER_DB_DIR || path.join(cacheRoot, 'db'));

    mkdirSync(downloadDir, { recursive: true });
    mkdirSync(dbRoot, { recursive: true });
    pruneManagedDbRoot(dbRoot);

    setDefaultEnv('MONGOMS_DOWNLOAD_DIR', downloadDir);
    setDefaultEnv('MONGOMS_PREFER_GLOBAL_PATH', 'false');
    setDefaultEnv('MONGOMS_RUNTIME_DOWNLOAD', 'true');
    setDefaultEnv('MONGOMS_VERSION', binaryVersion);

    return { downloadDir, dbRoot };
}

function createManagedDbPath(dbRoot: string, dbName: string): string {
    return mkdtempSync(path.join(dbRoot, `replset-${sanitizePathSegment(dbName)}-${process.pid}-`));
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanupManagedDbPath(dbPath: string | null): Promise<boolean> {
    if (!dbPath) {
        return true;
    }
    for (const waitMs of [0, 50, 100, 200, 400, 800]) {
        if (waitMs > 0) {
            await delay(waitMs);
        }
        try {
            rmSync(dbPath, { recursive: true, force: true });
            if (!existsSync(dbPath)) {
                return true;
            }
        } catch {
            // Retry while the OS releases journal files.
        }
    }
    return !existsSync(dbPath);
}

function resolveLaunchTimeout(): number | undefined {
    const raw = process.env.MONSQLIZE_MEMORY_MONGO_LAUNCH_TIMEOUT_MS;
    if (!raw) {
        return DEFAULT_MEMORY_SERVER_LAUNCH_TIMEOUT_MS;
    }

    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value > 0 ? value : undefined;
}

async function seedMemoryServerBinaryCache(binaryVersion: string, downloadDir: string): Promise<void> {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { DryMongoBinary } = require('mongodb-memory-server-core/lib/util/DryMongoBinary') as {
            DryMongoBinary: {
                generateOptions(opts: Record<string, unknown>): Promise<Record<string, unknown>>;
                generatePaths(opts: Record<string, unknown>): Promise<{ resolveConfig?: string; homeCache?: string }>;
            };
        };
        const options = await DryMongoBinary.generateOptions({ version: binaryVersion, downloadDir });
        options.downloadDir = downloadDir;
        const paths = await DryMongoBinary.generatePaths(options);
        if (
            paths.resolveConfig &&
            paths.homeCache &&
            path.resolve(paths.resolveConfig) !== path.resolve(paths.homeCache) &&
            existsSync(paths.homeCache) &&
            !existsSync(paths.resolveConfig)
        ) {
            mkdirSync(path.dirname(paths.resolveConfig), { recursive: true });
            copyFileSync(paths.homeCache, paths.resolveConfig);
        }
    } catch {
        // Best-effort seeding only; mongodb-memory-server can still download into the configured cache.
    }
}

/**
 * Starts or reuses the mongodb-memory-server singleton, returning the connection URI.
 * Uses MongoMemoryReplSet (single-node replica set) to support MongoDB transactions.
 * @internal Only used by the useMemoryServer code path.
 */
async function startMemoryServer(
    logger: Logger | undefined,
    memoryServerOptions: MongoConnectConfig['memoryServerOptions'] = {},
): Promise<string> {
    while (_memoryServerStopPromise) await _memoryServerStopPromise;
    if (_memoryServerInstance) {
        return _memoryServerInstance.getUri();
    }
    if (_memoryServerStartPromise) {
        return _memoryServerStartPromise;
    }
    _memoryServerStartPromise = startMemoryServerCore(logger, memoryServerOptions)
        .finally(() => {
            _memoryServerStartPromise = null;
        });
    return _memoryServerStartPromise;
}

async function startMemoryServerCore(
    logger: Logger | undefined,
    memoryServerOptions: MongoConnectConfig['memoryServerOptions'] = {},
): Promise<string> {
    if (_memoryServerInstance) {
        return _memoryServerInstance.getUri();
    }

    const binaryVersion = resolveMemoryServerBinaryVersion(memoryServerOptions);
    const { dbRoot, downloadDir } = resolveMemoryServerPolicy(binaryVersion);
    await seedMemoryServerBinaryCache(binaryVersion, downloadDir);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { MongoMemoryReplSet } = require('mongodb-memory-server') as {
        MongoMemoryReplSet: {
            create(opts?: unknown): Promise<{ getUri(): string; stop(cleanupOptions?: { doCleanup?: boolean; force?: boolean }): Promise<boolean | void> }>;
        };
    };

    logger?.info?.('Starting MongoDB Memory ReplSet', { binaryVersion });

    // Single-node replica set is required for MongoDB transactions; storageEngine uses wiredTiger.
    const dbName = memoryServerOptions?.instance?.dbName || 'monsqlize_memory';
    const instanceConfig = { ...(memoryServerOptions?.instance ?? {}) } as Record<string, unknown>;
    const hasUserDbPath = typeof instanceConfig.dbPath === 'string' && instanceConfig.dbPath.length > 0;
    if (!hasUserDbPath) {
        _memoryServerDbPath = createManagedDbPath(dbRoot, dbName);
        instanceConfig.dbPath = _memoryServerDbPath;
    } else {
        _memoryServerDbPath = null;
    }
    if (instanceConfig.launchTimeout === undefined) {
        const launchTimeout = resolveLaunchTimeout();
        if (launchTimeout) {
            instanceConfig.launchTimeout = launchTimeout;
        }
    }
    _memoryServerCleanupOptions = { doCleanup: true, force: !hasUserDbPath };

    const defaultConfig = {
        replSet: { count: 1, storageEngine: 'wiredTiger' },
        binary: { version: binaryVersion },
        instanceOpts: [instanceConfig],
    };

    const resolvedConfig = {
        ...defaultConfig,
        binary: { ...defaultConfig.binary, ...(memoryServerOptions?.binary ?? {}) },
    };

    try {
        _memoryServerInstance = await MongoMemoryReplSet.create(resolvedConfig);
        const uri = _memoryServerInstance!.getUri();
        logger?.info?.('MongoDB Memory ReplSet started', { uri });
        return uri;
    } catch (err) {
        if (!hasUserDbPath) {
            await cleanupManagedDbPath(_memoryServerDbPath);
            _memoryServerDbPath = null;
        }
        logger?.error?.('Failed to start MongoDB Memory ReplSet', err);
        throw createConnectionError(
            `Failed to start MongoDB Memory ReplSet: ${(err as Error).message}`,
            err instanceof Error ? err : undefined,
        );
    }
}

async function stopMemoryServer(logger?: Logger, strict = false): Promise<void> {
    if (_memoryServerPendingConnections > 0) return;
    const stopping = _memoryServerStopPromise ?? (async () => {
        if (_memoryServerStartPromise) await _memoryServerStartPromise.catch(() => undefined);
        const instance = _memoryServerInstance;
        if (!instance) return;
        const stopped = await instance.stop(_memoryServerCleanupOptions);
        if (stopped === false) throw createError(ErrorCodes.CONNECTION_CLOSED, 'MongoDB Memory ReplSet did not stop.');
        if (_memoryServerCleanupOptions.force) {
            const cleaned = await cleanupManagedDbPath(_memoryServerDbPath);
            if (!cleaned) {
                try { logger?.warn?.('Failed to remove MongoDB Memory ReplSet dbPath.', { dbPath: _memoryServerDbPath }); } catch { /* Preserve cleanup outcome. */ }
            }
        }
        _memoryServerInstance = null;
        _memoryServerDbPath = null;
        _memoryServerCleanupOptions = { doCleanup: true, force: true };
        try { logger?.info?.('MongoDB Memory ReplSet stopped'); } catch { /* Logging is not resource ownership. */ }
    })();
    _memoryServerStopPromise = stopping;
    try { await stopping; }
    catch (error) {
        if (strict) throw error;
        try { logger?.warn?.('Failed to stop MongoDB Memory ReplSet cleanly.', error); } catch { /* Legacy cleanup logs are best effort. */ }
    } finally { if (_memoryServerStopPromise === stopping) _memoryServerStopPromise = null; }
}

/**
 * Establishes a MongoDB connection.
 * @since v1.3.0
 */
export async function connectMongo(params: {
    databaseName: string;
    config?: MongoConnectConfig;
    logger?: Logger;
    onCreated?: (client: MongoClient) => void;
}): Promise<MongoConnectionState> {
    const databaseName = params.databaseName?.trim();
    if (!databaseName) {
        throw createError(ErrorCodes.INVALID_DATABASE_NAME, 'Database name must be a non-empty string.');
    }

    let effectiveUri = params.config?.uri?.trim();
    let usesManagedMemoryServer = false;
    let reservedMemoryConnection = false;

    // v1 compat: useMemoryServer code path
    if (!effectiveUri && params.config?.useMemoryServer === true) {
        // If MONSQLIZE_USE_SYSTEM_MONGO=true, connect to the system MongoDB directly (skip mongodb-memory-server)
        if (process.env['MONSQLIZE_USE_SYSTEM_MONGO'] === 'true') {
            const systemUri = process.env['MONSQLIZE_SYSTEM_MONGO_URI'] ?? 'mongodb://127.0.0.1:27017';
            params.logger?.info?.('Using system MongoDB instead of memory server', { uri: systemUri });
            effectiveUri = systemUri;
        } else {
            while (_memoryServerStopPromise) await _memoryServerStopPromise;
            _memoryServerPendingConnections++;
            reservedMemoryConnection = true;
            try { effectiveUri = await startMemoryServer(params.logger, params.config.memoryServerOptions); }
            catch (error) {
                _memoryServerPendingConnections--;
                reservedMemoryConnection = false;
                if (_memoryServerClients.size === 0) await stopMemoryServer(params.logger);
                throw error;
            }
            usesManagedMemoryServer = true;
        }
    }

    if (!effectiveUri) {
        throw createError(ErrorCodes.INVALID_CONFIG, 'MongoDB connect requires config.uri.');
    }

    const clientOptions: MongoClientOptions = { ...(params.config?.options ?? {}) };
    if (params.config?.readPreference !== undefined) {
        clientOptions.readPreference = params.config.readPreference;
    }
    let client: MongoClient;
    try { client = new MongoClient(effectiveUri, clientOptions); }
    catch (error) {
        if (reservedMemoryConnection) _memoryServerPendingConnections--;
        if (usesManagedMemoryServer && _memoryServerClients.size === 0) await stopMemoryServer(params.logger);
        throw error;
    }
    if (usesManagedMemoryServer) _memoryServerClients.add(client);
    if (reservedMemoryConnection) _memoryServerPendingConnections--;

    try {
        params.onCreated?.(client);
        await client.connect();
        const db = client.db(databaseName);
        if (usesManagedMemoryServer) {
            _memoryServerClients.add(client);
        }
        params.logger?.info?.('MongoDB connected', { databaseName });
        return { client, db };
    } catch (cause) {
        if (!params.onCreated) await closeMongo(client, params.logger);
        throw createConnectionError(
            `Failed to connect to MongoDB database: ${databaseName}`,
            cause instanceof Error ? cause : undefined,
        );
    }
}

/**
 * Closes the MongoDB connection.
 * @since v1.3.0
 */
export async function closeMongo(client: MongoClient | null | undefined, logger?: Logger, strict = false): Promise<void> {
    if (!client) {
        if (strict && _memoryServerClients.size === 0) await stopMemoryServer(logger, true);
        return;
    }

    if (strict) {
        await client.close();
        if (_memoryServerClients.delete(client) && _memoryServerClients.size === 0) {
            try { await stopMemoryServer(logger, true); }
            catch (error) { _memoryServerClients.add(client); throw error; }
        }
        try { logger?.info?.('MongoDB connection closed'); } catch { /* Preserve the successful release. */ }
        return;
    }
    const shouldReleaseMemoryServer = _memoryServerClients.delete(client);
    let closeError: MonSQLizeError | null = null;
    try {
        await client.close();
        logger?.info?.('MongoDB connection closed');
    } catch (cause) {
        closeError = createError(
            ErrorCodes.CONNECTION_CLOSED,
            'Failed to close MongoDB connection cleanly.',
            undefined,
            cause instanceof Error ? cause : undefined,
        ) as MonSQLizeError;
        logger?.warn?.(closeError.message, closeError.cause);
    } finally {
        if (shouldReleaseMemoryServer && _memoryServerClients.size === 0) {
            await stopMemoryServer(logger);
        }
    }

    if (closeError) {
        return;
    }
}

