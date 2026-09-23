# Configuration Reference

This page is the public reference for `new MonSQLize(options)`. It focuses on the constructor configuration surface. Method-level options such as `find(..., { cache, maxTimeMS })` are documented on the corresponding method pages.

Use this page when you want to answer:

- What is the smallest valid constructor config?
- Which fields can be set globally?
- How should MongoDB, cache, Redis, Model, sync, pools, logging, and pagination be configured together?
- Which values are defaults and which values are validated at runtime?

## Minimal configuration

```ts
import MonSQLize from 'monsqlize';

const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'app',
  config: {
    uri: 'mongodb://127.0.0.1:27017'
  }
});

await msq.connect();

const users = msq.collection('users');
const list = await users.find({ status: 'active' }).toArray();

await msq.close();
```

`type: 'mongodb'` is required by the current runtime. `databaseName` is recommended for clarity; if omitted, the runtime falls back to `database`, then to `default`.

## Production-shaped example

```ts
import MonSQLize from 'monsqlize';
import Redis from 'ioredis';

const redis = new Redis('redis://127.0.0.1:6379/0');

const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'shop',
  config: {
    uri: 'mongodb://mongo.internal:27017/shop',
    options: {
      maxPoolSize: 20,
      minPoolSize: 2,
      serverSelectionTimeoutMS: 5000
    }
  },

  maxTimeMS: 3000,
  findLimit: 500,
  findMaxLimit: 10000,
  findMaxSkip: 50000,
  findPageMaxLimit: 500,
  slowQueryMs: 500,

  cursorSecret: 'replace-with-a-stable-secret',
  requireCursorSecret: true,

  cache: {
    memory: {
      maxEntries: 100000,
      defaultTtl: 60000,
      enableStats: true
    },
    redis: {
      redis,
      timeoutMs: 300,
      prefix: 'shop:'
    },
    distributed: {
      redis,
      channel: 'shop:cache:invalidate',
      instanceId: 'api-1'
    },
    autoInvalidate: false
  },

  logger: console,

  slowQueryLog: {
    enabled: true,
    storage: {
      type: 'mongodb',
      useBusinessConnection: true,
      database: 'ops',
      collection: 'slow_queries',
      ttl: 7 * 24 * 3600
    }
  },

  models: {
    path: './models',
    pattern: '*.model.{js,mjs,cjs}',
    recursive: false
  },
  autoIndex: false,

  writePathPolicy: {
    default: 'allow-both'
  }
});
```

The Redis cache adapter and distributed invalidator can share the same Redis URL. They are separate runtime concerns: L2 cache stores query results, while `cache.distributed` opens Pub/Sub for cross-instance invalidation.

## Top-level options

