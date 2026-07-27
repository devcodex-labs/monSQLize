# Write Operations

## Overview

This page covers the collection-level insert APIs. Use these methods when you want MongoDB-native write behavior with monSQLize conveniences such as explicit cache invalidation, unified errors, and slow operation monitoring.

| Method | Purpose | Performance | Applicable scenarios |
|------|------|------|---------|
| **insertOne** | Insert a single document | One write command per call | Real-time single document writing, interactive operation |
| **insertMany** | Batch insert documents | Fewer round trips for a batch; workload-dependent | Data import, batch creation, initialization data |

Use the Model layer instead when the write must go through schema defaults, hooks, timestamps, versioning, soft delete, or optimistic locking. If you want to enforce that rule at runtime, configure [Write Path Policy](./write-path-policy.md).


## 🔵 MongoDB native vs monSQLize extension

**The method itself**: MongoDB native ✅
- `insertOne()` and `insertMany()` are standard methods officially supported by MongoDB
- All parameters (writeConcern, ordered, comment, etc.) are natively supported by MongoDB

**monSQLize extension**: 🔧
- ✅ **Explicit cache invalidation** - Clear related caches with `cache.invalidate` or `autoInvalidate` after insertion
- ✅ **Unified Error Code** - Unified error handling such as DUPLICATE_KEY/VALIDATION_ERROR
- ✅ **Slow Query Monitoring** - Automatically record write operations that take longer than the threshold
- ✅ **Detailed Log** - DEBUG/WARN level operation log

## API parameter description


## insertOne()

Insert a single document into a collection.



## Method signature

```typescript
collection(name: string).insertOne(document: object, options?: InsertOneOptions): Promise<InsertOneResult>
```



## Detailed explanation of parameters

**First parameter: document** (required)
- Type: `object`
- Description: Document object to be inserted

**Second parameter: options** (optional)

| Parameters | Type | Default value | Source | Description |
|------|------|--------|------|------|
| **writeConcern** | `object` | `{ w: 1 }` | MongoDB native ✅ | Write confirmation level |
| **writeConcern.w** | `number \| 'majority'` | `1` | MongoDB native ✅ | Write acknowledgment level (`1` = primary acknowledgement, `'majority'` = majority acknowledgement) |
| **writeConcern.j** | `boolean` | `false` | MongoDB native ✅ | Whether to wait for the log to be placed |
| **writeConcern.wtimeout** | `number` | - | MongoDB native ✅ | Write timeout (milliseconds) |
| **bypassDocumentValidation** | `boolean` | `false` | MongoDB native ✅ | Skip document validation (not recommended) |
| **comment** | `string` | - | MongoDB native ✅ | Query comments for production environment log tracking |

**Legend description**:
- ✅ **MongoDB native**: This parameter is a standard function officially supported by MongoDB

