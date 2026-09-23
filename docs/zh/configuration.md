# 完整配置参考

本页是 `new MonSQLize(options)` 的公开配置参考，只说明构造函数配置。`find(..., { cache, maxTimeMS })` 这类方法级选项放在对应 API 文档中说明。

当你需要确认下面这些问题时，优先看本页：

- 最小可用配置怎么写？
- 哪些字段可以全局配置？
- MongoDB、缓存、Redis、Model、同步、连接池、日志、分页应该如何组合？
- 哪些是默认值，哪些会在运行时校验？

## 最小配置

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

当前 runtime 要求显式传入 `type: 'mongodb'`。`databaseName` 建议显式配置；如果省略，runtime 会按 `database`、`databaseName`、`default` 的顺序解析默认数据库名。

## 生产配置示例

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

Redis 二级缓存和分布式失效可以共用同一个 Redis URL。二者职责不同：二级缓存存储查询结果，`cache.distributed` 使用 Pub/Sub 做跨实例失效广播。

## 顶层配置项

| 配置项 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `type` | `'mongodb'` | 无 | 当前 runtime 必填。 |
| `databaseName` | `string` | alias fallback 后为 `'default'` | 默认数据库名。 |
| `database` | `string` | 无 | `databaseName` 的 alias，优先级高于 `databaseName`。 |
| `config` | `MongoConnectConfig` | 无 | MongoDB 连接配置。 |
| `cache` | `MemoryCache`、`CacheLike`、`MultiLevelCacheOptions` 或普通 cache config | memory cache | 查询缓存后端。 |
| `cache.autoInvalidate` | `boolean` | `false` | monSQLize 写入成功后 broad 失效集合读缓存；默认关闭。 |
| `logger` | `LoggerLike \| null` | `null` | 自定义 logger，必须暴露 `debug`、`info`、`warn`、`error`。 |
| `schemaDsl` | `false \| SchemaDslRuntimeConfig` | 隔离 runtime | Model schema-dsl runtime 接入配置。 |
| `models` | `string \| { path, pattern?, recursive? }` | 无 | 连接时自动加载 Model 定义文件。 |
| `autoIndex` | `boolean \| object` | `true` | 控制 Model 自动创建索引。 |
| `writePathPolicy` | `WritePathPolicyOptions` | `allow-both` | collection 与 Model 写路径策略。 |
| `pools` | `PoolConfig[]` | 无 | 额外 MongoDB 连接池。 |
| `poolStrategy` | `PoolStrategy` | manager 默认值 | 连接池选择策略。 |
| `poolFallback` | `boolean \| object` | manager 默认值 | 连接池失败后的 fallback 行为。 |
| `maxPoolsCount` | `number` | manager 默认值 | 最大连接池数量。 |
| `transaction` | `object` | manager 默认值 | 全局事务默认值与统计配置。 |
| `sync` | `SyncConfig` | disabled | Change Stream 同步配置。 |
| `slowQueryLog` | `boolean \| Partial<SlowQueryLogConfig>` | disabled | 慢查询日志持久化配置。 |
| `maxTimeMS` | `number` | `2000` | 全局查询超时时间，单位毫秒。 |
| `findLimit` | `number` | `500` | 调用方未指定时的 `find()` 默认 limit。 |
| `findMaxLimit` | `number` | `10000` | 显式 `find().limit(n)` 上限；`limit(0)` 保留 MongoDB 无限制语义。 |
| `findMaxSkip` | `number` | `50000` | 显式 `find().skip(n)` 与 `offsetJump.maxSkip` 上限。 |
| `findPageMaxLimit` | `number` | `500` | `findPage()` 最大 limit，超过后会被钳制。 |
| `slowQueryMs` | `number` | `500` | 慢查询检测与慢查询日志默认阈值。 |
| `namespace` | `{ scope?, instanceId? }` | `{ scope: 'database' }` | 缓存命名空间隔离配置。 |
| `cursorSecret` | `string` | 无 | `findPage()` 游标 token 的 HMAC 密钥。 |
| `requireCursorSecret` | `boolean` | `false` | 要求配置 `cursorSecret` 后才能使用 `findPage()`。 |
| `cursorSecretWarning` | `'off' \| 'production' \| 'always'` | `'production'` | 未配置 `cursorSecret` 时的启动告警策略。 |
| `cursorTypes` | `Record<string, CursorValueType>` | 无 | 解码游标值时的字段类型提示。 |
| `cursorValueNormalizer` | `CursorValueNormalizer` | 无 | 自定义游标值归一化函数。 |
| `log.slowQueryTag` | `{ event?, code? }` | `{ event: 'slow_query', code: 'SLOW_QUERY' }` | 慢查询事件 tag 字段。 |
| `log.formatSlowQuery` | `(meta) => unknown` | 无 | 慢查询事件 metadata 格式化函数。 |
| `autoConvertObjectId` | `boolean \| object \| field map` | MongoDB 下为 `true` | 自动把合法 24 位 hex 字符串转换为 `ObjectId`。 |
| `countQueue` | `boolean \| object` | enabled | 高并发下批处理 count 操作。 |

