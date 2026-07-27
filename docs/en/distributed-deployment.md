# Distributed Deployment Guide

## Overview

monSQLize supports single-instance and multi-instance deployments. In a **single instance** environment, local query cache is usually enough. In a multi-instance deployment, use Redis-backed remote cache and distributed invalidation when cached reads must converge across processes.


## Why is distributed support needed?

In a multi-instance deployment, each instance has its own local cache and lock manager. If no special treatment is done, it will lead to:

1. **Cache inconsistency window**: after instance A updates data, instance B can briefly hold an old local cache entry until invalidation arrives.
2. **Transaction/cache boundary**: MongoDB transactions keep session semantics, while cache invalidation is flushed after commit on a best-effort basis.
3. **Business critical sections**: balance, inventory and payment flows still need application-level idempotency, fencing or explicit locks.

---

## Architecture selection


## 1. Single instance deployment (✅ Recommended: small applications)

```text
┌─────────────────────────────┐
│ Node.js Example │
│                              │
│  ┌───────────────┐          │
│ │ Local Cache LRU │ │
│  └───────────────┘          │
└─────────────────────────────┘
         │
         ▼
MongoDB (replica set)
```

**Features**:
- ✅ All functions fully supported
- ✅ No Redis required
- ✅ Easy to configure
- ⚠️ No high availability

**Applicable scenarios**:
- Development/test environment
- Production environment with low traffic
- Single application

**Configuration Example**:
```javascript
const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'mydb',
  config: { uri: 'mongodb://localhost:27017' },
  cache: {
    maxEntries: 1000,
    defaultTtl: 60000
  }
});
```

---


## 2. Multiple instances + independent local cache (🔴 not recommended)

```text
┌───────────────────┐    ┌───────────────────┐
│Instance A │ │Instance B │
│ ┌──────────┐      │    │ ┌──────────┐      │
│ │Local cache A │ │ │ │Local cache B │ │
│ └──────────┘      │    │ └──────────┘      │
└────────┬──────────┘    └────────┬──────────┘
         │                         │
         └────────┬────────────────┘
                  ▼
MongoDB (replica set)
```

**RISK**:
- 🔴 **High Risk**: Cache Inconsistency
- 🔴 **Transaction isolation failure**
- ❌ **Not recommended for production environments**

---


## 3. Multiple instances + Redis + distributed cache failure (🟢 Recommended)

```text
┌───────────────────┐    ┌───────────────────┐
│Instance A │ │Instance B │
│ ┌──────────┐      │    │ ┌──────────┐      │
│ │Local cache A │ │ │ │Local cache B │ │
│ └────┬─────┘      │    │ └────┬─────┘      │
└──────┼────────────┘    └──────┼────────────┘
       │                         │
       └────────┬────────────────┘
                ▼
         ┌─────────────┐
         │   Redis     │
│ (caching + broadcasting) │
         └──────┬──────┘
                │
                ▼
MongoDB (replica set)
```

**Features**:
- ✅ High availability
- ✅ Good cache consistency (millisecond latency)
- ✅Excellent performance
- ⚠️ Depends on Redis

**Applicable scenarios**:
- Production environment (recommended)
- High concurrency scenarios
- Tolerate short-term (millisecond level) data inconsistencies

**Configuration Example**:
```javascript
const Redis = require('ioredis');
const redis = new Redis('redis://localhost:6379');

const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'mydb',
  config: { uri: 'mongodb://localhost:27017' },

  cache: {
    multiLevel: true,
    local: { maxEntries: 1000 },
    remote: MonSQLize.createRedisCacheAdapter(redis),  //Redis cache

    // Enable distributed cache invalidation
    distributed: {
      enabled: true,           //✅ Required: Enable
      redis,
      instanceId: 'instance-1' // Optional, recommended for logs and diagnostics
      //channel: 'myapp:cache:invalidate' // ❌ Optional: Custom channel
    }
  }
});
```

---


## 4. Multiple instances + explicit business coordination (🟡 Finance/Trading)

```text
┌───────────────────┐    ┌───────────────────┐
│Instance A │ │Instance B │
│ ┌──────────┐      │    │ ┌──────────┐      │
│ │Local cache A │ │ │ │Local cache B │ │
│ └────┬─────┘      │    │ └────┬─────┘      │
└──────┼────────────┘    └──────┼────────────┘
       │                         │
       └────────┬────────────────┘
                ▼
         ┌─────────────┐
         │   Redis     │
│ (cache + explicit business lock) │
         └──────┬──────┘
                │
                ▼
MongoDB (replica set)
```

