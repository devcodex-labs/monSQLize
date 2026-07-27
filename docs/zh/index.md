---
pageType: home

hero:
  badge: v3.0.0 TypeScript
  name: monSQLize
  text: TypeScript 数据运行时增强层
  tagline: 当前以 MongoDB 为稳定适配器，后续以数据库原生语义接入 MySQL 与 PostgreSQL。
  image:
    src: /hero-mark.svg
    alt: monSQLize hero mark
  actions:
    - theme: brand
      text: 安装
      link: /zh/getting-started.html
    - theme: alt
      text: 快速上手
      link: /zh/basic-operations.html
    - theme: alt
      text: 完整配置
      link: /zh/configuration.html
    - theme: alt
      text: 示例
      link: /zh/examples.html
    - theme: alt
      text: API 参考
      link: /zh/api-index.html
    - theme: alt
      text: GitHub
      link: https://github.com/devcodex-labs/monSQLize

features:
  - icon: ⚡
    title: 智能两级缓存
    details: L1 内存 LRU 加可选 L2 Redis，基于 cache-hub 提供模式化失效与分布式缓存同步。
    link: /zh/cache.html
  - icon: 🔎
    title: MongoDB 适配器 API
    details: findPage、findAndCount、stream、explain、ID 便利方法与链式 builder 明确保持 MongoDB 语义。
    link: /zh/api-index.html
  - icon: 🏢
    title: 共享生产运行时
    details: 缓存一致性、事务、连接池、同步、慢查询日志与显式启用的外部服务。
    link: /zh/capability-index.html
  - icon: 🌐
    title: 多连接池与读写分离
    details: 支持池路由、负载均衡、故障转移，以及 pool().use().scopedCollection() 链式访问。
    link: /zh/multi-pool.html
  - icon: 🧩
    title: 可选 Model 层
    details: Schema 验证、生命周期 hooks、Relations 与 Populate 支持，可渐进式接入。
    link: /zh/model.html
  - icon: 🔷
    title: Adapter 路线图
    details: MongoDB 当前稳定；MySQL 与 PostgreSQL 将以数据库原生 adapter 接入，而不是伪装成 MongoDB 方言。
    link: /zh/roadmap-boundaries.html
  - icon: 🔄
    title: Change Stream 同步
    details: 基于 resume token 的 MongoDB Change Stream 同步辅助能力。
    link: /zh/sync-backup.html
  - icon: 📊
    title: 慢查询日志
    details: 支持可配置阈值的慢查询检测，并内置 MongoDB 与内存存储适配器。
    link: /zh/slow-query-log.html
  - icon: 🔗
    title: 链式查询 API
    details: find().where().select().sort().skip().limit().lean() 流式 builder，兼顾表达力与类型推断。
    link: /zh/chaining-api.html
---
