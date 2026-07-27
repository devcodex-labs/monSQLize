# Business-level distributed lock

> **Deprecated compatibility page**: monSQLize keeps `withLock()`, `acquireLock()`, and `tryAcquireLock()` for existing callers, but business locking is no longer a recommended monSQLize capability. Prefer application/framework-level locking, such as the VextJS runtime layer, for new payment/order critical sections.

## Overview

monSQLize keeps business lock APIs for historical callers. These APIs are compatibility helpers, not the recommended boundary for new cross-process critical sections.

> **Current runtime boundary**: In the current v3 runtime, the convenience APIs `msq.withLock()`, `msq.acquireLock()`, and `msq.tryAcquireLock()` use the built-in process-local `LockManager`. They coordinate callers inside the same Node.js process, but they do not provide cross-worker or cross-instance mutual exclusion by themselves. The process-local lock also does not auto-renew while the callback is running; if the callback runs longer than `ttl`, the lock can expire before the callback returns. For Egg.js cluster workers, payment flows, order de-duplication, or other cross-process critical sections, wire and verify a Redis-backed `DistributedCacheLockManager` path explicitly and pair it with idempotency or fencing at the business layer.


## Compatibility Scope

- `withLock()`, `acquireLock()`, and `tryAcquireLock()` remain available for existing monSQLize callers.
- The convenience APIs use the built-in process-local `LockManager` unless an application explicitly wires a Redis-backed lock manager.
- Redis-backed compatibility integrations can use TTL and retry options, but there is no automatic watchdog renewal or fencing-token contract.
- New payment, order, or fulfillment critical sections should put locking, idempotency, and recovery in the application/framework layer.


## Legacy scenarios

| Previously used for | Current guidance |
|------|------|
| Complex order creation | Keep only for existing compatibility code; prefer framework-level locks plus idempotency for new code |
| Inventory deduction | Prefer database conditions, transactions, or application-level coordination depending on consistency needs |
| Scheduled task deduplication | Prefer the scheduler/framework lease mechanism when available |
| External API call | Prefer durable outbox/idempotency handling around the external side effect |


## Not applicable scenarios

| Scenario | Recommended solution |
|------|---------|
| Simple Inventory Deduction (-1) | Transaction + Condition Update |
| Prevent users from clicking repeatedly | Rate limiting (frame layer) |
| Strong consistency across services | Using Redlock or ZooKeeper |

---

## Legacy usage example


## 1. Install dependencies

monSQLize includes the Redis adapter dependency in its package dependency set. You still need to provide a Redis service and configure an application-side Redis client through `cache.distributed`.


## 2. Configuration

```javascript
import MonSQLize from 'monsqlize';
const Redis = require('ioredis');

const redis = new Redis('redis://localhost:6379');

const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'mydb',
    config: { uri: 'mongodb://localhost:27017' },
    cache: {
        transaction: {
            distributedLock: {
                redis: redis,                       //Redis instance
                keyPrefix: 'myapp:lock:'           //Lock key prefix (optional)
            }
        }
    }
});
```


## 3. Use

```javascript
await msq.connect();

// Existing compatibility code can still use the legacy business lock API.
await msq.withLock('inventory:SKU123', async () => {
    const product = await inventory.findOne({ sku: 'SKU123' });
    if (product.stock >= 1) {
        await inventory.updateOne(
            { sku: 'SKU123' },
            { $inc: { stock: -1 } }
        );
    }
});
```

---

## API Reference


## withLock(key, callback, options?)

Legacy convenience wrapper for managing a lock around a callback.

**Signature**:
```typescript
async withLock<T>(
    key: string,
    callback: () => Promise<T>,
    options?: LockOptions
): Promise<T>
```

**Parameters**:

| Parameters | Type | Required | Default value | Description |
|------|------|------|--------|------|
| `key` | string | ✅ | - | The unique identifier of the lock |
| `callback` | Function | ✅ | - | Function executed after acquiring the lock |
| `options.ttl` | number | ❌ | 10000 | Lock expiration time (milliseconds) |
| `options.retryTimes` | number | ❌ | 3 | Number of retries |
| `options.retryDelay` | number | ❌ | 100 | Retry interval (milliseconds) |
| `options.fallbackToNoLock` | boolean | ❌ | false | Downgrade when Redis is unavailable |

