# Search Index Lifecycle

Since v3.4.0, collection accessors and Models can create, inspect, update, drop, and wait for MongoDB Search indexes. One API covers full-text `search` indexes and `vectorSearch` indexes; use [`vectorSearch()`](vector-search.md) to query a Vector Search index.

## Requirements

- MongoDB Atlas, MongoDB Community or Enterprise 8.2+ with `mongot`, or the local `mongodb/mongodb-atlas-local` image.
- Plain `mongod` deployments (including `mongodb-memory-server`) do not support Search index commands; calls reject with `SEARCH_INDEX_UNSUPPORTED`.
- Index builds are asynchronous on the server. Create, update, and drop return once the server accepts the command; use `waitForSearchIndex()` to wait for the outcome.

## API

```ts
collection.createSearchIndex(spec: SearchIndexSpec, options?: { ifExists?: 'error' | 'skip' | 'update' })
  : Promise<{ name: string; action: 'created' | 'skipped' | 'updated'; created: boolean }>;
collection.createSearchIndexes(specs: SearchIndexSpec[]): Promise<string[]>;
collection.listSearchIndexes(options?: { type?: 'search' | 'vectorSearch' }): Promise<SearchIndexInfo[]>;
collection.getSearchIndex(name: string): Promise<SearchIndexInfo>;
collection.updateSearchIndex(name: string, definition: Record<string, unknown>): Promise<void>;
collection.dropSearchIndex(name: string, options?: { ignoreMissing?: boolean }): Promise<void>;
collection.waitForSearchIndex(name: string, options?: {
  until?: 'queryable' | 'ready' | 'dropped'; // default 'queryable'
  timeoutMs?: number;                        // default 300000
  intervalMs?: number;                       // default 2000, minimum 100
  signal?: AbortSignal;
}): Promise<SearchIndexInfo>;
```

Models expose the same seven methods.

```ts
interface SearchIndexSpec {
  name: string;
  type: 'search' | 'vectorSearch';
  definition: Record<string, unknown>;
}

interface SearchIndexInfo {
  name: string;
  status: 'PENDING' | 'BUILDING' | 'READY' | 'FAILED' | 'STALE' | 'DELETING' | 'DOES_NOT_EXIST';
  queryable: boolean;
  type?: 'search' | 'vectorSearch';
  typeSource: 'server' | 'inferred' | 'unknown';
  id?: string;
  latestDefinition?: Record<string, unknown>;
  latestDefinitionVersion?: { version: number; createdAt: Date };
  statusDetail?: Array<Record<string, unknown>>;
  raw: Record<string, unknown>;
}
```

## Behavior

| Method | Behavior |
|--------|----------|
| `createSearchIndex` | Validates locally, then checks for an index with the same name. With the default `ifExists: 'error'` an existing index rejects with `SEARCH_INDEX_EXISTS`. `'skip'` leaves it unchanged (`action: 'skipped'`). `'update'` replaces the definition (`action: 'updated'`), unless the type differs, which rejects with `INVALID_SEARCH_INDEX_DEFINITION` (drop the index first). |
| `createSearchIndexes` | Validates every spec before sending one command. It has no `ifExists` option; duplicate names reject with `SEARCH_INDEX_EXISTS`. |
| `listSearchIndexes` | Returns normalized entries. `type` filters by the resolved type. |
| `getSearchIndex` | A missing index resolves to `status: 'DOES_NOT_EXIST'`; it does not throw. |
| `updateSearchIndex` | Replaces the definition and the server rebuilds the index. While it rebuilds, the previous version can keep serving queries (`queryable` stays `true`). A missing index rejects with `SEARCH_INDEX_NOT_FOUND`. |
| `dropSearchIndex` | A missing index rejects with `SEARCH_INDEX_NOT_FOUND` unless `ignoreMissing: true`. |
| `waitForSearchIndex` | Polls once per `intervalMs`. See the table below. |

