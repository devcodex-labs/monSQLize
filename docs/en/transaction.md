# MongoDB Transaction Guide

## Overview

monSQLize wraps MongoDB driver sessions with `withTransaction()` and `startSession()` helpers. The ACID boundary is MongoDB's transaction/session boundary; monSQLize adds retry, timeout, statistics, and cache-invalidation coordination around that driver behavior.


## Core Features

- ✅ **Automatic Transaction Management** (withTransaction - Recommended)
- ✅ **Manual transaction management** (startSession - Advanced usage)
- ✅ **Transaction-aware cache policy** (session reads bypass shared query cache; writes record post-commit invalidations)
- ✅ **Process-local cache barrier/lock** (short-lived protection around cache invalidation)
- ✅ **Auto-Retry** (Auto-retry on transient errors)
- ✅ **Timeout processing** (automatically interrupt long transactions)
- ✅ **Monitoring indicators** (execution time, success rate, etc.)
- ✅ **Read attention/read preference/causal consistency**


## Prerequisites

- ✅ MongoDB 4.0+ replica set or sharded cluster
- ✅ Node.js 18+

---

## Quick start


## 1. Initialization and configuration

```javascript
import MonSQLize from 'monsqlize';

const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'mydb',
    config: {
        uri: 'mongodb://localhost:27017?replicaSet=rs0', // Must be a replica set
        options: {}
    },
    cache: {
        defaultTtl: 60000, //Cache for 60 seconds
        maxEntries: 1000  //Up to 1000 items
    }
});

await msq.connect();
const { collection } = await msq.connect();
```


## 2. Use automatic transactions (recommended⭐)

The simplest way to automatically manage commits, rollbacks and retries:

```javascript
//Example 1: Transfer
await msq.withTransaction(async (tx) => {
    const accounts = collection('accounts');

    //Debit Alice
    await accounts.updateOne(
        { userId: 'alice' },
        { $inc: { balance: -100 } },
        { session: tx.session } //🔑 Pass in session
    );

    //Add money to Bob
    await accounts.updateOne(
        { userId: 'bob' },
        { $inc: { balance: 100 } },
        { session: tx.session }
    );

    //✅ Success: Automatic submission
    //❌ Failure: automatic rollback
});
```

```javascript
//Example 2: Inventory deduction + create order
const orderId = await msq.withTransaction(async (tx) => {
    const inventory = collection('inventory');
    const orders = collection('orders');

    //Check inventory
    const product = await inventory.findOne(
        { productId: 'SKU123' },
        { session: tx.session }
    );

    if (product.stock < 10) {
        throw new Error('Insufficient stock');
    }

    //deduction inventory
    await inventory.updateOne(
        { productId: 'SKU123' },
        { $inc: { stock: -10 } },
        { session: tx.session }
    );

    //Create order
    const order = {
        orderId: 'ORDER001',
        productId: 'SKU123',
        quantity: 10,
        createdAt: new Date()
    };
    await orders.insertOne(order, { session: tx.session });

    return order.orderId;
});

console.log('Order created successfully:', orderId);
```


## 3. Use manual transactions (advanced usage)

Use when you need fine control over the transaction life cycle:

```javascript
const tx = await msq.startSession();

try {
    await tx.start();

    //perform operations
    await collection('accounts').updateOne(
        { userId: 'alice' },
        { $inc: { balance: -100 } },
        { session: tx.session }
    );

    //Manual submission
    await tx.commit();
} catch (error) {
    //Manual rollback
    await tx.abort();
    throw error;
} finally {
    //Release resources
    await tx.end();
}
```

---

## Configuration options


## Global configuration (constructor)