**MongoDB reference documentation**:
- [insertOne()](https://www.mongodb.com/docs/manual/reference/method/db.collection.insertOne/)



## Return value

```typescript
{
  acknowledged: boolean,  // Whether it is acknowledged (usually true)
  insertedId: ObjectId    // Inserted document _id
}
```

---


## insertMany()

Batch insert multiple documents into a collection to reduce per-document command overhead. Measure throughput with your document shape, indexes, write concern, and network.



## Method signature (insertMany())

```typescript
collection(name: string).insertMany(documents: object[], options?: InsertManyOptions): Promise<InsertManyResult>
```



## Detailed explanation of parameters (insertMany())

**First parameter: documents** (required)
- Type: `object[]`
- Description: Array of documents to be inserted

**Second parameter: options** (optional)

| Parameters | Type | Default value | Source | Description |
|------|------|--------|------|------|
| **ordered** | `boolean` | `true` | MongoDB native ✅ | Whether to insert in order (true=stop when encountering an error, false=continue inserting other documents) |
| **writeConcern** | `object` | `{ w: 1 }` | MongoDB native ✅ | Write confirmation level (same as insertOne) |
| **bypassDocumentValidation** | `boolean` | `false` | MongoDB native ✅ | Skip document validation (not recommended) |
| **comment** | `string` | - | MongoDB native ✅ | Query comments for production environment log tracking |

**Legend description**:
- ✅ **MongoDB native**: This parameter is a standard function officially supported by MongoDB

**MongoDB reference documentation**:
- [insertMany()](https://www.mongodb.com/docs/manual/reference/method/db.collection.insertMany/)



## Return value (insertMany())

```typescript
{
  acknowledged: boolean,           // Whether it is acknowledged
  insertedCount: number,           // Number of documents successfully inserted
  insertedIds: {                   // Inserted document _id mapping
    0: ObjectId(...),
    1: ObjectId(...),
    2: ObjectId(...)
  }
}
```

---

## Usage example


## Basic usage



## 1. Insert a single document

```javascript
const { collection } = await msq.connect();

const result = await collection('products').insertOne({
  name: 'iPhone 15 Pro',
  price: 999,
  category: 'electronics',
  inStock: true,
  createdAt: new Date()
});

console.log('Insertion successful:', result.insertedId);
// Output: Insertion successful: 507f1f77bcf86cd799439011
```



## 2. Insert documents in batches

```javascript
const result = await collection('products').insertMany([
  { name: 'MacBook Pro', price: 2499, category: 'electronics' },
  { name: 'iPad Air', price: 599, category: 'electronics' },
  { name: 'AirPods Pro', price: 249, category: 'accessories' }
]);

console.log(`Successfully inserted ${result.insertedCount} documents`);
console.log('Inserted ID:', result.insertedIds);
// Output: 3 documents successfully inserted
// Output: Inserted IDs: { 0: ObjectId(...), 1: ObjectId(...), 2: ObjectId(...) }
```

---


## Advanced Scenario



## 3. Use comment parameter (production environment log tracking)

```javascript
// In production, use comment to identify the query source for log analysis and slow-query tracking.
const result = await collection('orders').insertOne(
  {
    userId: 'user_123',
    items: [{ productId: 'prod_456', quantity: 2 }],
    totalAmount: 1998,
    status: 'pending'
  },
  {
    comment: 'OrderAPI:createOrder:user_123'  // Format: service name: method name: user ID
  }
);

// MongoDB logs will contain this comment for tracking and analysis.
console.log('Order created successfully:', result.insertedId);
```

**comment Best Practices**:
```javascript
// Recommended format: "ServiceName:methodName:uniqueIdentifier"
comment: 'ProductAPI:createProduct:admin_456'
comment: 'OrderService:batchImport:session_abc123'
comment: 'DataMigration:seedUsers:v2.0'

// Slow query log example:
// [Slow write] insertOne - orders (45ms) | comment: "OrderAPI:createOrder:user_123"
```

---



## 4. Use writeConcern (key data persistence)

```javascript
// For critical data such as financial transactions and orders,
// use { w: 'majority', j: true } to improve durability.
const result = await collection('transactions').insertOne(
  {
    userId: 'user_789',
    amount: 10000,
    type: 'transfer',
    timestamp: new Date()
  },
  {
    writeConcern: {
      w: 'majority',    // Wait for acknowledgement from the majority of nodes
      j: true,          // Wait for journal persistence
      wtimeout: 5000    // 5-second timeout
    }
  }
);

console.log('Transaction records have been safely written:', result.insertedId);
```

**writeConcern Selection Guide**:

| scene | w | j | description |
|------|---|---|------|
| **Default scenario** | 1 | false | The primary acknowledges immediately, which offers the best performance |
| **Critical data** | 'majority' | true | Most nodes acknowledge and the write is journaled |
| **High-performance requirements** | 1 | false | Primary memory acknowledgement, fastest |
| **Read/write separation scenario** | 'majority' | false | Ensure the data can be read from secondary nodes after replication |

---



## 5. ordered vs unordered mode (insertMany)



### 5.1 ordered mode (default)

**Stop** the insertion when an error is encountered, suitable for scenarios requiring transaction consistency.

```javascript
//ordered: true (default) - stop on error
const result = await collection('products').insertMany(
  [
    { _id: 1, name: 'Product A' },  //✅ Inserted successfully
    { _id: 1, name: 'Product B' },  //❌ Repeat key error, stop
    { _id: 2, name: 'Product C' }   //⏸️ Will not attempt to insert
  ],
  { ordered: true }  //Stop on error (default)
);

//Result: Only item 1 is inserted successfully
```



### 5.2 unordered mode

When an error is encountered, **continue** to insert other documents, suitable for data import scenarios.

```javascript
//ordered: false - continue inserting additional documents when an error is encountered
const result = await collection('products').insertMany(
  [
    { _id: 1, name: 'Product A' },  //✅ Inserted successfully
    { _id: 1, name: 'Product B' },  //❌ Repeat key error but continue
    { _id: 2, name: 'Product C' }   //✅ Inserted successfully
  ],
  { ordered: false }  //Continue to insert other documents
);

console.log(`Successfully inserted ${result.insertedCount} items`);
//Output: 2 items successfully inserted (items 1 and 3)
```

**Mode Selection Guide**:

| Scenario | Recommended mode | Reason |
|------|---------|------|
| **Data Import** | unordered | Import as much data as possible, skipping errors |
| **Transactional operation** | ordered | Ensure data consistency, all success or all failure |
| **Initialization data** | unordered | Allow partial failure to improve import success rate |
| **Key business** | ordered | Strictly control data integrity |

---



## 6. Error handling

```javascript
try {
  const result = await collection('products').insertOne({
    _id: 'duplicate_id',
    name: 'Product X'
  });
  console.log('Insertion successful:', result.insertedId);
} catch (err) {
  if (err.code === 'DUPLICATE_KEY') {
    console.error('Error: Document ID already exists', err.details);
    //Handling duplicate key errors
  } else if (err.code === 'VALIDATION_ERROR') {
    console.error('Error: Document validation failed', err.details);
    //Handle validation errors
  } else {
    console.error('Unknown error:', err.message);
  }
}
```

**Common error codes**:

| Error code | Description | Handling suggestions |
|--------|------|---------|
| `DUPLICATE_KEY` | Document _id already exists | Use a different _id or update an existing document |
| `VALIDATION_ERROR` | Document validation failed | Check document format and fields |
| `DATABASE_ERROR` | Database operation failed | Check connection status and permissions |
| `INVALID_COLLECTION_NAME` | Invalid collection name | Use a valid collection name |

---



## 7. Explicit cache invalidation

After a successful insert, monSQLize does not clear query caches by default. Use `cache.invalidate` for precise entries or `autoInvalidate: true` for collection-wide broad invalidation. Cache invalidation is best-effort and post-write; see [Cache Invalidation](./cache-invalidation.md) for consistency boundaries.

```javascript
//Step 1: Query products (cached results)
const products1 = await collection('products').find(
  { category: 'electronics' },
  { cache: 60000 }  //Cache for 60 seconds
);
console.log('First query:', products1.length);  //Output: 10

//Step 2: Insert new product and precisely invalidate the affected query cache.
await collection('products').insertOne(
  {
    name: 'New Product',
    category: 'electronics',
    price: 599
  },
  {
    cache: {
      invalidate: [{
        operation: 'find',
        query: { category: 'electronics' },
        options: { cache: 60000 }
      }]
    }
  }
);
console.log('Cache invalidation was triggered according to the explicit policy');

//Step 3: Query again (the cache has expired, query the database again)
const products2 = await collection('products').find(
  { category: 'electronics' },
  { cache: 60000 }
);
console.log('Query after insertion:', products2.length);  //Output: 11 (new data)
```

**Configurable invalidation operations**:
- ✅ `find()`
- ✅ `findOne()`
- ✅ `count()`
- ✅ `findPage()`
- ✅ `aggregate()`
- ✅ `distinct()`

---

## Performance optimization


## Batch insert performance comparison

```javascript
const testData = Array.from({ length: 100 }, (_, i) => ({
  name: `Product ${i + 1}`,
  price: Math.floor(Math.random() * 1000),
  category: 'test'
}));

//❌ Method 1: Loop single insertion (slow)
console.time('Single insert');
for (const doc of testData) {
  await collection('products').insertOne(doc);
}
console.timeEnd('Single insert');
//Output: single insert: 1250ms

// Method 2: Batch insert (fewer network round trips)
console.time('Batch insert');
await collection('products').insertMany(testData);
console.timeEnd('Batch insert');
//Output: Batch insert: 45ms

//Performance improvement: 1250ms ÷ 45ms ≈ 27.8 times
```

**Performance Recommendations**:
- **Batch Insert** - Prefer `insertMany()` when batching matches the business and failure semantics; benchmark the chosen batch size
- 🚀 **Batch Size** - Recommend 100-1000 items per batch to balance performance and memory
- 🚀 **unordered mode** - Use `ordered: false` when importing data to improve the success rate
- 🚀 **Disable verification** - Non-production environments can use `bypassDocumentValidation: true` to accelerate

---

## Best Practices


## 1. Log tracking (comment)

```javascript
//✅ Good practice: Use comment to identify the query source
await collection('orders').insertOne(
  orderData,
  { comment: 'OrderAPI:createOrder:user_123' }
);

//❌ Bad practice: Not using comments makes it difficult to track slow queries
await collection('orders').insertOne(orderData);
```


## 2. Write confirmation level (writeConcern)

```javascript
//✅ Good practice: use majority + j: true for key data
await collection('transactions').insertOne(
  transactionData,
  { writeConcern: { w: 'majority', j: true } }
);

//❌ Bad practice: Use default settings for critical data (possible data loss)
await collection('transactions').insertOne(transactionData);
```


## 3. Error handling

```javascript
//✅ Good practice: catch and handle specific errors
try {
  await collection('products').insertOne(productData);
} catch (err) {
  if (err.code === 'DUPLICATE_KEY') {
    //Handle duplicate keys
  } else if (err.code === 'VALIDATION_ERROR') {
    //Handle validation errors
  } else {
    throw err;  //Rethrow unknown error
  }
}

//❌ Bad practice: Ignore errors or treat them generically
try {
  await collection('products').insertOne(productData);
} catch (err) {
  console.log('Insertion failed');  //Insufficient information
}
```


## 4. Batch insert

```javascript
//✅ Good practice: Use insertMany() to insert in batches
await collection('products').insertMany([doc1, doc2, doc3, ...]);

//❌ Bad practice: Looping single insertion
for (const doc of documents) {
  await collection('products').insertOne(doc);
}
```


## 5. ordered vs unordered

```javascript
//✅ Data import scenario: Use unordered to improve success rate
await collection('products').insertMany(
  importedData,
  { ordered: false }  //Skip errors and continue inserting
);

//✅ Transactional operations: Use ordered to ensure consistency
await collection('orders').insertMany(
  orderItems,
  { ordered: true }  //Stop on error
);
```

---

## Slow query monitoring

When the insertion operation takes more than the threshold, the `slow-query` event will be triggered:

```javascript
const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'shop',
  config: { uri: 'mongodb://localhost:27017' },
  slowQueryMs: 50  //Slow query threshold 50ms
});

//Listen for slow queries
msq.on('slow-query', (meta) => {
  console.warn('[Slow write]', {
    Operation: meta.operation, // 'insertOne' or 'insertMany'
    Collection: meta.collectionName, // 'products'
    Duration: meta.duration, // 75 (ms)
    Comment: meta.comment // 'ProductAPI:createProduct:user_123'
  });
});

await msq.connect();
```

**Example output**:
```text
[slow write] {
Operation: 'insertOne',
Collection: 'orders',
Time taken: 75,
Comment: 'OrderAPI:createOrder:user_123'
}
```

---

## FAQ


## Q: What is the difference between insertMany and multiple insertOne?

**A**: The performance difference is huge:
- `insertMany`: Single network round trip, batch writing, ~0.5-1ms/item
- `insertOne` (cyclic call): one command per document and more network round trips
- **Performance**: workload-dependent; record the dataset, indexes, write concern, concurrency, and environment when benchmarking


## Q: Which should I choose between ordered and unordered?

**A**: Select according to the scenario:
- **ordered (default)**: transactional operation, requiring all success or all failure
- **unordered**: data import, allowing partial failure


## Q: How should writeConcern be set?

**A**: Select based on data importance:
- **Default (w: 1)**: Normal data, performance priority
- **Key data (w: 'majority', j: true)**: financial transactions, orders, etc.


## Q: Do I need to manually clear the cache after inserting?

**A**: Configure it explicitly. Use `cache.invalidate` for precise entries, or `autoInvalidate: true` for broad invalidation.


## Q: How to deal with duplicate key errors?

**A**: Catching `DUPLICATE_KEY` error:
```javascript
try {
  await collection('products').insertOne({ _id: 'dup', name: 'Product' });
} catch (err) {
  if (err.code === 'DUPLICATE_KEY') {
    console.log('Document already exists, skip inserting');
  }
}
```


## Q: Will the memory overflow when inserting a large amount of data?

**A**: It is recommended to insert in batches:
```javascript
const BATCH_SIZE = 1000;
for (let i = 0; i < allData.length; i += BATCH_SIZE) {
  const batch = allData.slice(i, i + BATCH_SIZE);
  await collection('products').insertMany(batch);
}
```

---

## References

- [single insert runnable example](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/insert.ts) - Current TypeScript single insertion example
- [bulk insert runnable example](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/insert-many.ts) - Current TypeScript bulk insert example
- [Cache system](./cache.md) - Cache invalidation mechanism
- [Event system](./events.md) - Slow query monitoring
- [MongoDB writeConcern documentation](https://www.mongodb.com/docs/manual/reference/write-concern/)
