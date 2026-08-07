/** Meta options for controlling timing/cache info in query results. */
export interface MetaOptions {
    /** 'op' = operation-level timing only; 'sub' = include sub-step timings (findPage only) */
    level?: 'op' | 'sub';
    /** Include cache hit/miss/ttl info in meta */
    includeCache?: boolean;
}

/** v1-compatible aggregate options exported from the root package. */
export interface AggregateOptions {
    cache?: number;
    maxTimeMS?: number;
    allowDiskUse?: boolean;
    collation?: any;
    hint?: string | object;
    comment?: string;
    meta?: boolean | MetaOptions;
}

/**
 * Options forwarded to the aggregate execution behind `vectorSearch()`.
 * `meta`, `stream`, and `explain` are intentionally unavailable because
 * `vectorSearch()` always resolves to a stable array of score envelopes.
 */
export interface VectorSearchAggregateOptions extends Omit<AggregateOptions, 'meta'> {
    meta?: never;
    stream?: never;
    explain?: never;
    [key: string]: unknown;
}

/** Options for a MongoDB `$vectorSearch` aggregation stage. */
export interface VectorSearchOptions {
    /** Name of the MongoDB Vector Search index. */
    index: string;
    /** Indexed vector field path. */
    path: string;
    /** Query embedding. Every value must be a finite number. */
    queryVector: number[];
    /** Maximum number of scored documents to return. */
    limit: number;
    /** Required for approximate nearest-neighbor search (`exact !== true`). */
    numCandidates?: number;
    /** Set to `true` to request exact nearest-neighbor search. */
    exact?: boolean;
    /** Optional MongoDB Vector Search pre-filter. */
    filter?: Record<string, unknown>;
    /** Fields to return from each matched document. */
    projection?: Record<string, unknown> | string[];
    /** Supported aggregate options; result-shape options are excluded. */
    aggregateOptions?: VectorSearchAggregateOptions;
}

/** A vector-search result that preserves the source document and its score. */
export interface VectorSearchHit<TDocument = unknown> {
    document: TDocument;
    score: number;
}
