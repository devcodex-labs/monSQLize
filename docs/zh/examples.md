# 🧪 Examples Gallery

文档站中的每个核心 API，都应尽量对应到**当前仓库内可直接运行的示例**。

> 当前完整示例源列表见 [官方示例总览](https://github.com/devcodex-labs/monSQLize/blob/main/examples/README.md)，其中 `npm run test:examples` 会统一编译并执行当前 **58 个** TypeScript 示例；[`examples/helpers/bootstrap.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/helpers/bootstrap.ts) 是辅助模块，不单独执行。

## 运行方式

```bash
npm run build
npm run test:examples
```

`npm run test:examples` 会在父进程中启动共享 `mongodb-memory-server` standalone + replica set，并在示例之间做健康检查，再把 URI 传给所有示例子进程；二进制缓存固定在 `.cache/mongodb-memory-server/binaries`，临时数据目录固定在 `.cache/mongodb-memory-server/db` 并在退出时清理。

也可以单独执行任意示例：

```bash
tsc -p tsconfig.examples.json
node .generated/examples-dist/examples/docs/find.js
```

## 入门示例

| 文档 | 示例 |
|------|------|
| [`getting-started.md`](./getting-started.md) | [`examples/quick-start/basic-connect.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/quick-start/basic-connect.ts) |
| [`basic-operations.md`](./basic-operations.md) | [`examples/quick-start/basic-operations.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/quick-start/basic-operations.ts) |
| [`cache.md`](./cache.md) | [`examples/docs/cache-multilevel.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/cache-multilevel.ts) |

## 查询操作

| 文档 | 示例 |
|------|------|
| [`find.md`](./find.md) | [`examples/docs/find.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/find.ts) |
| [`findOne.md`](./findOne.md) | [`examples/docs/find-one.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/find-one.ts) |
| [`findPage.md`](./findPage.md) | [`examples/docs/find-page.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/find-page.ts) |
| [`find-and-count.md`](./find-and-count.md) | [`examples/docs/find-and-count.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/find-and-count.ts) |
| [`count.md`](./count.md) | [`examples/docs/count.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/count.ts) |
| [`count-queue.md`](./count-queue.md) | [`examples/docs/count-queue.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/count-queue.ts) |
| [`distinct.md`](./distinct.md) | [`examples/docs/distinct.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/distinct.ts) |
| [`aggregate.md`](./aggregate.md) | [`examples/docs/aggregate.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/aggregate.ts) |
| [`explain.md`](./explain.md) | [`examples/docs/explain.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/explain.ts) |
| [`chaining-api.md`](./chaining-api.md) | [`examples/docs/chaining-api.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/chaining-api.ts) |

## 写入操作

| 文档 | 示例 |
|------|------|
| [`insert-one.md`](./insert-one.md) | [`examples/docs/insert.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/insert.ts) |
| [`insert-many.md`](./insert-many.md) | [`examples/docs/insert-many.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/insert-many.ts) |
| [`insertBatch.md`](./insertBatch.md) | [`examples/docs/insert.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/insert.ts) |
| [`update-one.md`](./update-one.md) | [`examples/docs/update-one.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/update-one.ts) |
| [`update-many.md`](./update-many.md) | [`examples/docs/update.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/update.ts) |
| [`updateBatch.md`](./updateBatch.md) | [`examples/docs/update.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/update.ts) |
| [`update-aggregation.md`](./update-aggregation.md) | [`examples/docs/update-aggregation.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/update-aggregation.ts) |
| [`delete-one.md`](./delete-one.md) | [`examples/docs/delete.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/delete.ts) |
| [`delete-many.md`](./delete-many.md) | [`examples/docs/delete-many.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/delete-many.ts) |
| [`deleteBatch.md`](./deleteBatch.md) | [`examples/docs/delete.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/delete.ts) |
| [`upsert-one.md`](./upsert-one.md) | [`examples/docs/upsert-one.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/upsert-one.ts) |
| [`quick-upsert.md`](./quick-upsert.md) | [`examples/docs/quick-upsert.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/quick-upsert.ts) |
| [`replace-one.md`](./replace-one.md) | [`examples/docs/upsert.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/upsert.ts) |
| [`find-one-and-update.md`](./find-one-and-update.md) | [`examples/docs/upsert.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/upsert.ts) |
| [`find-one-and-replace.md`](./find-one-and-replace.md) | [`examples/docs/upsert.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/upsert.ts) |
| [`find-one-and-delete.md`](./find-one-and-delete.md) | [`examples/docs/delete.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/delete.ts) |
| [`increment-one.md`](./increment-one.md) | [`examples/docs/update.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/update.ts) |

## 高级能力

| 文档 | 示例 |
|------|------|
| [`expression-functions.md`](./expression-functions.md) | [`examples/docs/expression-functions.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/expression-functions.ts) |
| [`model.md`](./model.md) | [`examples/docs/model.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/model.ts) |
| [`hooks.md`](./hooks.md) | [`examples/docs/hooks.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/hooks.ts) |
| [`collection-management.md`](./collection-management.md) | [`examples/docs/collection-management.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/collection-management.ts) |
| [`create-index.md`](./create-index.md) | [`examples/docs/index-management.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/index-management.ts) |
| [`create-indexes.md`](./create-indexes.md) | [`examples/docs/index-management.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/index-management.ts) |
| [`list-indexes.md`](./list-indexes.md) | [`examples/docs/index-management.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/index-management.ts) |
| [`drop-index.md`](./drop-index.md) | [`examples/docs/index-management.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/index-management.ts) |
| [`data-tasks.md`](./data-tasks.md) | [`examples/docs/data-tasks.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/data-tasks.ts) |
| [`bookmarks.md`](./bookmarks.md) | [`examples/docs/bookmarks.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/bookmarks.ts) |
| [`slow-query-log.md`](./slow-query-log.md) | [`examples/docs/slow-query-log.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/slow-query-log.ts) |
| [`transaction.md`](./transaction.md) | [`examples/docs/transaction.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/transaction.ts) |
| [`transaction-optimizations.md`](./transaction-optimizations.md) | [`examples/docs/transaction-optimizations.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/transaction-optimizations.ts) |
| [`events.md`](./events.md) | [`examples/docs/events.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/events.ts) |
| [`watch.md`](./watch.md) | [`examples/docs/watch.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/watch.ts) |
| [`aggregate.md`](./aggregate.md) | [`examples/docs/aggregate-advanced.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/aggregate-advanced.ts) |
| [`write-operations.md`](./write-operations.md) | [`examples/docs/batch-operations.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/batch-operations.ts) |
| [`model.md`](./model.md) | [`examples/docs/soft-delete.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/soft-delete.ts) |
| [`cache.md`](./cache.md) | [`examples/docs/cache-multilevel.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/cache-multilevel.ts) |
| [`objectid-auto-convert.md`](./objectid-auto-convert.md) | [`examples/docs/objectid.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/objectid.ts) |
| [`multi-pool.md`](./multi-pool.md) | [`examples/docs/pool.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/pool.ts) |
| [`pool-chain-api.md`](./pool-chain-api.md) | [`examples/docs/pool-chain-api.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/pool-chain-api.ts) |
| [`failure-recovery-examples.md`](./failure-recovery-examples.md) | [`examples/docs/pool-fallback.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/pool-fallback.ts) |
| [`multi-pool-health-check.md`](./multi-pool-health-check.md) | [`examples/docs/multi-pool-health-check.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/multi-pool-health-check.ts) |
| [`sync-backup.md`](./sync-backup.md) | [`examples/docs/sync.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/sync.ts) |
| [`failure-recovery-examples.md`](./failure-recovery-examples.md) | [`examples/docs/sync-target-failure.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/sync-target-failure.ts) |
| [`failure-recovery-examples.md`](./failure-recovery-examples.md) | [`examples/docs/transaction-rollback.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/transaction-rollback.ts) |
| [`populate.md`](./populate.md) | [`examples/docs/populate-relations.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/populate-relations.ts) |
| [`relations.md`](./relations.md) | [`examples/docs/relations.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/relations.ts) |
| [`model/nested-populate.md`](./model/nested-populate.md) | [`examples/docs/nested-populate.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/nested-populate.ts) |

> 说明：部分概念型页面会复用同一个 richer example，而不是为每个标题机械复制一份完全相同的脚本；完整列表以 [官方示例总览](https://github.com/devcodex-labs/monSQLize/blob/main/examples/README.md) 为准。
