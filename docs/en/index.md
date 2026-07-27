---
pageType: home

hero:
  badge: v3.0.0 TypeScript
  name: monSQLize
  text: TypeScript Data Runtime Layer
  tagline: Database-native production runtime for MongoDB today, with MySQL and PostgreSQL adapters next.
  image:
    src: /hero-mark.svg
    alt: monSQLize hero mark
  actions:
    - theme: brand
      text: Installation
      link: /getting-started.html
    - theme: alt
      text: Basic Usage
      link: /basic-operations.html
    - theme: alt
      text: Configuration
      link: /configuration.html
    - theme: alt
      text: Examples
      link: /examples.html
    - theme: alt
      text: API Reference
      link: /api-index.html
    - theme: alt
      text: GitHub
      link: https://github.com/devcodex-labs/monSQLize

features:
  - icon: ⚡
    title: Smart Two-Level Cache
    details: L1 memory LRU plus optional L2 Redis, powered by cache-hub with pattern invalidation and distributed sync.
    link: /cache.html
  - icon: 🔎
    title: MongoDB Adapter APIs
    details: findPage, findAndCount, stream, explain, ID helpers, and chain builders stay explicit to MongoDB semantics.
    link: /api-index.html
  - icon: 🏢
    title: Shared Production Runtime
    details: Cache consistency, transactions, pools, sync, slow-query logging, and explicit external services.
    link: /capability-index.html
  - icon: 🌐
    title: Multi-Pool & Read/Write Split
    details: Pool routing, load balancing, failover, and pool().use().scopedCollection() access for advanced database layouts.
    link: /multi-pool.html
  - icon: 🧩
    title: Optional Model Layer
    details: Schema validation, lifecycle hooks, relations, and Populate support that can be adopted gradually.
    link: /model.html
  - icon: 🔷
    title: Adapter Roadmap
    details: MongoDB is stable today; MySQL and PostgreSQL are planned as database-native adapters, not fake MongoDB dialects.
    link: /roadmap-boundaries.html
  - icon: 🔄
    title: Change Stream Sync
    details: Resume-token aware synchronization helpers for MongoDB change streams.
    link: /sync-backup.html
  - icon: 📊
    title: Slow-Query Logging
    details: Configurable slow-query detection with MongoDB and memory storage adapters.
    link: /slow-query-log.html
  - icon: 🔗
    title: Chain Query API
    details: Fluent find().where().select().sort().skip().limit().lean() builders with TypeScript inference.
    link: /chaining-api.html
---