| Option | Type | Default | Description |
|---|---|---|---|
| `type` | `'mongodb'` | none | Required by the current runtime. |
| `databaseName` | `string` | `'default'` after alias fallback | Default database name. |
| `database` | `string` | none | Alias that takes priority over `databaseName`. |
| `config` | `MongoConnectConfig` | none | MongoDB connection config. |
| `cache` | `MemoryCache`, `CacheLike`, `MultiLevelCacheOptions`, or plain cache config | memory cache | Runtime query-cache backend. |
| `cache.autoInvalidate` | `boolean` | `false` | Broadly invalidate collection read caches after successful monSQLize writes; disabled by default. |
| `logger` | `LoggerLike \| null` | `null` | Custom logger. Must expose `debug`, `info`, `warn`, and `error`. |
| `schemaDsl` | `false \| SchemaDslRuntimeConfig` | isolated runtime | Model schema-dsl runtime integration. |
| `models` | `string \| { path, pattern?, recursive? }` | none | Auto-load Model definition files on connect. |
| `autoIndex` | `boolean \| object` | `true` | Controls automatic Model index creation. |
| `writePathPolicy` | `WritePathPolicyOptions` | `allow-both` | Optional policy for collection-vs-Model writes. |
| `pools` | `PoolConfig[]` | none | Additional MongoDB connection pools. |
| `poolStrategy` | `PoolStrategy` | manager default | Pool selection strategy. |
| `poolFallback` | `boolean \| object` | manager default | Pool fallback behavior. |
| `maxPoolsCount` | `number` | manager default | Maximum number of configured pools. |
| `transaction` | `object` | manager defaults | Global transaction defaults and statistics settings. |
| `sync` | `SyncConfig` | disabled | Change Stream fan-out sync configuration. |
| `slowQueryLog` | `boolean \| Partial<SlowQueryLogConfig>` | disabled | Persistent slow-query log storage. |
| `maxTimeMS` | `number` | `2000` | Global query timeout in milliseconds. |
| `findLimit` | `number` | `500` | Default `find()` limit when the caller does not set one. |
| `findMaxLimit` | `number` | `10000` | Maximum explicit `find().limit(n)` value. `limit(0)` keeps MongoDB unlimited semantics. |
| `findMaxSkip` | `number` | `50000` | Maximum explicit `find().skip(n)` and `offsetJump.maxSkip`. |
| `findPageMaxLimit` | `number` | `500` | Maximum `findPage()` limit. Requests above this cap are clamped. |
| `slowQueryMs` | `number` | `500` | Threshold used by slow-query detection and slow-query log defaults. |
| `namespace` | `{ scope?, instanceId? }` | `{ scope: 'database' }` | Cache namespace isolation. |
| `cursorSecret` | `string` | none | HMAC secret for `findPage()` cursor tokens. |
| `requireCursorSecret` | `boolean` | `false` | Reject `findPage()` until `cursorSecret` is configured. |
| `cursorSecretWarning` | `'off' \| 'production' \| 'always'` | `'production'` | Controls startup warning when `cursorSecret` is missing. |
| `cursorTypes` | `Record<string, CursorValueType>` | none | Field type hints for decoded cursor values. |
| `cursorValueNormalizer` | `CursorValueNormalizer` | none | Custom decoded cursor value normalizer. |
| `log.slowQueryTag` | `{ event?, code? }` | `{ event: 'slow_query', code: 'SLOW_QUERY' }` | Slow-query event tag fields. |
| `log.formatSlowQuery` | `(meta) => unknown` | none | Custom formatter for slow-query event metadata. |
| `autoConvertObjectId` | `boolean \| object \| field map` | `true` for MongoDB | Auto-convert valid 24-character hex strings to `ObjectId`. |
| `countQueue` | `boolean \| object` | enabled | Batches count operations under concurrency pressure. |

## Mongo connection config

`config` is passed to the MongoDB adapter and optional SSH/memory-server setup.

| Option | Type | Description |
|---|---|---|
| `config.uri` | `string` | MongoDB connection URI. Required unless `useMemoryServer` is true. |
| `config.options` | `MongoClientOptions` | Driver options such as `maxPoolSize`, `serverSelectionTimeoutMS`, and read/write concerns. |
| `config.readPreference` | MongoDB read preference | Shortcut merged into MongoDB client options. |
| `config.useMemoryServer` | `boolean` | Starts `mongodb-memory-server` automatically for tests. |
| `config.memoryServerOptions` | `object` | Memory-server `instance` and `binary` options. |
| `config.ssh` | `SSHConfig` | Bastion tunnel config. |
| `config.remoteHost` / `config.remotePort` | `string` / `number` | Remote MongoDB host and port visible from the SSH server. |
| `config.mongoHost` / `config.mongoPort` | `string` / `number` | Aliases for `remoteHost` / `remotePort`. |

```ts
const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'private_app',
  config: {
    uri: 'mongodb://mongo.internal:27017/private_app',
    ssh: {
      host: 'bastion.example.com',
      port: 22,
      username: 'deploy',
      privateKeyPath: '~/.ssh/id_rsa'
    },
    remoteHost: 'mongo.internal',
    remotePort: 27017
  }
});
```

## Cache config

Query caching is opt-in per query. A global cache backend only controls where cached query results are stored once a query asks for caching with `cache: <ttlMs>`.

Use `cache: 0` on a query to disable that query's cache. Use `cache: { enabled: false }` when you need the constructor-level cache backend to be disabled. Do not pass a boolean as the constructor cache config.

### Memory cache

```ts
const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'shop',
  config: { uri: 'mongodb://127.0.0.1:27017' },
  cache: {
    maxEntries: 100000,
    maxMemory: 0,
    defaultTtl: 60000,
    enableStats: true,
    enableTags: false,
    cleanupInterval: 60000
  }
});
```

| Option | Description |
|---|---|
| `cache.maxEntries` | Maximum entry count. |
| `cache.maxMemory` | Maximum memory in bytes. `0` means unlimited. |
| `cache.defaultTtl` | Default TTL in milliseconds when a set operation does not pass TTL. |
| `cache.enableStats` | Enables hit/miss/eviction stats. |
| `cache.enableTags` | Enables tag-based invalidation when the cache backend supports it. |
| `cache.cleanupInterval` | Periodic TTL cleanup interval in milliseconds. |
| `cache.enabled` | Set to `false` to disable this cache backend. |