## Mongo 连接配置

`config` 会传给 MongoDB adapter，并参与可选 SSH / memory-server 初始化。

| 配置项 | 类型 | 说明 |
|---|---|---|
| `config.uri` | `string` | MongoDB 连接 URI。除非使用 `useMemoryServer`，否则需要配置。 |
| `config.options` | `MongoClientOptions` | MongoDB driver 选项，例如 `maxPoolSize`、`serverSelectionTimeoutMS`、读写关注。 |
| `config.readPreference` | MongoDB read preference | 会合并到 MongoDB client options。 |
| `config.useMemoryServer` | `boolean` | 测试时自动启动 `mongodb-memory-server`。 |
| `config.memoryServerOptions` | `object` | memory-server 的 `instance` 与 `binary` 配置。 |
| `config.ssh` | `SSHConfig` | 堡垒机隧道配置。 |
| `config.remoteHost` / `config.remotePort` | `string` / `number` | SSH 服务器视角下的 MongoDB host / port。 |
| `config.mongoHost` / `config.mongoPort` | `string` / `number` | `remoteHost` / `remotePort` 的 alias。 |

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

## 缓存配置

查询缓存是按查询启用的。全局 cache 只决定“某个查询要求缓存时，缓存结果存在哪里”。

在单次查询上使用 `cache: 0` 可禁用该查询缓存。构造函数层面如需禁用 cache backend，使用 `cache: { enabled: false }`。不要把 boolean 作为构造函数 cache 配置传入。

### 内存缓存

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

| 配置项 | 说明 |
|---|---|
| `cache.maxEntries` | 最大缓存条目数。 |
| `cache.maxMemory` | 最大内存字节数，`0` 表示不限制。 |
| `cache.defaultTtl` | set 操作未传 TTL 时使用的默认 TTL，单位毫秒。 |
| `cache.enableStats` | 开启命中、未命中、淘汰等统计。 |
| `cache.enableTags` | 当 cache backend 支持时，开启 tag 失效。 |
| `cache.cleanupInterval` | TTL 清理周期，单位毫秒。 |
| `cache.enabled` | 设为 `false` 时禁用该 cache backend。 |

### Redis 二级缓存

```ts
const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'shop',
  config: { uri: 'mongodb://127.0.0.1:27017' },
  cache: MonSQLize.createRedisCacheAdapter('redis://127.0.0.1:6379/0')
});
```

本地 + Redis 双层缓存推荐使用 `memory` + `redis` 声明式写法：

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

### 分布式缓存失效

`cache.distributed` 开启 Redis Pub/Sub 失效广播。runtime 不会自动从二级缓存推断 Pub/Sub 连接；需要显式配置 `redisUrl`、`url`、`uri`，或传入已有 Redis-like `redis` 实例。已有 Redis 实例可以同时用于二级缓存和分布式失效。

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

缓存失效是 best-effort，跨实例最终收敛。MongoDB 写入成功后，如果后续缓存失效或分布式广播失败，runtime 不会回滚数据库写入。

