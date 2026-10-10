# Transaction Performance Optimization Guide

## Overview

This page explains the transaction behavior that matters when you tune throughput and cache consistency:

1. **Read-only transaction accounting** - transactions that do not run monSQLize write helpers are counted separately in `getTransactionStats()`.
2. **Process-local cache invalidation barrier** - transaction writes with explicit invalidation record intents and flush them after commit success or conservatively on an unknown commit result.


## Applicable scenarios

| Optimization | Applicable scenarios | What to expect |
|------|---------|------|
| **Read-only accounting** | Query-heavy flows and report jobs | Measure how much transaction traffic is read-only |
| **Cache invalidation barrier** | Cached read + transactional write workloads | Shorter stale-cache refill windows inside one process; cross-instance coherence remains best-effort |

---

## Optimization 1: Read-only optimization


## Working principle

```javascript
await msq.withTransaction(async (tx) => {
    //Read operation
    const user = await collection('users').findOne(
        { _id: 1 },
        { session: tx.session }
    );

    //No write helper runs, so this transaction is counted as read-only.
});
```


## How to use

No code changes are required for read-only transactions. A transaction is counted as read-only when it does not run monSQLize write helpers.

```javascript
//Automatically recognized as a read-only transaction
await msq.withTransaction(async (tx) => {
    const user = await collection('users').findOne(
        { _id: 1 },
        { session: tx.session }
    );

    const orders = await collection('orders').find(
        { userId: 1 },
        { session: tx.session }
    ).toArray();

    //There is no write operation, so transaction stats record it as read-only.
});
```


## Optimization 2: cache invalidation barrier

## Working principle

When a transaction performs writes through monSQLize helpers with explicit cache invalidation configured, the runtime records read-cache invalidation intents. After the MongoDB commit succeeds, it flushes the recorded invalidations and releases the process-local cache lock. An unknown commit result also causes conservative invalidation without reporting rollback or replaying the callback. Abort with a known outcome discards the intents. Pending fills on the same CacheLike object are revoked; cross-process Redis notifications remain eventually consistent.

```javascript
await msq.withTransaction(async (tx) => {
    await collection('users').updateOne(
        { _id: 1 },
        { $set: { balance: 100 } },
        {
            session: tx.session,
            cache: {
                invalidate: [{
                    operation: 'findOne',
                    query: { _id: 1 },
                    options: { cache: 5000 }
                }]
            }
        }
    );
    //The configured cache invalidation intent is flushed after commit.
});
```


## Usage

When you want transaction writes to clear cached reads, pass `session: tx.session` together with `cache.invalidate` or `autoInvalidate: true`.

```javascript
await Promise.all([
    msq.withTransaction(async (tx) => {
        await collection('users').updateOne(
            { _id: 1 },
            { $inc: { balance: 100 } },
            {
                session: tx.session,
                cache: { invalidate: true }
            }
        );
    }),
    msq.withTransaction(async (tx) => {
        await collection('users').updateOne(
            { _id: 2 },
            { $inc: { balance: 200 } },
            {
                session: tx.session,
                cache: { invalidate: true }
            }
        );
    })
]);

//MongoDB controls write conflicts. monSQLize only coordinates cache invalidation.
```


## Boundary

| Topic | Current behavior |
|-------|------------------|
| Lock scope | Process-local `CacheLockManager`; not a distributed mutex |
| Cache invalidation | Best-effort after MongoDB commit; a cache failure does not roll back the DB commit |
| Cross-instance cache | Eventual convergence through distributed invalidation when configured |
| Performance | Workload-dependent; use `getTransactionStats()` and application metrics instead of assuming fixed gains |

---

## Usage suggestions


## 1. Keep transactional writes narrow

Recommended:
- Keep transactions short.
- Pass `session: tx.session` only to the operations that must be part of the transaction.
- Prefer targeted filters and indexed queries so MongoDB can resolve conflicts efficiently.

Avoid:
- Long-running transactions with network calls inside the callback.
- Large batch updates inside one transaction unless you have measured the lock and oplog impact.
- Relying on monSQLize cache locks as cross-process business locks.


## 2. Make full use of read-only optimization

✅ **Recommended Scenario**:
- Report query
- Data analysis
- read-only copy

**Best Practice**:
```javascript
//✅ Good design: separate read-only and write-only
//read-only transaction
const reportData = await msq.withTransaction(async (tx) => {
    const users = await collection('users').find({}, { session: tx.session }).toArray();
    const orders = await collection('orders').find({}, { session: tx.session }).toArray();
    return { users, orders };
});

//Write transaction (executed separately)
await msq.withTransaction(async (tx) => {
    await collection('logs').insertOne({ report: reportData }, { session: tx.session });
});

//❌ Bad design: Mixing read-only and write-only
await msq.withTransaction(async (tx) => {
    const users = await collection('users').find({}, { session: tx.session }).toArray();
    await collection('logs').insertOne({ users }, { session: tx.session });
    //Contains write operations and will not be optimized
});
```