```javascript
const msq = new MonSQLize({
    //...basic configuration
    transaction: {
        //⭐ Important: Caching is not used by default within transactions (to ensure data consistency)
        //If you want to use cache within a transaction, you need to explicitly specify the cache parameter when querying

        //Whether to enable automatic retry (default: true)
        enableRetry: true,

        //Maximum number of retries (default: 3)
        maxRetries: 3,

        //Retry delay (ms, default: 100)
        retryDelay: 100,

        //Retry backoff factor (default: 2)
        retryBackoff: 2,

        //Default timeout (milliseconds, default: 30000)
        defaultTimeout: 30000,

        //Default read following (optional)
        defaultReadConcern: { level: 'majority' },

        //Write follow by default (optional)
        defaultWriteConcern: { w: 'majority' },

        //Cache lock maximum duration (ms, default: 300000)
        lockMaxDuration: 300000,

        //Cache lock cleanup interval (milliseconds, default: 10000)
        lockCleanupInterval: 10000
    }
});
```


## Single transaction configuration

```javascript
await msq.withTransaction(async (tx) => {
    //transaction logic
}, {
    //Read attention level
    readConcern: { level: 'snapshot' },

    //write level of concern
    writeConcern: { w: 'majority' },

    //Read preferences
    readPreference: 'primary',

    //Causal consistency (default: true)
    causalConsistency: true,

    //Timeout (milliseconds)
    timeout: 60000,

    //Maximum number of retries (overrides global configuration)
    maxRetries: 5
});
```

---

## API Reference


## msq.withTransaction(callback, options)

Automatically manage transactions (recommended).

**Parameters**:
- `callback(tx)`: transaction callback function
  - `tx.session`: MongoDB session object
  - `tx.id`: transaction unique identifier
  - `tx.state`: Transaction status ('pending' | 'active' | 'committed' | 'aborted')
- `options`: transaction options (optional)

**Returns**: Promise<any> - returns the return value of callback

**Example**:
```javascript
const result = await msq.withTransaction(async (tx) => {
    //Operations within a transaction must be passed into the session
    await collection('users').updateOne(
        { _id: 1 },
        { $set: { name: 'Alice' } },
        { session: tx.session }
    );

    return { success: true };
});
```


## msq.startSession(options)

Create a manual transaction session.

**Parameters**:
- `options`: Transaction options (same as withTransaction)

**Return**: Promise<Transaction>

**Transaction instance method**:
- `start()`: Start transaction
- `commit()`: Commit transaction
- `abort()`: rollback transaction
- `end()`: Release resources

**Example**:
```javascript
const tx = await msq.startSession({
    readConcern: { level: 'majority' },
    timeout: 60000
});

try {
    await tx.start();

    //perform operations
    await collection('accounts').updateOne(
        { _id: 1 },
        { $inc: { balance: -100 } },
        { session: tx.session }
    );

    await tx.commit();
} catch (error) {
    await tx.abort();
    throw error;
} finally {
    await tx.end();
}
```

---

## Caching strategy


## ⭐Default policy: no caching within transactions (recommended)

**Design Concept**: Transactions pursue data consistency, and caching pursues performance. By default, intra-transaction operations do not use caching, ensuring data accuracy.

```javascript
await msq.withTransaction(async (tx) => {
    //✅ Intra-transaction query: read directly from the database, without using cache
    const user = await collection('users').findOne(
        { _id: 1 },
        { session: tx.session }
        //No need to specify cache: 0, no caching by default
    );

    //✅ Intra-transaction writing: record a cache invalidation intent only when configured
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
});

// Cache invalidation is flushed only after the transaction commits successfully.
// If the transaction aborts, the pending invalidation intent is discarded.
// Post-commit cache invalidation is best-effort; a cache failure does not roll back the database commit.

//✅ Query outside transaction: use cache normally
const user = await collection('users').findOne(
    { _id: 1 },
    { cache: 60000 } //Cache for 60 seconds
);
```


## Session reads and cache

When an operation receives `session: tx.session`, monSQLize forwards the session to the MongoDB driver and skips the shared query-result cache. There is no separate transaction-cache isolation flag in the public API. Keep repeated transaction reads inside the driver snapshot, or move cacheable reads outside the transaction when that is safe for your workflow.


## Cache lock mechanism (when invalidation is configured)

**Function**: Record explicit cache invalidation intents during the transaction and keep a short-lived, process-local barrier until those intents are flushed after commit or discarded on abort.