| `cache.distributed` 配置 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | `boolean` | 配置对象存在时为 `true` | 保留对象结构但禁用 Pub/Sub 时设为 `false`。 |
| `redis` | Redis-like 实例 | 无 | 复用已有 Redis 客户端做发布/订阅，可与二级缓存共用。 |
| `redisUrl` | `string` | 无 | monSQLize 创建 Pub/Sub 客户端时使用的 Redis URL。 |
| `url` / `uri` | `string` | 无 | `redisUrl` 的 alias。 |
| `channel` | `string` | `monsqlize:cache:invalidate` | 所有需要接收失效消息的实例共用的 Pub/Sub channel。 |
| `instanceId` | `string` | 自动生成值 | 实例标识，用于忽略当前 runtime 自己发布的消息。 |

## Logger 配置

可以传 `console`、`null`，或暴露四个日志方法的对象。`{ level: 'debug' }` 这类对象不会生效，因为它不满足 logger 接口。

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

## Model 与 schema-dsl 配置

Model 层默认使用隔离的 `schema-dsl/runtime`。只有在需要注入已有 runtime、注册扩展、传入 runtime options 或显式关闭 schema-dsl 校验时，才需要配置 `schemaDsl`。

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

| 配置项 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `schemaDsl` | `false \| object` | 隔离 runtime | 默认使用隔离 runtime；只有明确关闭 Model schema 校验时才设为 `false`。 |
| `schemaDsl.enabled` | `boolean` | `true` | 使用对象形式时，可设为 `false` 禁用校验。 |
| `schemaDsl.runtime` | schema-dsl runtime | 无 | 注入已有 runtime，monSQLize 会使用它，但 `close()` 时不负责 dispose。 |
| `schemaDsl.options` | `SchemaDslRuntimeOptions` | 无 | monSQLize 自行创建 runtime 时传入的 options。 |
| `schemaDsl.extensions` | `unknown[]` | 无 | Model schema 编译前注册的扩展定义。 |
| `models` | `string \| object` | 无 | 自动加载 Model 定义文件，支持路径字符串或 `{ path, pattern, recursive }`。 |
| `autoIndex` | `boolean \| object` | `true` | 全局 Model 自动索引创建控制；Model 级 `options.autoIndex` 会覆盖它。 |

| `autoIndex` 写法 | 效果 |
|---|---|
| `true` | 创建 Model instance 时调度声明的 Model 索引；任务会先用 `listIndexes()` 预检，再创建缺失索引。 |
| `false` | 不自动调度索引创建；仍可显式调用 `ensureIndexes()`。 |
| `{ enabled: boolean }` | 对象形式的启停开关。 |
| `{ emitEvents: boolean }` | 自动索引创建失败或检测到冲突时触发 `model-index-error`。 |

自动索引会先预检声明索引，跳过 existing，只创建 missing，不会 drop、rename 或 rebuild 冲突索引。生产环境建议使用 `ensureIndexes({ dryRun: true })` 或 `ensureModelIndexes({ dryRun: true })` 作为显式发布门禁。

## 命名空间配置

多个 monSQLize 实例共用同一个缓存后端时，用 `namespace` 隔离缓存 key。

| 配置项 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `namespace.scope` | `'database' \| 'connection'` | `'database'` | 控制 runtime 缓存 key 使用的命名空间边界。 |
| `namespace.instanceId` | `string` | 无 | 给查询缓存 key 与失效 pattern 加实例前缀。多个应用共用 Redis/cache backend 时应配置。 |

## 写路径策略

默认情况下，collection 与 Model 写入都可用。如果某些命名空间必须经过 Model hooks、默认值、时间戳、版本与软删除规则，可以配置 `model-only`。

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

详见 [写路径策略](./write-path-policy.md)。

## 连接池配置

当服务需要具名数据库连接时，在构造函数中配置 `pools`。

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

详见 [连接池配置](./multi-pool.md)。

## 同步配置

`sync` 会接入 Change Stream fan-out manager。runtime 提供 at-least-once 语义，target 应保持幂等。可以用 `sync.idempotency` 减少重复 target 副作用。

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

详见 [Change Stream 同步](./sync-backup.md)。

## 慢查询日志

`slowQueryMs` 控制 runtime 阈值；需要持久化聚合慢查询记录时配置 `slowQueryLog`。

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

详见 [慢查询日志](./slow-query-log.md)。

## 事务配置

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

事务缓存锁是进程内锁。跨实例关键流程应使用应用层幂等/fencing 或显式业务锁。

