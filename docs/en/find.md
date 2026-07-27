# find()

## Overview

`find()` reads multiple documents from a MongoDB collection. Use it for filtered lists, sorted lists, pagination, projections, streaming, cached reads, and any query where you expect zero or more documents.

### ObjectId auto conversion

When a query contains valid 24-character ObjectId strings, monSQLize converts them before sending the query to MongoDB. You can usually pass request IDs as strings without calling `new ObjectId()` yourself.

```javascript
const posts = await collection('posts').find({
    authorId: '507f1f77bcf86cd799439011',
    categoryId: '507f1f77bcf86cd799439012'
});

const docs = await collection('docs').find({
    $or: [
        { authorId: userId1 },
        { editorId: userId2 }
    ]
});
```

See [ObjectId Auto Conversion](./objectid-auto-convert.md) for escape hatches when a 24-character hex business value must stay a string.

## Calling method

monSQLize supports both chain-style calls and options objects. Choose the shape that is easier for your codebase to read.

### Method 1: Chain call (recommended)

```javascript
// Basic chain call
const results = await collection('products')
  .find({ category: 'electronics' })
  .limit(10)
  .skip(5)
  .sort({ price: -1 });

// Complex call chain
const results = await collection('products')
  .find({ category: 'electronics', inStock: true })
  .sort({ rating: -1, sales: -1 })
  .skip(10)
  .limit(20)
  .project({ name: 1, price: 1, rating: 1 })
  .hint({ category: 1, price: -1 })
  .maxTimeMS(5000)
  .comment('ProductAPI:getList');
```

**Supported chained methods**:
- `.limit(n)` - Limit the number of returns
- `.skip(n)` - Number of skipped documents
- `.sort(spec)` - sorting rules
- `.project(spec)` - Field projection
- `.hint(spec)` - index hint
- `.collation(spec)` - sorting rules
- `.comment(str)` - Query comments
- `.maxTimeMS(ms)` - timeout period
- `.batchSize(n)` - batch size
- `.explain(v)` - execution plan
- `.stream()` - streaming return
- `.toArray()` - explicit conversion to array

`limit(0)` keeps MongoDB semantics and means no limit. Positive explicit limits are bounded by `findMaxLimit`, and explicit skips are bounded by `findMaxSkip`.

📚 **Detailed Documentation**: View [Chain Call Complete API Document](./chaining-api.md)

### Method 2: options parameter

```javascript
const results = await collection('products').find(
  { category: 'electronics' },
  {
    sort: { price: -1 },
    limit: 10,
    skip: 5,
    projection: { name: 1, price: 1 }
  }
);
```

Both styles execute the same query path.

---

## Method signature

```javascript
// Chain calling method
collection(name).find(query)
  .limit(n)
  .skip(n)
  .sort(spec)
  // ... other chained methods

// options parameter mode
async find(query = {}, options = {})
```

**Parameter Description**:
- `query` (Object): MongoDB query conditions, such as `{ status: 'active', age: { $gt: 18 } }`
- `options` (Object): Query option configuration (only required for options parameter method)

## Parameter description

### query parameters

MongoDB standard query condition object, supporting all MongoDB query operators.

### options object properties

| Parameters | Type | Required | Default | Source | Description |
|------|------|------|--------|------|------|
| `projection` / `project` | Object/Array | No | - | MongoDB native ✅ | Field projection configuration, specify the returned fields. `project` is an alias for `projection`; `projection` wins when both are provided. |
| `sort` | Object | No | - | MongoDB native ✅ | Collation, such as `{ createdAt: -1, name: 1 }` |
| `limit` | Number | No | Global Configuration | MongoDB Native ✅ | Limit the number of documents returned |
| `skip` | Number | No | - | MongoDB native ✅ | Skip the specified number of documents (not recommended for large data volumes) |
| `hint` | Object/String | No | - | MongoDB native ✅ | Specify the index used by the query |
| `collation` | Object | No | - | MongoDB native ✅ | Specify collation (for string sorting) |
| `maxTimeMS` | Number | No | Global configuration | MongoDB native ✅ | Query timeout (milliseconds) |
| `batchSize` | Number | No | - | MongoDB native ✅ | Batch size for streaming or array queries |
| `comment` | String | No | - | MongoDB native ✅ | Query comments, used for production environment log tracking and performance analysis |
| `explain` | Boolean/String | No | - | MongoDB native ✅ | Returns the query execution plan, optional values: `true`, `'queryPlanner'`, `'executionStats'`, `'allPlansExecution'` |
| `stream` | Boolean | No | `false` | monSQLize extension 🔧 | Whether to return a stream object (can also be called through the `.stream()` chain method) |
| `cache` | Number | No | `0` | monSQLize extension 🔧 | Cache TTL (milliseconds), greater than 0 to enable caching |

