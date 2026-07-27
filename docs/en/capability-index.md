# Advanced Capability Index

This page lists the stable capability entry points in the current TypeScript version of `monSQLize`.

monSQLize is a database-native production data runtime layer. The current stable adapter is MongoDB; MySQL and PostgreSQL are planned as future adapters and are not part of the current npm runtime.

Principles:

- Start with the API entry points users can call.
- Then point to the corresponding documentation and runnable examples.

## Current Capability Overview

| Layer | Current status | Scope |
|-------|----------------|-------|
| Shared runtime | Stable where exposed by the current runtime | Database cache, pools, transactions, model constraints, sync, slow-query logging, and runtime diagnostics |
| MongoDB adapter | Stable | `collection()`, `db()`, `use()`, `pool()`, query/write helpers, aggregation, indexes, transactions, Change Streams |
| MySQL adapter | Planned / in development | Future database-native adapter, no current public runtime API |
| PostgreSQL adapter | Planned / in development | Future database-native adapter, no current public runtime API |

| Capability | Recommended entry | Notes |
|------------|----------------------|-------|
| Model | `msq.model()` / `MonSQLize.Model` | Supports model registration, relations, virtuals, populate, and common query entries |
| write-path-policy | `writePathPolicy` | Optional runtime guard for Model-only write namespaces |
| cache | Query `cache` options / `msq.cache` | Database query cache, multi-layer cache access, invalidation, and statistics |
| transaction | `startSession()` / `withTransaction()` | Supports MongoDB transaction wrappers and transaction statistics |
| pool | `pools` / `pool()` / `ConnectionPoolManager` | Declare `pools: PoolConfig[]` in the constructor, route with `pool()`, and use the low-level manager for advanced inspection or manual management |
| sync | `startSync()` / `stopSync()` / `getSyncStats()` | Supports Change Stream sync start, stop, and status inspection |
| slow-query-log | `recordSlowQuery()` / `getSlowQueryLogs()` | Supports slow-query recording, querying, and runtime management |

## 1. Model

Available entries:

- `Model.define/get/list/undefine/redefine`
- `msq.model()`
- relations / virtuals / populate
- common model queries such as `findOne()` and `findAndCount()`

Model documentation and examples:

- Docs: [Model Overview](./model.md), [Populate](./populate.md), [Relations](./relations.md), [Nested Populate](./model/nested-populate.md)
- Examples: [model.ts](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/model.ts), [populate-relations.ts](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/populate-relations.ts)

## 2. write-path-policy

Available entries:

- `writePathPolicy.default`
- `writePathPolicy.namespaces`
- `WritePathPolicyOptions`

Use this when selected namespaces should be written through `msq.model()` instead of direct `collection()` writes. See [Write Path Policy](./write-path-policy.md).

## 3. transaction

Available entries:

- `startSession()`
- `withTransaction()`

Good first-use cases:

- Identifying the transaction wrapper entry.
- Inspecting transaction retry, timeout, and statistics behavior.

## 4. pool

Available entries:

- `pool()`
- `ConnectionPoolManager`
- `pools` / `poolStrategy` / `poolFallback` / `maxPoolsCount`

This is the current entry point for:

- Multi-pool onboarding.
- Configuration contract and runtime routing explanations.

## 5. sync / slow-query-log

Available entries:

- sync: contract / manager / lifecycle
- slow-query-log: manager / queue / runtime façade

These capabilities include topic pages and runnable examples:

- sync: [Change Stream Sync](./sync-backup.md), examples [sync.ts](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/sync.ts) and [sync-target-failure.ts](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/sync-target-failure.ts)
- slow-query-log: [Slow Query Logging](./slow-query-log.md), example [slow-query-log.ts](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/slow-query-log.ts)

For deployment and failure behavior, continue with [Distributed Deployment](./distributed-deployment.md), [Production Rollout](./production-rollout.md), and [Failure Recovery Examples](./failure-recovery-examples.md).

## 6. Recommended Entries in This Repository

1. Documentation home: [README](./README.md)
2. API index: [API Index](./api-index.md)
3. Example index: [Examples](./examples.md)
4. Runnable examples: [examples/docs](https://github.com/devcodex-labs/monSQLize/tree/main/examples/docs)

## 7. Common Reading Paths

1. Model path: [Model Overview](./model.md), [Relations](./relations.md), [Populate](./populate.md)
2. Transaction path: [Transactions](./transaction.md), [Transaction Optimizations](./transaction-optimizations.md)
3. Pool and deployment path: [Pool Configuration](./multi-pool.md), [Pool Chain API](./pool-chain-api.md), [Production Rollout](./production-rollout.md)
4. Cache path: [Cache Configuration](./cache-configuration.md), [Cache Creation](./cache-creation.md), [Cache Invalidation](./cache-invalidation.md)
5. Sync and observability path: [Change Stream Sync](./sync-backup.md), [Production Rollout](./production-rollout.md), [Slow Query Logging](./slow-query-log.md)