**Return value**: `Promise<T>` - return value of callback

**Example**:

```javascript
//Basic usage
await msq.withLock('resource:123', async () => {
    //critical section code
    await doSomething();
});

//Custom options
await msq.withLock('resource:123', async () => {
    await doSomething();
}, {
    ttl: 5000,        //Release automatically after 5 seconds
    retryTimes: 5,    //Retry 5 times
    retryDelay: 200   //Each interval is 200ms
});

//return value
const result = await msq.withLock('resource:123', async () => {
    return await calculateSomething();
});
console.log(result);
```

---


## acquireLock(key, options?)

Manually acquire the lock (blocking retries).

**Signature**:
```typescript
async acquireLock(
    key: string,
    options?: LockOptions
): Promise<Lock>
```

**Return value**: `Promise<Lock>` - Lock object

**Lock object methods**:

| Method | Description |
|------|------|
| `release()` | Release lock |
| `renew(ttl?)` | Renewal |
| `isHeld()` | Check if the lock is still held |
| `getHoldTime()` | Acquisition lock holding time (milliseconds) |

**Example**:

```javascript
const lock = await db.acquireLock('resource:123', {
    ttl: 10000,
    retryTimes: 3
});

try {
    //business logic
    await doSomething();

    //Optional: Renewal
    await lock.renew(5000);

} finally {
    await lock.release();
}
```

---


## tryAcquireLock(key, options?)

Try to acquire the lock (without blocking).

**Signature**:
```typescript
async tryAcquireLock(
    key: string,
    options?: Omit<LockOptions, 'retryTimes'>
): Promise<Lock | null>
```

**Return value**: `Promise<Lock | null>` - Lock object or null

**Example**:

```javascript
const lock = await db.tryAcquireLock('resource:123', { ttl: 5000 });

if (lock) {
    try {
        //business logic
        await doSomething();
    } finally {
        await lock.release();
    }
} else {
    console.log('Resources are occupied');
}
```

---


## getLockStats()

Get lock statistics.

**Signature**:
```typescript
getLockStats(): LockStats
```

**Return Value**:

```typescript
interface LockStats {
    locksAcquired: number;    //The number of times the lock was successfully acquired
    locksReleased: number;    //The number of times the lock was successfully released
    lockChecks: number;       //Number of lock checks
    errors: number;           //number of errors
    lockKeyPrefix: string;    //Lock key prefix
    maxDuration: number;      //Lock maximum duration
}
```

**Example**:

```javascript
const stats = db.getLockStats();
console.log(`Acquired locks: ${stats.locksAcquired} times`);
console.log(`Locks released: ${stats.locksReleased} times`);
console.log(`Errors: ${stats.errors} times`);
```

---

## Configuration options


## Global configuration

Configure in the `MonSQLize` constructor:

```javascript
new MonSQLize({
    cache: {
        transaction: {
            distributedLock: {
                //Redis instance (required)
                redis: redisInstance,

                //Lock key prefix (optional, default 'monsqlize:cache:lock:')
                keyPrefix: 'myapp:lock:'
            }
        }
    }
});
```


## API level configuration

The default value can be overridden on each call:

```javascript
await msq.withLock('key', callback, {
    ttl: 5000,          //Override default TTL
    retryTimes: 5,      //Override the default number of retries
    retryDelay: 200,    //Override the default retry interval
    fallbackToNoLock: true  //Enable downgrade
});
```

---

## Usage scenarios


## Scenario 1: Inventory deduction (complex business)

```javascript
await msq.withLock(`inventory:${sku}`, async () => {
    const product = await inventory.findOne({ sku });
    const user = await users.findOne({ userId });

    //Complex calculations: member discounts, coupons, points deductions
    const finalPrice = calculatePrice(product, user, coupon);

    if (user.balance < finalPrice) {
        throw new Error('Insufficient balance');
    }

    //Multiple table update
    await inventory.updateOne({ sku }, { $inc: { stock: -1 } });
    await users.updateOne({ userId }, { $inc: { balance: -finalPrice } });
    await orders.insertOne({ userId, sku, price: finalPrice });
});
```


