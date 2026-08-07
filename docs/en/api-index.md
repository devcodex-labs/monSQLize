# API Reference Index

This index documents the current stable MongoDB adapter APIs and shared runtime capabilities. MySQL and PostgreSQL adapter APIs will receive separate entries after runtime support, public types, examples, and verification coverage are available.

## Core Concepts

| Document | Description |
|----------|-------------|
| [Native API comparison](mongodb-native-vs-extensions.md) | **MongoDB native APIs vs monSQLize extensions** |
| [Basic usage](basic-operations.md) | Common CRUD, pagination, read cache, and Model entry-point examples |
| [Configuration reference](configuration.md) | Complete `new MonSQLize(options)` constructor options |
| [Connection management](connection.md) | Connection lifecycle and accessors |
| [Pool configuration](multi-pool.md) | Multi-pool configuration and runtime routing: declare `pools: PoolConfig[]` in the constructor and access pools through `pool()` / `use()` |
| [Chain pool/database access](pool-chain-api.md) | Chain pool/database access API: `pool()` / `use()` / `scopedCollection()` / `scopedModel()` |
| [ObjectId auto conversion](objectid-auto-convert.md) | ObjectId auto conversion for MongoDB query and write paths |
| [Model layer](model.md) | Model schema validation, methods, hooks, relations, and runtime binding |
| [Populate API](populate.md) | Load related documents declared by Model relations |
| [Relations API](relations.md) | Define `hasOne` / `hasMany` / `belongsTo`-style relationships, array keys, and default selection |
| [Hooks API](hooks.md) | Standard Model lifecycle hooks for create, update, delete, and find flows |
| [Relations and Populate](model/relations.md) | Model relationship definitions and related-data population |
| [Nested Populate](model/nested-populate.md) | Multi-level relation population |
| [SSH tunnel](ssh-tunnel.md) | **SSH tunnel: securely connect to private-network databases** |
| [Error code reference](error-codes.md) | **Error code reference: complete error-code definitions and handling guide** |
| [Cache system](cache.md) | Cache system (LRU + TTL) |
| [Transaction management](transaction.md) | Transaction management (automatic retry, cache locks) |
| [Write path policy](write-path-policy.md) | Optional runtime policy for Model-only write namespaces |
| [Change Stream sync](sync-backup.md) | **Change Stream data sync: real-time backup to multiple databases** |
| [Transaction optimizations](transaction-optimizations.md) | Transaction optimization strategies |
| [Distributed deployment](distributed-deployment.md) | **Distributed deployment guide for multi-instance cache consistency** |
| [Production rollout](production-rollout.md) | Production data task rollout, CDC sync, index preflight, and traffic-switch checks |
| [Production data migration](production-data-migration.md) | Scenario guide for data, indexes, and field edits from development or staging to production |
| [Data tasks API](data-tasks.md) | One `DataTaskJob`, four methods, parameters, backup, and restore contracts |
| [Event system](events.md) | Event system |

---

## Query Operations

| Document | Method | Description |
|----------|--------|-------------|
| [Find documents](find.md) | `find()` | Query multiple documents |
| [Find one document](findOne.md) | `findOne()` | Query one document |
| [Paginated find](findPage.md) | `findPage()` | Cursor pagination query |
| [Count documents](count.md) | `count()` | Count documents |
| [Distinct values](distinct.md) | `distinct()` | Distinct query |
| [Watch changes](watch.md) | `watch()` | Watch real-time data changes with Change Streams |

---

## Write Operations

### Insert Operations

| Document | Method | Description |
|----------|--------|-------------|
| [Insert one document](insert-one.md) | `insertOne()` | Insert one document |
| [Insert many documents](insert-many.md) | `insertMany()` | Insert many documents |
| [Batch insert](insertBatch.md) | `insertBatch()` | Large batch insert with batching and retry |
| [Write operations guide](write-operations.md) | All insert methods | Complete write operations guide |

### Update Operations

