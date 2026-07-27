# Guides

Use these guides when you already know the feature you want to turn on and need the smallest configuration shape, the key options, and the first place to look when something fails.

## Connect to MongoDB

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

| Option | Required | What it does |
|--------|----------|--------------|
| `type` | Optional | MongoDB is the current runtime adapter. Use `mongodb` when you want to be explicit. |
| `databaseName` | Yes | Default database used by `collection()` and `model()`. |
| `config.uri` | Yes | MongoDB connection string. |

If it fails, check for `INVALID_CONFIG` when `config.uri` is missing and `NOT_CONNECTED` when a collection is accessed before `connect()`.

Example source: [`examples/quick-start/basic-connect.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/quick-start/basic-connect.ts)

## Enable Memory Cache

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

| Option | Required | What it does |
|--------|----------|--------------|
| `cache.enabled` | No | Set `false` to disable cache creation from this config block. |
| `cache.ttl` / `cache.defaultTtl` | No | Default TTL in milliseconds for cache entries created by the runtime. |
| `cache.maxEntries` | No | Maximum entry count for the memory cache. |
| `cache.enableStats` | No | Enables cache hit/miss statistics. |

Memory cache needs no external service and is the quickest way to verify cached reads locally. Writes clear collection query cache only when `cache.invalidate`, `autoInvalidate`, or global `cache.autoInvalidate` is configured; transaction writes flush pending invalidations after commit.

Example source: [`examples/cache/with-cache.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/cache/with-cache.ts)

## Enable Redis L2 Cache and Distributed Invalidation

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

| Option | Required | What it does |
|--------|----------|--------------|
| `cache.memory` | No | Local L1 cache settings. |
| `cache.redis.url` | Yes for L2 | Redis connection used for the remote cache adapter. |
| `cache.redis.timeoutMs` | No | Timeout for remote cache operations. |
| `cache.distributed.redisUrl` | Yes for Pub/Sub when no Redis instance is supplied | Redis connection used by distributed invalidation Pub/Sub. |
| `cache.distributed.redis` | Alternative | Existing Redis-like instance for Pub/Sub. |
| `cache.distributed.channel` | No | Pub/Sub channel shared by all instances. |

Keep the Redis URL in a variable when both L2 cache and distributed invalidation use the same Redis endpoint. The runtime does not infer `cache.distributed.redisUrl` from `cache.redis.url`; provide both values or pass a Redis instance to `cache.distributed.redis`.

Example source: [`examples/docs/cache-multilevel.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/cache-multilevel.ts)

## Connect Through an SSH Tunnel

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

| Option | Required | What it does |
|--------|----------|--------------|
| `config.uri` | Yes | MongoDB URI as seen from the SSH target network. |
| `config.ssh.host` | Yes | Bastion host. |
| `config.ssh.username` | Yes | SSH username. |
| `config.ssh.privateKeyPath` | Usually | Private key path for key-based auth. |

When `config.ssh` is present, monSQLize opens a local tunnel before connecting to MongoDB. If the connection fails, check SSH credentials first, then MongoDB reachability from the bastion network.

Related docs: [`ssh-tunnel.md`](./ssh-tunnel.md)

## Configure Multiple Connection Pools

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

| Option | Required | What it does |
|--------|----------|--------------|
| `pools[].name` | Yes | Stable pool name used by `pool(name)`. |
| `pools[].uri` | Yes | MongoDB URI for that pool. |
| `pools[].role` | No | Describes primary, secondary, analytics, archive, or custom use. |
| `poolStrategy` | No | Selection strategy for pool routing. |
| `poolFallback` | No | Fallback behavior when a selected pool is unavailable. |

Configuration errors throw `INVALID_CONFIG`; unknown pool names throw `POOL_NOT_FOUND`; unavailable pools throw `INVALID_OPERATION`.

Example sources: [`examples/docs/pool.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/pool.ts) and [`examples/docs/multi-pool-health-check.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/multi-pool-health-check.ts)

## Enable the Model Layer

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

| Option | Required | What it does |
|--------|----------|--------------|
| `Model.define(name, config)` | Yes | Registers the model definition before runtime binding. |
| `schema: (s) => s(...)` | Usually | Current recommended schema callback style. |
| `schemaDsl` | No | Runtime options, extensions, injected runtime, or explicit validation disablement. |
| `writePathPolicy` | No | Use `model-only` when selected namespaces must go through Model writes. |

Model schema callbacks use the isolated `schema-dsl/runtime` owned by the `MonSQLize` instance. If your application owns custom schema-dsl types or messages, configure that runtime directly and inject it with `schemaDsl: { runtime }`.

Example source: [`examples/docs/model.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/model.ts)

## Troubleshoot by Error Code

```ts
import { ErrorCodes } from 'monsqlize';

try {
    await msq.connect();
} catch (error) {
    const code = (error as { code?: string }).code;
    if (code === ErrorCodes.INVALID_CONFIG) {
        console.error('Check the MonSQLize constructor options');
    } else if (code === ErrorCodes.CONNECTION_FAILED) {
        console.error('Check MongoDB network, authentication, and URI');
    } else {
        throw error;
    }
}
```

| Code | Usual cause | First check |
|------|-------------|-------------|
| `INVALID_CONFIG` | Missing or malformed runtime options | Constructor options and feature-specific config blocks |
| `CONNECTION_FAILED` | MongoDB or SSH connection failure | Network, credentials, URI, and SSH tunnel reachability |
| `NOT_CONNECTED` | Data API used before `connect()` | Runtime lifecycle |
| `POOL_NOT_FOUND` | Unknown pool name | `pools[].name` and `msq.pool(name)` |

More details: [`error-codes.md`](./error-codes.md)
