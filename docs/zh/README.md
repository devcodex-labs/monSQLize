# monSQLize 文档入口

这份文档从常见应用路径开始：连接 MongoDB，完成集合读写，需要时再加入 Model 校验，并按需开启缓存、事务、连接池、同步与运维能力。

## 主要文档路径

| 目标 | 入口 | 说明 |
|------|------|------|
| 安装、连接、完成第一次查询 | [`getting-started.md`](./getting-started.md) | 安装与最小连接验证 |
| 快速上手常用集合操作 | [`basic-operations.md`](./basic-operations.md) | 日常 CRUD、分页、缓存 TTL 与 Model 入口选择 |
| 配置 `new MonSQLize(options)` | [`configuration.md`](./configuration.md) | 构造函数完整参数、默认值、缓存、Redis、Model、同步、连接池与日志 |
| 对照文档与可运行源码 | [`examples.md`](./examples.md) | 每个主题都链接到 GitHub 示例源码 |
| 添加数据库缓存 | [`cache.md`](./cache.md) | 集合查询缓存、Redis 二级缓存、分布式失效 |
| 控制 collection 与 Model 写入路径 | [`write-path-policy.md`](./write-path-policy.md) | 需要某些命名空间必须经过 Model 写入时使用 |
| 准备生产发布 | [`production-rollout.md`](./production-rollout.md) | 数据任务发布、Change Stream CDC、索引预检与切流检查 |
| 按场景迁移生产数据 | [`production-data-migration.md`](./production-data-migration.md) | A 实例到生产的筛选数据、索引、字段调整与恢复流程 |
| 查询数据任务参数 | [`data-tasks.md`](./data-tasks.md) | 唯一 Job 配置、四个方法、全部参数与 CLI 命令 |
| 查看场景指南 | [`recipes.md`](./recipes.md) | 连接、缓存、Redis、SSH、连接池、Model 的场景指南 |
| 浏览完整 API | [`api-index.md`](./api-index.md) | 低层 API 与兼容 API 的参考入口 |
| 查看运行时边界 | [`capability-index.md`](./capability-index.md) | 能力总览与深入页面入口 |

## 推荐阅读顺序

1. 根入口说明：[仓库 README](../../README.md)
2. 安装：[`getting-started.md`](./getting-started.md)
3. 快速上手：[`basic-operations.md`](./basic-operations.md)
4. 构造配置：[`configuration.md`](./configuration.md)
5. 可执行示例：
   - [examples/README.md](https://github.com/devcodex-labs/monSQLize/blob/main/examples/README.md)
   - [examples/quick-start/basic-connect.ts](https://github.com/devcodex-labs/monSQLize/blob/main/examples/quick-start/basic-connect.ts)
   - [examples/quick-start/basic-operations.ts](https://github.com/devcodex-labs/monSQLize/blob/main/examples/quick-start/basic-operations.ts)
   - [examples/docs](https://github.com/devcodex-labs/monSQLize/tree/main/examples/docs)
   - [`examples.md`](./examples.md)
6. 缓存专题：[`cache.md`](./cache.md)
7. 写路径策略：[`write-path-policy.md`](./write-path-policy.md)
8. 生产发布：[`production-rollout.md`](./production-rollout.md)
9. 生产数据迁移：[`production-data-migration.md`](./production-data-migration.md)
10. 数据任务 API：[`data-tasks.md`](./data-tasks.md)
11. 场景指南：[`recipes.md`](./recipes.md)
12. API 与运行时参考：
   - [`api-index.md`](./api-index.md)
   - [`capability-index.md`](./capability-index.md)
   - [`support-matrix.md`](./support-matrix.md)

## 源码与验证

- 文档站由 [`docs/en`](https://github.com/devcodex-labs/monSQLize/tree/main/docs/en) 与 [`docs/zh`](https://github.com/devcodex-labs/monSQLize/tree/main/docs/zh) 生成。
- 可运行示例位于 [`examples`](https://github.com/devcodex-labs/monSQLize/tree/main/examples)。
- 公开行为应与包根导出、公开类型和可运行示例保持一致。

## 示例运行方式

在仓库根目录执行：

```bash
npm run build
npm run test:examples
```

`npm run test:examples` 会通过仓库示例 runner 启动临时 MongoDB 测试服务，编译 TypeScript 示例，执行示例，并在结束时清理临时数据目录。