## 3. Monitor transaction statistics

```javascript
//Check statistics regularly
const stats = msq.getTransactionStats();

if (stats) {
    console.log('Transaction statistics:');
    console.log(`- Read-only transaction ratio: ${stats.readOnlyRatio}`);
    console.log(`- Average time taken: ${stats.averageDuration.toFixed(2)}ms`);
    console.log(`- P95 time: ${stats.p95Duration.toFixed(2)}ms`);
    console.log(`- Success rate: ${stats.successRate}`);

    //Determine whether optimization is needed
    if (parseFloat(stats.readOnlyRatio) > 30) {
        console.log('✅ Read-only optimization works well');
    }
}
```


## 4. Configuration tuning

```javascript
const msq = new MonSQLize({
    //...basic configuration
    transaction: {
        //Cache lock maximum duration (default: 5 minutes)
        lockMaxDuration: 300000,

        //Lock cleaning interval (default: 10 seconds)
        lockCleanupInterval: 10000,

        //Number of statistical samples (default: 1000)
        maxStatsSamples: 1000
    }
});
```

---

## Monitoring indicators


## Key indicators

| Indicator | Description | Alarm threshold |
|------|------|---------|
| `readOnlyRatio` | Proportion of read-only transactions | <10%, optimization benefits are limited |
| `successRate` | Transaction success rate | <95% Investigation required |
| `averageDuration` | Average time consumption | >1000ms Needs optimization |
| `p95Duration` | P95 Time consuming | >3000ms Needs optimization |
| `activeTransactions` | Currently active transactions | Abnormal non-zero value for a long time requires investigation |


## Monitoring script example

```javascript
//Periodic output statistics (every minute)
setInterval(() => {
    const stats = msq.getTransactionStats();
    if (!stats) return;

    console.log('📊 Transaction monitoring:', {
        time: new Date().toISOString(),
        total: stats.totalTransactions,
        readOnlyRatio: stats.readOnlyRatio,
        successRate: stats.successRate,
        averageDuration: `${stats.averageDuration.toFixed(2)}ms`,
        p95Duration: `${stats.p95Duration.toFixed(2)}ms`
    });

    //Alarm check
    if (parseFloat(stats.successRate) < 95) {
        console.warn('⚠️ Warning: Transaction success rate is less than 95%');
    }

    if (stats.p95Duration > 3000) {
        console.warn('⚠️ WARNING: P95 takes more than 3 seconds');
    }
}, 60000);
```

---

## FAQ


## Q1: Will cache barriers increase memory usage?

**A**: The barrier and cache-lock metadata are process-local and short-lived. Watch `activeTransactions` and your process RSS if you run many concurrent long transactions.

## Q2: How do I inspect transaction behavior?

**A**: Use aggregate transaction stats and per-transaction stats:

```javascript
const tx = await msq.startSession();
await tx.start();
//... perform operations
const stats = tx.getStats();
console.log('Recorded invalidations:', stats.operationCount);
console.log('Locked key count:', stats.lockedKeysCount);

console.log(msq.getTransactionStats());
```


## Q3: Will read-only optimization affect data consistency?

**A**: No.

- Read-only transactions are still executed under transaction isolation level
- It just does not invalidate the cache and does not affect data accuracy.
- Data read within a transaction is still a consistent snapshot


## Q4: Can cache locking be disabled for one transaction?

**A**: Yes. Pass `enableCacheLock: false` to transaction options when you want driver transaction semantics without the process-local cache lock. Cache invalidation still follows the documented best-effort boundary.

```javascript
await msq.withTransaction(async (tx) => {
    await collection('users').updateOne(
        { _id: 1 },
        { $set: { status: 'active' } },
        { session: tx.session }
    );
}, {
    enableCacheLock: false
});
```

---

## Summary


## What to measure

| Scenario | Useful metric |
|------|------|
| Query-heavy transaction flow | `readOnlyRatio`, cache hit rate outside transactions |
| Write-heavy transaction flow | `successRate`, `p95Duration`, MongoDB write conflicts |
| Mixed read/write flow | Transaction duration and number of operations inside the callback |


## Suggestions

1. Keep transaction callbacks small and idempotent.
2. Monitor `getTransactionStats()` regularly.
3. Tune timeout, retry, and cache-lock settings from measured behavior.