**Features**:
- ✅ Shared cache invalidation across instances
- ✅ Explicit application/framework-level lock and idempotency choices
- ✅ Suitable for financial/trading scenarios when paired with durable business safeguards
- ⚠️ Cache invalidation remains best-effort and is not atomic with database commits

**Applicable scenarios**:
- financial system
- Payment/Transfer
- Inventory deductions
- Any scenario where the business layer already provides idempotency, fencing, or cache bypassing for strict reads

**Configuration Example**:
```javascript
const Redis = require('ioredis');
const redis = new Redis('redis://localhost:6379');

const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'mydb',
  config: { uri: 'mongodb://localhost:27017?replicaSet=rs0' },

  cache: {
    multiLevel: true,
    local: { maxEntries: 1000 },
    remote: MonSQLize.createRedisCacheAdapter(redis),

    //Distributed cache invalidation
    distributed: {
      enabled: true,              //✅ Required: Enable
      redis,
      instanceId: 'instance-1'    // Optional, recommended for logs and diagnostics
    },

  }
});

const businessLock = new MonSQLize.DistributedCacheLockManager({
  redis,
  lockKeyPrefix: 'myapp:business:lock:'
});

await businessLock.withLock(`payment:${paymentId}`, async () => {
  // Keep the critical section idempotent and use fencing/outbox where external effects are involved.
});
```

`transaction.distributedLock` is retained only as a compatibility placeholder and is not wired into transaction cache-lock interception. Disable cache on strict read paths or coordinate at the business/framework layer when cross-instance strict consistency is required.

---


## 5. Multiple instances + disable cache (🟡 Applicable: strong consistency requirements)

**Features**:
- ✅ 100% data consistency
- ✅ No external dependencies
- ❌ Performance degradation (all requests check the database)

**Applicable scenarios**:
- Low traffic applications
- Strong consistency requirements
- Unable to use Redis

**Configuration Example**:
```javascript
const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'mydb',
  config: { uri: 'mongodb://localhost:27017' },

  cache: {
    //Disable caching (all queries access the database directly)
    enabled: false
  }
});
```

---

## Risks in distributed environments


## Risk 1: Cache invalidation out of sync

**Scenario**:
```javascript
//timeline
T1: Instance A queries user { id: 1, balance: 100 } → writes local cache A
T2: Instance B queries user { id: 1, balance: 100 } → writes local cache B
T3: Instance A updates the balance to 150 → invalidates local cache A ✓
T4: Instance B queries user → hits local cache B → returns old data 100 ❌
```

**Impact**:
- Users see inconsistent balances
-Business logic may go wrong

**Solution**: Enable **Distributed Cache Invalidation Broadcast**

---


## Risk 2: Transaction cache lock does not take effect

**Scenario**:
```javascript
//Example A: Transfer transaction
await msq.withTransaction(async (tx) => {
  //T1: Debit Alice
  await accounts.updateOne(
    { userId: 'alice' },
    { $inc: { balance: -100 } },
    { session: tx.session }
  );

  //T2: Instance B queries Alice → reads the intermediate state → writes to the cache ❌

  //T3: Add Bob
  await accounts.updateOne(
    { userId: 'bob' },
    { $inc: { balance: 100 } },
    { session: tx.session }
  );
});
```

**Impact**:
- Read the intermediate state of the transaction
- There may be dirty data in the cache
- Transaction isolation failure

**Solution**: Use explicit business coordination and bypass cache when strict freshness is required

---

## Solution


## Solution 1: Distributed cache invalidation broadcast (recommended)

**Principle**: Use Redis Pub/Sub to broadcast cache invalidation messages

**Workflow**:
```text
1. Instance A updates data
2. Instance A invalid local cache + Redis
3. Instance A broadcast failure message (Redis Pub/Sub)
4. Instance B receives the message
5. Instance B invalidates local cache
```

**Configuration**:
```javascript
const Redis = require('ioredis');
const redis = new Redis('redis://localhost:6379');

cache: {
  multiLevel: true,
  local: { maxEntries: 1000 },
  remote: MonSQLize.createRedisCacheAdapter(redis),

  distributed: {
    enabled: true,                 //✅ Required: Enable distributed invalidation
    redis,
    instanceId: 'instance-A'       // Optional, recommended for logs and diagnostics
    // channel: 'myapp:cache:invalidate'// ❌ optional: default'monsqlize:cache:invalidate'
  }
}
```

