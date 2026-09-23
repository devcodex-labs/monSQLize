/**
 * Query adapter internal contracts.
 *
 * Notes:
 * - Houses the query layer's internal runtime contracts, preventing them from
 *   scattering across `queries/index.ts`, `accessors.ts`, and `runtime-core.ts`.
 * - These types are not part of the public API; they are shared “internal domain types”
 *   between the query adapter layer, the accessor layer, and the runtime.
 */

/**
 * Minimal TTL-aware query result cache interface.
 * Satisfied by MemoryCache and similar implementations; injected via the runtime
 * to avoid circular dependencies.
 */
export interface QueryCacheLike {
    get(key: string): unknown | Promise<unknown>;
    set(key: string, value: unknown, ttl: number): void | boolean | Promise<void> | Promise<boolean>;
    del?: (key: string) => unknown | Promise<unknown>;
    delete?: (key: string) => unknown | Promise<unknown>;
    delPattern?: (pattern: string) => number | Promise<number>;
    keys?: (pattern?: string) => string[] | Promise<string[]>;
}

export interface CountQueueLike {
    execute<T>(fn: (signal?: AbortSignal) => Promise<T>, options?: { signal?: AbortSignal }): Promise<T>;
}

export type NormalizedWritePathPolicyLike = import('../../capabilities/write-path-policy').NormalizedWritePathPolicy;

export type CursorValueType = 'date' | 'objectId' | 'string' | 'number' | 'boolean' | 'raw';

export type CacheInvalidationOperation =
    | 'find'
    | 'findOne'
    | 'count'
    | 'findPage'
    | 'aggregate'
    | 'distinct'
    | 'findOneById'
    | 'findByIds'
    | 'all';

export type CacheInvalidationEntry =
    | string
    | {
        cacheKey?: string;
        cacheKeys?: string[];
        pattern?: string;
        patterns?: string[];
        operation?: CacheInvalidationOperation | string;
        op?: CacheInvalidationOperation | string;
        query?: unknown;
        options?: unknown;
        pipeline?: unknown[];
        field?: string;
        id?: unknown;
        ids?: unknown[];
    };

export type CacheInvalidationRequest = CacheInvalidationEntry | CacheInvalidationEntry[];

export type CacheInvalidationIntent =
    | { type: 'pattern'; value: string }
    | { type: 'key'; value: string };

export interface WriteCacheControlOptions {
    cache?: {
        autoInvalidate?: boolean;
        invalidate?: false | true | CacheInvalidationRequest;
    };
    /**
     * Per-write broad invalidation shortcut. Kept for compatibility; exact invalidation
     * should use `cache.invalidate`.
     */
    autoInvalidate?: boolean;
}

export interface CursorValueNormalizationOptions {
    cursorTypes?: Record<string, CursorValueType>;
    cursorValueNormalizer?: (field: string, value: unknown) => unknown;
}

/**
 * Runtime defaults propagated from MonSQLizeOptions down through
 * DbFacade → CollectionFacade → query functions.
 *
 * Constraints:
 * - All fields are optional; fall back to v1 defaults when absent
 * - This is the “trimmed defaults” used by the query layer, not the full MonSQLizeOptions
 */
export interface RuntimeDefaults {
    maxTimeMS?: number;
    findLimit?: number;
    findMaxLimit?: number;
    findMaxSkip?: number;
    findPageMaxLimit?: number;
    autoConvertObjectId?: boolean | Record<string, unknown>;
    cursorSecret?: string;
    requireCursorSecret?: boolean;
    cursorTypes?: Record<string, CursorValueType>;
    cursorValueNormalizer?: (field: string, value: unknown) => unknown;
    slowQueryMs?: number;
    namespace?: { scope?: 'database' | 'connection'; instanceId?: string };
    countQueue?: CountQueueLike;
    writePathPolicy?: NormalizedWritePathPolicyLike;
    cacheAutoInvalidate?: boolean;
}

export interface CursorPayload {
    v: 1;
    values: unknown[];
}

export type SortShape = Record<string, 1 | -1>;