### Redis-backed cache

```ts
const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'shop',
  config: { uri: 'mongodb://127.0.0.1:27017' },
  cache: MonSQLize.createRedisCacheAdapter('redis://127.0.0.1:6379/0')
});
```

For a local + Redis two-level cache, prefer the declarative `memory` + `redis` shape:

```ts
const redisUrl = 'redis://127.0.0.1:6379/0';

const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'shop',
  config: { uri: 'mongodb://127.0.0.1:27017' },
  cache: {
    memory: { maxEntries: 10000, defaultTtl: 60000 },
    redis: { url: redisUrl, timeoutMs: 300, prefix: 'shop:' },
    policy: {
      writePolicy: 'both',
      backfillLocalOnRemoteHit: true
    }
  }
});
```

### Distributed invalidation

`cache.distributed` enables Redis Pub/Sub invalidation messages between monSQLize instances. It does not automatically infer a Pub/Sub connection from the L2 cache; configure `redisUrl`, `url`, `uri`, or an existing Redis-like `redis` instance explicitly. The same Redis instance can be used for both L2 cache and distributed invalidation.

```ts
import Redis from 'ioredis';

const redis = new Redis('redis://127.0.0.1:6379/0');

const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'shop',
  config: { uri: 'mongodb://127.0.0.1:27017' },
  cache: {
    memory: { maxEntries: 10000 },
    redis: { redis },
    distributed: {
      redis,
      channel: 'shop:cache:invalidate',
      instanceId: 'api-1',
      enabled: true
    }
  }
});
```

Cache invalidation is best-effort and eventually coherent across instances. MongoDB writes are not rolled back if cache invalidation or distributed publishing fails after the write.

| `cache.distributed` option | Type | Default | Description |
|---|---|---|---|
| `enabled` | `boolean` | `true` when the block is present | Set to `false` to keep the object shape while disabling Pub/Sub. |
| `redis` | Redis-like instance | none | Existing Redis client used for publish/subscribe. Can be the same instance as the L2 cache. |
| `redisUrl` | `string` | none | Redis URL used when monSQLize creates the Pub/Sub client. |
| `url` / `uri` | `string` | none | Aliases for `redisUrl`. |
| `channel` | `string` | `monsqlize:cache:invalidate` | Pub/Sub channel shared by all instances that should receive invalidation messages. |
| `instanceId` | `string` | generated value | Instance identifier used to ignore messages published by the same runtime. |

## Logger config

Pass `console`, `null`, or a logger object with all four log-level methods. Objects such as `{ level: 'debug' }` are ignored because they do not satisfy the logger interface.

```ts
const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'shop',
  config: { uri: 'mongodb://127.0.0.1:27017' },
  logger: {
    debug: (...args) => console.debug(...args),
    info: (...args) => console.info(...args),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args)
  }
});
```

## Model and schema-dsl config

The Model layer uses an isolated `schema-dsl/runtime` by default. Configure `schemaDsl` only when you need to inject an existing runtime, register extensions, pass runtime options, or disable schema-dsl validation.

```ts
import { createRuntime } from 'schema-dsl/runtime';

const schemaRuntime = createRuntime({
  messages: {
    required: 'Required field'
  }
});

const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'shop',
  config: { uri: 'mongodb://127.0.0.1:27017' },
  schemaDsl: {
    runtime: schemaRuntime
  }
});
```

| Option | Type | Default | Description |
|---|---|---|---|
| `schemaDsl` | `false \| object` | isolated runtime | Omit it for the default isolated runtime; set to `false` only when Model schema validation is intentionally disabled. |
| `schemaDsl.enabled` | `boolean` | `true` | Set to `false` to disable validation while keeping the object shape. |
| `schemaDsl.runtime` | schema-dsl runtime | none | Existing runtime. monSQLize uses it but does not dispose it on `close()`. |
| `schemaDsl.options` | `SchemaDslRuntimeOptions` | none | Options passed when monSQLize creates the runtime. |
| `schemaDsl.extensions` | `unknown[]` | none | Extension definitions registered before Model schema compilation. |
| `models` | `string \| object` | none | File path or `{ path, pattern, recursive }` for auto-loading Model definitions. |
| `autoIndex` | `boolean \| object` | `true` | Global automatic Model index creation control. Model-level `options.autoIndex` overrides this value. |