## Scenario 2: Order creation (lock + transaction)

```javascript
await msq.withLock(`order:${userId}:${sku}`, async () => {
    await msq.withTransaction(async (tx) => {
        //intra-transaction operations
        await inventory.updateOne(
            { sku, stock: { $gte: 1 } },
            { $inc: { stock: -1 } },
            { session: tx.session }
        );

        await orders.insertOne({
            userId, sku, createdAt: new Date()
        }, { session: tx.session });
    });
});
```


## Scenario 3: Scheduled task prevention

```javascript
//Scheduled tasks (executed at 0 o'clock every day)
async function dailyReportTask() {
    const lock = await db.tryAcquireLock('cron:daily-report', {
        ttl: 60000  //60 seconds
    });

    if (!lock) {
        console.log('Other instances are executing, skip');
        return;
    }

    try {
        await generateDailyReport();
    } finally {
        await lock.release();
    }
}
```


## Scenario 4: External API call

```javascript
await msq.withLock(`payment:${orderId}`, async () => {
    //Call third-party payment
    const paymentResult = await thirdPartyPayment.charge({
        orderId,
        amount: 100
    });

    //Update order status
    await orders.updateOne(
        { _id: orderId },
        {
            $set: {
                status: 'paid',
                paymentId: paymentResult.id
            }
        }
    );
});
```

---

## Cooperate with transactions

Business locks work seamlessly with monSQLize transactions:

```javascript
//Recommendation: lock outside, affairs inside
await msq.withLock('resource:123', async () => {
    await msq.withTransaction(async (tx) => {
        //Transaction operations
        await collection1.updateOne({}, {}, { session: tx.session });
        await collection2.insertOne({}, { session: tx.session });
    });
});
```

**Why is it locked out? **
- Locks protect the entire business process (including pre-transaction queries and calculations)
- Transactions ensure the atomicity of database operations
- The two are complementary and do not conflict with each other

---

## Error handling


## Error type

| Error | Description |
|------|------|
| `LockAcquireError` | Failed to acquire lock (still failed after retrying) |
| `LockTimeoutError` | Lock operation timed out |
| Redis connection error | Redis unavailable |


## Processing example

```javascript
const { LockAcquireError } = require('monsqlize');

try {
    await msq.withLock('resource:123', async () => {
        await doSomething();
    });
} catch (error) {
    if (error instanceof LockAcquireError) {
        //Lock is occupied
        console.log('The resource is busy, please try again later.');
        return { success: false, reason: 'busy' };
    }
    throw error;
}
```


## Downgrade strategy

```javascript
//Downgrade to lock-free execution when Redis is unavailable (use with caution)
await msq.withLock('resource:123', async () => {
    await doSomething();
}, {
    fallbackToNoLock: true  //⚠️ Use with caution!
});
```

**Downgrade Suggestions**:

| Scenario | Suggestions |
|------|------|
| Core business (orders, payments) | Throw exceptions, no downgrade |
| Non-core business (statistics, logs) | Can be downgraded |
| Scheduled tasks | Throw an exception and skip this execution |

---

## Best Practices


## 1. Unified management of lock keys

```javascript
// constants/lock-keys.js
const LockKeys = {
    INVENTORY: {
        key: (sku) => `inventory:${sku}`,
        ttl: 5000
    },
    ORDER_CREATE: {
        key: (userId, sku) => `order:create:${userId}:${sku}`,
        ttl: 10000
    }
};

//use
await msq.withLock(
    LockKeys.INVENTORY.key(sku),
    callback,
    { ttl: LockKeys.INVENTORY.ttl }
);
```


## 2. Lock granularity selection

