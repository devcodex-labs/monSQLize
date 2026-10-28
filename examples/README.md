# monSQLize Examples

Runnable TypeScript examples for every major monSQLize API.
Each file uses an in-memory MongoDB server (`mongodb-memory-server`) — no real database needed.

> This repository currently includes **59** runnable TypeScript examples. `examples/helpers/bootstrap.ts` is a shared helper module, and `npm run test:examples` compiles and runs the executable examples. `examples/docs/vector-search.ts` exits without calling Search when `MONSQLIZE_VECTOR_SEARCH_URI` and `MONSQLIZE_ATLAS_LOCAL_URI` are unset.

## Prerequisites

```bash
npm install
npm run build     # build the library
```

## Quick Start

```bash
# Compile all examples
tsc -p tsconfig.examples.json

# Run a single example
node .generated/examples-dist/examples/quick-start/basic-connect.js
```

## Run All Examples

```bash
npm run test:examples
```

`npm run test:examples` starts shared standalone and replica set MongoDB servers, health-checks them between examples, and passes their URIs into every example process. MongoDB binaries are cached in `.cache/mongodb-memory-server/binaries`, and temporary data directories are created under `.cache/mongodb-memory-server/db` and cleaned when the runner exits.

## Example Index

### Quick Start

| File | Description |
|------|-------------|
| [`quick-start/basic-connect.ts`](quick-start/basic-connect.ts) | Connect, CRUD lifecycle, disconnect |
| [`quick-start/basic-operations.ts`](quick-start/basic-operations.ts) | Daily CRUD, pagination, read cache, and Model entry-point guidance |

### Cache

| File | Description |
|------|-------------|
| [`cache/with-cache.ts`](cache/with-cache.ts) | Per-collection cache TTL, hit/miss, `invalidate()` |

### Docs — CRUD

| File | Description |
|------|-------------|
| [`docs/insert.ts`](docs/insert.ts) | `insertOne`, `insertMany`, `insertBatch` |
| [`docs/insert-many.ts`](docs/insert-many.ts) | Focused `insertMany()` example |
| [`docs/update.ts`](docs/update.ts) | `updateOne`, `updateMany`, `updateBatch`, `incrementOne` |
| [`docs/update-one.ts`](docs/update-one.ts) | Focused `updateOne()` example |
| [`docs/update-aggregation.ts`](docs/update-aggregation.ts) | Aggregation pipeline updates with computed fields |
| [`docs/delete.ts`](docs/delete.ts) | `deleteOne`, `deleteMany`, `deleteBatch` |
| [`docs/delete-many.ts`](docs/delete-many.ts) | Focused `deleteMany()` example |
| [`docs/upsert.ts`](docs/upsert.ts) | `upsertOne`, `findOneAndUpdate`, `findOneAndReplace`, `replaceOne` |
| [`docs/upsert-one.ts`](docs/upsert-one.ts) | Focused `upsertOne()` example |
| [`docs/quick-upsert.ts`](docs/quick-upsert.ts) | Quick insert-or-update patterns with returned documents and counters |

### Docs — Query

| File | Description |
|------|-------------|
| [`docs/find.ts`](docs/find.ts) | `find` with sort, limit, skip, project |
| [`docs/find-one.ts`](docs/find-one.ts) | `findOne`, `findOneById`, `findByIds` |
| [`docs/find-one-by-id.ts`](docs/find-one-by-id.ts) | Focused `findOneById()` example |
| [`docs/find-by-ids.ts`](docs/find-by-ids.ts) | Focused `findByIds()` example |
| [`docs/find-page.ts`](docs/find-page.ts) | `findPage` — cursor and offset pagination |
| [`docs/find-and-count.ts`](docs/find-and-count.ts) | `findAndCount` — returns `{ data, total }` |
| [`docs/count.ts`](docs/count.ts) | Focused `count()` example |
| [`docs/count-queue.ts`](docs/count-queue.ts) | CountQueue concurrency caps, queue-full rejection, and live stats |
| [`docs/distinct.ts`](docs/distinct.ts) | Focused `distinct()` example |
| [`docs/explain.ts`](docs/explain.ts) | Focused `explain()` example |
| [`docs/aggregate.ts`](docs/aggregate.ts) | Aggregation pipeline stages |
| [`docs/chaining-api.ts`](docs/chaining-api.ts) | `FindChain` and `AggregateChain` fluent builders |

### Docs — Advanced

