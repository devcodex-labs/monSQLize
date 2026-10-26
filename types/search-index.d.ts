/**
 * Search index lifecycle types (Atlas Search / Vector Search).
 * @since v3.4.0
 */

/** Search index kind: full-text `search` or `vectorSearch`. */
export type SearchIndexType = 'search' | 'vectorSearch';

/** Origin of `SearchIndexInfo.type`. */
export type SearchIndexTypeSource = 'server' | 'inferred' | 'unknown';

/** Server-reported Search index status (passed through unchanged). */
export type SearchIndexStatus =
    | 'PENDING'
    | 'BUILDING'
    | 'READY'
    | 'FAILED'
    | 'STALE'
    | 'DELETING'
    | 'DOES_NOT_EXIST';

/** Search index definition submitted to the server. */
export interface SearchIndexSpec {
    /** Index name; non-empty, without leading/trailing whitespace. */
    name: string;
    /** Index kind; required. */
    type: SearchIndexType;
    /** Index definition object, passed to the server as-is after basic validation. */
    definition: Record<string, unknown>;
}

/** Normalized Search index information. */
export interface SearchIndexInfo {
    name: string;
    status: SearchIndexStatus;
    /** Whether the index can currently serve queries; `false` when absent. */
    queryable: boolean;
    id?: string;
    /** Resolved index type; omitted only when `typeSource` is `'unknown'`. */
    type?: SearchIndexType;
    /**
     * Where `type` came from: reported by the server, inferred from `latestDefinition`
     * (self-managed mongot omits the top-level type field), or not determinable.
     */
    typeSource: SearchIndexTypeSource;
    latestDefinition?: Record<string, unknown>;
    latestDefinitionVersion?: { version: number; createdAt: Date; };
    statusDetail?: Array<Record<string, unknown>>;
    /** Raw driver document; `{}` when status is `DOES_NOT_EXIST`. */
    raw: Record<string, unknown>;
}

export interface CreateSearchIndexOptions {
    /** Behavior when an index with the same name exists. Default `'error'`. */
    ifExists?: 'error' | 'skip' | 'update';
}

export interface CreateSearchIndexResult {
    name: string;
    action: 'created' | 'skipped' | 'updated';
    /** `true` only when `action === 'created'`. */
    created: boolean;
}

export interface ListSearchIndexesOptions {
    /** Client-side filter on the resolved type; entries with `typeSource: 'unknown'` never match. */
    type?: SearchIndexType;
}

export interface DropSearchIndexOptions {
    /** Do not throw when the index does not exist. Default `false`. */
    ignoreMissing?: boolean;
}

export interface WaitForSearchIndexOptions {
    /** Target condition. Default `'queryable'`. */
    until?: 'queryable' | 'ready' | 'dropped';
    /** Overall timeout in ms (positive integer). Default `300000`. */
    timeoutMs?: number;
    /** Poll interval in ms (integer >= 100). Default `2000`. */
    intervalMs?: number;
    /** Abort signal; aborting rejects with `signal.reason`. */
    signal?: AbortSignal;
}

/**
 * Search index lifecycle methods, available on collection accessors and Models.
 * Write methods are governed by `writePathPolicy` under the `management` category.
 * Requires MongoDB Atlas, Community/Enterprise 8.2+ with mongot, or `mongodb/mongodb-atlas-local`.
 * @since v3.4.0
 */
export interface SearchIndexManagement {
    /** Creates one Search index. Default `ifExists: 'error'` throws `SEARCH_INDEX_EXISTS`. */
    createSearchIndex(spec: SearchIndexSpec, options?: CreateSearchIndexOptions): Promise<CreateSearchIndexResult>;
    /** Creates several Search indexes in one command (no `ifExists`). */
    createSearchIndexes(specs: SearchIndexSpec[]): Promise<string[]>;
    /** Lists Search indexes on the collection. */
    listSearchIndexes(options?: ListSearchIndexesOptions): Promise<SearchIndexInfo[]>;
    /** Returns one Search index; a missing index yields `status: 'DOES_NOT_EXIST'` instead of throwing. */
    getSearchIndex(name: string): Promise<SearchIndexInfo>;
    /** Replaces the index definition; the server rebuilds asynchronously. */
    updateSearchIndex(name: string, definition: Record<string, unknown>): Promise<void>;
    /** Drops a Search index; throws `SEARCH_INDEX_NOT_FOUND` unless `ignoreMissing`. */
    dropSearchIndex(name: string, options?: DropSearchIndexOptions): Promise<void>;
    /** Polls until the index is queryable, READY, or dropped. */
    waitForSearchIndex(name: string, options?: WaitForSearchIndexOptions): Promise<SearchIndexInfo>;
}
