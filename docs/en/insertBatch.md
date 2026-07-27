# insertBatch - batch insertion (supports automatic retry)

## API parameter description

## Method signature

```typescript
collection(name: string).insertBatch(
  documents: object[],
  options?: InsertBatchOptions
): Promise<InsertBatchResult>
```

## Detailed explanation of parameters

**First parameter: documents** (required)
- Type: `object[]`
- Description: Array of documents to be inserted

**Second parameter: options** (optional)

| Parameters | Type | Default value | Description |
|------|------|--------|------|
| **batchSize** | `number` | `1000` | Number of documents inserted in each batch |
| **concurrency** | `number` | `1` | Number of concurrent batches (1=serial, >1=parallel) |
| **ordered** | `boolean` | `false` | Whether the batch is inserted in order |
| **onProgress** | `Function` | - | Progress callback function `(progress) => {}` |
| **onError** | `string` | `'stop'` | Error handling strategy: `'stop'`/`'skip'`/`'collect'`/`'retry'` |
| **retryAttempts** | `number` | `3` | Maximum number of retries for failed batches (valid when onError='retry') |
| **retryDelay** | `number` | `1000` | Retry delay time (milliseconds) |
| **onRetry** | `Function` | - | Retry callback function `(retryInfo) => {}` |
| **writeConcern** | `object` | `{ w: 1 }` | Write confirmation level |
| **bypassDocumentValidation** | `boolean` | `false` | Whether to bypass document validation |
| **comment** | `string` | - | Operation comments (for log tracking) |

## Return value

```typescript
{
  acknowledged: boolean,      //Is it confirmed
  totalCount: number,          //Total number of documents
  insertedCount: number,       //Number of successful insertions
  batchCount: number,          //Total number of batches
  errors: Array<Object>,       //error list
  retries: Array<Object>,      //Retry record list (new)
  insertedIds: Object          //Inserted document _id mapping table
}
```

## Progress callback parameters

```typescript
{
  currentBatch: number,    //Current batch number (starting from 1)
  totalBatches: number,    //Total number of batches
  inserted: number,        //Inserted quantity
  total: number,           //total quantity
  percentage: number,      //Complete percentage (0-100)
  errors: number,          //number of errors
  retries: number          //Number of retries (new)
}
```

---

## Usage example

## 1. Basic usage - automatic batch insertion

```javascript
const largeDataset = Array.from({ length: 10000 }, (_, i) => ({
  name: `User ${i + 1}`,
  email: `user${i + 1}@example.com`,
  createdAt: new Date()
}));

const result = await collection('users').insertBatch(largeDataset, {
  batchSize: 1000  // 1000 items per batch, automatically divided into 10 batches
});

console.log(`Successfully inserted ${result.insertedCount}/${result.totalCount} documents`);
console.log(`Total ${result.batchCount} batches, ${result.errors.length} errors`);
```

## 2. Progress monitoring

```javascript
await collection('products').insertBatch(largeDataset, {
  batchSize: 500,
  onProgress: (progress) => {
    console.log(
      `Progress: ${progress.percentage}%` +
      `(Batch ${progress.currentBatch}/${progress.totalBatches})`
    );
  }
});

//Output:
//Progress: 20% (Batch 1/5)
//Progress: 40% (Batch 2/5)
//Progress: 60% (Batch 3/5)
//Progress: 80% (Batch 4/5)
//Progress: 100% (Batch 5/5)
```

## 3. Automatic retry mechanism ⭐ New features

## 3.1 retry strategy - automatic retry on failure