| File | Description |
|------|-------------|
| [`docs/aggregate-advanced.ts`](docs/aggregate-advanced.ts) | Multi-stage analytics aggregation with grouping, sorting, and post-processing |
| [`docs/batch-operations.ts`](docs/batch-operations.ts) | High-volume `insertBatch` / `updateBatch` / `deleteBatch` workflows |
| [`docs/expression-functions.ts`](docs/expression-functions.ts) | `MonSQLize.expr()` for reusable pipeline expressions |
| [`docs/model.ts`](docs/model.ts) | Model schema + lifecycle hooks (pre/post) |
| [`docs/hooks.ts`](docs/hooks.ts) | Focused model lifecycle hooks for insert / update / delete |
| [`docs/collection-management.ts`](docs/collection-management.ts) | `createCollection`, `createView`, index management, `db().admin()` |
| [`docs/index-management.ts`](docs/index-management.ts) | Focused `createIndex`, `createIndexes`, `listIndexes`, and `dropIndex` flow |
| [`docs/data-tasks.ts`](docs/data-tasks.ts) | Production-style Job: index preflight, filtered sync, local field edits, backup, verify, and restore preview |
| [`docs/bookmarks.ts`](docs/bookmarks.ts) | `prewarmBookmarks`, `listBookmarks`, `clearBookmarks` |
| [`docs/transaction.ts`](docs/transaction.ts) | `withTransaction()` with an in-memory replica-set |
| [`docs/transaction-rollback.ts`](docs/transaction-rollback.ts) | Focused rollback / recovery path for failed transactions |
| [`docs/transaction-optimizations.ts`](docs/transaction-optimizations.ts) | Read-only transactions and cache-invalidation lock stats |
| [`docs/slow-query-log.ts`](docs/slow-query-log.ts) | Slow query log configuration |
| [`docs/events.ts`](docs/events.ts) | Runtime events: `on`, `once`, `off`, `emit`, slow-query, and close |
| [`docs/watch.ts`](docs/watch.ts) | Change streams — native ChangeStream events |
| [`docs/populate-relations.ts`](docs/populate-relations.ts) | Cross-collection populate relations |
| [`docs/relations.ts`](docs/relations.ts) | Focused hasOne / hasMany / belongsTo relation definitions |
| [`docs/nested-populate.ts`](docs/nested-populate.ts) | Nested populate chain: author -> posts -> comments -> author |
| [`docs/increment-one.ts`](docs/increment-one.ts) | `incrementOne` — atomic counter field increments |
| [`docs/soft-delete.ts`](docs/soft-delete.ts) | Soft-delete lifecycle with filtered reads and restore-ready data shape |

### Docs — High-Level Capabilities

| File | Description |
|------|-------------|
| [`docs/cache-multilevel.ts`](docs/cache-multilevel.ts) | Multi-level database cache: L1 MemoryCache + L2 Redis stub + DistributedCacheInvalidator |
| [`docs/objectid.ts`](docs/objectid.ts) | ObjectId auto-conversion: insert/find/findByIds/update/delete with plain string IDs |
| [`docs/pool.ts`](docs/pool.ts) | ConnectionPoolManager — multi-pool routing with auto/round-robin/weighted strategies |
| [`docs/pool-chain-api.ts`](docs/pool-chain-api.ts) | Runtime `pool().use().collection()` and pool-scoped model routing |
| [`docs/pool-fallback.ts`](docs/pool-fallback.ts) | Pool health degradation with automatic fallback and recovery |
| [`docs/multi-pool-health-check.ts`](docs/multi-pool-health-check.ts) | Multi-pool health status, degradation, recovery, and stats |
| [`docs/sync.ts`](docs/sync.ts) | ChangeStreamSyncManager + ResumeTokenStore — resume-token-based change stream sync |
| [`docs/sync-target-failure.ts`](docs/sync-target-failure.ts) | Sync target failure accounting and recovery path |

### Docs — Search and vectors

`examples/docs/vector-search.ts` needs MongoDB Atlas, `mongodb/mongodb-atlas-local`, or Community/Enterprise 8.2+ with `mongot`. Set `MONSQLIZE_VECTOR_SEARCH_URI` or `MONSQLIZE_ATLAS_LOCAL_URI`. `npm run test:examples` still invokes the file; without those variables it prints a skip line and exits 0, because `mongodb-memory-server` cannot serve Search indexes.

| File | Description |
|------|-------------|
| [`docs/vector-search.ts`](docs/vector-search.ts) | Create a `vectorSearch` Search index, wait until queryable, query with `vectorSearch()`, then drop it |

### Docs — Legacy Compatibility

