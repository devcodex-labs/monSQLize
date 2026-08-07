# Capabilities → Documentation → Examples → Test Tracking Form

> Purpose: Put the **user portal, executable examples, and automated tests** of core capabilities into the same table to reduce the cost of "the function exists but I don't know where to look/how to verify it."

## Core tracking table

| Capabilities | Documentation Entry | Official Examples | Automated Verification |
|------|----------|----------|------------|
| Connection / Basic CRUD | `getting-started.md` | `examples/quick-start/basic-connect.ts` | `test/integration/mongodb/connect.test.ts` |
| Query (find / findOne / count / distinct) | `find.md` / `findOne.md` / `count.md` / `distinct.md` | `examples/docs/find.ts` / `find-one.ts` / `count.ts` / `distinct.ts` | `test/integration/mongodb/queries.test.ts` |
| Paging / Chain query | `findPage.md` / `chaining-api.md` | `examples/docs/find-page.ts` / `chaining-api.ts` | `test/integration/model/model-features.test.ts` + `npm run test:examples` |
| Aggregation / Expression | `aggregate.md` / `expression-functions.md` | `examples/docs/aggregate.ts` / `aggregate-advanced.ts` / `expression-functions.ts` | `test/unit/expression/*.test.ts` |
| Collection / Model vector search | `vector-search.md` | Documented API example; requires an external Vector Search deployment and index | `test/unit/runtime/vector-search.test.ts` / `test/unit/runtime/model-relations-p0.test.ts` |
| Write extension / Batch | `write-operations.md` / `updateBatch.md` / `deleteBatch.md` | `examples/docs/update.ts` / `batch-operations.ts` | `test/unit/writes/batch.test.ts` + `test/integration/mongodb/writes-batch.test.ts` |
| Collection management capabilities | `collection-management.md` / `create-index.md` / `database-ops.md` | `examples/docs/collection-management.ts` | `test/integration/mongodb/management.test.ts` |
| Production data tasks / index rollout | `production-data-migration.md` / `data-tasks.md` / `production-rollout.md` | `examples/docs/data-tasks.ts` | `test/unit/data-tasks/data-task-job-*.test.ts` / `test/integration/data-tasks/data-task-job-facade.test.ts` / `test/smoke/data-task-cli.test.ts` |
| Cache / legacy function-cache compatibility | `cache.md` / `cache-and-function-cache.md` / hidden compatibility page `function-cache.md` | `examples/cache/with-cache.ts` / `examples/docs/cache-multilevel.ts` / legacy `examples/docs/function-cache.ts` | `test/unit/cache/cache.test.ts` / compatibility `test/unit/function-cache/function-cache.test.ts` |
| Model / Populate / protected relations | `model.md` / `populate.md` / `hooks.md` / `relations.md` / `delete-one.md` | `examples/docs/model.ts` / `populate-relations.ts` | `test/integration/model/model-features.test.ts` / `test/integration/model/model-crud-extended.test.ts` / `test/unit/runtime/model-relations-p0.test.ts` |
| Transaction | `transaction.md` / `transaction-optimizations.md` | `examples/docs/transaction.ts` / `transaction-rollback.ts` | `test/integration/transaction/transaction.test.ts` |
| Pool / Multiple connection pool | `multi-pool.md` / `multi-pool-health-check.md` / `pool-chain-api.md` | `examples/docs/pool.ts` / `pool-fallback.ts` | `test/unit/pool/pool.test.ts` / `test/integration/pool/pool.test.ts` |
| Sync / Resume Token / target recovery | `sync-backup.md` / `watch.md` / `production-rollout.md` | `examples/docs/sync.ts` / `sync-target-failure.ts` | `test/unit/sync/sync.test.ts` / `test/integration/sync/sync.test.ts` |
| Slow Query Log | `slow-query-log.md` | `examples/docs/slow-query-log.ts` | `test/unit/slow-query-log/slow-query-log.test.ts` / `test/integration/slow-query-log/slow-query-log.test.ts` |
| ObjectId automatic conversion | `objectid-auto-convert.md` / `objectid-cross-version.md` | `examples/docs/objectid.ts` | `npm run test:examples` |

## Usage suggestions

1. **Look at the document entry first**: clarify capability boundaries and public APIs.
2. **Run the corresponding example again**: Verify the minimum executable path and recommended writing method.
3. **Final look at testing**: Confirm boundary conditions, regression points and compatible guards.

## Maintenance rules

- When adding new capabilities, at least update the **documentation entrance/an official example/an automated verification point** simultaneously.
- When adding a new example, give priority to including it in `npm run test:examples`.
- After hotspot reconstruction, the focus regression chain referenced by `test:refactor-guard` will be supplemented first.