```javascript
await msq.withTransaction(async (tx) => {
    //1. Update data
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
    //🔒 Records the configured cache invalidation intent in this process

    //2. Other reads in this process bypass or avoid refilling affected cache keys

    //3. Transaction submission
    await tx.commit();
    //🔓 Release process-local lock + flush recorded invalidations
});
```

The cache lock manager is process-local. Cross-instance cache coherence depends on post-commit distributed invalidation when configured, and remains best-effort/eventual rather than an atomic cache/DB commit.


## Cache strategy comparison

| Strategy | Advantages | Disadvantages | Applicable scenarios |
|------|------|------|---------|
| **No caching (default)** | High data consistency and simplicity | Slightly lower performance | Most scenarios |
| **Session reads** | Uses MongoDB snapshot semantics | Does not use shared query cache | Reads inside the transaction |
| **Cache barrier/lock** | Reduces stale cache refill windows in this process | Cross-instance coherence is still eventual | Automatically used for transaction invalidation |

---

## Best Practices


## 1. Idempotent design ⭐

**Important**: Transaction callbacks must be idempotent as automatic retries may be possible.

```javascript
//✅ Good design: use unique identifiers
await msq.withTransaction(async (tx) => {
    await collection('orders').insertOne({
        orderId: 'ORDER_' + Date.now(), //Unique ID
        status: 'pending'
    }, { session: tx.session });
});

//❌ Bad design: relying on external state
let counter = 0;
await msq.withTransaction(async (tx) => {
    counter++; //Retrying will cause the counter to be incremented multiple times
    await collection('logs').insertOne({
        logId: counter //Not idempotent
    }, { session: tx.session });
});
```


## 2. Timeout setting

```javascript
//Short transactions (recommended)
await msq.withTransaction(async (tx) => {
    //Simple operation
}, { timeout: 5000 });

//Long transactions (use with caution)
await msq.withTransaction(async (tx) => {
    //Complex operations
}, { timeout: 60000 }); //MongoDB default limit is 60 seconds
```


## 3. Error handling

```javascript
try {
    await msq.withTransaction(async (tx) => {
        //business logic
        const user = await collection('users').findOne(
            { _id: 1 },
            { session: tx.session }
        );

        if (!user) {
            throw new Error('User does not exist');
        }

        //More actions...
    });
} catch (error) {
    if (error.message === 'User does not exist') {
        //business error
        console.error('Business error:', error.message);
    } else if (error.errorLabels?.includes('TransientTransactionError')) {
        //MongoDB transient error (automatically retried)
        console.error('Transaction failed:', error.message);
    } else {
        //Other errors
        console.error('Unknown error:', error);
    }
}
```


## 4. Performance optimization

```javascript
//✅ Good practice: Verify first, then transaction
async function transfer(fromId, toId, amount) {
    //1. Pre-check outside the transaction (fail fast)
    const fromUser = await collection('users').findOne({ _id: fromId });
    if (!fromUser || fromUser.balance < amount) {
        throw new Error('Insufficient balance');
    }

    //2. Execution within a transaction
    await msq.withTransaction(async (tx) => {
        await collection('users').updateOne(
            { _id: fromId },
            { $inc: { balance: -amount } },
            { session: tx.session }
        );

        await collection('users').updateOne(
            { _id: toId },
            { $inc: { balance: amount } },
            { session: tx.session }
        );
    });
}

//❌ Bad practice: all logic within transactions
await msq.withTransaction(async (tx) => {
    //Complex business logic
    //multiple network calls
    //...(transaction occupied for a long time)
});
```


## 5. Monitoring and logging

```javascript
const tx = await msq.startSession();

try {
    await tx.start();

    console.log('Transaction starts:', tx.id);

    //business logic
    await collection('users').updateOne(
        { _id: 1 },
        { $set: { lastLogin: new Date() } },
        { session: tx.session }
    );

    await tx.commit();
    console.log('Transaction submitted successfully:', tx.id);
} catch (error) {
    await tx.abort();
    console.error('Transaction rollback:', tx.id, error);
    throw error;
} finally {
    await tx.end();
}
```

---

## FAQ


## Q1: Why does intra-transaction query not use cache?