**Advantages**:
- ✅ Real-time broadcast, low latency (millisecond level)
- ✅ Use existing Redis infrastructure
- ✅ Simple to implement and easy to maintain

**Disadvantages**:
- ⚠️ Depends on Redis
- ⚠️ May be inconsistent within a very short time window (network delay)

---


## Solution 2: Explicit business lock and cache bypass

**Principle**: Keep cache invalidation best-effort, and protect critical side effects with an explicit business lock plus idempotency/fencing.

**Workflow**:
```text
1. Instance A acquires a business lock, for example payment:order-123
2. Instance A performs an idempotent transaction and records any external side effect in an outbox/journal
3. Reads that require strict freshness bypass cache or read with an application-level freshness check
4. Instance A commits the database transaction
5. Cache invalidation is published after commit on a best-effort basis
6. Instance A releases the business lock
```

**Configuration**:
```javascript
const Redis = require('ioredis');
const redis = new Redis('redis://localhost:6379');

const businessLock = new MonSQLize.DistributedCacheLockManager({
  redis,
  lockKeyPrefix: 'myapp:business:lock:',
  maxDuration: 300000
});

await businessLock.withLock(`order:${orderId}`, async () => {
  // Idempotent transaction + fencing/outbox.
});
```

**Advantages**:
- ✅ The consistency contract is explicit at the business boundary
- ✅ Works with external effects such as payments, inventory, and fulfillment
- ✅ Suitable for financial/trading scenarios

**Disadvantages**:
- ⚠️ Requires application-level idempotency and recovery design
- ⚠️ Does not make cache invalidation transaction-atomic
- ⚠️ Depends on Redis availability when Redis locking is used

---

## Configuration Guide


## Complete configuration example

```javascript
import MonSQLize from 'monsqlize';
const Redis = require('ioredis');

//Create a Redis instance (reused for remote cache and broadcasting)
const redis = new Redis({
  host: 'localhost',
  port: 6379,
  db: 0,
  retryStrategy: (times) => {
    return Math.min(times * 50, 2000);
  }
});

const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'mydb',
  config: {
    uri: 'mongodb://localhost:27017?replicaSet=rs0'
  },

  cache: {
    //Multi-tier caching
    multiLevel: true,

    //Local cache configuration
    local: {
      maxEntries: 1000,    //Cache up to 1000 items
      maxMemory: 0,        //No memory limit
      enableStats: true    //Enable statistics
    },

    //Remote Redis cache (reuse instance)
    remote: MonSQLize.createRedisCacheAdapter(redis),

    //caching strategy
    policy: {
      writePolicy: 'both',            //Double-write (both) or local-first (local-first-async-remote)
      backfillLocalOnRemoteHit: true  //Backfill local when remote hits
    },

    // Distributed cache invalidation
    distributed: {
      enabled: true,                           //✅ Required: Enable
      redis,
      instanceId: process.env.INSTANCE_ID,    // Optional, recommended for logs and diagnostics
      channel: 'myapp:cache:invalidate'       // Optional custom channel
    },

  }
});

//connect
await msq.connect();

//use
const { collection } = await msq.connect();
const users = await collection('users').find(
  { active: true },
  { cache: 60000 }  //Cache for 60 seconds
);

//Close (clean up resources)
await msq.close();
```

**💡 Configuration instructions**:
- ✅ **Required**: Must be configured, otherwise the function will not work
- ❌ **Optional**: You can not configure it, use the default value
- **One Redis instance**: used for remote cache and broadcasting; if you also use business locks, wire that path explicitly.

---


## Configuration option description


### distributed (distributed cache invalidation)

| Options | Type | Required | Default | Description |
|-----|------|------|--------|------|
| `enabled` | Boolean | ✅ | - | Whether to enable distributed cache invalidation |
| `redis` | Object | Use `redis` or `redisUrl` | - | Existing Redis-like instance with `duplicate()` support. |
| `redisUrl` | String | ❌ | - | Redis connection URL (choose one from redis, not recommended) |
| `instanceId` | String | ❌ | `instance-${timestamp}-${random}` | Instance identification, automatically generated by default (such as `instance-1732521234567-a2b3c4d5e`), **strongly recommended to set manually** |
| `channel` | String | ❌ | `'monsqlize:cache:invalidate'` | Pub/Sub channel name |

