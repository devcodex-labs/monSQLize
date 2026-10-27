import type { MongoClient } from 'mongodb';
import type { Logger } from '../core/logger';
import { ErrorCodes, createError } from '../core/errors';
import type { MonSQLizeOptions } from '../../types/monsqlize';
import type { RuntimeDefaults } from '../types/internal/query';
import { createMonSQLizeGridFSBucket, type MonSQLizeGridFSBucketImpl } from '../capabilities/gridfs';
import { resolveDatabaseName } from './runtime-db-facade';

type GridFSRuntimeState = {
    ensureConnected?: () => void;
    _connected?: boolean;
    options: MonSQLizeOptions;
    logger?: Logger;
    _logger?: Logger;
    _client: MongoClient | null;
    _poolManager: Record<string, unknown> | null;
    _runtimeDefaults?: RuntimeDefaults;
};

export function openRuntimeGridFS(
    runtime: unknown,
    bucketName?: string,
    opts?: { db?: string; pool?: string; chunkSizeBytes?: number },
): MonSQLizeGridFSBucketImpl {
    return openGridFS(runtime, {
        bucketName,
        dbName: opts?.db,
        poolName: opts?.pool,
        chunkSizeBytes: opts?.chunkSizeBytes,
        source: 'db',
    });
}

export function openModelGridFS(
    runtime: unknown,
    dbName: string,
    poolName: string | undefined,
    bucketName?: string,
    chunkSizeBytes?: number,
): MonSQLizeGridFSBucketImpl {
    return openGridFS(runtime, { bucketName, dbName, poolName, chunkSizeBytes, source: 'model' });
}

function openGridFS(runtime: unknown, request: {
    bucketName?: string;
    dbName?: string;
    poolName?: string;
    chunkSizeBytes?: number;
    source: 'db' | 'model';
}): MonSQLizeGridFSBucketImpl {
    const state = runtime as GridFSRuntimeState;
    if (typeof state.ensureConnected === 'function') state.ensureConnected();
    else if (!state._connected) {
        throw createError(ErrorCodes.NOT_CONNECTED, 'Database is not connected. Please call connect() first.');
    }
    const bucketName = request.bucketName === undefined ? 'fs' : request.bucketName;
    const dbName = request.dbName ?? resolveDatabaseName(state.options);
    if (!dbName || typeof dbName !== 'string' || !dbName.trim()) {
        throw createError(ErrorCodes.INVALID_DATABASE_NAME, 'Database name must be a non-empty string');
    }
    const client = resolveClient(state, request.poolName);
    return createMonSQLizeGridFSBucket({
        db: client.db(dbName),
        bucketName,
        dbName,
        poolName: request.poolName,
        chunkSizeBytes: request.chunkSizeBytes,
        source: request.source,
        policy: state._runtimeDefaults?.writePathPolicy,
        logger: state.logger ?? state._logger,
    });
}

function resolveClient(state: GridFSRuntimeState, poolName?: string): MongoClient {
    if (!poolName) {
        if (!state._client) throw createError(ErrorCodes.NOT_CONNECTED, 'Database is not connected. Please call connect() first.');
        return state._client;
    }
    const poolManager = state._poolManager;
    if (!poolManager) {
        throw createError(ErrorCodes.NO_POOL_MANAGER, `GridFS requires pool '${poolName}' but no pools are configured.`);
    }
    const client = readPoolClient(poolManager, poolName);
    if (!client) {
        const getNames = poolManager['getPoolNames'];
        const available = typeof getNames === 'function' ? (getNames as () => string[]).call(poolManager) : [];
        const error = createError(ErrorCodes.POOL_NOT_FOUND, `Pool '${poolName}' not found. Available pools: [${available.join(', ')}]`);
        (error as unknown as Record<string, unknown>)['available'] = available;
        throw error;
    }
    return client;
}

function readPoolClient(poolManager: Record<string, unknown>, poolName: string): MongoClient | null {
    const getPoolV1 = poolManager['_getPool'] as ((name: string) => MongoClient | null) | undefined;
    const getPoolV2 = poolManager['getPool'] as ((name: string) => MongoClient | null) | undefined;
    if (typeof getPoolV1 === 'function') return getPoolV1.call(poolManager, poolName) ?? null;
    if (typeof getPoolV2 === 'function') {
        try {
            return getPoolV2.call(poolManager, poolName) ?? null;
        } catch {
            return null;
        }
    }
    return null;
}
