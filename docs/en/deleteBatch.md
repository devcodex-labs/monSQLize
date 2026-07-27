# deleteBatch - delete documents in batches

## API parameter description

## Method signature

```typescript
collection(name: string).deleteBatch(
  filter: object,
  options?: DeleteBatchOptions
): Promise<DeleteBatchResult>
```

## Detailed explanation of parameters

**First parameter: filter** (required)
- Type: `object`
- Description: Deletion condition, same as `deleteMany`

**Second parameter: options** (optional)

| Parameters | Type | Default value | Description |
|------|------|--------|------|
| **batchSize** | `number` | `1000` | Number of documents deleted in each batch |
| **estimateProgress** | `boolean` | `true` | Whether to pre-count the total number (for progress percentage) |
| **onProgress** | `Function` | - | Progress callback function `(progress) => {}` |
| **onError** | `string` | `'stop'` | Error handling strategy: `'stop'`/`'skip'`/`'collect'`/`'retry'` |
| **retryAttempts** | `number` | `3` | The maximum number of retries for a failed batch (when onError='retry') |
| **retryDelay** | `number` | `1000` | Retry delay time (milliseconds) |
| **onRetry** | `Function` | - | Retry callback function `(retryInfo) => {}` |
| **writeConcern** | `object` | `{ w: 1 }` | Write confirmation level |
| **comment** | `string` | - | Operation comments (for log tracking) |

## Return value

```typescript
{
  acknowledged: boolean,      //Is it confirmed
  totalCount: number | null,  //Total number of documents (valid when estimateProgress=true)
  deletedCount: number,       //Number of successful deletions
  batchCount: number,         //Total number of batches
  errors: Array<Object>,      //error list
  retries: Array<Object>      //Retry record list
}
```

## Progress callback parameters

```typescript
{
  currentBatch: number,    //Current batch number (starting from 1)
  totalBatches: number,    //Total number of batches
  deleted: number,         //Deleted quantity
  total: number | null,    //Total quantity (valid when estimateProgress=true)
  percentage: number | null, //Complete percentage (0-100, has value when estimateProgress=true)
  errors: number,          //number of errors
  retries: number          //Number of retries
}
```

---

## Usage example

## 1. Basic usage - clear expired logs

```javascript
//Delete logs older than 90 days
const expireDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

const result = await collection('logs').deleteBatch(
    { createdAt: { $lt: expireDate } },
    { batchSize: 5000 }
);

console.log(`Delete ${result.deletedCount} expired logs`);
```

## 2. With progress monitoring - cleaning large amounts of data

```javascript
const result = await collection('logs').deleteBatch(
    { level: 'debug' },
    {
        batchSize: 5000,
        estimateProgress: true,  //Pre count, display percentage
        onProgress: (progress) => {
            console.log(`Progress: ${progress.percentage}% (${progress.deleted}/${progress.total} items)`);
        }
    }
);
```

**Example output**:
```text
Progress: 20% (100000/500000 items)
Progress: 40% (200000/500000 items)
Progress: 60% (300000/500000 items)
Progress: 80% (400000/500000 items)
Progress: 100% (500000/500000 items)
```

## 3. No pre-count - avoid performance overhead

```javascript
//When the amount of data is particularly large, counting in advance is very slow, so you don’t need to count.
const result = await collection('logs').deleteBatch(
    { status: 'archived' },
    {
        batchSize: 5000,
        estimateProgress: false,  //No pre-count
        onProgress: (progress) => {
            //percentage is null, but you can still see the deleted count
            console.log(`Deleted: ${progress.deleted} items (batch ${progress.currentBatch})`);
        }
    }
);
```

## 4. Error handling - stop strategy (default)

```javascript
const result = await collection('logs').deleteBatch(
    { userId: { $in: userIds } },
    {
        batchSize: 1000,
        onError: 'stop'  //Stop immediately when encountering an error
    }
);

if (result.errors.length > 0) {
    console.error('Delete failed:', result.errors[0].message);
}
```

## 5. Error handling - skip strategy

```javascript
const result = await collection('temp_data').deleteBatch(
    { category: 'test' },
    {
        batchSize: 5000,
        onError: 'skip'  //Skip failed batches and continue with subsequent batches
    }
);

console.log(`Successfully deleted: ${result.deletedCount} items`);
console.log(`Failure batch: ${result.errors.length}`);
```

## 6. Error handling - retry strategy (recommended)

```javascript
const result = await collection('logs').deleteBatch(
    { status: 'expired' },
    {
        batchSize: 5000,
        onError: 'retry',      //Automatically retry on failure
        retryAttempts: 3,      //Retry up to 3 times
        retryDelay: 1000,      //1 second between retries
        onRetry: (info) => {
            console.log(`Batch ${info.batchIndex + 1} retry ${info.attempt}...`);
        }
    }
);

console.log(`Number of retries: ${result.retries.length}`);
```

## 7. Error handling - collect strategy

```javascript
const result = await collection('logs').deleteBatch(
    { type: 'temp' },
    {
        batchSize: 1000,
        onError: 'collect'  //Collect all errors and continue execution
    }
);

//View all errors
result.errors.forEach((err, idx) => {
    console.log(`Batch ${err.batchIndex + 1} Error: ${err.message}`);
});
```

## 8. Complex query conditions

```javascript
//Delete documents that match multiple criteria
const result = await collection('orders').deleteBatch(
    {
        status: 'cancelled',
        createdAt: { $lt: new Date('2024-01-01') },
        $or: [
            { paymentStatus: 'unpaid' },
            { amount: { $eq: 0 } }
        ]
    },
    {
        batchSize: 5000,
        estimateProgress: true,
        onProgress: (p) => {
            console.log(`Delete progress: ${p.percentage}%`);
        }
    }
);
```