These examples remain runnable for existing users, but they are not primary monSQLize capabilities. New non-database function caching, business locks, and Saga orchestration should live in the application or framework runtime.

| File | Description |
|------|-------------|
| [`docs/function-cache.ts`](docs/function-cache.ts) | Legacy `withCache()` / `FunctionCache` compatibility |
| [`docs/lock.ts`](docs/lock.ts) | Legacy lock compatibility — acquire/release/try-lock |
| [`docs/lock-timeout.ts`](docs/lock-timeout.ts) | Legacy lock contention / timeout / recovery flow |
| [`docs/saga.ts`](docs/saga.ts) | Legacy Saga compatibility — multi-step workflow with rollback |
| [`docs/saga-advanced.ts`](docs/saga-advanced.ts) | Legacy Saga retry, timeout, context, compensation, and stats |

## Running Individual Examples

```bash
# After building:
tsc -p tsconfig.examples.json

node .generated/examples-dist/examples/quick-start/basic-connect.js
node .generated/examples-dist/examples/quick-start/basic-operations.js
node .generated/examples-dist/examples/cache/with-cache.js
node .generated/examples-dist/examples/docs/insert.js
node .generated/examples-dist/examples/docs/insert-many.js
node .generated/examples-dist/examples/docs/update.js
node .generated/examples-dist/examples/docs/update-one.js
node .generated/examples-dist/examples/docs/update-aggregation.js
node .generated/examples-dist/examples/docs/delete.js
node .generated/examples-dist/examples/docs/delete-many.js
node .generated/examples-dist/examples/docs/upsert.js
node .generated/examples-dist/examples/docs/upsert-one.js
node .generated/examples-dist/examples/docs/quick-upsert.js
node .generated/examples-dist/examples/docs/find.js
node .generated/examples-dist/examples/docs/find-one.js
node .generated/examples-dist/examples/docs/find-one-by-id.js
node .generated/examples-dist/examples/docs/find-by-ids.js
node .generated/examples-dist/examples/docs/find-page.js
node .generated/examples-dist/examples/docs/find-and-count.js
node .generated/examples-dist/examples/docs/count.js
node .generated/examples-dist/examples/docs/count-queue.js
node .generated/examples-dist/examples/docs/distinct.js
node .generated/examples-dist/examples/docs/explain.js
node .generated/examples-dist/examples/docs/aggregate.js
node .generated/examples-dist/examples/docs/aggregate-advanced.js
node .generated/examples-dist/examples/docs/batch-operations.js
node .generated/examples-dist/examples/docs/chaining-api.js
node .generated/examples-dist/examples/docs/expression-functions.js
node .generated/examples-dist/examples/docs/model.js
node .generated/examples-dist/examples/docs/hooks.js
node .generated/examples-dist/examples/docs/collection-management.js
node .generated/examples-dist/examples/docs/index-management.js
node .generated/examples-dist/examples/docs/data-tasks.js
node .generated/examples-dist/examples/docs/bookmarks.js
node .generated/examples-dist/examples/docs/transaction.js
node .generated/examples-dist/examples/docs/transaction-rollback.js
node .generated/examples-dist/examples/docs/transaction-optimizations.js
node .generated/examples-dist/examples/docs/slow-query-log.js
node .generated/examples-dist/examples/docs/events.js
node .generated/examples-dist/examples/docs/watch.js
node .generated/examples-dist/examples/docs/soft-delete.js
node .generated/examples-dist/examples/docs/populate-relations.js
node .generated/examples-dist/examples/docs/relations.js
node .generated/examples-dist/examples/docs/nested-populate.js
node .generated/examples-dist/examples/docs/increment-one.js
node .generated/examples-dist/examples/docs/cache-multilevel.js
node .generated/examples-dist/examples/docs/objectid.js
node .generated/examples-dist/examples/docs/pool.js
node .generated/examples-dist/examples/docs/pool-chain-api.js
node .generated/examples-dist/examples/docs/pool-fallback.js
node .generated/examples-dist/examples/docs/multi-pool-health-check.js
node .generated/examples-dist/examples/docs/sync.js
node .generated/examples-dist/examples/docs/sync-target-failure.js
node .generated/examples-dist/examples/docs/vector-search.js

# Legacy compatibility examples
node .generated/examples-dist/examples/docs/function-cache.js
node .generated/examples-dist/examples/docs/lock.js
node .generated/examples-dist/examples/docs/lock-timeout.js
node .generated/examples-dist/examples/docs/saga.js
node .generated/examples-dist/examples/docs/saga-advanced.js
```
