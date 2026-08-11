/**
 * Internal contract types for the runtime core layer.
 *
 * Promotes large anonymous inline interfaces in entry/runtime-core.ts to named interfaces,
 * improving readability and providing stable type anchors for external tooling
 * (test helpers, adapter bridge extensions, etc.).
 *
 * Note: all imports use `import type` to avoid introducing runtime circular dependencies.
 */

import type { Db, MongoClient, Collection } from 'mongodb';
import type { CacheLike, MemoryCache } from '../../capabilities/cache';
import type { ModelDescriptor, ModelInstance } from '../../capabilities/model';
import type {
    MongoCollectionAccessor as CollectionFacade,
    MongoDbAccessor as DbFacade,
} from '../../adapters/mongodb/common/accessors';

// ─── AdapterBridge ────────────────────────────────────────────────────────────

/**
 * Internal interface definition for `_adapterBridge`.
 *
 * AdapterBridge is the bridge object through which MonSQLizeRuntime exposes
 * MongoDB low-level handles and admin operations to downstream adapter / capability
 * layers; it is not directly visible to end users.
 *
 * Primary responsibilities:
 * - Expose `db` / `client` / `cache` / `instanceId` handles
 * - Proxy admin operations (ping / buildInfo / serverStatus, etc.)
 * - Provide the low-level `collection()` accessor for the v1 compat layer
 */
export interface AdapterBridgeLike {
    /** Current default MongoDB Db instance; null when not connected. */
    readonly db: Db | null;
    /** Current MongoClient instance; null when not connected. */
    readonly client: MongoClient | null;
    /** Current cache instance in use (MemoryCache, MultiLevelCache, or custom CacheLike). */
    cache: CacheLike | null;
    /** Current instance ID (from namespace.instanceId config); undefined when not set. */
    readonly instanceId: string | undefined;
    /** Test MongoDB connection reachability. */
    ping(): Promise<boolean>;
    /** Return the MongoDB server buildInfo. */
    buildInfo(): Promise<Record<string, unknown>>;
    /** Return the MongoDB server serverStatus report. */
    serverStatus(options?: { scale?: number }): Promise<Record<string, unknown>>;
    /** Return MongoDB server stats. */
    stats(options?: { scale?: number }): Promise<Record<string, unknown>>;
    /** List all databases. */
    listDatabases(options?: { nameOnly?: boolean }): Promise<unknown[]>;
    /**
     * Drop the specified database (requires explicit confirmation; production requires extra params).
     * Safety guard: throws CONFIRMATION_REQUIRED when `confirm: true` is not passed.
     */
    dropDatabase(
        name: string,
        options?: { confirm?: boolean; allowProduction?: boolean; user?: string },
    ): Promise<{ dropped: boolean; database: string; timestamp: Date }>;
    /** List collections in the current database. */
    listCollections(options?: Record<string, unknown>): Promise<unknown>;
    /** Send an arbitrary admin command to MongoDB. */
    runCommand(
        command: Record<string, unknown>,
        options?: Record<string, unknown>,
    ): Promise<Record<string, unknown>>;
    /**
     * Return the underlying native MongoDB Collection handle (used by the v1 compat layer).
     * @param dbName Database name
     * @param collName Collection name
     */
    collection(dbName: string, collName: string): Collection;
}

export interface LegacyAdapterBridgeLike extends AdapterBridgeLike {
    _iidCache: MemoryCache | null;
}

// ─── Connect result ───────────────────────────────────────────────────────────

/**
 * Scoped accessor shape returned by `use(dbName)`.
 * Used to obtain collection or model instances within the specified database.
 */
export interface ScopedUseResult {
    /** Get the accessor for the named collection. */
    collection(collectionName: string): CollectionFacade;
    /** Get the typed instance for the named model. */
    model<TDocument = Record<string, unknown>>(
        model: string | ModelDescriptor<string, TDocument>,
    ): ModelInstance<TDocument>;
}

/**
 * Accessor object shape resolved by `connect()`.
 * `TRuntime` is a generic parameter to avoid a circular import with `MonSQLizeRuntime`.
 *
 * Typical usage:
 * ```ts
 * const { collection, db, use, instance } = await client.connect();
 * ```
 */
export interface ConnectResult<TRuntime = unknown> {
    /** Get a collection accessor for the default database. */
    collection(name: string): CollectionFacade;
    /** Get a DbFacade for the specified database (uses the default when no name is passed). */
    db(name?: string): DbFacade;
    /** Switch to the specified database and return scoped collection / model accessors. */
    use(name: string): ScopedUseResult;
    /** Reference to the current MonSQLizeRuntime instance itself (for chaining or event listeners). */
    instance: TRuntime;
}

// ─── AutoConvert config ───────────────────────────────────────────────────────

/**
 * Public property shape of the ObjectId auto-convert config (corresponds to runtime.autoConvertConfig).
 *
 * When `enabled = true`, MonSQLize automatically converts qualifying string fields to
 * MongoDB ObjectId on queries and writes, improving v1 behaviour compatibility.
 */
export interface AutoConvertConfigPublic {
    /** Whether ObjectId auto-conversion is enabled (default false). */
    enabled: boolean;
    /** List of field names excluded from auto-conversion. */
    excludeFields?: string[];
    /** List of custom field-name match patterns (substring match). */
    customFieldPatterns?: string[];
    /** Maximum depth when recursively scanning nested objects (default 3). */
    maxDepth?: number;
    /** Conversion log level ('debug' | 'info' | 'none'). */
    logLevel?: string;
}