| `transaction` 配置 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enableRetry` | `boolean` | manager 默认值 | 开启 retryable transaction 失败重试。 |
| `maxRetries` | `number` | manager 默认值 | 最大重试次数。 |
| `retryDelay` | `number` | manager 默认值 | 首次重试等待时间，单位毫秒。 |
| `retryBackoff` | `number` | manager 默认值 | 重试间隔退避倍数。 |
| `defaultTimeout` / `maxDuration` | `number` | manager 默认值 | 事务超时时间，单位毫秒。 |
| `defaultReadConcern` | MongoDB read concern | 无 | 默认传入 transaction options 的 read concern。 |
| `defaultWriteConcern` | MongoDB write concern | 无 | 默认传入 transaction options 的 write concern。 |
| `defaultReadPreference` | MongoDB read preference | 无 | 默认传入 transaction options 的 read preference。 |
| `lockMaxDuration` | `number` | cache-lock manager 中为 `30000` | 进程内事务缓存锁持续时间，单位毫秒。 |
| `lockCleanupInterval` | `number` | cache-lock manager 中为 `60000` | 进程内缓存锁清理间隔，单位毫秒。 |
| `maxStatsSamples` | `number` | manager 默认值 | 保留的事务统计样本上限。 |
| `distributedLock` | `object` | 无 | 兼容占位；当前 v3 运行时不会因此启用分布式事务缓存锁。 |

## CountQueue 配置

`countQueue` 是进程内协作式队列，主要用于分页 total 这类 count 压力路径。

| 配置项 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `countQueue` | `boolean \| object` | enabled | 设为 `false` 时绕过队列；`true` 使用默认值。 |
| `countQueue.enabled` | `boolean` | `true` | 对象形式下的启停开关。 |
| `countQueue.concurrency` | `number` | 实现默认值 | 当前进程内最多并发执行的 count runner 数。 |
| `countQueue.maxQueueSize` | `number` | 实现默认值 | 等待队列长度上限，超过后拒绝新任务。 |
| `countQueue.timeout` | `number` | 实现默认值 | 等待队列超时时间，单位毫秒；不会强制取消已经开始执行的 MongoDB 操作。 |

Collection `countDocuments` 会把调用方的 `signal` 传给 count 队列。预先取消的 signal 会在返回缓存结果前拒绝；取消等待中的任务会移出队列，取消运行中的任务会拒绝调用方并把 signal 传给 MongoDB。队列超时与调用方取消互相独立。

## 运行时校验

以下构造项会在实例创建时校验：

| 配置项 | 最小值 | 最大值 |
|---|---:|---:|
| `maxTimeMS` | 1 | 300000 |
| `findLimit` | 1 | 10000 |
| `findMaxLimit` | 1 | 100000 |
| `findMaxSkip` | 0 | 10000000 |
| `findPageMaxLimit` | 1 | 10000 |

`findLimit` 还必须小于或等于 `findMaxLimit`。

## 配置优先级

同一能力同时存在实例级与方法级配置时，方法级配置优先。

```ts
const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'shop',
  config: { uri: 'mongodb://127.0.0.1:27017' },
  maxTimeMS: 3000
});

await msq.connect();

const users = msq.collection('users');

await users.find({}, { maxTimeMS: 5000 }); // 使用 5000。
await users.find({});                      // 使用 3000。
```

## 常见误区

| 误区 | 正确写法 |
|---|---|
| 把 boolean 当作构造函数 cache 配置 | `cache: { enabled: false }`，或查询级 `{ cache: 0 }` |
| 通过 cache type 字符串和 host/port 对象选择 Redis | `MonSQLize.createRedisCacheAdapter(redisUrl)` 或 `cache.redis.url` |
| 只传 logger level | `logger: console`，或提供 `debug/info/warn/error` 方法 |
| 以为二级缓存字段会自动创建 Pub/Sub | 显式配置 `cache.distributed.redisUrl`，或传入同一个 `cache.distributed.redis` 实例 |
| 省略 `type` | 显式设置 `type: 'mongodb'` |

## 相关文档

- [安装](./getting-started.md)
- [连接管理](./connection.md)
- [缓存 API](./cache.md)
- [连接池配置](./multi-pool.md)
- [Model 概览](./model.md)
- [写路径策略](./write-path-policy.md)
- [Change Stream 同步](./sync-backup.md)
- [慢查询日志](./slow-query-log.md)