| Document | Method | Description |
|----------|--------|-------------|
| [Update methods overview](update-operations.md) | All update methods | Method choice, traditional operators, and pipeline handoff |
| [Upsert guide](upsert-guide.md) | **Upsert guide** | Insert when missing, update when present |
| [Update one document](update-one.md) | `updateOne()` | Update one document |
| [Update many documents](update-many.md) | `updateMany()` | Update many documents |
| [Aggregation pipeline update guide](update-aggregation.md) | Aggregation pipeline update | Field-to-field calculation, conditional assignment, and pipeline details |
| [Batch update](updateBatch.md) | `updateBatch()` | Large batch update with batching and retry |
| [Replace one document](replace-one.md) | `replaceOne()` | Replace a whole document |
| [Find one and update](find-one-and-update.md) | `findOneAndUpdate()` | Atomically update and return |
| [Find one and replace](find-one-and-replace.md) | `findOneAndReplace()` | Atomically replace and return |

### Convenience Methods

| Document | Method | Description |
|----------|--------|-------------|
| [Upsert one document](upsert-one.md) | `upsertOne()` | Update if present, insert if missing |
| [Increment one document](increment-one.md) | `incrementOne()` | Atomically increment or decrement field values |

### Delete Operations

| Document | Method | Description |
|----------|--------|-------------|
| [Delete one document](delete-one.md) | `deleteOne()` / Model protected delete | Delete one document or restrict deletion using declared relations |
| [Delete many documents](delete-many.md) | `deleteMany()` | Delete many documents |
| [Batch delete](deleteBatch.md) | `deleteBatch()` | Large batch delete with batching and retry |
| [Find one and delete](find-one-and-delete.md) | `findOneAndDelete()` | Atomically delete and return |

---

## Aggregation Operations

| Document | Method | Description |
|----------|--------|-------------|
| [Aggregation pipeline](aggregate.md) | `aggregate()` | Aggregation pipeline query |
| [Vector search](vector-search.md) | Collection / Model `vectorSearch()` | MongoDB Vector Search query with Model soft-delete visibility when applicable |

---

## Advanced Features

| Document | Description |
|----------|-------------|
| [Chain query API](chaining-api.md) | Chain query API |
| [Chain method reference](chaining-methods.md) | Detailed chain method reference |
| [Query plan analysis](explain.md) | Query plan analysis |
| [Pagination bookmarks](bookmarks.md) | Pagination bookmark management |

---

## Utilities and Configuration

| Document | Description |
|----------|-------------|
| [Utility functions](utilities.md) | Utility functions |
| [Configuration reference](configuration.md) | Constructor defaults, cache, Redis, Model, sync, pools, logging, and validation |
| [Collection management](collection-management.md) | Collection management |
| [Read preference](readPreference.md) | Read preference settings |
| [Count queue](count-queue.md) | Count queue control for high-concurrency optimization |
| [Write path policy](write-path-policy.md) | Configure whether writes may use collection APIs or must use Model APIs |
| [Distributed deployment](distributed-deployment.md) | Distributed deployment configuration |

---

## Compatibility and Testing

| Document | Description |
|----------|-------------|
| [MongoDB driver compatibility](mongodb-driver-compatibility.md) | Detailed MongoDB driver compatibility notes |
| [findOneAnd return values](findOneAnd-return-value-unified.md) | Unified `findOneAnd*` return-value behavior |
| [ESM support](esm-support.md) | ES Module (`import`) support |

---

## By Feature Category

### CRUD Operations

**Create**

- [Insert one document](insert-one.md) - `insertOne`
- [Insert many documents](insert-many.md) - `insertMany`
- [Batch insert](insertBatch.md) - `insertBatch`
- [Write operations guide](write-operations.md) - Complete write operations guide

**Read**

- [Find documents](find.md) - `find`
- [Find one document](findOne.md) - `findOne`
- [Paginated find](findPage.md) - `findPage`
- [Count documents](count.md) - `count`
- [Distinct values](distinct.md) - `distinct`

**Update**

- [Update methods overview](update-operations.md) - Method choice, traditional operators, and pipeline handoff
- [Update one document](update-one.md) - `updateOne`
- [Update many documents](update-many.md) - `updateMany`
- [Replace one document](replace-one.md) - `replaceOne`
- [Find one and update](find-one-and-update.md) - `findOneAndUpdate`
- [Find one and replace](find-one-and-replace.md) - `findOneAndReplace`

**Delete**

- [Delete one document](delete-one.md) - `deleteOne`
- [Delete many documents](delete-many.md) - `deleteMany`
- [Find one and delete](find-one-and-delete.md) - `findOneAndDelete`

### Advanced Queries

