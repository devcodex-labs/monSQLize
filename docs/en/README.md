# monSQLize Documentation

This documentation starts with the common application path: connect to MongoDB, run collection operations, add Model validation when needed, then enable cache, transactions, pools, sync, and operations features deliberately.

## Main Documentation Paths

| Goal | Start here | Notes |
|------|------------|-------|
| Install, connect, and run the first query | [`getting-started.md`](./getting-started.md) | Installation and minimal connection validation |
| Learn basic usage for common collection operations | [`basic-operations.md`](./basic-operations.md) | Daily CRUD, pagination, cache TTL, and Model entry-point guidance |
| Configure `new MonSQLize(options)` | [`configuration.md`](./configuration.md) | Complete constructor options, defaults, cache, Redis, Model, sync, pools, and logging |
| Match docs to runnable source | [`examples.md`](./examples.md) | Links each topic to a GitHub example source |
| Add database caching | [`cache.md`](./cache.md) | Collection query cache, Redis L2 cache, and distributed invalidation |
| Control collection-vs-Model writes | [`write-path-policy.md`](./write-path-policy.md) | Optional guard when selected namespaces must go through Model writes |
| Prepare production rollout | [`production-rollout.md`](./production-rollout.md) | Data task rollout, Change Stream CDC, index preflight, and traffic-switch checks |
| Migrate production data by scenario | [`production-data-migration.md`](./production-data-migration.md) | Filtered data, indexes, field edits, and restore from instance A to production |
| Look up data task parameters | [`data-tasks.md`](./data-tasks.md) | One Job configuration, four methods, every parameter, and CLI commands |
| Follow scenario guides | [`recipes.md`](./recipes.md) | Guides for connection, cache, Redis, SSH, pools, and Model usage |
| Browse the full API surface | [`api-index.md`](./api-index.md) | Reference entry for lower-level and compatibility APIs |
| Check runtime boundaries | [`capability-index.md`](./capability-index.md) | Capability map with links to deeper reference pages |

## Recommended Reading Order

1. Package entry: [repository README](../../README.md)
2. Installation: [`getting-started.md`](./getting-started.md)
3. Basic usage: [`basic-operations.md`](./basic-operations.md)
4. Constructor configuration: [`configuration.md`](./configuration.md)
5. Examples:
   - [examples/README.md](https://github.com/devcodex-labs/monSQLize/blob/main/examples/README.md)
   - [examples/quick-start/basic-connect.ts](https://github.com/devcodex-labs/monSQLize/blob/main/examples/quick-start/basic-connect.ts)
   - [examples/quick-start/basic-operations.ts](https://github.com/devcodex-labs/monSQLize/blob/main/examples/quick-start/basic-operations.ts)
   - [examples/docs](https://github.com/devcodex-labs/monSQLize/tree/main/examples/docs)
   - [`examples.md`](./examples.md)
6. Cache guide: [`cache.md`](./cache.md)
7. Write path policy: [`write-path-policy.md`](./write-path-policy.md)
8. Production rollout: [`production-rollout.md`](./production-rollout.md)
9. Production data migration: [`production-data-migration.md`](./production-data-migration.md)
10. Data tasks API: [`data-tasks.md`](./data-tasks.md)
11. Scenario guides: [`recipes.md`](./recipes.md)
12. API and runtime reference:
   - [`api-index.md`](./api-index.md)
   - [`capability-index.md`](./capability-index.md)
   - [`support-matrix.md`](./support-matrix.md)

## Source and Verification

- The website is generated from [`docs/en`](https://github.com/devcodex-labs/monSQLize/tree/main/docs/en) and [`docs/zh`](https://github.com/devcodex-labs/monSQLize/tree/main/docs/zh).
- Runnable examples live in [`examples`](https://github.com/devcodex-labs/monSQLize/tree/main/examples).
- Public package behavior should match the package root exports, public types, and runnable examples.

## Running Examples

Run these commands from the repository root:

```bash
npm run build
npm run test:examples
```

`npm run test:examples` starts temporary MongoDB test servers through the repository example runner, compiles the TypeScript examples, runs them, and cleans up the temporary data directories.