| `autoIndex` form | Effect |
|---|---|
| `true` | Schedule declared Model indexes when the Model instance is created. The task preflights with `listIndexes()` before creating missing indexes. |
| `false` | Do not schedule automatic Model index creation. You can still call `ensureIndexes()` explicitly. |
| `{ enabled: boolean }` | Object form for toggling automatic index creation. |
| `{ emitEvents: boolean }` | Emits `model-index-error` when automatic index creation fails or conflicts are detected. |

Automatic index creation preflights declared indexes, skips existing indexes, and creates only missing indexes. It does not drop, rename, or rebuild conflicting indexes; use `ensureIndexes({ dryRun: true })` or `ensureModelIndexes({ dryRun: true })` as an explicit production release gate before changing production indexes.

## Namespace config

Use `namespace` when several monSQLize instances share one cache backend and their cache keys must remain isolated.

| Option | Type | Default | Description |
|---|---|---|---|
| `namespace.scope` | `'database' \| 'connection'` | `'database'` | Controls the namespace boundary used by runtime cache keys. |
| `namespace.instanceId` | `string` | none | Prefixes query-cache keys and invalidation patterns for one runtime instance. Use this when multiple apps share the same Redis/cache backend. |

## Write path policy

By default, both collection and Model writes are available. Use `model-only` when selected namespaces must pass through Model hooks, defaults, timestamps, versioning, and soft-delete behavior.

```ts
const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'shop',
  config: { uri: 'mongodb://127.0.0.1:27017' },
  writePathPolicy: {
    default: 'model-only',
    namespaces: {
      'shop.audit_logs': 'allow-both'
    }
  }
});
```

See [Write Path Policy](./write-path-policy.md).

## Pool config

Configure pools in the constructor when your service needs named database connections.

```ts
const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'main',
  config: { uri: 'mongodb://primary:27017/main' },
  pools: [
    {
      name: 'analytics',
      uri: 'mongodb://analytics:27017/main',
      role: 'analytics',
      tags: ['reporting'],
      options: { maxPoolSize: 5 }
    }
  ],
  poolStrategy: 'auto',
  poolFallback: { enabled: true, fallbackStrategy: 'primary' },
  maxPoolsCount: 5
});

const reports = msq.pool('analytics').collection('reports');
```

See [Pool Configuration](./multi-pool.md).

## Sync config

`sync` wires a Change Stream fan-out manager. The runtime provides at-least-once delivery; targets should be idempotent. Use `sync.idempotency` to reduce duplicate target side effects.

```ts
const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'main',
  config: { uri: 'mongodb://primary:27017/main?replicaSet=rs0' },
  sync: {
    enabled: true,
    collections: ['orders'],
    targets: [
      {
        name: 'backup',
        uri: 'mongodb://backup:27017',
        databaseName: 'backup',
        collections: ['orders']
      }
    ],
    resumeToken: {
      storage: 'file',
      path: './.sync-resume-token',
      strictLoad: true,
      strictSave: true,
      saveRetries: 2,
      saveRetryDelayMs: 100
    },
    idempotency: {
      enabled: true,
      keyPrefix: 'monsqlize:sync:idempotency',
      ttl: 24 * 3600 * 1000,
      markMode: 'success'
    }
  }
});
```

See [Change Stream Sync](./sync-backup.md).

## Slow query logging

Use `slowQueryMs` for the runtime threshold and `slowQueryLog` when you want persistent aggregation of slow-query records.

```ts
const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'shop',
  config: { uri: 'mongodb://127.0.0.1:27017' },
  slowQueryMs: 500,
  log: {
    slowQueryTag: { event: 'slow_query', code: 'SLOW_QUERY' },
    formatSlowQuery: (meta) => meta
  },
  slowQueryLog: {
    enabled: true,
    storage: {
      type: 'mongodb',
      useBusinessConnection: true,
      database: 'ops',
      collection: 'slow_queries',
      ttl: 7 * 24 * 3600
    },
    filter: {
      minExecutionTimeMs: 1000,
      excludeCollections: ['healthchecks']
    }
  }
});
```

See [Slow Query Logging](./slow-query-log.md).

## Transaction config

