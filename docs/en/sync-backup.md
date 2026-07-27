# Change Stream Sync

## Overview

Change Stream sync uses MongoDB's native Change Stream mechanism to dispatch accepted data-change events to one or more targets. It is useful for backup databases, denormalized projections, cache invalidation callbacks, and other asynchronous CDC workflows.


## Core Features

- ✅ **Asynchronous CDC**: Based on MongoDB Change Stream; latency depends on MongoDB, network, and target workload
- ✅ **Decoupled design**: Primary database writes do not wait for target apply callbacks
- ✅ **Resume breakpoint**: Resume Token is saved after all matching targets succeed, so restarts can resume from the latest persisted token
- ✅ **Multi-target support**: Sync to multiple backup databases at the same time
- ✅ **Data Filtering**: Custom filtering logic
- ✅ **Data conversion**: Support desensitization and field conversion
- ✅ **Observable lifecycle**: Sync stats expose running state and error counters for monitoring/restart workflows
- ✅ **Health Check**: Target health-check configuration for managed targets

---

## ⚠️ Prerequisites


## Must satisfy

1. **MongoDB Replica Set** 🔴
   ```bash
   # Check whether it is a Replica Set
   rs.status()
   ```

2. **MongoDB version >= 4.0** 🔴

3. **User Permissions** 🔴
   ```javascript
   // Requires changeStream permission
   {
       resource: { db: "dbName", collection: "" },
       actions: ["changeStream", "find"]
   }
   ```

---

## 🚀 Quick Start


## Basic configuration

```javascript
import MonSQLize from 'monsqlize';

const msq = new MonSQLize({
    type: 'mongodb',
    config: {
        uri: 'mongodb://localhost:27017/main',
        replicaSet: 'rs0'  // Required
    },

    // Synchronization configuration
    sync: {
        enabled: true,
        targets: [
            {
                name: 'backup-main',
                uri: 'mongodb://backup:27017/backup',
                collections: ['users', 'orders']
            }
        ]
    }
});

await msq.connect();

// Normal use, automatic synchronization
await msq.collection('users').insertOne({ name: 'Alice' });
// Automatically sync to backup-main

await msq.close();
```

---

## 📖 Configuration options


## sync configuration

| Options | Type | Required | Default | Description |
|------|------|------|--------|------|
| `enabled` | boolean | ✅ | - | Whether to enable synchronization |
| `targets` | Array | ✅ | - | Backup target array |
| `resumeToken` | Object | ❌ | - | Resume Token Configuration |
| `idempotency` | Object | ❌ | disabled | Optional per-target replay idempotency gate |
| `filter` | Function | ❌ | - | Event filtering function |
| `transform` | Function | ❌ | - | Data conversion function |

`transform` is a manager-level conversion hook. It runs once for each accepted change event before the event is delivered to all matching targets, so all targets receive the same transformed document. Delete events usually do not include `fullDocument`; custom targets should handle an `undefined` document and use `event.documentKey` for delete handling.


## targets[].Configuration

| Options | Type | Required | Description |
|------|------|------|------|
| `name` | string | ✅ | Target name (unique) |
| `uri` | string | Conditional | MongoDB URI. Each target must provide one of `uri`, `pool`, or `apply` |
| `pool` | string | Conditional | Named connection pool target |
| `apply` | Function | Conditional | Custom target callback `(event, document, context) => Promise<void>` |
| `collections` | Array | ❌ | Synchronized collection, `['*']` represents all |
| `healthCheck` | Object | ❌ | Health Check Configuration |


## resumeToken configuration

| Options | Type | Required | Default | Description |
|------|------|------|--------|------|
| `storage` | string | ❌ | `'file'` | Storage type: `'file'` or `'redis'` |
| `path` | string | ❌ | `./.sync-resume-token` | File path (file mode) |
| `redis` | Object | ❌ | - | Redis instance (Redis mode) |
| `strictLoad` | boolean | ❌ | same as `strictSave` | Treat unreadable or corrupted stored tokens as fatal instead of starting from no token |
| `strictSave` | boolean | ❌ | `true` | Treat token save failures as fatal so CDC never advances without a persisted token |
| `saveRetries` | number | ❌ | `0` | Retry attempts before a strict token save fails |
| `saveRetryDelayMs` | number | ❌ | `100` | Delay between token-save retries |

Resume token persistence is strict by default. File storage writes to a same-directory temporary file, fsyncs it, keeps the previous token as `<path>.bak`, and then atomically renames the temporary file into place. Startup also validates the stored token: a corrupted token fails fast when `strictLoad` is true, instead of silently starting without a resume token. After all eligible targets apply an event successfully, monSQLize saves the event resume token; `syncedCount` advances only after that save succeeds. If token persistence fails after the configured retries, or any eligible target fails to apply the event, the manager records the error, closes the live stream, marks `isRunning: false`, and does not process later queued events. This is an at-least-once contract, not exactly-once: a crash after target apply and before token save can replay the same event. Set `strictSave: false` and `strictLoad: false` only for legacy best-effort token-storage behavior, where a restart may replay already-applied events or start without the previously stored token. Built-in MongoDB targets are idempotent (`replaceOne(..., { upsert: true })` / `deleteOne()`); custom `apply` targets should still deduplicate by change event `_id`.

### idempotency configuration

