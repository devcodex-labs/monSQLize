/**
 * Runtime database facade (DbFacade) factory functions.
 *
 * Encapsulates MongoDbAccessor instantiation logic and provides database name
 * resolution and ConnectResult construction utilities, keeping runtime-core
 * free of constructor-argument assembly details.
 */

import type { MongoClient } from 'mongodb';
import { scopedCacheDefaults } from '../core/cache-scope';
import type { Logger } from '../core/logger';
import { MemoryCache, type CacheLike } from '../capabilities/cache';
import {
    MongoDbAccessor as DbFacadeImpl,
    MongoCollectionAccessor as CollectionFacade,
} from '../adapters/mongodb/common/accessors';
import type { RuntimeDefaults } from '../types/internal/query';
import type { ConnectResult, ScopedUseResult } from '../types/internal/runtime';
import type { MonSQLizeOptions } from '../../types/monsqlize';
import type { MongoDbAccessor as DbFacade } from '../adapters/mongodb/common/accessors';

/**
 * Host contract required by `createRuntimeDbFacade`.
 * The host must provide `_client` / `_logger` / `_runtimeDefaults` and a cache resolver.
 */
export type RuntimeDbFacadeHost = {
    options: MonSQLizeOptions;
    _client: MongoClient;
    _logger: Logger;
    _runtimeDefaults: RuntimeDefaults;
    resolveAdapterCache(): CacheLike | null;
};

type RuntimeAccessorConfig<TRuntime> = {
    defaultDb: DbFacade;
    runtime: TRuntime;
    db: (name?: string) => DbFacade;
    use: (name: string) => ScopedUseResult;
    getIidCache: () => MemoryCache | null;
    setIidCache: (value: MemoryCache) => void;
};

/**
 * Create a `MongoDbAccessor` (DbFacade) instance for the given database,
 * injecting cache, query cache, logger, and runtime defaults.
 */
export function createRuntimeDbFacade(host: RuntimeDbFacadeHost, databaseName: string): DbFacade {
    const cacheOptions = host.options.cache && typeof host.options.cache === 'object' && !Array.isArray(host.options.cache)
        ? host.options.cache as Record<string, unknown>
        : undefined;
    const cacheAutoInvalidate = typeof cacheOptions?.autoInvalidate === 'boolean'
        ? cacheOptions.autoInvalidate
        : host.options.cacheAutoInvalidate === true;
    return new DbFacadeImpl(
        databaseName,
        host._client.db(databaseName),
        {
            cache: host.resolveAdapterCache(),
            queryCache: host.resolveAdapterCache(),
            getCache: () => host.resolveAdapterCache(),
            getQueryCache: () => host.resolveAdapterCache(),
            logger: host._logger,
            defaults: scopedCacheDefaults(host._runtimeDefaults, host._client, host.resolveAdapterCache()),
            cacheAutoInvalidate,
        },
    ) as DbFacade;
}

/**
 * Resolve the default database name used by the runtime.
 * Priority: `options.database` (v1 compat field) > `options.databaseName` > `'default'`.
 */
export function resolveDatabaseName(options: MonSQLizeOptions): string {
    return (options as Record<string, unknown>)['database'] as string | undefined
        ?? options.databaseName
        ?? 'default';
}

/**
 * Build the accessor object returned by `connect()` (`ConnectResult<TRuntime>`).
 *
 * Contains `collection` / `db` / `use` / `instance` fields.
 * The `collection` accessor validates the name before access and initialises the IID cache.
 */
export function createRuntimeAccessors<TRuntime>(config: RuntimeAccessorConfig<TRuntime>): ConnectResult<TRuntime> {
    return {
        collection: (name: string) => {
            if (!name || typeof name !== 'string' || !name.trim()) {
                const error = new Error('Collection name must be a non-empty string') as Error & { code: string };
                error.code = 'INVALID_COLLECTION_NAME';
                throw error;
            }
            if (!config.getIidCache()) {
                config.setIidCache(new MemoryCache({
                    maxEntries: 100_000,
                    enableStats: false,
                }));
            }
            return config.defaultDb.collection(name) as CollectionFacade;
        },
        db: (name?: string) => config.db(name),
        use: (name: string) => config.use(name),
        instance: config.runtime,
    };
}
