# 高级能力索引

本页用于给出当前 TS 版 `monSQLize` 的稳定能力入口索引。

monSQLize 是数据库原生的生产数据运行时增强层。当前稳定适配器是 MongoDB；MySQL 与 PostgreSQL 是后续计划中的 adapter，不属于当前 npm runtime。

> 原则：
> - 先说明“用户可以从哪些 API 入口开始”
> - 再给出对应的文档与示例入口

## 当前能力总览

| 层级 | 当前状态 | 范围 |
|------|----------|------|
| 共享运行时 | 当前 runtime 已暴露能力稳定 | 数据库缓存、连接池、事务、模型约束、同步、慢查询日志与运行时诊断 |
| MongoDB adapter | Stable | `collection()`、`db()`、`use()`、`pool()`、查询/写入增强、聚合、索引、事务、Change Streams |
| MySQL adapter | Planned / in development | 后续数据库原生 adapter，当前暂无公开 runtime API |
| PostgreSQL adapter | Planned / in development | 后续数据库原生 adapter，当前暂无公开 runtime API |

| 能力 | 推荐入口 | 说明 |
|------|--------------|------|
| Model | `msq.model()` / `MonSQLize.Model` | 支持 Model 注册、关系、虚拟字段、populate 与常用查询入口 |
| write-path-policy | `writePathPolicy` | 可选的 Model-only 写入命名空间运行时护栏 |
| cache | 查询 `cache` 选项 / `msq.cache` | 数据库查询缓存、多层缓存接入、缓存失效与统计 |
| transaction | `startSession()` / `withTransaction()` | 支持 MongoDB 事务封装与事务统计 |
| pool | `pools` / `pool()` / `ConnectionPoolManager` | 在构造函数中声明 `pools: PoolConfig[]`，通过 `pool()` 路由，底层管理器用于进阶状态查看与手动管理 |
| sync | `startSync()` / `stopSync()` / `getSyncStats()` | 支持 Change Stream 同步启动、停止和状态查询 |
| slow-query-log | `recordSlowQuery()` / `getSlowQueryLogs()` | 支持慢查询记录、查询和运行时管理 |

## 1. Model

可用入口：

- `Model.define/get/list/undefine/redefine`
- `msq.model()`
- relations / virtuals / populate
- `findOne()`、`findAndCount()` 等常用 Model 查询入口

Model 相关文档与示例：

- 文档：[Model 概览](./model.md)、[Populate](./populate.md)、[Relations](./relations.md)、[嵌套 Populate](./model/nested-populate.md)
- 示例：[model.ts](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/model.ts)、[populate-relations.ts](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/populate-relations.ts)

## 2. write-path-policy

可用入口：

- `writePathPolicy.default`
- `writePathPolicy.namespaces`
- `WritePathPolicyOptions`

当指定命名空间必须通过 `msq.model()` 写入，而不能直接通过 `collection()` 写入时使用。详见 [写路径策略](./write-path-policy.md)。

## 3. transaction

可用入口：

- `startSession()`
- `withTransaction()`

适合先用于：

- 事务封装入口识别
- 事务重试、超时与统计行为确认

## 4. pool

可用入口：

- `pool()`
- `ConnectionPoolManager`
- `pools` / `poolStrategy` / `poolFallback` / `maxPoolsCount`

当前适合作为：

- 多连接池入口识别
- 配置契约与运行时路由说明

## 5. sync / slow-query-log

可用入口：

- sync：contract / manager / lifecycle
- slow-query-log：manager / queue / runtime façade

这些能力已提供专题文档与可执行示例：

- sync：[Change Stream 同步](./sync-backup.md)，示例 [sync.ts](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/sync.ts)、[sync-target-failure.ts](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/sync-target-failure.ts)
- slow-query-log：[慢查询日志](./slow-query-log.md)，示例 [slow-query-log.ts](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/slow-query-log.ts)

部署与故障恢复继续阅读 [分布式部署](./distributed-deployment.md)、[生产发布与迁移](./production-rollout.md) 与 [故障恢复示例](./failure-recovery-examples.md)。

## 6. 当前仓库内的推荐入口

1. 文档站首页：[README](./README.md)
2. API 索引：[API 索引](./api-index.md)
3. 示例索引：[示例](./examples.md)
4. 可执行示例目录：[examples/docs](https://github.com/devcodex-labs/monSQLize/tree/main/examples/docs)

## 7. 常用阅读路径

1. Model 路径：[Model 概览](./model.md)、[Relations](./relations.md)、[Populate](./populate.md)
2. 事务路径：[事务](./transaction.md)、[事务优化](./transaction-optimizations.md)
3. 连接池与部署路径：[连接池配置](./multi-pool.md)、[连接池链式 API](./pool-chain-api.md)、[生产发布与迁移](./production-rollout.md)
4. 缓存路径：[缓存配置](./cache-configuration.md)、[缓存创建](./cache-creation.md)、[缓存失效](./cache-invalidation.md)
5. 同步与观测路径：[Change Stream 同步](./sync-backup.md)、[生产发布与迁移](./production-rollout.md)、[慢查询日志](./slow-query-log.md)