`sync.idempotency` is optional and disabled by default. When enabled, the manager builds a per-target idempotency key from the change event `_id` unless `keyBuilder` is provided. If the key is already present, that target is skipped and the event can still advance its resume token after all eligible targets are accounted for. Use a durable `store` for restart protection; the built-in memory fallback only protects repeated delivery in the same process. `markMode: 'success'` records after `apply` resolves. `markMode: 'start'` records before `apply`; it narrows unknown-success duplicate risk, but a failure after the marker is written can make runtime replay skip that target, so use it only when the target has its own durable idempotency and recovery path.

---

## 💡 Usage example


## Example 1: Multiple backup targets

```javascript
{
    sync: {
        enabled: true,
        targets: [
            {
                name: 'backup-asia',
                uri: 'mongodb://asia:27017/backup',
                collections: ['*']
            },
            {
                name: 'backup-us',
                uri: 'mongodb://us:27017/backup',
                collections: ['*']
            }
        ]
    }
}
```


## Example 2: Data filtering

```javascript
{
    sync: {
        enabled: true,
        targets: [...],

        // Only sync active users
        filter: (event) => {
            if (event.ns?.coll === 'users') {
                return event.fullDocument?.status === 'active';
            }
            return true;
        }
    }
}
```


## Example 3: Data desensitization

```javascript
{
    sync: {
        enabled: true,
        targets: [...],

        // Remove sensitive fields
        transform: (doc) => {
            delete doc.password;
            delete doc.ssn;
            return doc;
        }
    }
}
```


## Example 4: Redis Resume Token

```javascript
const Redis = require('ioredis');
const redis = new Redis();

{
    sync: {
        enabled: true,
        targets: [...],
        resumeToken: {
            storage: 'redis',
            redis: redis,
            strictSave: true,
            saveRetries: 3,
            saveRetryDelayMs: 100
        }
    }
}
```

---

## 📊 Performance impact

| Write QPS | Primary database CPU | Primary database memory | Network bandwidth | Synchronization delay |
|---------|---------|---------|---------|---------|
| 100 | +0.5% | +10MB | 1MB/s | 10-50ms |
| 1000 | +1% | +20MB | 10MB/s | 50-200ms |
| 5000 | +2% | +50MB | 50MB/s | 200-500ms |

---

## 🔧 API


## Get statistics

```javascript
const stats = msq.getSyncStats();
console.log(stats);
// {
//   isRunning: true,
//   eventCount: 1234,
//   syncedCount: 1230,
//   errorCount: 4,
//   startTime: 2026-01-17T...,
//   lastEventTime: 2026-01-17T...,
//   lastError: null,
//   tokenSaveErrorCount: 0,
//   lastTokenSaveError: null,
//   targets: [...]
// }
```


## Manually stop synchronization

```javascript
await msq.stopSync();
```


## Manually start synchronization

```javascript
await msq.startSync();
```

---

## ❓ FAQ


## Q1: Prompt "Change Stream is not available"

**Reason**: MongoDB is not a Replica Set

**Solution**:
```bash
# 1. Check the topology
rs.status()

# 2. If it is a single node, switch to Replica Set
rs.initiate()
```


## Q2: Is there a delay in synchronization?

**Cause**: Network delay, backup database performance

**Solution**:
1. Check network delay: `ping backup-host`
2. Check backup database performance: `db.serverStatus()`
3. Reduce the number of synchronized collections


## Q3: What should I do if the Resume Token is lost?

**Impact**: After restarting, synchronization starts from the current time and intermediate data is lost.

**Solution**:
1. Use Redis to store Resume Token
2. Back up the Resume Token file regularly
3. Manually synchronize all data once


## Q4: How to deal with synchronization failure?

**Automatic processing**:
- Targets that already applied the event are not rolled back, but any target failure stops the manager before the resume token advances
- A resume-token save failure stops the sync manager before the token can advance
- Change Stream driver errors and unexpected stream closes are logged and reflected in stats; monitor `isRunning`, `errorCount`, and `lastError`, then restart the manager or runtime from your supervisor when needed

**Manual processing**:
```javascript
// View error statistics
const stats = msq.getSyncStats();
console.log(stats.errorCount);
console.log(stats.lastError);
console.log(stats.targets[0].lastError);
```

---

## 🛡️ Best Practices


## 1. Production environment configuration

```javascript
{
    sync: {
        enabled: true,
        targets: [
            {
                name: 'backup-main',
                uri: 'mongodb://backup:27017/backup',
                collections: ['*'],
                healthCheck: {
                    enabled: true,
                    interval: 30000,  //30 seconds
                    timeout: 5000,
                    retries: 3
                }
            }
        ],
        resumeToken: {
            storage: 'redis',  //Use Redis
            redis: redisInstance
        }
    }
}
```


## 2. Monitoring and Alarming

```javascript
//Check statistics regularly
setInterval(() => {
    const stats = msq.getSyncStats();

    if (stats.errorCount > 100) {
        //Send alert
        sendAlert('Too many sync errors');
    }

    if (!stats.isRunning) {
        //Send alert
        sendAlert('Sync stopped');
    }
}, 60000);
```


## 3. Graceful shutdown

```javascript
process.on('SIGTERM', async () => {
    console.log('Received SIGTERM, closed gracefully...');
    await msq.close();
    process.exit(0);
});
```

---

## More resources

- [Sample code](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/sync.ts)
- [MongoDB Change Streams official documentation](https://www.mongodb.com/docs/manual/changeStreams/)
- [Multi-pool configuration documentation](./multi-pool.md)