```javascript
//❌ The granularity is too coarse: all orders share one lock
await msq.withLock('order', async () => { ... });

//✅ Suitable granularity: one lock for each user + product
await msq.withLock(`order:${userId}:${sku}`, async () => { ... });

//⚠️ Too fine granularity: one lock per request (meaningless)
await msq.withLock(`order:${requestId}`, async () => { ... });
```


## 3. TTL settings

```javascript
//experience value
{
    ttl: 5000    //Simple operation (inventory deduction)
    ttl: 10000   //General operations (order creation)
    ttl: 60000   //scheduled tasks
    ttl: 300000  //Long-term tasks (report generation)
}
```


## 4. Error handling

```javascript
//✅ Recommended: Complete error handling
try {
    await msq.withLock('key', async () => {
        await doSomething();
    });
} catch (error) {
    if (error instanceof LockAcquireError) {
        //Lock is occupied
        return { success: false, reason: 'busy' };
    }
    //Other errors
    throw error;
}
```


## 5. Monitoring statistics

```javascript
//Regularly check lock statistics
setInterval(() => {
    const stats = db.getLockStats();
    if (stats.errors > 100) {
        console.warn('Lock error rate is too high:', stats);
    }
}, 60000);
```

---

## FAQ


## Q1: What is the difference between business locks and transaction locks?

| Comparison items | Transaction lock | Business lock compatibility API |
|--------|--------------|----------------|
| **Purpose** | Protect cache consistency | Protect business logic |
| **Lifecycle** | Transaction duration | User defined |
| **API** | Internal use | Public API |
| **Key management** | session binding | user specified |


## Q2: When might legacy code keep using a business lock?

**Existing code sometimes kept business locks for**:
- Complex business flows (query → calculation → multi-table update)
- Scheduled-task deduplication
- Database updates after an external API call

**New code should usually prefer other boundaries for**:
- Simple deduction (database condition + transaction)
- Repeated user clicks (rate limiting)
- Payment/order critical sections that need cross-process guarantees, renewal, recovery, or fencing


## Q3: What should I do if Redis is unavailable?

```javascript
//Method 1: Throw an exception
try {
    await msq.withLock('key', callback);
} catch (error) {
    if (error.message.includes('Redis unavailable')) {
        //Record alarm
    }
}

//Method 2: Downgrade (use with caution)
await msq.withLock('key', callback, {
    fallbackToNoLock: true
});
```


## Q4: What happens if the lock times out?

The lock will be released automatically (TTL mechanism) and will not cause deadlock.


## Q5: How to avoid deadlock?

- Prefer application/framework-level coordination for new critical sections.
- Existing compatibility code can use `withLock` for auto release inside one process.
- Use `try...finally` when manually acquiring the lock.
- Set a reasonable TTL and keep callback execution shorter than the TTL.


## Q6: Does lock renewal support?

Supported, use `lock.renew(ttl)`:

```javascript
const lock = await db.acquireLock('key');
try {
    await doSomething();
    await lock.renew(5000);  //Renewal 5 seconds
    await doMoreThings();
} finally {
    await lock.release();
}
```

---

## Comparison with professional lock library

| Features | monSQLize legacy lock | Redlock | node-redis-warlock |
|------|----------------|---------|-------------------|
| **Installation** | Package includes Redis adapter dependency; application provides Redis service/client | Additional installation | Additional installation |
| **Redis Node** | Single node | Multi-node | Single node |
| **Consistency** | Eventually consistent | Strong consistency | Eventually consistent |
| **Complexity** | Simple | Complex | Simple |
| **Applicable scenarios** | Existing monSQLize callers | Finance/core | Simple scenarios |
| **Integrated with monSQLize** | Built-in compatibility API | Manual required | Manual required |

**Current guidance**:
- Keep monSQLize business locks only for existing compatibility code.
- Use application/framework-level locking, idempotency, or a dedicated distributed-lock library for new payment/order critical sections.
- For finance/payment paths, verify Redlock, consensus, or fencing semantics outside monSQLize.

---

## Reference

- [Program Document]
- [Sample code](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/lock.ts)
- [Unit Test](../../test/unit/lock/lock.test.ts)