```javascript
const result = await collection('items').insertBatch(unstableData, {
  batchSize: 1000,
  onError: 'retry',      //Automatically retry on failure
  retryAttempts: 3,      //Retry up to 3 times
  retryDelay: 1000,      //Delay 1 second for each retry
  onRetry: (retryInfo) => {
    console.log(
      `Batch ${retryInfo.batchIndex + 1} Retrying...` +
      `(${retryInfo.attempt}/${retryInfo.maxAttempts} times)`
    );
  }
});

console.log(`Success: ${result.insertedCount}`);
console.log(`Retries: ${result.retries.length} batches`);
console.log(`Final failure: ${result.errors.length} batches`);

//View retry details
result.retries.forEach(retry => {
  console.log(
    `Batch ${retry.batchIndex + 1}: Retry ${retry.attempts} times,` +
    `${retry.success ? 'success' : 'failed'}`
  );
});
```

## 4. Comparison of error handling strategies

## 4.1 stop strategy (default) - stop on error

```javascript
try {
  await collection('items').insertBatch(dataWithDuplicate, {
    batchSize: 1000,
    onError: 'stop'  //Stop immediately when encountering an error
  });
} catch (error) {
  console.log('Insertion failed:', error.message);
  //The previous successful batch has been inserted, but subsequent batches have not been executed.
}
```

## 4.2 skip strategy - skip failed batches

```javascript
const result = await collection('items').insertBatch(dataWithErrors, {
  batchSize: 1000,
  onError: 'skip'  //Skip failed batches and continue with subsequent batches
});

console.log(`Success: ${result.insertedCount}, failed batch: ${result.errors.length}`);
//Output: Success: 8000, Failure batch: 2
```

## 4.3 collect strategy - collect all errors

```javascript
const result = await collection('items').insertBatch(dataWithErrors, {
  batchSize: 1000,
  onError: 'collect'  //Collect all errors and complete execution
});

if (result.errors.length > 0) {
  console.log('Error details:');
  result.errors.forEach((err, idx) => {
    console.log(`Batch ${err.batchIndex + 1}: ${err.message}`);
  });
}
```

## 5. Concurrent insertion (accelerate big data import)

```javascript
//serial insert (default)
await collection('data').insertBatch(largeDataset, {
  batchSize: 1000,
  concurrency: 1  //Insert batch by batch
});

//Concurrent inserts (faster)
await collection('data').insertBatch(largeDataset, {
  batchSize: 1000,
  concurrency: 3  //3 batches of parallel inserts
});

//⚠️ Note: Too large a concurrency may overwhelm the database. Recommended value: 2-5
```

## 6. Combined with comment parameter (production environment)

```javascript
await collection('logs').insertBatch(logData, {
  batchSize: 2000,
  comment: 'DataMigration:logs:v2.0',  //Easy to track
  onProgress: (progress) => {
    if (progress.percentage % 10 === 0) {
      console.log(`Migration progress: ${progress.percentage}%`);
    }
  }
});
```

---

## Comparison of error handling strategies

| Strategy | Behavior | Applicable Scenarios | Performance |
|------|------|---------|------|
| **stop** | Stop immediately when an error occurs | High data consistency requirements | Fastest (stop when an error occurs) |
| **skip** | Skip failed batches | Allow partial failures | Medium |
| **collect** | Collect all errors | Full error report required | Slower (execute all) |
| **retry** ⭐ | Automatically retry failed batches | Network instability, temporary failure | Slowest (with retry delay) |

## Strategy Selection Guide

```javascript
//Data import - using skip or retry
await collection('products').insertBatch(importData, {
  onError: 'retry',  //Automatically retry temporary failures
  retryAttempts: 3,
  onProgress: (p) => console.log(`${p.inserted} items imported`)
});

//Data migration - using stop
await collection('users').insertBatch(migrationData, {
  onError: 'stop',  //Stop when encountering an error to ensure data integrity
  writeConcern: { w: 'majority', j: true }
});

//Data validation - using collect
const result = await collection('test').insertBatch(testData, {
  onError: 'collect'  //Collect all errors and generate a complete report
});

console.log(`Verification completed: ${result.insertedCount} successful, ${result.errors.length} failed`);
```

---

## Performance optimization suggestions

## 1. Batch size (batchSize)

