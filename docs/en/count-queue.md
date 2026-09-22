# Count queue control

## Overview

For direct `CountQueue.execute(task, { signal })` calls, an aborted queued task is removed before execution. Timeout or caller abort rejects the caller and aborts the task signal, but the running slot remains occupied until the underlying task actually settles. Tasks that ignore abort can therefore keep a slot occupied.

Count queue control is an advanced feature of monSQLize that limits the number of `countDocuments` operations that can be executed simultaneously.


## Core functions

- ✅ **Concurrency Control** - Limit the number of counts executed simultaneously
- ✅ **Queue Management** - Requests exceeding the limit are automatically queued
- ✅ **Timeout Protection** - Prevent requests from waiting for long periods of time and pass an `AbortSignal` to the running task for cooperative cancellation
- ✅ **Statistics Monitoring** - Provides queue status and performance metrics
- ✅ **AUTO-ENABLED** - Enabled by default, no configuration required

---

## Runtime boundary

CountQueue is a cooperative in-process scheduler. It limits how many count tasks monSQLize starts concurrently and aborts the provided `AbortSignal` on timeout, but it does not isolate work in separate workers, force-stop a promise that ignores the signal, or propagate distributed backpressure across multiple Node.js processes.

---

## Why queue control is needed


## Problem Scenario

```javascript
//High concurrency scenario: 100 users request paging data at the same time
for (let i = 0; i < 100; i++) {
    await collection.findPage({
        query: { status: 'active' },
        totals: { mode: 'async' }
    });
}

//Result: 100 countDocuments executed simultaneously
//❌ Database connection pool exhausted
// ❌ CPU 100%
//❌ Other queries time out
//❌ Database crash
```


## Solution

```javascript
//Use Count queue (enabled by default)
const msq = new MonSQLize({
    countQueue: {
        enabled: true,
        concurrency: 8  //Up to 8 counts at the same time
    }
});

//Result: up to 8 countDocuments executed simultaneously
//✅ Database pressure is controllable
//✅ The connection pool is normal
//✅ Other inquiries will not be affected
```

---

## Quick start


## Default configuration (recommended)

```javascript
import MonSQLize from 'monsqlize';

const msq = new MonSQLize({
    type: 'mongodb',
    config: {
        uri: 'mongodb://localhost:27017/mydb'
    }
    //countQueue is enabled by default and requires no configuration
});

await msq.connect();
const collection = msq.collection('users');

//Automatically use queue control
await collection.findPage({
    query: { status: 'active' },
    totals: {
        mode: 'async'  //Automatically apply queue control
    }
});
```

**Default configuration**:
- ✅ `enabled: true` - enabled by default
- ✅ `concurrency:` CPU core number (minimum 4, maximum 16)
- ✅ `maxQueueSize: 10000` - Maximum queue capacity
- ✅ `timeout: 60000` - Timeout 1 minute

---

## Configuration options


## Basic configuration

```javascript
const msq = new MonSQLize({
    countQueue: {
        enabled: true,       //Whether to enable queue control
        concurrency: 8,      //count number of simultaneous executions
        maxQueueSize: 5000,  //Queue maximum capacity
        timeout: 30000       //Timeout (milliseconds)
    }
});
```


## Configuration instructions


### `enabled`

- **Type**: `Boolean`
- **Default value**: `true`
- **Description**: Whether to enable queue control

```javascript
//Disable queues (not recommended)
countQueue: {
    enabled: false
}
```


### `concurrency`

- **Type**: `Number`
- **Default**: Number of CPU cores (4-16)
- **Description**: The maximum number of counts executed simultaneously

```javascript
//High concurrency scenario: increase the number of concurrencies
countQueue: {
    concurrency: 16
}

//Low configuration server: reduce the number of concurrencies
countQueue: {
    concurrency: 4
}
```

**Recommended value**:
- Small application (single instance): 4-8
- Medium application (multiple instances): 8-12
- Large applications (high concurrency): 12-16


### `maxQueueSize`

- **Type**: `Number`
- **Default value**: `10000`
- **Description**: The maximum capacity of the queue. New requests will be rejected after exceeding the limit.

```javascript
//High traffic scenario: increase queue capacity
countQueue: {
    maxQueueSize: 20000
}
```


### `timeout`

- **Type**: `Number` (milliseconds)
- **Default**: `60000` (1 minute)
- **Description**: Request timeout

```javascript
//Fail fast: reduce timeouts
countQueue: {
    timeout: 30000  //30 seconds
}
```

---

## Usage scenarios


## Scenario 1: High concurrent paging

```javascript
//A large number of users access the list page at the same time
app.get('/api/users', async (req, res) => {
    const result = await collection.findPage({
        query: { status: 'active' },
        page: req.query.page,
        limit: 20,
        totals: {
            mode: 'async'  //Automatically use queue control
        }
    });

    res.json(result);
});
```


## Scenario 2: Batch query

```javascript
//Batch query statistics for multiple conditions
const queries = [
    { status: 'active' },
    { status: 'pending' },
    { status: 'expired' }
];

const results = await Promise.all(
    queries.map(query =>
        collection.findPage({
            query,
            totals: { mode: 'async' }
        })
    )
);
//Queue automatically controls concurrency
```


## Scenario 3: Scheduled statistical tasks

