/**
 * Scoped collection resolver (runtime-scoped-collection).
 *
 * Determines the MongoClient and collection instance to use based on the Model's
 * connection config (pool / database). Supports three routing paths:
 *   1. Pool specified + CollectionFromClient adapter present → route via adapter
 *   2. Pool specified + poolManager present → route via poolManager.selectPool
 *   3. No pool configured → route via the default MongoClient
 */

import { Collection, type Db, type Document, type MongoClient } from 'mongodb';
import {
    MongoCollectionAccessor as CollectionFacade,
    type MongoDbAccessor as DbFacade,
} from '../adapters/mongodb/common/accessors';
import type { CacheLike } from '../capabilities/cache';
import type { Logger } from '../core/logger';
import type { ConnectionPoolManager } from '../capabilities/pool';
import { ErrorCodes, createError } from '../core/errors';
import type { RuntimeDefaults } from '../types/internal/query';
import type { MonSQLizeOptions } from '../../types/monsqlize';
import { resolvePoolClientFromRecord } from './runtime-compat-accessors';
import { scopedCacheDefaults } from '../core/cache-scope';

/**
 * Full configuration for `resolveScopedCollection`.
 *
 * Contains collectionName / connection scope / internal state references passed in
 * from runtime-core, reducing the scoped-collection module's direct dependency on
 * runtime-core private fields.
 */
type ResolveScopedCollectionConfig = {
    collectionName: string;
    connection: { pool?: string; database?: string };
    options: MonSQLizeOptions;
    self: Record<string, unknown>;
    client: MongoClient | null;
    poolManager: ConnectionPoolManager | null;
    cache: CacheLike;
    logger: Logger;
    runtimeDefaults: RuntimeDefaults;
    db: (name?: string) => DbFacade;
};

/**
 * Resolve and return the MongoDB collection instance for the given connection config.
 *
 * Branches on whether `config.connection.pool` is set:
 * - Pool present → prefer the adapter or poolManager to obtain the pool's Collection
 * - No pool → obtain via the default connection's `db(databaseName).collection(collectionName)`
 *
 * @throws `NO_POOL_MANAGER` — Model specifies a pool but no pools option is configured
 * @throws `POOL_NOT_FOUND` — the specified pool name is not in the pool manager
 * @throws `NOT_CONNECTED` — no pool and not yet connected
 */
export function resolveScopedCollection(config: ResolveScopedCollectionConfig): unknown {
    const poolName = config.connection.pool;
    const defaultDbName = (config.self['databaseName'] as string | undefined)
        ?? ((config.options as Record<string, unknown>)['database'] as string | undefined)
        ?? config.options.databaseName
        ?? 'default';
    const databaseName = config.connection.database || defaultDbName;

    if (poolName) {
        const poolManagerRecord = config.self['_poolManager'] as Record<string, unknown> | null;
        if (!poolManagerRecord) {
            throw createError(ErrorCodes.NO_POOL_MANAGER, `Model '${config.collectionName}' requires pool '${poolName}' but no pools are configured. Add 'pools' to MonSQLize constructor options.`);
        }
        const client = resolvePoolClientFromRecord(poolManagerRecord, poolName);
        if (!client) {
            const getNames = poolManagerRecord['getPoolNames'] as (() => string[]) | undefined;
            const available = typeof getNames === 'function' ? getNames.call(poolManagerRecord) : [];
            const error = createError(ErrorCodes.POOL_NOT_FOUND, `Pool '${poolName}' not found. Available pools: [${available.join(', ')}]`);
            (error as unknown as Record<string, unknown>)['available'] = available;
            throw error;
        }
        const adapter = config.self['_adapter'] as Record<string, unknown> | undefined;
        if (adapter && typeof adapter['collectionFromClient'] === 'function') {
            const scoped = (adapter['collectionFromClient'] as (currentClient: unknown, dbName: string, collectionName: string) => unknown)(
                client,
                databaseName,
                config.collectionName,
            );
            if (scoped instanceof CollectionFacade) {
                return scoped;
            }
            if (!(scoped instanceof Collection)) {
                return scoped;
            }
            const dbRef = resolveDbRef(client, databaseName);
            return new CollectionFacade(
                databaseName,
                config.collectionName,
                scoped as Collection<Document>,
                {
                    cache: config.cache,
                    queryCache: config.cache,
                    getCache: () => config.cache,
                    getQueryCache: () => config.cache,
                    logger: config.logger,
                    defaults: scopedCacheDefaults(config.runtimeDefaults, client, config.cache, poolName),
                    poolName,
                },
                dbRef,
            );
        }
        if (config.poolManager) {
            const selected = config.poolManager.selectPool('read', { pool: poolName, databaseName });
            return new CollectionFacade(
                databaseName,
                config.collectionName,
                selected.collection(databaseName, config.collectionName),
                {
                    cache: config.cache,
                    queryCache: config.cache,
                    getCache: () => config.cache,
                    getQueryCache: () => config.cache,
                    logger: config.logger,
                    defaults: scopedCacheDefaults(config.runtimeDefaults, client, config.cache, poolName),
                    poolName,
                },
            );
        }
        return null;
    }

    if (config.client) {
        return config.db(databaseName).collection(config.collectionName);
    }
    const dbInstance = config.self['dbInstance'] as { db: (name: string) => { collection: (name: string) => unknown } } | null;
    if (!dbInstance) {
        throw createError(ErrorCodes.NOT_CONNECTED, 'Database is not connected. Call connect() first.');
    }
    return dbInstance.db(databaseName).collection(config.collectionName);
}

function resolveDbRef(client: unknown, databaseName: string): Db | undefined {
    const maybeClient = client as { db?: (name: string) => Db };
    return typeof maybeClient?.db === 'function' ? maybeClient.db(databaseName) : undefined;
}
