# 场景指南

当你已经知道要启用哪项能力，但需要最小配置、关键参数和排障入口时，从这些指南开始。

## 连接 MongoDB

```ts
import MonSQLize from 'monsqlize';

const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'app',
    config: { uri: 'mongodb://127.0.0.1:27017' },
});

await msq.connect();

const users = msq.collection('users');
await users.insertOne({ name: 'Ada', createdAt: new Date() });

await msq.close();
```

| 参数 | 是否必填 | 作用 |
|------|----------|------|
| `type` | 否 | 当前 runtime adapter 是 MongoDB；需要显式声明时写 `mongodb`。 |
| `databaseName` | 是 | `collection()` 和 `model()` 默认使用的数据库。 |
| `config.uri` | 是 | MongoDB 连接字符串。 |

如果失败，先看缺少 `config.uri` 时的 `INVALID_CONFIG`，以及 `connect()` 前访问集合时的 `NOT_CONNECTED`。

示例源码：[`examples/quick-start/basic-connect.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/quick-start/basic-connect.ts)

## 开启内存缓存

```ts
import MonSQLize from 'monsqlize';

const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'app',
    config: { uri: 'mongodb://127.0.0.1:27017' },
    cache: {
        enabled: true,
        ttl: 60_000,
        maxEntries: 5_000,
        enableStats: true,
    },
});

await msq.connect();
```

| 参数 | 是否必填 | 作用 |
|------|----------|------|
| `cache.enabled` | 否 | 设置为 `false` 可关闭从该配置块创建缓存。 |
| `cache.ttl` / `cache.defaultTtl` | 否 | runtime 创建缓存条目时使用的默认 TTL，单位毫秒。 |
| `cache.maxEntries` | 否 | 内存缓存最大条目数。 |
| `cache.enableStats` | 否 | 开启命中/未命中统计。 |

内存缓存不需要额外服务，适合单进程或本地快速验证。写入会失效集合查询缓存；事务内写入会在提交成功后刷新待处理失效。

示例源码：[`examples/cache/with-cache.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/cache/with-cache.ts)

## 开启 Redis 二级缓存与分布式失效

```ts
import MonSQLize from 'monsqlize';

const redisUrl = 'redis://127.0.0.1:6379';

const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'app',
    config: { uri: 'mongodb://127.0.0.1:27017' },
    cache: {
        memory: { maxEntries: 5_000, ttl: 30_000 },
        redis: { url: redisUrl, timeoutMs: 300 },
        distributed: {
            redisUrl,
            channel: 'app:cache:invalidate',
        },
    },
});

await msq.connect();
```

| 参数 | 是否必填 | 作用 |
|------|----------|------|
| `cache.memory` | 否 | 本地 L1 缓存设置。 |
| `cache.redis.url` | 启用 L2 时是 | Redis 连接，用于远程缓存适配器。 |
| `cache.redis.timeoutMs` | 否 | 远程缓存操作超时时间。 |
| `cache.distributed.redisUrl` | 未传 Redis 实例时是 | Redis Pub/Sub 连接，用于分布式失效广播。 |
| `cache.distributed.redis` | 可替代 | 传入已有 Redis-like 实例。 |
| `cache.distributed.channel` | 否 | 多实例共享的 Pub/Sub 频道。 |

如果 L2 缓存和分布式失效使用同一个 Redis 地址，把它放进 `redisUrl` 变量即可避免字符串重复。runtime 不会从 `cache.redis.url` 自动推导 `cache.distributed.redisUrl`；需要显式提供两个值，或给 `cache.distributed.redis` 传入已有 Redis 实例。

示例源码：[`examples/docs/cache-multilevel.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/cache-multilevel.ts)

## 通过 SSH 隧道连接内网 MongoDB

```ts
import MonSQLize from 'monsqlize';

const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'app',
    config: {
        uri: 'mongodb://mongo.internal:27017/app',
        ssh: {
            host: 'bastion.example.com',
            username: 'deploy',
            privateKeyPath: '~/.ssh/id_rsa',
        },
    },
});

