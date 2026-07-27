# monSQLize

Database-native production data runtime layer for TypeScript services. monSQLize keeps database semantics explicit while adding shared runtime capabilities for caching, transactions, connection pools, models, synchronization, observability, and CommonJS / ESM / TypeScript declaration outputs.

[![npm version](https://img.shields.io/npm/v/monsqlize.svg)](https://www.npmjs.com/package/monsqlize)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)
[![MongoDB](https://img.shields.io/badge/MongoDB-7.x%20%2F%208.x-green.svg)](https://www.mongodb.com/)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-brightgreen)](https://nodejs.org/)

Documentation: [English](https://devcodex-labs.github.io/monSQLize/) · [简体中文](https://devcodex-labs.github.io/monSQLize/zh/)
Quick path: [Installation](https://devcodex-labs.github.io/monSQLize/getting-started) · [Basic Usage](https://devcodex-labs.github.io/monSQLize/basic-operations)
Configuration reference: [English](https://devcodex-labs.github.io/monSQLize/configuration) · [简体中文](https://devcodex-labs.github.io/monSQLize/zh/configuration)
Upgrade and security: [Migration Guide](./MIGRATION.md) · [Private Vulnerability Reporting](./SECURITY.md)

The npm `latest` dist-tag and GitHub Pages are the stable channel; `main` may contain the next release. Pages deployment accepts only a versioned Git tag whose package version is already present on npm, so unpublished APIs are not promoted as stable documentation.

This source tree contains the stable `3.1.0` release candidate, pinned to verified registry `schema-dsl@3.0.0`. The v3 package remains subject to the full release gate before its immutable tag and npm publication.

```bash
npm install monsqlize
```

MongoDB is the first complete adapter. MySQL and PostgreSQL adapters are planned as database-native runtime adapters, not as a transparent promise that every database already accepts the same query syntax.

## Why monSQLize

monSQLize is not an ORM and it is not just a CRUD wrapper. It is a production data runtime layer: the database driver remains visible, while the operational features teams usually build around the driver are provided in one runtime.

- Database-native adapter APIs: the current stable adapter preserves MongoDB-style CRUD, aggregation, indexes, transactions, and Change Streams.
- Smart database caching through `cache-hub`, including local memory caching, optional Redis-backed L2 caching, and automatic invalidation.
- A lightweight Model layer with `schema-dsl` validation, hooks, relations, populate, custom methods, timestamps, soft delete, optimistic locking, and production-safe index preflight.
- Multi-connection-pool support, pool health checks, pool-scoped collections/models, and fallback strategies.
- Change Stream sync helpers with resume token storage.
- Slow-query logging and query diagnostics.
- CommonJS, ESM, and TypeScript declaration outputs from `dist/**`.

## Adapter Status

| Adapter | Current status | Public entry |
|---|---|---|
| MongoDB | Stable and fully implemented | `type: 'mongodb'`, `collection()`, `db()`, `use()`, `pool()` |
| MySQL | Planned / in development | Not part of the current npm runtime yet |
| PostgreSQL | Planned / in development | Not part of the current npm runtime yet |

The shared runtime direction is cache consistency, connection lifecycle, transaction helpers, model constraints, synchronization, and observability across adapters. Adapter-native query, transaction, and connection semantics will stay explicit.

## Runtime Consistency Contract

monSQLize coordinates cache, transactions, sync, and queues inside the runtime, but it does not provide a global strict-consistency kernel. MongoDB transactions keep MongoDB session ACID semantics. Query caching is opt-in, and write-side cache invalidation is explicit: use `cache.invalidate` for precise entries or `autoInvalidate` / `cache.autoInvalidate` for broad invalidation. Cache invalidation runs after successful writes or transaction commit and is best-effort; Redis/L2 cache and Pub/Sub invalidation provide eventual cross-instance coherence rather than atomic cache/DB commits. Change Stream sync is at-least-once; custom targets should be idempotent by change event `_id`, and `sync.idempotency` can record per-target replay markers when a durable store is provided. Transaction cache locks are process-local in the current v3 runtime; use explicit business coordination, idempotency/fencing, or cache bypassing for cross-instance strict flows.

## Write Path Policy

By default, both `collection()` and `model()` may write. Applications that want all writes for selected namespaces to pass through Model defaults, hooks, timestamps, versioning, and soft-delete rules can enable `writePathPolicy`.

```ts
const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'app',
  config: { uri: 'mongodb://localhost:27017' },
  writePathPolicy: {
    default: 'model-only',
    namespaces: {
      'app.audit_logs': 'allow-both'
    }
  }
});
```

`model-only` blocks direct collection/db/legacy write surfaces by default, including raw access and `$out` / `$merge` aggregate writes, while Model write and Model management methods remain available. See [Write Path Policy](./docs/en/write-path-policy.md).

## When to Use It

monSQLize is a good fit when you need:

| Scenario | Benefit |
|---|---|
| High-concurrency reads | Cache hot data and reduce repeated database work. |
| MongoDB API compatibility today | Keep familiar MongoDB syntax while adding higher-level runtime helpers. |
| A future multi-database runtime boundary | Prepare for MySQL/PostgreSQL adapters without turning SQL into fake MongoDB syntax. |
| Multi-instance services | Use Redis invalidation and pool health checks to keep instances coordinated. |
| Transaction-heavy flows | Use `withTransaction()` and transaction-aware helpers instead of hand-rolled lifecycle code. |
| Model-level ergonomics | Add schema validation, hooks, populate, and custom methods only where needed. |
| Smooth upgrade from v1 | Keep legacy application source stable while adopting the TypeScript rewrite. |

monSQLize is usually not the best first choice for pure write-heavy workloads, extremely strict real-time reads where every query must bypass cache, or very small applications that do not need the extra operational layer.

## Installation

```bash
npm install monsqlize
```

Use Node.js 18 or newer and provide a MongoDB connection URI. Optional Redis, SSH tunnel, cache, Model, and sync features are configured only when your application enables them.

## Quick Start

The current stable quick start uses the MongoDB adapter.

### CommonJS

```js
const MonSQLize = require('monsqlize');

const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'mydb',
  config: {
    uri: 'mongodb://localhost:27017'
  },
  cache: {
    maxEntries: 10000,
    defaultTtl: 60_000
  }
});

await msq.connect();

const users = msq.collection('users');

await users.insertOne({
  username: 'john',
  email: 'john@example.com',
  createdAt: new Date()
});

const user = await users.findOne({ email: 'john@example.com' });
const sameUser = await users.findOne({ _id: '507f1f77bcf86cd799439011' });

await users.updateOne(
  { email: 'john@example.com' },
  { $set: { lastLoginAt: new Date() } }
);

await msq.close();
```

Next, use the [Basic Usage guide](https://devcodex-labs.github.io/monSQLize/basic-operations) for common CRUD, pagination, read cache, and Model entry-point examples.

### ESM and TypeScript

```ts
import MonSQLize from 'monsqlize';
import type { Collection } from 'monsqlize';

const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'mydb',
  config: {
    uri: 'mongodb://localhost:27017'
  }
});

await msq.connect();

const users: Collection = msq.collection('users');
const activeUsers = await users.find({ status: 'active' }).toArray();

await msq.close();
```

Published entry points:

| Format | Entry |
|---|---|
| CommonJS | `dist/cjs/index.cjs` |
| ESM | `dist/esm/index.mjs` |
| Types | `dist/types/index.d.ts` |

The package root exports only the public package contract. Deep imports into historical `lib/**` files are not part of the v3 publishing surface.

## Model Layer

The Model layer is optional. Use it when you want schema validation, hooks, relations, populate, custom methods, timestamps, soft delete, or optimistic locking.

Models use the current `schema-dsl/runtime` path through monSQLize. monSQLize creates an isolated schema runtime for each `MonSQLize` instance, then compiles Model schema callbacks when a Model is bound to that runtime.

### Manual Model Registration

```js
const MonSQLize = require('monsqlize');
const { Model } = MonSQLize;

Model.define('users', {
  schema: (s) => s({
    username: 'string:3-32!',
    email: 'email!',
    password: 'string:6-!',
    age: 'number:0-120'
  }),
  relations: {
    posts: {
      from: 'posts',
      localField: '_id',
      foreignField: 'userId',
      single: false
    }
  },
  hooks: (model) => ({
    insert: {
      before: async (ctx, doc) => {
        doc.createdAt = new Date();
        return doc;
      }
    }
  }),
  methods: (model) => ({
    instance: {
      checkPassword(password) {
        return this.password === password;
      }
    },
    static: {
      async findByUsername(username) {
        return model.findOne({ username });
      }
    }
  })
});

const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'mydb',
  config: { uri: 'mongodb://localhost:27017' }
});

await msq.connect();

const User = msq.model('users');
const user = await User.insertOne({
  username: 'john',
  email: 'john@example.com',
  password: 'secret123',
  age: 25
});
```

When a service needs runtime-local custom types, messages, locale, or an already-owned schema-dsl runtime, configure `schemaDsl` on the MonSQLize instance:

```js
const { createRuntime } = require('schema-dsl/runtime');

const schemaRuntime = createRuntime({
  types: {
    tenantId: { type: 'string', pattern: '^tenant_[a-z0-9]+$' }
  }
});

Model.define('tenantUsers', {
  schema: (s) => s({
    tenantId: 'tenantId!',
    email: 'email!'
  })
});

const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'mydb',
  config: { uri: 'mongodb://localhost:27017' },
  schemaDsl: { runtime: schemaRuntime }
});
```

For monSQLize-only Model validation, no direct application import from `schema-dsl` is required. Direct application imports should use `schema-dsl/runtime` when they need to share the same isolated runtime state with monSQLize.
Use `schemaDsl: { extensions }` when monSQLize should own the runtime and register extension definitions. When the application owns the schema-dsl lifecycle, configure that runtime directly, including `runtime.registerExtensions([...])`, and inject it with `schemaDsl: { runtime }`. If the default `schema-dsl/runtime` entry cannot be resolved or does not expose the required runtime APIs, monSQLize throws `INVALID_CONFIG`; validation is disabled only when `schemaDsl: false` or `schemaDsl: { enabled: false }` is set explicitly.

For `insertOne`, `insertMany`, `insertBatch`, `replaceOne`, `findOneAndReplace`, and hydrated document `save()`, successful schema validation now forwards schema-dsl's normalized `data` into the actual write. Public errors remain `{ field, message }`, mapped from canonical upstream `path/message`. Update operators and pipelines are intentionally outside this complete-document normalization contract.

### Automatic Model Loading

```js
const path = require('path');
const MonSQLize = require('monsqlize');

const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'mydb',
  config: { uri: 'mongodb://localhost:27017' },
  models: path.join(__dirname, 'models')
});

await msq.connect();

const User = msq.model('users');
```

```js
// models/user.model.js
module.exports = {
  name: 'users',
  schema: (s) => s({
    username: 'string:3-32!',
    email: 'email!'
  }),
  methods: (model) => ({
    static: {
      async findByUsername(username) {
        return model.findOne({ username });
      }
    }
  })
};
```

Relative model paths are resolved from `process.cwd()`. In production services, prefer absolute paths such as `path.join(__dirname, 'models')`.

### Production Model Index Rollout

Model-declared indexes are still created automatically by default for backward compatibility. Production services can turn off automatic indexing and run an explicit preflight before creating missing indexes:

```js
const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'mydb',
  config: { uri: 'mongodb://localhost:27017' },
  autoIndex: false
});

const plan = await msq.ensureModelIndexes({ models: ['users'], dryRun: true });

if (plan.totals.conflicts === 0) {
  await msq.ensureModelIndexes({ models: ['users'], throwOnError: true });
}
```

`ensureModelIndexes()` creates only missing indexes. It does not drop, rename, or rebuild conflicting indexes.

### Versioned Writes

Models with `options.version` use single-document optimistic concurrency control. When the filter contains a direct `_id`, monSQLize reads the current version automatically. You can still pass an explicit version in the filter or as `expectedVersion` when you want to control the expected version yourself:

```js
await User.updateOne(
  { _id: userId },
  { $set: { status: 'active' } }
);

await User.replaceOne(
  { _id: userId },
  nextUser,
  { expectedVersion: user.version }
);
```

Successful `save()`, `updateOne()`, `replaceOne()`, `findOneAndUpdate()`, and `findOneAndReplace()` advance the version. Stale writes throw a `WRITE_CONFLICT` error.

For `updateMany()` and `updateBatch()`, choose the batch version behavior explicitly when needed:

```js
await User.updateMany({ status: 'pending' }, { $set: { status: 'active' } }, {
  versionMode: 'strict' // 'counter' | 'strict' | 'off'
});
```

`counter` is the default and only increments the version counter; it is not optimistic locking. `strict` pre-reads matching document IDs and versions, conditionally updates each document, and returns `conflictCount` / `conflictedIds` on the result object.

### Populate

```js
Model.define('posts', {
  schema: (s) => s({
    title: 'string:1-200!',
    content: 'string!',
    userId: 'objectId!'
  })
});

const userWithPosts = await User.findOne({ username: 'john' })
  .populate('posts', {
    select: 'title content',
    match: { status: 'published' },
    sort: { createdAt: -1 },
    limit: 10
  });
```

Populate is supported by `find()`, `findOne()`, `findByIds()`, `findOneById()`, `findAndCount()`, and `findPage()`.

For has-many relations, `skip` and `limit` are applied per parent document after related records are grouped. Nested populate has a default `maxDepth` of `5`; set `maxDepth` on a populate branch when a self-referencing relation needs a different cap.

### Soft Delete Visibility

When `softDelete` is enabled, standard model read paths hide deleted documents by default: `find()`, `findOne()`, `findOneById()`, `findByIds()`, `findPage()`, `findAndCount()`, `count()`, `distinct()`, `aggregate()`, `stream()`, and `explain()`. Pass `withDeleted: true` to include deleted documents or `onlyDeleted: true` to query only deleted documents.

For aggregation, monSQLize prepends a soft-delete `$match` stage before the user pipeline, or after `$geoNear` when that stage is first. Soft-delete filtering inside user-authored `$lookup` pipelines remains the application's responsibility.

## Caching and Performance

monSQLize can cache collection queries and coordinate local/Redis-backed invalidation for database runtime usage.

```js
const users = msq.collection('users');

const hotUser = await users.findOne(
  { email: 'john@example.com' },
  { cache: 60_000 }
);
```

Cache capabilities include:

- In-memory L1 cache.
- Optional Redis-backed L2 cache.
- Automatic invalidation after writes.
- Cache namespace, TTL, and distributed invalidation controls.

## Advanced Capabilities

### Transactions

```js
await msq.withTransaction(async (tx) => {
  await msq.collection('orders').insertOne({ userId, status: 'pending' }, { session: tx.session });
  await msq.collection('users').updateOne(
    { _id: userId },
    { $inc: { orderCount: 1 } },
    { session: tx.session }
  );
});
```

Read options such as `session`, `readConcern`, `readPreference`, `collation`, `hint`, `maxTimeMS`, and `allowDiskUse` are forwarded to the MongoDB driver. Query caches are bypassed while a `session` is present, so transaction reads use the driver snapshot instead of a shared cache entry.

Transaction cache invalidations are recorded during the transaction and flushed only after a successful commit. If the transaction aborts, pending invalidations are discarded.

### Connection Pools

```js
const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'main',
  config: { uri: 'mongodb://primary:27017' },
  pools: [
    { name: 'analytics', uri: 'mongodb://analytics:27017' }
  ]
});

const reports = msq.pool('analytics').collection('reports');
```

### Change Streams

```js
const watcher = msq.collection('orders').watch([
  { $match: { 'fullDocument.status': 'pending' } }
]);

watcher.on('change', (change) => {
  console.log('Order changed:', change.fullDocument);
});
```

## Migration from the MongoDB Driver

The smallest migration is usually to replace only initialization:

```js
const { MongoClient } = require('mongodb');

const nativeClient = await MongoClient.connect('mongodb://localhost:27017');
const nativeUsers = nativeClient.db('mydb').collection('users');
```

```js
const MonSQLize = require('monsqlize');

const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'mydb',
  config: { uri: 'mongodb://localhost:27017' },
  cache: { enabled: true }
});

await msq.connect();
const users = msq.collection('users');
```

MongoDB-style collection calls can remain unchanged in most cases:

```js
const user = await users.findOne({ email });
const list = await users.find({ status: 'active' }).toArray();
```

The v3 line has been validated against the workspace consumers `chat`, `payment`, `user`, `admin`, `search`, `vext`, and `permission-core` without requiring business-source changes in those projects.

## Compatibility

| Surface | Current Support |
|---|---|
| Node.js | `>=18.0.0`; CI covers Node 18 / 20 / 22. |
| MongoDB driver | `mongodb@6.21.0` runtime baseline; driver 7.5.0 has additional compatibility coverage. |
| MongoDB server | Memory-server based 7.x / 8.x validation is covered by the strict project test matrix. |
| Module systems | CommonJS and ESM are both validated. |
| TypeScript | Public declarations are published from `dist/types/index.d.ts`. |
| Package license | Apache-2.0. |

See the current support and verification documents:

- [English documentation](https://github.com/devcodex-labs/monSQLize/blob/main/docs/en/README.md)
- [Chinese documentation](https://github.com/devcodex-labs/monSQLize/blob/main/docs/zh/README.md)
- [English common scenarios](https://github.com/devcodex-labs/monSQLize/blob/main/docs/en/recipes.md)
- [Support matrix](https://github.com/devcodex-labs/monSQLize/blob/main/docs/en/support-matrix.md)
- [test/compatibility/README.md](https://github.com/devcodex-labs/monSQLize/blob/main/test/compatibility/README.md)
- [test/validation/VERIFICATION-PROGRESS.md](https://github.com/devcodex-labs/monSQLize/blob/main/test/validation/VERIFICATION-PROGRESS.md)

## Documentation

Current TypeScript documentation and examples are the source of truth for the v3 package:

- Complete docs: [English](https://devcodex-labs.github.io/monSQLize/) · [简体中文](https://devcodex-labs.github.io/monSQLize/zh/)
- Constructor configuration: [English](https://devcodex-labs.github.io/monSQLize/configuration) · [简体中文](https://devcodex-labs.github.io/monSQLize/zh/configuration)
- Production rollout: [English](https://devcodex-labs.github.io/monSQLize/production-rollout) · [简体中文](https://devcodex-labs.github.io/monSQLize/zh/production-rollout)
- Production data migration: [English](https://devcodex-labs.github.io/monSQLize/production-data-migration) · [简体中文](https://devcodex-labs.github.io/monSQLize/zh/production-data-migration)
- Data tasks API: [English](https://devcodex-labs.github.io/monSQLize/data-tasks) · [简体中文](https://devcodex-labs.github.io/monSQLize/zh/data-tasks)
- Common scenarios: [English](https://devcodex-labs.github.io/monSQLize/recipes) · [简体中文](https://devcodex-labs.github.io/monSQLize/zh/recipes)
- Example source: [examples index](https://github.com/devcodex-labs/monSQLize/blob/main/examples/README.md)
- Documentation source: [docs/en](https://github.com/devcodex-labs/monSQLize/tree/main/docs/en) · [docs/zh](https://github.com/devcodex-labs/monSQLize/tree/main/docs/zh)
- Compatibility checks: [test/compatibility](https://github.com/devcodex-labs/monSQLize/tree/main/test/compatibility)
- Verification mapping: [test/validation](https://github.com/devcodex-labs/monSQLize/tree/main/test/validation)

Historical v1 and v2 assets are useful for tracing old behavior, but they are not the current publishing surface for v3.

## Development

```bash
git clone https://github.com/devcodex-labs/monSQLize.git
cd monSQLize
npm install
```

Common commands:

```bash
npm run build
npm run type-check
npm test
npm run verify:fast
npm run verify:full
npm run release:preflight
```

The package self-check command runs linting, documentation/type/size/runtime/compatibility/refactor guards, the default test suite, 90% source coverage, all runnable examples, the MongoDB server matrix, real dataTasks and CLI integration, production dependency audit, a temporary package-install smoke, and a final `npm pack --dry-run`.

`npm run release:publish` runs the package self-check once and then calls `npm publish --ignore-scripts` so the final publish step does not repeat the full lifecycle check. Raw `npm publish` is still guarded by `prepublishOnly`.

Optional commands:

```bash
npm run check:docs-examples
npm run test:examples
npm run test:coverage
npm run test:audit
npm run test:server-matrix
npm run test:data-tasks:integration
npm run test:data-task-cli
npm run test:pack-install
npm run test:real-env:private
```

`check:docs-examples` verifies the bilingual documentation matrix, runnable-example runner parity, shared-example targets, doc-check targets, and user-facing path text.

`test:examples`, `test:server-matrix`, and `config.useMemoryServer` use a fixed `mongodb-memory-server` policy: MongoDB `7.0.37` by default, binaries cached under `.cache/mongodb-memory-server/binaries`, and temporary data paths created under `.cache/mongodb-memory-server/db` with forced cleanup for project-managed paths. The release matrix strictly requires MongoDB `7.0.37` and `8.0.26`; a missing binary, failed probe, or failed combination exits nonzero. Stale managed data paths whose owner PID is no longer alive are pruned before new memory-server launches. Override with `MONSQLIZE_MEMORY_MONGO_BINARY_VERSION`, `MONSQLIZE_REPLSET_BINARY_VERSION`, `MONGOMS_DOWNLOAD_DIR`, or `MONSQLIZE_MEMORY_SERVER_DB_DIR` when needed.

`test:coverage` remains an independently runnable 90% governance command for the published CJS runtime plus source-level gap coverage resolved through sourcemaps, and the single-source release preflight requires it. Public CI runs that same preflight in its release-gate job. `test:audit` checks production dependencies against the npm registry. Only `test:real-env:private` remains opt-in because it expects private environment variables.

## Roadmap

- MongoDB remains the stable adapter and the current production runtime.
- MySQL and PostgreSQL adapters will be introduced as database-native adapters under the same production runtime contract.
- Adapter status will move from planned to alpha/stable only after runtime support, public types, examples, and verification coverage are present.
- The project does not currently promise production-ready "one query syntax automatically adapts to every database" behavior.
- Query analyzer improvements.
- Automatic index suggestions.
- Additional data-task observability and large-scope operational probes.
- GraphQL integration experiments.
- More real-environment validation coverage.

## License

monSQLize is released under the [Apache License 2.0](./LICENSE).

## Support

- Issues: [GitHub Issues](https://github.com/devcodex-labs/monSQLize/issues)
- npm: [monsqlize](https://www.npmjs.com/package/monsqlize)
- Website: [https://devcodex-labs.github.io/monSQLize/](https://devcodex-labs.github.io/monSQLize/)