## 9. Use comment to track operations

```javascript
const result = await collection('logs').deleteBatch(
    { level: 'debug' },
    {
        batchSize: 5000,
        comment: 'cleanup-debug-logs'  //It will be displayed in the slow query log
    }
);
```

---

## Performance optimization suggestions

## 1. Batch size selection

| Data volume | Recommended batchSize | Reason |
|--------|---------------|------|
| < 100,000 | 1000-2000 | Small batch, quick response |
| 100,000-1 million | 3000-5000 | Balance performance and memory |
| > 1 million | 5000-10000 | Large batches, reducing network overhead |

```javascript
//Example: Dynamically adjust based on data volume
const totalCount = await collection('logs').count({ status: 'expired' });
const batchSize = totalCount > 1000000 ? 10000 : 5000;

await collection('logs').deleteBatch(
    { status: 'expired' },
    { batchSize }
);
```

## 2. Whether to count in advance

```javascript
//✅ Small data volume: count in advance, display progress
if (estimatedCount < 1000000) {
    await collection('logs').deleteBatch(filter, {
        estimateProgress: true  //Show percentage
    });
}

//✅ Large data volume: no count to avoid performance overhead
else {
    await collection('logs').deleteBatch(filter, {
        estimateProgress: false  //Doesn't show percentage, but faster
    });
}
```

## 3. Index optimization

```javascript
//Make sure there is an index before deleting
await collection('logs').createIndex({ createdAt: 1 });

//and then delete
await collection('logs').deleteBatch(
    { createdAt: { $lt: expireDate } },
    { batchSize: 5000 }
);
```

## 4. Wrong strategy selection

| Scenario | Recommended strategy | Reason |
|------|---------|------|
| Production environment cleanup | **retry** | Automatically retry to reduce failures |
| Test data cleaning | **skip** | Quick cleaning, skip failures |
| Deletion of critical data | **stop** | Stop immediately when an error occurs to ensure consistency |
| Batch cleaning tasks | **collect** | Collect all errors and process them afterwards |

---

## FAQ

## Q1: What is the difference between deleteBatch and deleteMany?

| Compare items | deleteBatch | deleteMany |
|--------|-------------|------------|
| **Applicable data volume** | > 10000 items | < 10000 items |
| **Memory usage** | Constant (streaming) | Linear growth |
| **Progress Monitoring** | ✅ Supported | ❌ Not Supported |
| **Error Handling** | ✅ 4 Strategies | ❌ Only Fail All |
| **Auto Retry** | ✅ Supported | ❌ Not Supported |
| **Performance** | Better for large data volumes | Faster for small data volumes |

**Suggestions**:
- Data volume < 10000 items → use `deleteMany`
- Data volume ≥ 10000 → use `deleteBatch`

## Q2: Will deleteBatch cause data inconsistency?

**Answer**: `deleteBatch` processes matching `_id` values through a cursor and deletes them in batches. It does not create a MongoDB transaction or guarantee snapshot isolation by itself. If you need a transactional snapshot, run it inside an explicit transaction and pass the transaction `session`.

```javascript
//✅ Security: Even if other operations insert new data at the same time, it will not be deleted accidentally.
await collection('logs').deleteBatch(
    { createdAt: { $lt: expireDate } },
    { batchSize: 5000 }
);
```

## Q3: How do I know which documents have been deleted?

```javascript
//Method 1: Query before deleting
const toDelete = await collection('logs').find({ status: 'expired' });
console.log('Will be deleted:', toDelete.map(d => d._id));

//then delete
await collection('logs').deleteBatch({ status: 'expired' });

//Method 2: Use soft delete
await collection('logs').updateBatch(
    { status: 'expired' },
    { $set: { deleted: true, deletedAt: new Date() } }
);
```

## Q4: Will deleteBatch trigger slow query logs?

**Answer**: Yes. If the delete operation exceeds the threshold (default 500ms), slow query logs will be recorded.

```javascript
//You can see it in the slow query log
//[WARN] [deleteBatch] Slow operation warning {
//   ns: 'mydb.logs',
//   duration: 25000,
//   deletedCount: 500000,
//   batchCount: 100
// }
```

## Q5: Can deleteBatch be used in a transaction?

**Answer**: Yes, but please note:

```javascript
const session = await msq.startSession();

try {
    await session.withTransaction(async () => {
        //✅Supports use in transactions
        await collection('orders').deleteBatch(
            { status: 'cancelled' },
            { batchSize: 1000 }
        );

        await collection('payments').deleteBatch(
            { orderId: { $in: cancelledIds } },
            { batchSize: 1000 }
        );
    });
} finally {
    await session.endSession();
}
```

## Q6: How to estimate the deletion time?

```javascript
//Performance Reference (In-Memory Database)
//Deletion speed: about 30000-50000 items/second

const totalCount = 1000000;
const estimatedTime = totalCount / 40000;  //about 25 seconds

console.log(`Estimated time: ${Math.ceil(estimatedTime)} seconds`);
```

---

## References

- [updateBatch - Batch update documents](./updateBatch.md)
- [insertBatch - Insert documents in batches](./insertBatch.md)
- [find - streaming query](./find.md)
- [deleteMany - Batch deletion (small data volume)](./delete-many.md)
- [Usage Example](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/batch-operations.ts)
- [Batch write test](../../test/unit/writes/batch.test.ts)