> **vectorSearch update limitation.** Some deployments reject `updateSearchIndex` (and `createSearchIndex` with `ifExists: 'update'`) on a `vectorSearch` index. This was observed on `mongodb/mongodb-atlas-local` with mongod 8.3.13, where the server answers `BadValue` (2) `"mappings" is required`. Behavior on MongoDB Atlas was not tested. monSQLize passes the server error through as `MONGODB_ERROR` with `serverCode` and does not fall back automatically. To change the definition there, drop the index, wait for `dropped`, and create it again; the index is not queryable in between.

`status` passes the server value through unchanged. Use `queryable` to decide whether searches can run and `status` to show progress.

### Index type

The type comes from the server's top-level `type` field (`typeSource: 'server'`). Self-managed `mongot` does not return that field ([MongoDB limitations](https://www.mongodb.com/docs/search/self-managed/current/limitations/)). In that case the type is inferred from `latestDefinition` (`typeSource: 'inferred'`): a `fields` array with a `type: 'vector'` entry means `vectorSearch`, and a `mappings` key means `search`. Otherwise `type` is omitted and `typeSource` is `'unknown'`; such entries never match a `listSearchIndexes({ type })` filter.

### waitForSearchIndex

| `until` | Resolves when | `FAILED` | Missing index |
|---------|---------------|----------|---------------|
| `queryable` | `queryable === true` | Rejects with `SEARCH_INDEX_BUILD_FAILED` only when not queryable | Keeps waiting for up to 30 seconds, then rejects with `SEARCH_INDEX_NOT_FOUND` |
| `ready` | `status === 'READY'` | Rejects with `SEARCH_INDEX_BUILD_FAILED` | Same as above |
| `dropped` | `status === 'DOES_NOT_EXIST'` | Keeps waiting | Resolves |

Timeouts reject with `SEARCH_INDEX_WAIT_TIMEOUT`, and `details[0].last` holds the last observed status. Aborting `signal` rejects with `signal.reason` unchanged.

## writePathPolicy

`createSearchIndex`, `createSearchIndexes`, `updateSearchIndex`, and `dropSearchIndex` are `management` operations, the same as `createIndex()`. Under `model-only` with `management: 'inherit'`, Model calls are allowed and direct collection calls reject with `INVALID_OPERATION`. Read methods (`listSearchIndexes`, `getSearchIndex`, `waitForSearchIndex`) are not restricted.

## Errors

| Code | When |
|------|------|
| `INVALID_SEARCH_INDEX_DEFINITION` | Local validation failed (name, type, definition, options), or `ifExists: 'update'` targets an index of another type |
| `SEARCH_INDEX_EXISTS` | Same-name index exists with `ifExists: 'error'`, or duplicate names in `createSearchIndexes` |
| `SEARCH_INDEX_NOT_FOUND` | `updateSearchIndex` / `dropSearchIndex` target is missing; `waitForSearchIndex` saw no index after the grace period |
| `SEARCH_INDEX_UNSUPPORTED` | The deployment does not support Search index commands |
| `SEARCH_INDEX_BUILD_FAILED` | `waitForSearchIndex` observed `FAILED` |
| `SEARCH_INDEX_WAIT_TIMEOUT` | `waitForSearchIndex` exceeded `timeoutMs` |

Every error raised from a server response keeps the driver error as `cause`. Server errors without a dedicated code reject with `MONGODB_ERROR`; `details[0]` carries `serverCode`, `serverCodeName`, and `serverMessage`, and `error.monsqlize = { operation, namespace, indexName }` is attached. See [Error codes](error-codes.md).

## Examples

```ts
const docs = msq.collection('docs');

await docs.createSearchIndex({
  name: 'embedding_idx',
  type: 'vectorSearch',
  definition: {
    fields: [
      { type: 'vector', path: 'embedding', numDimensions: 1536, similarity: 'cosine' },
      { type: 'filter', path: 'tenantId' },
    ],
  },
}, { ifExists: 'skip' });
await docs.waitForSearchIndex('embedding_idx', { until: 'queryable', timeoutMs: 600_000 });

await docs.createSearchIndex({ name: 'text_idx', type: 'search', definition: { mappings: { dynamic: true } } });
const info = await docs.getSearchIndex('text_idx');
console.log(info.status, info.queryable);

await docs.dropSearchIndex('text_idx', { ignoreMissing: true });
await docs.waitForSearchIndex('text_idx', { until: 'dropped' });
```
