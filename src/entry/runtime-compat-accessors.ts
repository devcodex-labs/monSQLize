/**
 * Runtime compat-layer accessor utilities.
 *
 * Encapsulates the generic accessor functions used in runtime-core to access internal
 * fields via `unknown` casts, avoiding scattered `as Record<string, unknown>` assertions
 * throughout the core file.
 *
 * Notes:
 * - All functions are pure utilities with no side effects
 * - Internal to the entry layer; not exposed externally
 */

import {
    MongoCollectionAccessor as CollectionFacade,
} from '../adapters/mongodb/common/accessors';
import { MemoryCache } from '../capabilities/cache';
import { ErrorCodes, createError } from '../core/errors';
import {
    ModelInstance,
    type ModelDefinition,
} from '../capabilities/model';
import type { ModelCollectionLike, ModelRuntimeLike } from '../capabilities/model/populate-promise';
import type { SchemaDslEngine } from '../capabilities/model/schema-dsl';

/**
 * Minimal duck-type constraint for a runtime db instance.
 * Used for type-safe assertions on the dbInstance field when connected.
 */
export type RuntimeDbInstanceLike = {
    collection: (name: string) => unknown;
    db: (name?: string) => unknown;
};

/**
 * Pool-scoped accessor shape.
 * Created by `createPoolScope` and exposed externally via the `pool(name)` method.
 */
export type RuntimePoolScope = {
    collection: (name: string) => CollectionFacade;
    model: <TDocument = Record<string, unknown>>(name: string) => ModelInstance<TDocument>;
    use: (dbName: string) => {
        collection: (name: string) => CollectionFacade;
        model: <TDocument = Record<string, unknown>>(name: string) => ModelInstance<TDocument>;
    };
};

/**
 * Host contract required to create a pool scope.
 * Implemented by runtime-core and passed down to `createPoolScope`.
 */
export type RuntimePoolScopeHost = {
    scopedCollection: (name: string, options?: { database?: string; pool?: string }) => CollectionFacade;
    scopedModel: <TDocument = Record<string, unknown>>(
        name: string,
        options?: { database?: string; pool?: string },
    ) => ModelInstance<TDocument>;
};

/**
 * Loose type view of runtime internal state, used for field access in the v1 compat layer.
 * Only reads a small set of necessary fields; does not depend on the concrete implementation class.
 */
export type RuntimeCompatRecord = Record<string, unknown> & {
    dbInstance?: RuntimeDbInstanceLike | null;
    _poolManager?: Record<string, unknown> | null;
    _modelInstances?: MemoryCache | null;
    databaseName?: string;
};

/**
 * Safely cast an `unknown` value to a `RuntimeCompatRecord` view.
 * Used only in v1 compat paths within the entry layer; no runtime validation is performed.
 */
export function asRuntimeCompatRecord(value: unknown): RuntimeCompatRecord {
    return value as unknown as RuntimeCompatRecord;
}

/**
 * Assert that the runtime is connected and return the dbInstance.
 * Throws `NOT_CONNECTED` when not connected.
 */
export function requireCompatDbInstance(value: unknown): RuntimeDbInstanceLike {
    const dbInstance = asRuntimeCompatRecord(value).dbInstance;
    if (!dbInstance) {
        throw createError(ErrorCodes.NOT_CONNECTED, 'Database is not connected. Call connect() first.');
    }
    return dbInstance;
}

/**
 * Assert that the pool manager is initialised and return its raw record object.
 * Throws `NO_POOL_MANAGER` when no pool manager is configured.
 */
export function requireCompatPoolManagerRecord(value: unknown): Record<string, unknown> {
    const poolManager = asRuntimeCompatRecord(value)._poolManager;
    if (!poolManager) {
        throw createError(ErrorCodes.NO_POOL_MANAGER, 'No pool manager configured. Add pools to MonSQLize constructor options.');
    }
    return poolManager;
}

/**
 * Resolve the MongoClient for a named pool from the pool manager record.
 * Compatible with both v1 (`_getPool`) and v2 (`getPool`) accessor interfaces.
 * Returns null when the pool does not exist or the call fails.
 */