**Legend description**:
- ✅ **MongoDB native**: This parameter/method is a standard function officially supported by MongoDB
- 🔧 **monSQLize extension**: monSQLize’s unique extension function, providing additional convenience

**MongoDB reference documentation**:
- [find() method](https://www.mongodb.com/docs/manual/reference/method/db.collection.find/)
- [Cursor method](https://www.mongodb.com/docs/manual/reference/method/js-cursor/)

### comment configuration

Query comments are used to identify the query source in MongoDB logs to facilitate operation and maintenance monitoring and performance analysis of the production environment:

```javascript
comment: 'UserAPI:listProducts:user_12345'
```

**Naming Suggestions**:
```javascript
// Format: servicename:operation:identifier
comment: 'ProductAPI:getList:session_abc123'
comment: 'OrderService:getUserOrders:traceId=xyz789'
comment: 'AdminDashboard:getTotalActive:admin_user_5'
```

**Usage Scenario**:
- **Production Monitoring**: Identify query sources in MongoDB logs
- **Slow Query Diagnosis**: Quickly locate slow query business scenarios
- **Distributed Tracing**: Combined with traceId to achieve complete link tracing
- **Performance Optimization**: A/B testing the performance difference of different query strategies
- **Audit and Compliance**: Record query initiator and business scenario

**Best Practice**:
- ✅ Use a unified naming format: "service name:operation:identifier"
- ✅ Contains key information (user ID, session ID, traceId)
- ✅ Avoid including sensitive data (passwords, ID numbers, etc.)
- ✅ Keep it simple (<100 characters recommended)
- ✅ Enable MongoDB slow query log (slowOpThresholdMs) in production environment

**MongoDB log example**:
```json
{
  "t": { "$date": "2025-11-07T08:00:00.000Z" },
  "c": "COMMAND",
  "msg": "Slow query",
  "attr": {
    "type": "find",
    "ns": "mydb.products",
    "command": {
      "find": "products",
      "filter": { "category": "electronics" },
      "comment": "ProductAPI:listProducts:user_12345"
    },
    "durationMillis": 523
  }
}
```

**Reference Document**:
- [MongoDB comment parameter official document](https://www.mongodb.com/docs/manual/reference/command/find/#std-label-find-cmd-comment)
- [Database Profiler](https://www.mongodb.com/docs/manual/reference/command/profile/)

### projection configuration

Projection configuration is used to specify fields to include or exclude in query results. Two formats are supported:

**Object format**:
```javascript
projection: {
  name: 1,        // Contains name field
  email: 1,       // Contains email field
  password: 0     // Exclude password field
}
```

**Array format**:
```javascript
projection: ['name', 'email', 'createdAt']  // Return only these fields (plus _id)
```

**Notice**:
- MongoDB does not allow mixing include(1) and exclude(0), except for `_id` fields
- Array format is automatically converted to include mode
- `_id` fields are always included by default unless explicitly excluded: `{ _id: 0 }`

### sort configuration

The sort configuration specifies how the results are sorted:

```javascript
sort: {
  createdAt: -1,  // -1 means descending order
  name: 1,        // 1 means ascending order
  _id: 1          // It is recommended to add _id as the last sorting field to ensure stable sorting
}
```

**Performance Recommendations**:
- For large data sets, make sure there is an index on the sorting field
- Avoid sorting on unindexed fields
- Use composite indexes to optimize multi-field sorting

### hint configuration

Force MongoDB to use the specified index:

```javascript
// Use index name
hint: 'status_createdAt_idx'

// Use index definition
hint: { status: 1, createdAt: -1 }
```

**Usage Scenario**:
- MongoDB query optimizer selected wrong index
- Need to force the use of specific indexes to ensure performance
- Test the performance differences of different indexes

### collation configuration

Specify rules for string comparison and sorting:

```javascript
collation: {
  locale: 'zh',           // Chinese
  strength: 2,            // Ignore case and accents
  caseLevel: false,
  numericOrdering: true   // Numeric strings sorted numerically
}
```

**Guides**:
- Requires case-insensitive queries and sorting
- Correct sorting in multiple languages
- Natural ordering of numeric strings

## Return value

### Normal mode returns array

By default, the `find` method returns a Promise and resolve is a document array:

```javascript
const users = await collection('users').find(
  { status: 'active' },
  { limit: 10 }
);

// users = [
//   { _id: '...', name: 'Alice', status: 'active', ... },
//   { _id: '...', name: 'Bob', status: 'active', ... },
//   ...
// ]
```

**Return value type**: `Promise<Array<Object>>`

### Streaming mode returns stream object

When `stream: true` is used, a MongoDB Cursor Stream object is returned:

```javascript
const stream = await collection('orders').find(
  { status: 'completed' },
  {
    sort: { completedAt: -1 },
    stream: true,
    batchSize: 100
  }
);

// stream is a Node.js Readable Stream
stream.on('data', (doc) => console.log(doc));
stream.on('end', () => console.log('Finish'));
stream.on('error', (err) => console.error('mistake:', err));
```

**Return value type**: `ReadableStream`

### explain mode returns execution plan

When `explain` is true or the specified level, returns the query execution plan:

```javascript
const plan = await collection('orders').find(
  { status: 'paid' },
  { explain: 'executionStats' }
);

// plan = {
//   queryPlanner: { ... },
//   executionStats: {
//     executionTimeMillis: 5,
//     totalDocsExamined: 100,
//     totalKeysExamined: 100,
//     ...
//   }
// }
```

**Return value type**: `Promise<Object>`

## Usage mode

### 1. Basic query

The simplest query method, returns all matching documents:

```javascript
// Query all active users
const users = await collection('users').find(
  { status: 'active' }
);

// Query specified fields
const users = await collection('users').find(
  { status: 'active' },
  { projection: { name: 1, email: 1 } }
);

// Query with sorting
const users = await collection('users').find(
  { status: 'active' },
  {
    sort: { createdAt: -1 },
    limit: 20
  }
);
```

**Applicable scenarios**:
- Collections with small data size
- Need to get all results at once
- The number of results is controllable (it is recommended to set limit)

### 2. Paging query (skip + limit)

Implement traditional paging using skip and limit:

```javascript
const page = 2;
const pageSize = 20;

const users = await collection('users').find(
  { status: 'active' },
  {
    sort: { createdAt: -1 },
    skip: (page - 1) * pageSize,
    limit: pageSize
  }
);
```

**Performance Note**:
- skip has poor performance on large data sets (needs to traverse skipped documents)
- Not recommended for skips over 10,000
- For high-performance paging, it is recommended to use the `findPage` method

### 3. Streaming processing

Stream large data sets to avoid memory overflow:

```javascript
const stream = await collection('orders').find(
  {
    createdAt: { $gte: new Date('2024-01-01') }
  },
  {
    sort: { createdAt: 1 },
    stream: true,
    batchSize: 1000
  }
);

let count = 0;
let totalAmount = 0;

stream.on('data', (order) => {
  count++;
  totalAmount += order.amount;
});

stream.on('end', () => {
  console.log(`Processed${count} orders, total amount:${totalAmount}`);
});

stream.on('error', (err) => {
  console.error('Stream processing error:', err);
});
```

**Advantages**:
- Constant memory usage (only the current batch is saved)
- Suitable for processing millions of data
- Support pipe operations

**Notice**:
- Streaming does not support caching
- It is recommended to set an appropriate batchSize (default 1000)

### 4. Complex query conditions

Build complex queries using MongoDB query operators:

```javascript
// range query
const orders = await collection('orders').find(
  {
    amount: { $gte: 100, $lte: 1000 },
    status: { $in: ['paid', 'completed'] },
    createdAt: { $gte: new Date('2024-01-01') }
  },
  { sort: { amount: -1 } }
);

// Logical combination query
const users = await collection('users').find(
  {
    $or: [
      { role: 'admin' },
      { $and: [{ level: { $gte: 5 } }, { verified: true }] }
    ]
  }
);

// Array query
const products = await collection('products').find(
  {
    tags: { $all: ['electronics', 'discount'] },
    'reviews.rating': { $gte: 4.5 }
  }
);
```

### 5. Use index optimization

Use hint to force the use of indexes and explain to view the execution plan:

```javascript
// View execution plan
const plan = await collection('orders').find(
  { status: 'paid', amount: { $gte: 1000 } },
  {
    sort: { createdAt: -1 },
    explain: 'executionStats'
  }
);
});

console.log('Execution time:', plan.executionStats.executionTimeMillis, 'ms');
console.log('Number of scanned documents:', plan.executionStats.totalDocsExamined);
console.log('index used:', plan.executionStats.inputStage?.indexName);

// Force the use of indexes
const orders = await collection('orders').find(
  { status: 'paid' },
  {
    sort: { createdAt: -1 },
    hint: 'status_createdAt_idx',
    limit: 100
  }
);
```

### 6. Cache query results

For data that is frequently queried and does not change much, use caching to improve performance:

```javascript
// Cache for 5 minutes
const categories = await collection('categories').find(
  { enabled: true },
  {
    sort: { order: 1 },
    cache: 300000  // 5 * 60 * 1000
  }
);

// Popular product list, cached for 10 minutes
const hotProducts = await collection('products').find(
  { hot: true, inStock: true },
  {
    sort: { sales: -1 },
    limit: 20,
    projection: ['name', 'price', 'image'],
    cache: 600000  // 10 * 60 * 1000
  }
);
```

**Caching instructions**:
- Cache keys are automatically generated based on query conditions, sorting, projection and other parameters
- The same query conditions will reuse the cache
- The cache is stored at the instance level (process memory)
- Suitable for scenarios where there is a lot of reading and a little writing

## Performance optimization suggestions

### 1. Reasonable use of limit

Always set reasonable limits for queries to avoid returning too much data:

```javascript
// ❌ Bad: Millions of data may be returned
const users = await collection('users').find(
  { status: 'active' }
);

// ✅ Good: Limit the number of returns
const users = await collection('users').find(
  { status: 'active' },
  { limit: 100 }
);
```

### 2. Query only the required fields

Use projection to reduce data transfer:

```javascript
// ❌ Bad: returns all fields
const users = await collection('users').find(
  { status: 'active' }
);

// ✅ Good: only return required fields
const users = await collection('users').find(
  { status: 'active' },
  { projection: { name: 1, email: 1 } }
);
```

### 3. Create an index for the sorting field

```javascript
// Make sure there is an index: db.orders.createIndex({ status: 1, createdAt: -1 })
const orders = await collection('orders').find(
  { status: 'paid' },
  {
    sort: { createdAt: -1 },
    limit: 20
  }
);
```

### 4. Avoid large skips

```javascript
// ❌ Bad: Skip has poor performance on large data volumes
const page10000 = await collection('orders').find(
  {},
  {
    skip: 99990,
    limit: 10
  }
);

// ✅ Good: Use findPage for cursor paging
const page = await collection('orders').findPage(
  {},
  {
    limit: 10,
    after: lastCursor
  }
);
```

### 5. Use streaming processing for large data sets

```javascript
// ❌ Bad: Load all data into memory at once
const allOrders = await collection('orders').find(
  { year: 2024 }
);
allOrders.forEach(order => process(order));

// ✅ Good: Streaming
const stream = await collection('orders').find(
  { year: 2024 },
  { stream: true }
);
stream.on('data', order => process(order));
```

### 6. Set query timeout

To prevent slow queries from blocking the system:

```javascript
const users = await collection('users').find(
  { complexCondition: '...' },
  { maxTimeMS: 5000 }  // 5 seconds timeout
);
```

## Error handling

```javascript
try {
  const users = await collection('users').find(
    { status: 'active' },
    { maxTimeMS: 5000 }
  );
  
  console.log(`turn up${users.length} users`);
} catch (error) {
  if (error.code === 'TIMEOUT') {
    console.error('Query timeout');
  } else if (error.code === 'INVALID_QUERY') {
    console.error('Invalid query condition:', error.message);
  } else {
    console.error('Query failed:', error);
  }
}
```

## Differences from findPage

| Features | find | findPage |
|------|------|----------|
| Return format | Array | Object with paging information |
| Cursor paging | ❌ | ✅ |
| Page jump function | ❌ | ✅ (bookmark mechanism) |
| Total Statistics | ❌ | ✅ |
| Streaming | ✅ | ✅ |
| Traditional paging (skip) | ✅ | ✅(offsetJump) |
| Applicable scenarios | Simple query | High-performance paging |

**Selection Suggestions**:
- Simple one-time query: use `find`
- Lists that need to be paginated: use `findPage`
- Large data set processing: both support stream
- Need total statistics: use `findPage`

## References

- [MongoDB find document](https://docs.mongodb.com/manual/reference/method/db.collection.find/)
- [findPage method documentation](./findPage.md)
- [find method example](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/find.ts)
- [find method test](../../test/integration/mongodb/find.test.ts)

## FAQ

### Q1: How to choose between find and findPage?

**A**: Select according to usage scenario:

- **Use find**:
- Get a small amount of data (< 100 items) at one time
- No pagination required
- Simple data export or statistics
- The amount of known data is small

- **Use findPage**:
- Need to display the list in pages
- Large amount of data (> 1000 items)
- Requires cursor paging function
- Need to get total statistics

### Q2: Why is it not recommended to use skip in large quantities?

**A**: skip performance issues:
- MongoDB must iterate through all skipped documents
- skip(10000) needs to scan 10000 documents
- Performance degrades linearly on large data sets
- It is recommended to use findPage's cursor paging alternative

### Q3: How to optimize find query performance?

**A**: Performance optimization checklist:
1. ✅ Create indexes for query fields and sort fields
2. ✅ Use projection to query only the required fields
3. ✅ Set reasonable limits
4. ✅ Use explain to analyze the query plan
5. ✅ Enable caching for frequent queries
6. ✅ Use streaming processing for large data sets
7. ✅ Set maxTimeMS to prevent slow queries

### Q4: When is streaming query used?

**A**: Suitable for streaming query scenarios:
- Data volume exceeds 100,000 items
- Need to process data item by item
- Memory is limited
- Data export or ETL operations
- Real-time data processing

### Q5: When does the cache expire?

**A**: Cache invalidation mechanism:
- Automatically expires when TTL time is reached
- Calling `collection.invalidate()` manually clears matching collection read caches
- The cache is cleared after the process is restarted
- The cache key is generated based on the query parameters. If the parameters change, the cache will become invalid.

### Q6: How to handle sorting of large amounts of data?

**A**: Big data sorting optimization:
```javascript
// 1. Create a covering index
db.orders.createIndex({ status: 1, createdAt: -1, amount: 1 });

// 2. Use index sorting
const orders = await collection('orders').find(
  { status: 'paid' },
  {
    sort: { createdAt: -1 },  // Sort using index fields
    projection: { amount: 1, createdAt: 1 },  // Projection using index field
    limit: 100,
    hint: { status: 1, createdAt: -1 }  // Force the use of indexes
  }
);

// 3. Avoid: Sorting large data sets on unindexed fields
// ❌ Poor performance
const orders = await collection('orders').find(
  {},
  {
    sort: { randomField: -1 },  // Unindexed fields
    limit: 10000  // Large data volume
  }
);
```

### Q7: How to debug slow queries?

**A**: Slow query debugging steps:
```javascript
// 1. Use explain to view the execution plan
const plan = await collection('orders').find(
  { status: 'paid', amount: { $gte: 1000 } },
  {
    sort: { createdAt: -1 },
    explain: 'executionStats'
  }
);

console.log('Execution time:', plan.executionStats.executionTimeMillis, 'ms');
console.log('Scan documents:', plan.executionStats.totalDocsExamined);
console.log('Return to document:', plan.executionStats.nReturned);
console.log('Use index:', plan.executionStats.inputStage?.indexName || 'none');

// 2. Check index usage efficiency
const efficiency = plan.executionStats.nReturned / 
                   (plan.executionStats.totalDocsExamined || 1);
if (efficiency < 0.1) {
  console.warn('⚠️ Query efficiency is less than 10%, it is recommended to optimize the index');
}

// 3. Monitor slow query events
msq.on('slow-query', (meta) => {
  console.warn('slow query:', meta);
});
```

## Best Practices

### 1. Always set limit

```javascript
// ❌ Danger: millions of data may be returned
const users = await collection('users').find(
  { status: 'active' }
});

// ✅ Security: Limit the number of returns
const users = await collection('users').find(
  { status: 'active' },
  {
    limit: 100
  }
);
```

### 2. Use projection to reduce data transmission

```javascript
// ❌ Return all fields (including large text, binary, etc.)
const users = await collection('users').find(
  { status: 'active' },
  {
    limit: 100
  }
);

// ✅ Only return required fields
const users = await collection('users').find(
  { status: 'active' },
  {
    projection: { name: 1, email: 1, avatar: 1 },
    limit: 100
  }
);
```

### 3. Composite sorting ensures stability

```javascript
// ❌ Unstable: The order of the same createdAt is uncertain
const orders = await collection('orders').find(
  {},
  {
    sort: { createdAt: -1 },
    limit: 20
  }
);

// ✅ Stable: Add _id to ensure stable sorting
const orders = await collection('orders').find(
  {},
  {
    sort: { createdAt: -1, _id: 1 },
    limit: 20
  }
);
```

### 4. Proper use of cache

```javascript
// Scenarios suitable for caching
const categories = await collection('categories').find(
  { enabled: true },
  {
    sort: { order: 1 },
    cache: 600000  // Cache for 10 minutes (data changes infrequently)
  }
);

// Scenarios not suitable for caching
const realtimeOrders = await collection('orders').find(
  { status: 'pending' },
  {
    sort: { createdAt: -1 }
    // Do not set cache (real-time data)
  }
);
```

### 5. Handling exceptions

```javascript
async function safeFind(collectionName, query, options) {
  try {
    const result = await collection(collectionName).find(query, options);
    return { success: true, data: result };
  } catch (error) {
    if (error.code === 50) {  // MongoDB timeout error
      console.error('Query timeout, please optimize query conditions or add indexes');
      return { success: false, error: 'TIMEOUT', data: [] };
    } else if (error.name === 'MongoServerError') {
      console.error('Database error:', error.message);
      return { success: false, error: 'DB_ERROR', data: [] };
    } else {
      console.error('unknown error:', error);
      return { success: false, error: 'UNKNOWN', data: [] };
    }
  }
}
```

### 6. Batch processing of big data

```javascript
// Using streaming batch operations
async function batchProcess(collectionName, processFunc, batchSize = 1000) {
  const stream = await collection(collectionName).find(
    {},
    {
      stream: true,
      batchSize
    }
  );

  let batch = [];
  let processedCount = 0;

  stream.on('data', async (doc) => {
    batch.push(doc);
    
    if (batch.length >= batchSize) {
      stream.pause();
      await processFunc(batch);
      processedCount += batch.length;
      console.log(`Processed: ${processedCount} strip`);
      batch = [];
      stream.resume();
    }
  });

  stream.on('end', async () => {
    if (batch.length > 0) {
      await processFunc(batch);
      processedCount += batch.length;
    }
    console.log(`Processed in total: ${processedCount} strip`);
  });
}
```