**A**: This is the default behavior by design. Reason:
1. **Data consistency first** - Transactions pursue accuracy, cache may have delays
2. **Avoid dirty reads** - The latest data should be read within the transaction
3. **Simplified use** - Users do not need to consider caching issues

If performance optimization is required, the `cache` option can be enabled explicitly.


## Q2: When to use manual transactions?

**A**: Use `withTransaction` (auto) in most cases. Consider manual operation in the following situations:
- Need to make complex judgments before starting a transaction
- Additional verification is required before committing
- Need for fine-grained control of transaction life cycle


## Q3: How to debug transaction failure?

**A**: Check the following points:
1. **Is MongoDB a replica set? ** - Single node does not support transactions
2. **Is the connection string correct? ** - requires `?replicaSet=rs0`
3. **Is the timeout reasonable? ** - Default 30 seconds
4. **Is the callback idempotent? ** - may retry multiple times

`withTransaction()` retries transient transaction errors and retries `commitTransaction()` when the driver marks the result as `UnknownTransactionCommitResult`.


## Q4: Will cache locks affect performance?

**A**: The impact is minimal. Reason:
- The lock is only in effect for the duration of the transaction (usually a short period of time)
- The lock is process-local memory (no network I/O)
- Checking of locks is very fast (O(1) hash lookup)

The cache lock is process-local. Cross-instance cache coherence is handled by distributed invalidation after commit on a best-effort basis; use application/framework-level coordination when a critical section must be mutually exclusive across processes.


## Q5: Can multiple databases be operated within a transaction?

**A**: Yes, but there are restrictions:
- ✅ Multiple databases within the same MongoDB cluster
- ❌ Across MongoDB clusters (not supported)

```javascript
await msq.withTransaction(async (tx) => {
    //Operation db1.users
    await collection('users').updateOne(
        { _id: 1 },
        { $set: { status: 'active' } },
        { session: tx.session }
    );

    //Operate db2.logs (you need to obtain the collection of db2 first)
    const db2 = msq.db('db2');
    await db2.collection('logs').insertOne({
        action: 'user_activated',
        userId: 1
    }, { session: tx.session });
});
```


## Q6: Will concurrent transactions cause deadlock?

**A**: MongoDB automatically detects and throws `WriteConflict` errors. monSQLize will automatically retry if `enableRetry` is enabled.

---

## Performance optimization


## 1. Reduce intra-transaction operations

```javascript
//✅ Good practice
const validated = await preValidate(); //Outside affairs
if (validated) {
    await msq.withTransaction(async (tx) => {
        //Core operations only
    });
}

//❌ Bad practice
await msq.withTransaction(async (tx) => {
    await validate();  //within affairs
    await doWork();    //within affairs
});
```


## 2. Batch operation

```javascript
//✅ Good Practice: Use Bulk API
await msq.withTransaction(async (tx) => {
    await collection('users').updateMany(
        { status: 'inactive' },
        { $set: { status: 'deleted' } },
        { session: tx.session }
    );
});

//❌ Bad practice: looping single updates
await msq.withTransaction(async (tx) => {
    for (const user of users) {
        await collection('users').updateOne(
            { _id: user._id },
            { $set: { status: 'deleted' } },
            { session: tx.session }
        );
    }
});
```


## 3. Proper use of indexes

```javascript
//✅ Make sure the query field is indexed
await collection('users').createIndex({ userId: 1 });

await msq.withTransaction(async (tx) => {
    //Query using indexed fields (fast)
    const user = await collection('users').findOne(
        { userId: 'alice' }, //There is an index
        { session: tx.session }
    );
});
```


## 4. Monitor transaction performance

```javascript
//Get transaction statistics
const stats = msq.getTransactionStats();
if (stats) {
    console.log('Transaction statistics:', {
        total: stats.totalTransactions,
        successful: stats.successfulTransactions,
        failed: stats.failedTransactions,
        averageDuration: `${stats.averageDuration}ms`
    });
}
```

---

## Related documents

- [MongoDB transaction official document](https://docs.mongodb.com/manual/core/transactions/)
- [Sample code](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/transaction.ts)