export function resolvePoolClientFromRecord(poolManager: Record<string, unknown>, poolName: string): unknown {
    const getPoolV1 = poolManager['_getPool'] as ((name: string) => unknown) | undefined;
    const getPoolV2 = poolManager['getPool'] as ((name: string) => unknown) | undefined;
    if (typeof getPoolV1 === 'function') {
        return getPoolV1.call(poolManager, poolName) ?? null;
    }
    if (typeof getPoolV2 === 'function') {
        try {
            return getPoolV2.call(poolManager, poolName) ?? null;
        } catch {
            return null;
        }
    }
    return null;
}

/**
 * Assert that the named pool exists in the pool manager.
 * Throws `POOL_NOT_FOUND` with the list of available pool names when not found.
 */
export function assertCompatPoolExists(poolManager: Record<string, unknown>, poolName: string): void {
    if (resolvePoolClientFromRecord(poolManager, poolName)) {
        return;
    }
    const getNames = poolManager['getPoolNames'] as (() => string[]) | undefined;
    const available = typeof getNames === 'function' ? getNames.call(poolManager) : [];
    const error = createError(ErrorCodes.POOL_NOT_FOUND, `Pool '${poolName}' not found. Available pools: [${available.join(', ')}]`);
    (error as unknown as Record<string, unknown>)['available'] = available;
    throw error;
}

/**
 * Create a scoped accessor object for the named pool.
 * The returned object supports `collection` / `model` / `use` operations within that pool.
 */
export function createPoolScope(runtime: RuntimePoolScopeHost, poolName: string): RuntimePoolScope {
    return {
        collection: (name: string) => runtime.scopedCollection(name, { pool: poolName }),
        model: <TDocument = Record<string, unknown>>(name: string) => runtime.scopedModel<TDocument>(name, { pool: poolName }),
        use: (dbName: string) => ({
            collection: (name: string) => runtime.scopedCollection(name, { pool: poolName, database: dbName }),
            model: <TDocument = Record<string, unknown>>(name: string) => runtime.scopedModel<TDocument>(name, { pool: poolName, database: dbName }),
        }),
    };
}

/**
 * Read the metadata (collection name, connection config) of a registered Model.
 * Prefers `definition.collection`, then falls back to `definition.name`, then `collectionName`.
 */
export function getRegisteredModelMetadata<TDocument>(registered: {
    collectionName: string;
    definition: ModelDefinition<TDocument>;
}): {
    actualCollectionName: string;
    connection?: { pool?: string; database?: string };
} {
    const definition = registered.definition as ModelDefinition<TDocument> & {
        collection?: string;
        name?: string;
        connection?: { pool?: string; database?: string };
    };
    return {
        actualCollectionName: definition.collection ?? definition.name ?? registered.collectionName,
        connection: definition.connection,
    };
}

/**
 * Read the runtime's current default database name, falling back to `'default'` when unset.
 */
export function getRuntimeDatabaseName(value: unknown): string {
    return asRuntimeCompatRecord(value).databaseName ?? 'default';
}

/**
 * Get the runtime's internal Model instance cache.
 * Auto-creates an empty cache and writes it back when not yet initialised.
 */
export function getCompatModelInstanceCache(
    value: unknown,
): MemoryCache {
    const record = asRuntimeCompatRecord(value);
    if (!record._modelInstances) {
        record._modelInstances = new MemoryCache({
            maxEntries: 100_000,
            enableStats: false,
        });
    }
    return record._modelInstances;
}

/**
 * Create a fully contextualised ModelInstance.
 * Combines collection / runtime / metadata into a standard ModelInstance object.
 */
export function createCompatModelInstance<TDocument>(config: {
    collection: unknown;
    runtime: unknown;
    collectionName: string;
    modelName?: string;
    dbName: string;
    poolName?: string;
    definition: ModelDefinition<TDocument>;
    schemaEngine?: Pick<SchemaDslEngine, 'dsl' | 'validate'> | null;
}): ModelInstance<TDocument> {
    return new ModelInstance<TDocument>(
        config.collection as ModelCollectionLike<TDocument>,
        config.runtime as ModelRuntimeLike,
        {
            collectionName: config.collectionName,
            modelName: config.modelName,
            dbName: config.dbName,
            poolName: config.poolName,
            definition: config.definition,
            schemaEngine: config.schemaEngine,
        },
    );
}
