# 能力 → 文档 → 示例 → 测试追踪表

> 目的：把核心能力的**用户入口、可执行示例、自动化测试**放到同一张表里，降低“功能存在但不知道去哪看/怎么验证”的成本。

## 核心追踪表

| 能力 | 文档入口 | 官方示例 | 自动化验证 |
|------|----------|----------|------------|
| 连接 / 基础 CRUD | `getting-started.md` | `examples/quick-start/basic-connect.ts` | `test/integration/mongodb/connect.test.ts` |
| Query（find / findOne / count / distinct） | `find.md` / `findOne.md` / `count.md` / `distinct.md` | `examples/docs/find.ts` / `find-one.ts` / `count.ts` / `distinct.ts` | `test/integration/mongodb/queries.test.ts` |
| 分页 / 链式查询 | `findPage.md` / `chaining-api.md` | `examples/docs/find-page.ts` / `chaining-api.ts` | `test/integration/model/model-features.test.ts` + `npm run test:examples` |
| 聚合 / 表达式 | `aggregate.md` / `expression-functions.md` | `examples/docs/aggregate.ts` / `aggregate-advanced.ts` / `expression-functions.ts` | `test/unit/expression/*.test.ts` |
| Collection / Model 向量查询 | `vector-search.md` | 文档 API 示例；需要外部 Vector Search 部署和索引 | `test/unit/runtime/vector-search.test.ts` / `test/unit/runtime/model-relations-p0.test.ts` |
| 写入扩展 / Batch | `write-operations.md` / `updateBatch.md` / `deleteBatch.md` | `examples/docs/update.ts` / `batch-operations.ts` | `test/unit/writes/batch.test.ts` + `test/integration/mongodb/writes-batch.test.ts` |
| Collection 管理能力 | `collection-management.md` / `create-index.md` / `database-ops.md` | `examples/docs/collection-management.ts` | `test/integration/mongodb/management.test.ts` |
| 生产数据任务 / 索引发布 | `production-data-migration.md` / `data-tasks.md` / `production-rollout.md` | `examples/docs/data-tasks.ts` | `test/unit/data-tasks/data-task-job-*.test.ts` / `test/integration/data-tasks/data-task-job-facade.test.ts` / `test/smoke/data-task-cli.test.ts` |
| Cache / legacy 函数缓存兼容 | `cache.md` / `cache-and-function-cache.md` / 隐藏兼容页 `function-cache.md` | `examples/cache/with-cache.ts` / `examples/docs/cache-multilevel.ts` / legacy `examples/docs/function-cache.ts` | `test/unit/cache/cache.test.ts` / 兼容 `test/unit/function-cache/function-cache.test.ts` |
| Model / Populate / 受保护关系 | `model.md` / `populate.md` / `hooks.md` / `relations.md` / `delete-one.md` | `examples/docs/model.ts` / `populate-relations.ts` | `test/integration/model/model-features.test.ts` / `test/integration/model/model-crud-extended.test.ts` / `test/unit/runtime/model-relations-p0.test.ts` |
| Transaction | `transaction.md` / `transaction-optimizations.md` | `examples/docs/transaction.ts` / `transaction-rollback.ts` | `test/integration/transaction/transaction.test.ts` |
| Pool / 多连接池 | `multi-pool.md` / `multi-pool-health-check.md` / `pool-chain-api.md` | `examples/docs/pool.ts` / `pool-fallback.ts` | `test/unit/pool/pool.test.ts` / `test/integration/pool/pool.test.ts` |
| Sync / Resume Token / target 恢复 | `sync-backup.md` / `watch.md` / `production-rollout.md` | `examples/docs/sync.ts` / `sync-target-failure.ts` | `test/unit/sync/sync.test.ts` / `test/integration/sync/sync.test.ts` |
| Slow Query Log | `slow-query-log.md` | `examples/docs/slow-query-log.ts` | `test/unit/slow-query-log/slow-query-log.test.ts` / `test/integration/slow-query-log/slow-query-log.test.ts` |
| ObjectId 自动转换 | `objectid-auto-convert.md` / `objectid-cross-version.md` | `examples/docs/objectid.ts` | `npm run test:examples` |

## 使用建议

1. **先看文档入口**：明确能力边界与公开 API。
2. **再跑对应示例**：验证最小可执行路径与推荐写法。
3. **最后看测试**：确认边界条件、回归点和兼容守卫。

## 维护规则

- 新增能力时，至少同步更新 **文档入口 / 一个官方示例 / 一个自动化验证点**。
- 新增示例时，优先把它纳入 `npm run test:examples`。
- 热点重构后，优先补 `test:refactor-guard` 所引用的聚焦回归链。
