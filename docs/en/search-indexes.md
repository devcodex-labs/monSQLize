# Search Index Lifecycle

Since v3.4.0, collection accessors and Models can create, inspect, update, drop, and wait for MongoDB Search indexes. A **Search index** has type `search` (full text) or `vectorSearch`. Use [`vectorSearch()`](vector-search.md) to query a Search index of type `vectorSearch`.

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
| `createSearchIndex` | Validates the spec, then applies `ifExists`. |
| `createSearchIndexes` | Validates every spec, then sends one command. |
| `listSearchIndexes` | Returns normalized entries. Optional `type` filter. |
| `getSearchIndex` | Missing name returns `DOES_NOT_EXIST`. |
| `updateSearchIndex` | Replaces the definition. The server rebuilds it. |
| `dropSearchIndex` | Drops the index, or returns when `ignoreMissing` is set. |
| `waitForSearchIndex` | Polls until the requested condition, timeout, or abort. |

### createSearchIndex

The call validates locally, then looks for an index with the same name.

- Default `ifExists: 'error'` rejects an existing index with `SEARCH_INDEX_EXISTS`.
- `'skip'` leaves the existing index unchanged and returns `action: 'skipped'`.
- `'update'` replaces the definition and returns `action: 'updated'`.
- A type change rejects with `INVALID_SEARCH_INDEX_DEFINITION`. Drop the index first.

### createSearchIndexes

Every spec is validated before one command is sent. There is no `ifExists` option. Duplicate names reject with `SEARCH_INDEX_EXISTS`.

### listSearchIndexes and getSearchIndex

`listSearchIndexes` returns normalized entries. `type` filters by the resolved type. Entries with `typeSource: 'unknown'` never match that filter.

`getSearchIndex` resolves a missing index to `status: 'DOES_NOT_EXIST'` and does not throw.

### updateSearchIndex

The call replaces the definition. The server rebuilds the index asynchronously. While it rebuilds, the previous version can keep serving queries.

The reported `queryable` flag is not the same on every deployment. Community 8.2.12 kept it `true`. atlas-local 8.3.13 reported `false` during a `search` rebuild even though `$search` still returned results. Both results were measured. A missing index rejects with `SEARCH_INDEX_NOT_FOUND`.

In-place `updateSearchIndex` on a Search index of type `vectorSearch` depends on the deployment:

| Deployment | In-place update |
|------------|-----------------|
| MongoDB Atlas | Documented as supported. Not measured by monSQLize. |
| atlas-local 8.3.13 | Rejected. Server `BadValue` (2). Measured. |
| Community 8.2.12 + community-search | Accepted. Queries continued during rebuild. Measured. |

MongoDB Atlas documentation says the previous index keeps serving queries while the new definition builds. monSQLize has not measured that path.

`mongodb/mongodb-atlas-local` (mongod 8.3.13) rejects the update with `BadValue` (2) and the message `"mappings" is required`.

Community 8.2.12 with `mongodb/mongodb-community-search` accepts the update. During a measured rebuild of about 30 seconds for 20,000 documents with 64 dimensions, `$vectorSearch` kept returning results.

On every measured deployment the server rejects a `type` field on the `updateSearchIndex` command (`IDLUnknownField`). Sending one does not help. monSQLize passes that rejection through as `MONGODB_ERROR` with `serverCode` and does not fall back on its own.

When an in-place update is not available, change the definition without downtime: create an index under a new name, call `waitForSearchIndex(newName, { until: 'queryable' })`, switch queries to the new name, then drop the old index. Both indexes exist for a while. That uses extra resources and counts against index limits (Atlas Free tier: 3 Search indexes, Flex: 10).

If a short outage is acceptable, drop the index, wait for `dropped`, and create it again. Searches fail until it is queryable again. The gap grows with data size. On atlas-local, 50,000 documents with 64 dimensions took about 1–2 seconds.

`status` passes the server value through unchanged. Use `queryable` to decide whether searches can run and `status` to show progress.

### dropSearchIndex

A missing index rejects with `SEARCH_INDEX_NOT_FOUND` unless `ignoreMissing: true`.

### Index type

The type comes from the server's top-level `type` field (`typeSource: 'server'`). Self-managed `mongot` does not return that field ([MongoDB limitations](https://www.mongodb.com/docs/search/self-managed/current/limitations/)). In that case the type is inferred from `latestDefinition` (`typeSource: 'inferred'`): a `fields` array with a `type: 'vector'` entry means `vectorSearch`, and a `mappings` key means `search`. Otherwise `type` is omitted and `typeSource` is `'unknown'`.

### waitForSearchIndex

| `until` | Resolves when | `FAILED` | Missing index |
|---------|---------------|----------|---------------|
| `queryable` | `queryable` is true | Rejects if not queryable | 30s grace, then not found |
| `ready` | `status` is `READY` | Rejects | Same 30s grace |
| `dropped` | `status` is `DOES_NOT_EXIST` | Keeps waiting | Resolves |

For `until: 'queryable'`, `FAILED` rejects with `SEARCH_INDEX_BUILD_FAILED` only when the index is not queryable. For `until: 'ready'`, `FAILED` rejects with `SEARCH_INDEX_BUILD_FAILED`. For `until: 'dropped'`, `FAILED` keeps waiting.

A missing index on `queryable` or `ready` keeps waiting for up to 30 seconds, then rejects with `SEARCH_INDEX_NOT_FOUND`. A missing index on `dropped` resolves immediately.

The method polls once per `intervalMs`. Timeouts reject with `SEARCH_INDEX_WAIT_TIMEOUT`, and `details[0].last` holds the last observed status. Aborting `signal` rejects with `signal.reason` unchanged.

## writePathPolicy

`createSearchIndex`, `createSearchIndexes`, `updateSearchIndex`, and `dropSearchIndex` are `management` operations, the same as `createIndex()`. Under `model-only` with `management: 'inherit'`, Model calls are allowed and direct collection calls reject with `INVALID_OPERATION`. Read methods (`listSearchIndexes`, `getSearchIndex`, `waitForSearchIndex`) are not restricted.

## Errors

| Code | When |
|------|------|
| `INVALID_SEARCH_INDEX_DEFINITION` | Local validation failed, or `update` changes type |
| `SEARCH_INDEX_EXISTS` | Same name exists, or a batch repeats a name |
| `SEARCH_INDEX_NOT_FOUND` | Update, drop, or wait target is missing |
| `SEARCH_INDEX_UNSUPPORTED` | The deployment does not support Search index commands |
| `SEARCH_INDEX_BUILD_FAILED` | `waitForSearchIndex` observed `FAILED` |
| `SEARCH_INDEX_WAIT_TIMEOUT` | `waitForSearchIndex` exceeded `timeoutMs` |

Local validation covers the name, type, definition, and options. `ifExists: 'update'` also rejects a type change. `SEARCH_INDEX_NOT_FOUND` includes a `waitForSearchIndex` miss after the grace period.

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

Query the `vectorSearch` index with [`vectorSearch()`](vector-search.md). A runnable create, wait, and query walkthrough is [`examples/docs/vector-search.ts`](../../examples/docs/vector-search.ts). It needs MongoDB Atlas, `mongodb/mongodb-atlas-local`, or Community/Enterprise 8.2+ with `mongot`, via `MONSQLIZE_VECTOR_SEARCH_URI` or `MONSQLIZE_ATLAS_LOCAL_URI`.