**⚠️ IMPORTANT NOTE**:
- **`redis` and `redisUrl`**: choose one for distributed invalidation
  - **Recommended**: pass the same Redis instance as `cache.distributed.redis` when you want cache and Pub/Sub to share connection ownership explicitly.
  - If you need to configure it separately: use the `redis` parameter; the instance must expose `duplicate()` so publish and subscribe use separate Redis connections
  - Not recommended: use `redisUrl` (new connection will be created)
- **`instanceId`**: Optional, but **strongly recommended to set manually**
  - Default value format: `instance-${timestamp}-${random}` (such as `instance-1732521234567-a2b3c4d5e`)
  - **`instanceId` must be different for each instance**, otherwise the cache invalidation broadcast will fail.
  - It is recommended to use environment variables: `process.env.INSTANCE_ID` or `process.env.HOSTNAME`


### transaction.distributedLock (compatibility placeholder)

`transaction.distributedLock` is retained only as a compatibility placeholder and is not wired into transaction cache-lock interception. Transaction cache locks remain process-local. Use `DistributedCacheLockManager` explicitly for business critical sections, pair it with idempotency/fencing, or disable cache for strict read paths.

---

## Runtime behavior for users

### Distributed cache invalidation flow

When `cache.distributed` is enabled and Redis Pub/Sub is configured, monSQLize prepares a broadcast channel during `connect()`. The application-facing contract is:

1. A write succeeds or fails according to MongoDB.
2. If cache invalidation is enabled for that write, monSQLize attempts local cache invalidation and publishes an invalidation message for other instances.
3. Other instances receive the message and invalidate their local cache entries for the matching namespace or pattern.
4. Redis publish/subscribe failures are observable through logging/stats, but they do not roll back the already completed MongoDB write.


### Operational notes

- Give every running instance a unique `instanceId` so it can ignore its own broadcasts and accept broadcasts from peers.
- Keep strict-read paths explicit: bypass or disable cache where stale reads are not acceptable.
- Monitor cache invalidation warnings, Redis publish errors, and cache stats. A database write can be committed even if a later cache invalidation step fails.
- Treat distributed invalidation as an eventual-consistency helper. It narrows stale-cache windows; it is not a two-phase commit protocol and does not provide global strong consistency.

---

## Best Practices


## 1. Environment detection

Automatically detect whether you are in a distributed environment:

```javascript
function isDistributedEnvironment() {
  return !!(
    process.env.INSTANCE_ID ||
    process.env.POD_NAME ||      // Kubernetes
    process.env.HOSTNAME         // Docker
  );
}

const cache = isDistributedEnvironment() ? {
  multiLevel: true,
  distributed: { enabled: true, ... }
} : {
  maxEntries: 1000
};
```

---


## 2. Choose a plan based on your business

| Business type | Recommended solution | Configuration |
|---------|---------|------|
| **General Application** | Distributed Cache Invalidation | `distributed.enabled = true` |
| **Finance/Payment** | Cache invalidation + explicit business coordination | `distributed.enabled = true`<br>Business lock + idempotency/fencing |
| **Strong Consistency** | Disable caching | `cache.enabled = false` |
| **Development Environment** | Local Cache | Default Configuration |

---


## 3. Monitoring and logging

Enable logs to view distributed component status:

```javascript
const msq = new MonSQLize({
  // ...
  logger: {
    level: 'info',  // debug | info | warn | error
    // ...
  }
});

//View statistics
const cache = msq.getCache();
console.log(cache.getStats());  //cache statistics
```

---


## 4. Error handling

Degrade strategy when distributed components fail:

```javascript
//If the Redis connection fails, you can still use the local cache
cache: {
  multiLevel: true,
  local: { maxEntries: 1000 },
  remote: MonSQLize.createRedisCacheAdapter('redis://...'),

  distributed: {
    enabled: true,
    redisUrl: 'redis://...'
    //If Redis is unavailable, it will automatically downgrade to local cache only.
  }
}
```

---

## Performance considerations


## 1. Distributed cache invalidation performance

- **Latency**: ~1-5ms (Redis Pub/Sub)
- **Bandwidth**: Each failure ~100 bytes
- **Impact**: Negligible impact on overall performance


## 2. Explicit business lock performance