```ts
const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'shop',
  config: { uri: 'mongodb://127.0.0.1:27017/shop?replicaSet=rs0' },
  transaction: {
    enableRetry: true,
    maxRetries: 3,
    retryDelay: 100,
    retryBackoff: 2,
    defaultTimeout: 30000,
    lockMaxDuration: 30000,
    lockCleanupInterval: 60000
  }
});
```

Transaction cache locks are process-local. For cross-instance critical sections, use application-level idempotency/fencing or an explicit business lock.

| `transaction` option | Type | Default | Description |
|---|---|---|---|
| `enableRetry` | `boolean` | manager default | Enables transaction retry for retryable failures. |
| `maxRetries` | `number` | manager default | Maximum retry attempts. |
| `retryDelay` | `number` | manager default | Initial retry delay in milliseconds. |
| `retryBackoff` | `number` | manager default | Backoff multiplier between retries. |
| `defaultTimeout` / `maxDuration` | `number` | manager default | Transaction timeout in milliseconds. |
| `defaultReadConcern` | MongoDB read concern | none | Default read concern passed to transaction options. |
| `defaultWriteConcern` | MongoDB write concern | none | Default write concern passed to transaction options. |
| `defaultReadPreference` | MongoDB read preference | none | Default read preference passed to transaction options. |
| `lockMaxDuration` | `number` | `30000` in the cache-lock manager | Process-local transaction cache-lock duration in milliseconds. |
| `lockCleanupInterval` | `number` | `60000` in the cache-lock manager | Process-local cache-lock cleanup interval in milliseconds. |
| `maxStatsSamples` | `number` | manager default | Maximum retained transaction statistics samples. |
| `distributedLock` | `object` | none | Compatibility placeholder. It does not enable distributed transaction cache locks in the current v3 runtime. |

## Count queue config

`countQueue` is a process-local cooperative queue for count-heavy paths such as paginated totals.

| Option | Type | Default | Description |
|---|---|---|---|
| `countQueue` | `boolean \| object` | enabled | Set to `false` to bypass the queue. `true` uses defaults. |
| `countQueue.enabled` | `boolean` | `true` | Enables the queue when using object form. |
| `countQueue.concurrency` | `number` | implementation default | Maximum concurrent count runners in this process. |
| `countQueue.maxQueueSize` | `number` | implementation default | Maximum pending count jobs before new jobs are rejected. |
| `countQueue.timeout` | `number` | implementation default | Queue wait timeout in milliseconds. It does not forcibly cancel an already running MongoDB operation. |

Collection `countDocuments` passes the caller's `signal` to the count queue. A pre-aborted signal rejects before a cached result is returned; aborting a queued job removes it, while aborting a running job rejects the caller and forwards the signal to MongoDB. Queue timeout and caller cancellation remain separate.

## Runtime validation

These constructor options are validated when the instance is created:

| Option | Minimum | Maximum |
|---|---:|---:|
| `maxTimeMS` | 1 | 300000 |
| `findLimit` | 1 | 10000 |
| `findMaxLimit` | 1 | 100000 |
| `findMaxSkip` | 0 | 10000000 |
| `findPageMaxLimit` | 1 | 10000 |

`findLimit` must also be less than or equal to `findMaxLimit`.

## Configuration priority

For options that exist at both instance and method level, method-level options win.

```ts
const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'shop',
  config: { uri: 'mongodb://127.0.0.1:27017' },
  maxTimeMS: 3000
});

await msq.connect();

const users = msq.collection('users');

await users.find({}, { maxTimeMS: 5000 }); // Uses 5000.
await users.find({});                      // Uses 3000.
```

## Common mistakes

| Mistake | Use instead |
|---|---|
| Passing a boolean as constructor cache config | `cache: { enabled: false }` or query-level `{ cache: 0 }` |
| Selecting Redis through a cache type string and host/port object | `MonSQLize.createRedisCacheAdapter(redisUrl)` or `cache.redis.url` |
| Passing only a logger level | `logger: console` or a logger with `debug/info/warn/error` |
| Relying on the L2 cache field to create Pub/Sub | Add `cache.distributed.redisUrl`, or pass the same instance as `cache.distributed.redis` |
| Omitting `type` | Set `type: 'mongodb'` |

## Related pages

- [Installation](./getting-started.md)
- [Connection Management](./connection.md)
- [Cache API](./cache.md)
- [Pool Configuration](./multi-pool.md)
- [Model Overview](./model.md)
- [Write Path Policy](./write-path-policy.md)
- [Change Stream Sync](./sync-backup.md)
- [Slow Query Logging](./slow-query-log.md)