- [Aggregation pipeline](aggregate.md) - Aggregation pipelines
- [Vector search](vector-search.md) - MongoDB Vector Search queries
- [Query plans](explain.md) - Query plans
- [Chain queries](chaining-api.md) - Chain queries

### Performance and Cache

- [Cache system](cache.md) - Cache system
- [Pagination bookmarks](bookmarks.md) - Pagination optimization

---

## Entries, Examples, and Site Pages

| Document | Description |
|----------|-------------|
| [Documentation index](README.md) | Documentation directory index |
| [Site home](index.md) | Documentation site home |
| [API reference index](api-index.md) | Current API reference index |
| [Installation](getting-started.md) | Installation and minimal connection validation |
| [Basic usage](basic-operations.md) | Common operations after the first connection succeeds |
| [Examples](examples.md) | Example index |
| [Common scenarios](recipes.md) | Connection, cache, Redis, SSH, pool, and Model usage scenarios |
| [Capability index](capability-index.md) | Capability index |

---

## Management, Indexes, and Expressions

| Document | Description |
|----------|-------------|
| [Administration API](admin.md) | Administration API |
| [Database operations](database-ops.md) | Database operations |
| [Create one index](create-index.md) | Create one index |
| [Create indexes in bulk](create-indexes.md) | Create indexes in bulk |
| [Drop an index](drop-index.md) | Drop an index |
| [List indexes](list-indexes.md) | List indexes |
| [Find and count](find-and-count.md) | Find and count |
| [Expression functions](expression-functions.md) | Expression functions |
| [Quick upsert](quick-upsert.md) | Quick upsert |

---

## Runtime and Deployment

| Document | Description |
|----------|-------------|
| [Runtime consistency and boundaries](runtime-architecture.md) | Runtime capability boundaries and consistency contracts |
| [Production rollout](production-rollout.md) | Index, one-time data, CDC, and production traffic-switch runbook |
| [Production data migration](production-data-migration.md) | One-time filtered data and index release scenarios |
| [Support matrix](support-matrix.md) | Support matrix |
| [Roadmap boundaries](roadmap-boundaries.md) | Roadmap boundaries |
| [Validation notes](validation.md) | Validation notes |

---

## ObjectId, Cache, and Troubleshooting

| Document | Description |
|----------|-------------|
| [ObjectId conversion scope](objectid-conversion-scope.md) | ObjectId conversion scope |
| [ObjectId cross-version notes](objectid-cross-version.md) | ObjectId cross-version notes |
| [ObjectId cross-version FAQ](objectid-cross-version-faq.md) | ObjectId cross-version FAQ |
| [ObjectId logging optimization](objectid-logging-optimization.md) | ObjectId logging optimization |
| [Cache API](cache.md) | Database query cache, multi-layer cache access, invalidation, and statistics |
| [Slow-query logging](slow-query-log.md) | Slow-query logging |
| [Failure recovery examples](failure-recovery-examples.md) | Failure recovery examples |
| [Multi-pool health checks](multi-pool-health-check.md) | Multi-pool health checks |
| [Distributed deployment quick reference](distributed-deployment-quickref.md) | Distributed deployment quick reference |
| [Relations quick start](model/relations-quickstart.md) | Relations quick start |

---

## Start Path

Recommended reading order for new users:

1. [Installation](getting-started.md) - Install, connect, and run the first query.
2. [Basic usage](basic-operations.md) - Run common CRUD, pagination, cache, and Model entry-point examples.
3. [Configuration reference](configuration.md) - Choose constructor options for the service.
4. [Connection management](connection.md) - Learn connection lifecycle and accessors.
5. [Find documents](find.md) - Learn query details.
6. [Insert one document](insert-one.md) / [Insert many documents](insert-many.md) - Learn inserts.
7. [Update one document](update-one.md) / [Update many documents](update-many.md) - Learn updates.
8. [Delete one document](delete-one.md) / [Delete many documents](delete-many.md) - Learn deletes.
9. [Cache system](cache.md) - Understand the cache mechanism.
10. [Transaction management](transaction.md) - Learn transaction management.
11. [Distributed deployment](distributed-deployment.md) - Multi-instance deployment for production.
12. [Production rollout](production-rollout.md) - Index, one-time data, CDC, and traffic-switch checks.
13. [Production data migration](production-data-migration.md) - Configuration-driven release from instance A to production.