await msq.connect();
```

| 参数 | 是否必填 | 作用 |
|------|----------|------|
| `config.uri` | 是 | 从 SSH 目标网络可访问的 MongoDB URI。 |
| `config.ssh.host` | 是 | 跳板机地址。 |
| `config.ssh.username` | 是 | SSH 用户名。 |
| `config.ssh.privateKeyPath` | 通常是 | 使用密钥登录时的私钥路径。 |

传入 `config.ssh` 后，monSQLize 会先建立本地隧道，再连接 MongoDB。连接失败时先检查 SSH 凭据，再检查跳板机网络内是否能访问 MongoDB。

相关文档：[`ssh-tunnel.md`](./ssh-tunnel.md)

## 配置多连接池

```ts
import MonSQLize from 'monsqlize';

const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'app',
    pools: [
        { name: 'primary', uri: 'mongodb://primary:27017/app', role: 'primary' },
        { name: 'analytics', uri: 'mongodb://analytics:27017/app', role: 'analytics', tags: ['reporting'] },
    ],
    poolStrategy: 'auto',
    poolFallback: { enabled: true, fallbackStrategy: 'secondary' },
});

await msq.connect();
const reports = msq.pool('analytics').collection('reports');
```

| 参数 | 是否必填 | 作用 |
|------|----------|------|
| `pools[].name` | 是 | 通过 `pool(name)` 访问时使用的稳定名称。 |
| `pools[].uri` | 是 | 该连接池的 MongoDB URI。 |
| `pools[].role` | 否 | 描述 primary、secondary、analytics、archive 或自定义用途。 |
| `poolStrategy` | 否 | 连接池路由选择策略。 |
| `poolFallback` | 否 | 目标池不可用时的回退行为。 |

连接池配置错误会抛出 `INVALID_CONFIG`；指定不存在的池会抛出 `POOL_NOT_FOUND`；所有池不可用会抛出 `INVALID_OPERATION`。

示例源码：[`examples/docs/pool.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/pool.ts)、[`examples/docs/multi-pool-health-check.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/multi-pool-health-check.ts)

## 启用 Model 层

```ts
import MonSQLize, { Model } from 'monsqlize';

Model.define('users', {
    schema: (s) => s({
        name: 'string:1-64!',
        email: 'email!',
    }),
});

const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'app',
    config: { uri: 'mongodb://127.0.0.1:27017' },
});

await msq.connect();
const User = msq.model('users');
await User.insertOne({ name: 'Ada', email: 'ada@example.com' });
```

| 参数 | 是否必填 | 作用 |
|------|----------|------|
| `Model.define(name, config)` | 是 | 在 runtime 绑定前注册 Model 定义。 |
| `schema: (s) => s(...)` | 通常是 | 当前推荐的 schema 回调写法。 |
| `schemaDsl` | 否 | 配置 runtime options、extensions、外部 runtime 或显式关闭验证。 |
| `writePathPolicy` | 否 | 某些命名空间必须经过 Model 写入时使用 `model-only`。 |

Model 的 schema 回调使用当前 `MonSQLize` 实例隔离的 `schema-dsl/runtime`。如果应用持有自定义 schema-dsl 类型或消息，应直接配置该 runtime，并通过 `schemaDsl: { runtime }` 注入。

示例源码：[`examples/docs/model.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/model.ts)

## 按错误码排障

```ts
import { ErrorCodes } from 'monsqlize';

try {
    await msq.connect();
} catch (error) {
    const code = (error as { code?: string }).code;
    if (code === ErrorCodes.INVALID_CONFIG) {
        console.error('检查 MonSQLize 构造配置');
    } else if (code === ErrorCodes.CONNECTION_FAILED) {
        console.error('检查 MongoDB 网络、认证和 URI');
    } else {
        throw error;
    }
}
```

| 错误码 | 常见原因 | 先检查 |
|--------|----------|--------|
| `INVALID_CONFIG` | 构造参数或功能配置块缺失/格式错误 | MonSQLize 构造参数和对应功能配置 |
| `CONNECTION_FAILED` | MongoDB 或 SSH 连接失败 | 网络、认证、URI、SSH 隧道可达性 |
| `NOT_CONNECTED` | `connect()` 前使用数据 API | runtime 生命周期 |
| `POOL_NOT_FOUND` | 池名称不存在 | `pools[].name` 和 `msq.pool(name)` |

更多错误码与处理建议见 [`error-codes.md`](./error-codes.md)。