```javascript
//❌ Too small - too many batches, large network overhead
await collection('data').insertBatch(data, { batchSize: 10 });

//❌ Too big - possible memory overflow or timeout
await collection('data').insertBatch(data, { batchSize: 100000 });

//✅ Recommended range: 500-2000
await collection('data').insertBatch(data, { batchSize: 1000 });
```

**Selection Guide**:
- **Small document** (< 1KB): `batchSize: 1000-2000`
- **Chinese Document** (1-10KB): `batchSize: 500-1000`
- **Large Document** (> 10KB): `batchSize: 100-500`

## 2. Concurrency control (concurrency)

```javascript
//✅ Local database - allows for higher concurrency
await collection('data').insertBatch(data, {
  batchSize: 1000,
  concurrency: 5  //The local network is fast and can be set to high speed
});

//✅ Remote database - be conservative
await collection('data').insertBatch(data, {
  batchSize: 1000,
  concurrency: 2  //The remote network is slow, avoid timeouts
});

//✅ Production environment - more conservative
await collection('data').insertBatch(data, {
  batchSize: 500,
  concurrency: 1,  //Serial is the most stable
  writeConcern: { w: 'majority', j: true }
});
```

## 3. Retry policy configuration

```javascript
//✅ Unstable network environment
await collection('data').insertBatch(data, {
  onError: 'retry',
  retryAttempts: 5,      //Try multiple times
  retryDelay: 2000,      //longer delay
  onRetry: (info) => {
    console.log(`Batch ${info.batchIndex + 1} retry ${info.attempt}`);
  }
});

//✅ Stable environment, fast failure
await collection('data').insertBatch(data, {
  onError: 'stop',       //No retry, immediate failure
  retryAttempts: 0
});
```

---

## FAQ

## Q: How to choose insertBatch vs insertMany?

**A**: Select based on data volume:
- **< 5K items**: Use `insertMany` (easier)
- **5K-50K items**: Use `insertBatch` (safer)
- **> 50K items**: Must use `insertBatch` (to avoid timeouts)

## Q: How to set batchSize?

**A**: Consider the following factors:
1. **Document size**: The larger the document, the smaller `batchSize`
2. **Network speed**: The slower the network, the smaller the `batchSize`
3. **Database Performance**: The weaker the database, the smaller `batchSize`
4. **Recommended starting point**: Use `1000` first, and adjust according to the actual situation

## Q: When should the retry mechanism be used?

**A**: The following scenarios are suitable for retrying:
- ✅ Network instability (WiFi, mobile network)
- ✅ High database load (temporary connection failure)
- ✅ Lock conflict (may succeed after waiting)
- ❌ Data error (retry will not succeed)
- ❌ Permission problem (retry will not succeed)

## Q: Will concurrency lead to data inconsistency?

**A**: No. `insertBatch` ensures:
- Each batch is inserted independently
- `insertedIds` is mapped in original order
- Error handling is associated with batches
- Explicit cache invalidation is supported

## Q: How to deal with partial failure?

**A**: Use `collect` or `retry` strategy:
```javascript
const result = await collection('data').insertBatch(data, {
  onError: 'retry', // or'collect'
  retryAttempts: 3
});

//Retry failed batches
for (const err of result.errors) {
  const failedDocs = data.slice(
    err.batchStartIndex,
    err.batchStartIndex + err.batchSize
  );

  //Analyze the cause of the failure, clean the data and try again
  console.log(`Batch ${err.batchIndex + 1} failed: ${err.message}`);
  console.log(`Retried ${err.attempts} times`);
}
```

---

## References

- [batch operations runnable example](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/batch-operations.ts) - Current TypeScript example
- [test/unit/writes/batch.test.ts](../../test/unit/writes/batch.test.ts) - test case
- [Write operations guide](./write-operations.md) - Overview of write operations
- [Cache system](./cache.md) - Cache invalidation mechanism
- [insertBatch improvement notes](./insertBatch.md) - Suggestions for further improvements