```javascript
//Scheduled statistical tasks (executed every minute)
setInterval(async () => {
    const stats = await Promise.all([
        collection.findPage({ query: { type: 'A' }, totals: { mode: 'async' } }),
        collection.findPage({ query: { type: 'B' }, totals: { mode: 'async' } }),
        collection.findPage({ query: { type: 'C' }, totals: { mode: 'async' } })
    ]);

    console.log('Statistics completed:', stats);
}, 60000);
```

---

## Performance comparison


## Test scenario

- **Data volume**: 1 million records
- **Concurrent Requests**: 100
- **Server**: 8-core CPU


## Result comparison

| Configuration | count concurrency | response time | database CPU | connection pool | results |
|------|-------------|---------|-----------|--------|------|
| **No queue** | 100 simultaneously | - | 100% | Exhausted | ❌ Crash |
| **Queue (4)** | Max 4 | 2.5s | 60% | Normal | ✅ Stable |
| **Queue (8)** | Max 8 | 1.8s | 80% | Normal | ✅ Best |
| **Queue (16)** | Max 16 | 1.5s | 95% | Normal | ⚠️ Close to limit |

**Conclusion**: `concurrency: 8` is the best balance point

---

## Best Practices


## 1. Adjust the number of concurrency according to the server configuration

```javascript
const os = require('os');
const cpuCount = os.cpus().length;

const msq = new MonSQLize({
    countQueue: {
        //Number of concurrencies = number of CPU cores (minimum 4, maximum 16)
        concurrency: Math.max(4, Math.min(cpuCount, 16))
    }
});
```


## 2. Use with cache

```javascript
const msq = new MonSQLize({
    cache: {
        enabled: true,
        ttl: 600000  //Caching for 10 minutes
    },
    countQueue: {
        concurrency: 8
    }
});

//First query: execute count and cache the results
await collection.findPage({
    query: { status: 'active' },
    totals: { mode: 'async', ttl: 600000 }
});

//Query again within 10 minutes: return to cache directly without executing count
```


## 3. Plan multi-instance concurrency explicitly

`countQueue.concurrency` is per Node.js process. If you run four instances with `concurrency: 8`, the database may still see up to 32 concurrent count operations. For strict fleet-wide limits, set a lower per-instance value or enforce global backpressure in your application, gateway, job scheduler, or database capacity plan.


## 4. Monitor queue status

```javascript
//Use the public CountQueue class when you need direct queue metrics
const queue = new MonSQLize.CountQueue({ concurrency: 8 });

setInterval(() => {
    const stats = queue.getStats();

    if (stats.rejected > 10) {
        console.warn('The number of queue rejections is too many, consider increasing maxQueueSize');
    }

    if (stats.avgWaitTime > 5000) {
        console.warn('The average waiting time is too long, consider increasing concurrency');
    }
}, 60000);
```


## 5. Use approx mode (fast but approximate)

```javascript
//For scenarios with low accuracy requirements, use approx mode
await collection.findPage({
    query: { status: 'active' },
    totals: {
        mode: 'approx'  //fast approximate statistics
    }
});

//Advantages:
//- Empty queries use estimatedDocumentCount (no queue required)
//- Query conditions using countDocuments controlled by queue
```

---

## Troubleshooting


## Issue 1: Queue rejects request

**Error**: `Count queue is full (10000)`

**Cause**: The queue is full and new requests are rejected.

**Solution**:
```javascript
//Option 1: Increase queue capacity
countQueue: {
    maxQueueSize: 20000
}

//Option 2: Increase the number of concurrencies
countQueue: {
    concurrency: 16
}

//Option 3: Use caching to reduce count requests
cache: {
    enabled: true,
    ttl: 600000
}
```


## Problem 2: Request timeout

**Error**: `Count execution timeout (60000ms)`

**Cause**: count execution time exceeds the timeout limit

**Solution**:
```javascript
//Option 1: Increase the timeout
countQueue: {
    timeout: 120000  //2 minutes
}

//Option 2: Add index to speed up count
await collection.createIndex({ status: 1 });

//Option 3: Use approx mode
totals: {
    mode: 'approx'
}
```


## Question 3: Database pressure is still very high

**Cause**: The number of concurrency settings is too high

**Solution**:
```javascript
//Reduce the number of concurrencies
countQueue: {
    concurrency: 4  //Reduced from 16 to 4
}

//For multi-instance deployments, lower per-instance concurrency
countQueue: {
    concurrency: 2
}
```

---

## API Reference


## Configuration object

```typescript
interface CountQueueConfig {
    enabled?: boolean;        //Whether to enable, default true
    concurrency?: number;     //Number of concurrencies, default number of CPU cores (4-16)
    maxQueueSize?: number;    //Queue capacity, default 10000
    timeout?: number;         //Timeout time, default 60000ms
}
```

`CountQueue.execute(fn)` passes an optional `AbortSignal` to `fn`. When the execution timeout fires, the signal is aborted before the queue rejects with `OPERATION_TIMEOUT`. JavaScript cannot force-stop a promise that ignores the signal, so long-running custom tasks should forward the signal to their own cancellable work where possible.


## Statistics

```typescript
interface CountQueueStats {
    executed: number;         //Total number of executions
    queued: number;          //Total number of queues
    timeout: number;         //Number of timeouts
    rejected: number;        //Number of rejections
    avgWaitTime: number;     //Average waiting time (ms)
    maxWaitTime: number;     //Maximum waiting time (ms)
    running: number;         //Currently executing
    queuedNow: number;       //Currently in queue
}
```

---

## Related documents

- [findPage API](./findPage.md)
- [Cache Configuration](./cache.md)
- [Distributed deployment](./distributed-deployment.md)
- Performance optimization