- **Latency**: ~2-10ms (Redis SET/DEL)
- **Throughput**: Slight decrease (~10-20%)
- **RECOMMENDED**: Use only around business critical sections that need cross-instance coordination


## 3. Comparison of caching strategies

| Strategy | Latency | Consistency | Applicable scenarios |
|-----|------|--------|---------|
| **Local Only** | Minimum | Low | Single Instance |
| **Local + Redis** | Low | Medium | Multiple instances |
| **Local + Redis + Broadcast** | Low | Eventual after invalidation | Recommended |
| **Local + Redis + Broadcast + Business Lock** | Medium | Explicit business boundary | Finance/Trading |
| **Disable Cache** | High | Highest | Strong Consistency |

---

## Troubleshooting


## Problem 1: Cache invalidation broadcast does not take effect

**Symptoms**: After instance A is updated, instance B still reads old data

**Troubleshooting steps**:
1. Check whether the Redis connection is normal
   ```javascript
   await redis.ping();  //should return 'PONG'
   ```

2. Check Pub/Sub subscriptions
   ```javascript
   await redis.subscribe('myapp:cache:invalidate');
   redis.on('message', (channel, message) => {
     console.log('Received message:', channel, message);
   });
   ```

3. View logs
   ```javascript
   //Pass a LoggerLike implementation
   logger: console
   ```

4. Check the instance ID
   ```javascript
   //Make sure the instanceId is different for each instance (manual setting is highly recommended)
   distributed: {
     instanceId: process.env.INSTANCE_ID  //Use environment variables
   }
   ```

---


## Problem 2: `transaction.distributedLock` does not take effect

**Symptom**: Other instances still write to cache during transaction

**Troubleshooting steps**:
1. Confirm the runtime boundary
   ```javascript
   // v2 compatibility note:
   // transaction.distributedLock is not wired into transaction cache-lock interception.
   ```

2. Use an explicit business lock for critical sections
   ```javascript
   const lock = new MonSQLize.DistributedCacheLockManager({
     redis,
     lockKeyPrefix: 'myapp:business:lock:'
   });

   await lock.withLock(`payment:${paymentId}`, async () => {
     // Idempotent critical section.
   });
   ```

3. Disable cache or bypass cache for strict freshness paths.

---


## Problem 3: Redis connection failed

**Symptoms**: An error occurs when the application starts or the cache does not work

**Solution**:
```javascript
const Redis = require('ioredis');
const redis = new Redis({
  host: 'localhost',
  port: 6379,
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  reconnectOnError: (err) => {
    console.error('Redis error:', err);
    return true;
  }
});

redis.on('error', (err) => {
  console.error('Redis connection failed:', err.message);
});

redis.on('connect', () => {
  console.log('✅ Redis connection successful');
});
```

---

## Summary


## Recommended configuration

| Environment | Recommended solutions |
|------|---------|
| **Development Environment** | Local cache (default) |
| **Production environment (single instance)** | Local cache + Redis |
| **Production environment (multiple instances)** | Local + Redis + distributed failure |
| **Financial/Trading System** | Local + Redis + Invalidation + explicit business coordination |


## Quick Start

**The simplest distributed configuration** (recommended):
```javascript
const Redis = require('ioredis');
const redis = new Redis('redis://localhost:6379');

const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'mydb',
  config: { uri: 'mongodb://...' },
  cache: {
    multiLevel: true,
    local: { maxEntries: 1000 },
    remote: MonSQLize.createRedisCacheAdapter(redis),
    distributed: {
      enabled: true,              //✅ Required: Enable
      redis,
      instanceId: 'instance-1'    // Optional, recommended for logs and diagnostics
    }
  }
});
```

**⚠️ IMPORTANT**:
- `instanceId` is optional and automatically generated by default (format: `instance-${timestamp}-${random}`)
- But **strongly recommended to set it manually** to facilitate debugging and log tracking
- `instanceId` must be different for each instance
- It is recommended to use environment variables: `instanceId: process.env.INSTANCE_ID`
- Set either `redis` or `redisUrl`; the runtime does not infer Pub/Sub config from `cache.remote`.

---

## Related documents

- [Cache Policy Document](./cache.md)
- [Cache consistency description](./cache.md)
- [Transaction Function Document](./transaction.md)
- [Redis Cache Adapter](https://github.com/devcodex-labs/monSQLize/blob/main/src/capabilities/cache/redis-cache-adapter.ts)

---
