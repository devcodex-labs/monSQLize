# distinct method detailed documentation

## Overview

`distinct` is the field deduplication query method provided by monSQLize, which is used to obtain all unique values ​​of the specified field from the MongoDB collection. **Directly uses MongoDB's native `Collection.distinct()` method**, which supports query condition filtering, sorting rules and extended options.

## Method signature

```javascript
async distinct(field, filter = {}, options = {})
```

## Parameter description

### field parameter

| Parameters | Type | Required | Description |
|------|------|------|------|
| `field` | String | Yes | Field name to remove duplicates, nested fields are supported (such as `'user.name'`, `'address.city'`) |

### filter parameters

Query condition object, only matching documents are deduplicated, using MongoDB standard query syntax.

**Type**: `Object`
**Required**: No
**Default value**: `{}` (empty object means deduplication of all documents)

**Example**:

```javascript
// simple condition
{ inStock: true }

// range query
{ price: { $gte: 1000 } }

// Logical combination
{
  status: 'active',
  verified: true
}

// Empty query (deduplication of all documents)
{}
```

### options parameter object

**Core Options** (MongoDB native ✅):

| Parameters | Type | Required | Default | Source | Description |
|------|------|------|--------|------|------|
| `maxTimeMS` | Number | No | - | MongoDB native ✅ | Query timeout (milliseconds) to prevent long-term query blocking |
| `collation` | Object | No | - | MongoDB native ✅ | Collation configuration for string comparison and deduplication (e.g. case-insensitive) |
| `comment` | String | No | - | MongoDB native ✅ | Query comments for logging and performance analysis |
| `session` | ClientSession | No | - | MongoDB native ✅ | Transaction session object, used for transaction operations |

**Extended options** (monSQLize extension 🔧):

| Parameters | Type | Required | Default | Source | Description |
|------|------|------|--------|------|------|
| `cache` | Number | No | `0` | monSQLize extension 🔧 | Cache TTL (milliseconds), greater than 0 to enable caching |
| `meta` | Boolean/Object | No | `false` | monSQLize extension 🔧 | Return query metadata (execution time, cache hit rate, etc.) |
| `explain` | Boolean/String | No | - | MongoDB native ✅ | Returns the query execution plan, optional values: `true`, `'queryPlanner'`, `'executionStats'`, `'allPlansExecution'` |

**MongoDB reference documentation**:
- [distinct()](https://www.mongodb.com/docs/manual/reference/method/db.collection.distinct/)

### comment configuration

Query annotations are used to identify the purpose of deduplication queries in MongoDB logs and performance analysis tools.

**Format Suggestions**:
```javascript
comment: 'Module:Action:Context'
```

**Usage Scenario**:
- **Filter Options**: Identifies data sources for various drop-down lists and filters
- **Data Statistics**: Statistical query that identifies data dimensions
- **Performance Analysis**: Track the source of slow queries and help locate optimization points

**Example**:
```javascript
// Get product category (for filter)
const categories = await collection('products').distinct(
  'category',
  { inStock: true },
  { comment: 'FilterOptions:getCategories:shop_page' }
);

// Get user role (for management backend)
const roles = await collection('users').distinct(
  'role',
  {},
  { comment: 'AdminPanel:getUserRoles:users_page' }
);
```

### session configuration

Execute a distinct query within a transaction:

```javascript
const session = client.startSession();
try {
  await session.withTransaction(async () => {
    // Get deduplicated data in transaction
    const categories = await collection('products').distinct(
      'category',
      { inStock: true },
      { session }
    );

    // Other transaction operations...
  });
} finally {
  await session.endSession();
}
```

**Usage Scenario**:
- Deduplication queries that need to ensure data consistency
- Executed in the same transaction as other write operations
- Queries that require isolation level guarantees

**Note**:
- session must be a valid MongoDB ClientSession object
- distinct queries in transactions will be affected by the transaction isolation level
- Transactions across sharded collections are not supported

### collation configuration

Specify rules for string comparison and deduplication:

```javascript
collation: {
  locale: 'zh',           // Chinese
  strength: 1,            // 1: ignore case and accent, 2: case sensitive
  caseLevel: false,
  numericOrdering: true   // Numeric strings sorted numerically
}
```

**Guides**:
- Requires case-insensitive deduplication (such as email, username)
- Correct deduplication in multi-language environments
- Natural deduplication of numeric strings

## Return value

### Normal mode returns array

By default, the `distinct` method returns a Promise, and resolve is an array of values ​​after deduplication:

```javascript
const categories = await collection('products').distinct('category', { inStock: true });

// categories = ['electronics', 'books', 'clothing']
```

**Return value type**: `Promise<Array<any>>`

**Notice**:
- The type of array elements returned depends on the actual data type of the field
- If the field is an array type, the array will be expanded and deduplicated.
- `null` and non-existing fields will be treated as a unique value

### explain mode returns execution plan

When `explain` is true or the specified level, returns the query execution plan:

```javascript
const plan = await collection('products').distinct(
  'category',
  { inStock: true },
  { explain: 'executionStats' }
);

// plan = {
//   queryPlanner: { ... },
//   executionStats: {
//     executionTimeMillis: 5,
//     totalDocsExamined: 100,
//     ...
//   }
// }
```

**Return value type**: `Promise<Object>`

## Usage mode

### 1. Basic deduplication query

The simplest way to remove duplicates, get all unique values ​​of a specified field:

```javascript
// Get all product categories
const categories = await collection('products').distinct('category');
// Return: ['electronics', 'books', 'clothing']

// Get all user status
const statuses = await collection('users').distinct('status');
// Return: ['active', 'inactive', 'pending']

// Get all order years
const years = await collection('orders').distinct('year');
// Return: [2021, 2022, 2023, 2024]
```

**Applicable scenarios**:
- Get enumeration values ​​such as categories, tags, etc.
- Dimension value of statistics
- Build filter options

### 2. Conditional deduplication query

Combined with the query conditions, only matching documents are deduplicated:

```javascript
// Get all categories of products on sale
const activeCategories = await collection('products').distinct('category', { inStock: true });

// Get the role list of active users
const activeRoles = await collection('users').distinct('role', { status: 'active' });

// Get a list of customer IDs for completed orders
const completedCustomers = await collection('orders').distinct('customerId', { status: 'completed' });
```

**Applicable scenarios**:
- Statistics need to be based on specific conditions
- Dynamic filter options
- Data analysis and reporting

### 3. Nested field deduplication

Supports deduplication of nested fields:

```javascript
// Get the cities of all users
const cities = await collection('users').distinct('address.city');

// Get payment methods for all orders
const paymentMethods = await collection('orders').distinct('payment.method');

// Get the main tags of all products
const mainTags = await collection('products').distinct('tags.0');
```

**Applicable scenarios**:
- Field statistics for complex document structures
- Dimensional analysis of nested objects

### 4. Array field deduplication

When the field itself is an array, distinct will expand the array and remove duplicates:

```javascript
// Assume the product document structure:
// { name: "Product A", tags: ["sale", "hot", "new"] }
// { name: "Product B", tags: ["hot", "recommended"] }

const allTags = await collection('products').distinct('tags');
// Return: ["sale", "hot", "new", "recommended"]
// Automatically expand the tags array of all products and remove duplicates
```

**Applicable scenarios**:
- Tag cloud, keyword statistics
- All possible values ​​for multi-select fields
- Classification aggregation

### 5. Case-insensitive deduplication

Use the `collation` configuration to achieve case-insensitive deduplication:

```javascript
// Get username case-insensitively
const usernames = await collection('users').distinct('username', {}, {
  collation: {
    locale: 'en',
    strength: 1  // 1 = ignore case and accents
  }
});

// Assuming data: ['Alice', 'alice', 'Bob', 'bob', 'Charlie']
// Return: ['Alice', 'Bob', 'Charlie']
```

**Applicable scenarios**:
- Case-insensitive fields such as username and email address
- Multi-language text deduplication
- Standardized data statistics

### 6. Complex query conditions

Combined with MongoDB query operators to perform complex conditional deduplication:

```javascript
// Get categories of high-priced items
const expensiveCategories = await collection('products').distinct('category', { price: { $gte: 1000 } });

// Get the customer ID of orders in the past 30 days
const recentCustomers = await collection('orders').distinct('customerId', {
  createdAt: { $gte: new Date(Date.now() - 30 * 86400000) }
});

// Get highly rated product tags
const topTags = await collection('products').distinct('tags', {
  rating: { $gte: 4.5 },
  inStock: true
});
```

**Applicable scenarios**:
- Data analysis and reporting
- Conditional filtering
- Business logic statistics

### 7. Enable caching

For frequently queried deduplication results, enabling caching can significantly improve performance:

```javascript
// Cache product category list for 5 minutes
const categories = await collection('products').distinct('category', {}, { cache: 5 * 60 * 1000 });

// Cache user role list for 10 minutes
const roles = await collection('users').distinct('role', { status: 'active' }, { cache: 10 * 60 * 1000 });
```

**Applicable scenarios**:
- UI component data such as drop-down lists and filters
- Metadata and configuration items
- Statistics that change infrequently

**Note**:
- The cache time should not be too long to avoid data inconsistency
- It is not recommended to use cache in scenarios where data updates frequently
- Use `collection.invalidate('distinct')` to clear cache manually

### 8. Performance Analysis

Use the `explain` parameter to view query performance and index usage:

```javascript
// View the basic execution plan
const plan1 = await collection('products').distinct('category', {}, { explain: true });

// View detailed execution statistics
const plan2 = await collection('products').distinct('category', { inStock: true }, { explain: 'executionStats' });

console.log('Number of scanned documents:', plan2.executionStats.totalDocsExamined);
console.log('Execution time:', plan2.executionStats.executionTimeMillis, 'ms');
```

**Applicable scenarios**:
- Performance optimization and debugging
- Index effect verification
- Slow query analysis

### 9. distinct query in transaction

Execute distinct queries in transaction context to ensure data consistency:

```javascript
const session = client.startSession();
try {
  await session.withTransaction(async () => {
    // Get role of active user in transaction
    const roles = await collection('users').distinct(
      'role',
      { status: 'active' },
      { session }
    );

    // Perform other actions based on roles
    for (const role of roles) {
      await collection('permissions').updateMany(
        { role },
        { $set: { lastChecked: new Date() } },
        { session }
      );
    }
  });
} finally {
  await session.endSession();
}
```

**Applicable scenarios**:
- Deduplication queries that need to ensure data consistency
- Executed in the same transaction as other write operations
- Queries that require isolation level guarantees

**Note**:
- session must be a valid MongoDB ClientSession object
- Queries within a transaction are affected by the isolation level
- Transactions across sharded collections are not supported

## Performance optimization suggestions

### 1. Use index

Index fields that are frequently subjected to distinct queries:

```javascript
// Create an index for the category field
await collection('products').createIndex({ category: 1 });

// Create a composite index for combined queries
await collection('products').createIndex({ inStock: 1, category: 1 });
```

**Effect**:
-Significantly improve query speed
- Reduce the number of documents scanned
- Reduce server load

### 2. Reasonable use of query conditions

Narrow the query scope as much as possible and reduce the number of documents that need to be scanned:

```javascript
// ❌ BAD: Scan all documents
const allTags = await collection('products').distinct('tags');

// ✅ Better: Only scan items on sale
const activeTags = await collection('products').distinct('tags', {
  inStock: true
});
```

### 3. Enable caching

For data that changes infrequently, enable caching:

```javascript
// Classified data changes infrequently and is cached for 30 minutes
const categories = await collection('products').distinct('category', {
  cache: 30 * 60 * 1000
});
```

### 4. Avoid deduplication of large array fields

The distinct operation on an array field containing a large number of elements can be slow:

```javascript
// ⚠️ Note: If the tags array is large, performance may be poor
const allTags = await collection('products').distinct('tags');

// Consider using aggregation pipelines for more flexible control
```

## FAQ

### Q1: What is the difference between monSQLize's distinct and native MongoDB?

monSQLize's `distinct()` **directly calls the native MongoDB's `Collection.distinct()` method**, and provides extended functions on this basis:

**Native MongoDB distinct**:
```javascript
db.collection('products').distinct('category', { inStock: true }, {
  maxTimeMS: 5000,
  collation: { locale: 'en', strength: 1 },
  comment: 'getCategories'
});
```

**monSQLize distinct (fully compatible + extended)**:
```javascript
collection('products').distinct('category', { inStock: true }, {
  // Native MongoDB options (passed directly)
  maxTimeMS: 5000,
  collation: { locale: 'en', strength: 1 },
  comment: 'getCategories',
  session: clientSession,

  // monSQLize extended options
  cache: 5 * 60 * 1000,  // Cache for 5 minutes
  explain: 'executionStats'  // Performance analysis
});
```

**Extended function description**:

1. **Cache support** (`cache`)
- Automatically cache query results to reduce database pressure
- Suitable for data that does not change frequently (categories, labels, etc.)
- Clear cache manually using `collection.invalidate('distinct')`

2. **Performance Analysis** (`explain`)
- Return query execution plan instead of actual results
- Supports multiple verbosity levels: `'queryPlanner'`, `'executionStats'`, `'allPlansExecution'`
- Help optimize indexing and query performance

3. **Automatic event emission**
- Emit `beforeDistinct` and `afterDistinct` events
-Support query logging and monitoring

4. **Unified error handling**
- Wrap native errors and provide more friendly error messages
- Integrated error handling mechanism of monSQLize

**Core Principles**:
- ✅ All native MongoDB distinct options are passed unchanged
- ✅ Extended options (cache, explain) are processed by monSQLize before calling native methods
- ✅ The behavior is fully compatible with native MongoDB, but provides additional convenient functions

### Q2: What is the difference between distinct and aggregate + $group?

### Q2: What is the difference between distinct and aggregate + $group? (FAQ)

**distinct**:
- Easy to use, intuitive syntax
- Specifically used for field deduplication
- Better performance optimization
- Does not support complex data conversion

**aggregate + $group**:
- More powerful functions, supporting complex aggregation
- Can calculate multiple fields at the same time
- Support data conversion and calculation
- The syntax is relatively complex

**Selection Suggestions**:
- Simple deduplication using `distinct`
- Requires calculations, transformations or multi-field aggregations using `aggregate`

### Q3: Is the array returned by distinct in order?

By default, the array returned by distinct is unordered. If sorting is required, it should be sorted manually after getting the results:

```javascript
const categories = await collection('products').distinct('category');
const sortedCategories = categories.sort();
```

### Q4: How to deal with null values?

distinct will return the `null` value as a unique value:

```javascript
// Suppose some documents have category fields that are null
const categories = await collection('products').distinct('category');
// Return: ['electronics', 'books', null]

// If you want to exclude null values, use query criteria
const categoriesWithoutNull = await collection('products').distinct('category', { category: { $ne: null } });
```

### Q5: How to count the number of each unique value?

distinct returns only unique values, not counts. To count, use aggregate:

```javascript
// Use aggregate to count the number of items in each category
const categoryCounts = await collection('products').aggregate([
  { $group: { _id: '$category', count: { $sum: 1 } } },
  { $sort: { count: -1 } }
]);
// Return: [{ _id: 'electronics', count: 45 }, { _id: 'books', count: 30 }, ...]
```

### Q6: Does distinct support multi-field deduplication?

distinct only supports single field deduplication. If you need to combine multiple fields to remove duplicates, use aggregate:

```javascript
// Get unique (category, brand) combination
const combinations = await collection('products').aggregate([
  { $group: { _id: { category: '$category', brand: '$brand' } } }
]);
```

### Q7: How to use distinct in transactions?

Pass the ClientSession object with the `session` option:

```javascript
const session = client.startSession();
try {
  await session.withTransaction(async () => {
    const roles = await collection('users').distinct(
      'role',
      { status: 'active' },
      { session }  // Pass session
    );
    // Other transaction operations...
  });
} finally {
  await session.endSession();
}
```

## Usage suggestions

### When to use distinct

**✅ Recommended usage scenarios**:
- Get a list of enumeration values ​​such as categories, tags, etc.
- Build drop-down lists and filter options
- Simple data dimension statistics
- No counting or other aggregation calculations required

**❌ Not recommended scenarios**:
- Need to count the number of each value (use `aggregate` + `$group`)
- Requires multi-field combination deduplication (use `aggregate`)
- Requires complex conversion of results (use `aggregate`)
- The field is a very large array with a large amount of data (consider the performance impact)

### Performance considerations

**Optimization points**:
1. **Create an index for distinct fields**
   ```javascript
   await collection('products').createIndex({ category: 1 });
   ```

2. **Use query conditions to narrow the scope**
   ```javascript
   // ❌ Scan all documents
   const tags = await collection('products').distinct('tags');

   // ✅ Only scan items on sale
   const tags = await collection('products').distinct('tags', { inStock: true });
   ```

3. **Enable caching (data that changes infrequently)**
   ```javascript
   const categories = await collection('products').distinct('category', {}, {
     cache: 30 * 60 * 1000  // Caching for 30 minutes
   });
   ```

4. **Use explain to analyze performance**
   ```javascript
   const plan = await collection('products').distinct('category', {}, {
     explain: 'executionStats'
   });
   console.log('Execution time:', plan.executionStats.executionTimeMillis, 'ms');
   ```

### Caching strategy

**Data suitable for caching**:
- Metadata such as classification and tags (low frequency of change)
- List of enumeration values ​​(status, role, etc.)
- Filter options (no real-time updates required)

**Data not suitable for caching**:
- Frequently updated fields
-Statistics requiring real-time accuracy
- Sensitive data related to users

**Cache duration recommendations**:
```javascript
// Metadata: 30 minutes - 1 hour
const categories = await collection('products').distinct('category', {}, {
  cache: 30 * 60 * 1000
});

// Filter options: 5 - 10 minutes
const brands = await collection('products').distinct('brand', { inStock: true }, {
  cache: 5 * 60 * 1000
});

// Real-time data: no caching
const recentStatuses = await collection('orders').distinct('status', {
  createdAt: { $gte: new Date(Date.now() - 3600000) }
});
```

## Related methods

- **find**: Query multiple records and return complete documents
- **findOne**: Query a single record
- **count**: counts the number of documents
- **aggregate**: perform aggregation pipeline operations

## Best Practices

### 1. Index optimization
Create indexes for commonly used distinct fields to significantly improve query performance:

```javascript
// single field index
await collection('products').createIndex({ category: 1 });

// Composite index (with query conditions)
await collection('products').createIndex({ inStock: 1, category: 1 });
```

### 2. Narrow the query scope
Use query criteria to reduce the number of documents that need to be scanned:

```javascript
// ❌ BAD: Scan all documents
const tags = await collection('products').distinct('tags');

// ✅ Better: only scan relevant documents
const tags = await collection('products').distinct('tags', {
  inStock: true,
  category: 'electronics'
});
```

### 3. Proper use of cache
Enable caching for data that changes infrequently to reduce database pressure:

```javascript
// Metadata cache 30 minutes
const categories = await collection('products').distinct('category', {}, {
  cache: 30 * 60 * 1000
});

// Do not use caching when real-time data is needed
const recentStatuses = await collection('orders').distinct('status', {
  createdAt: { $gte: new Date(Date.now() - 3600000) }
});
```

### 4. Performance analysis
Use `explain` to analyze query performance and optimize indexes:

```javascript
const plan = await collection('products').distinct('category', { inStock: true }, {
  explain: 'executionStats'
});

console.log('Number of scanned documents:', plan.executionStats.totalDocsExamined);
console.log('Execution time:', plan.executionStats.executionTimeMillis, 'ms');
console.log('Whether to use index:', plan.executionStats.executionStages.stage);
```

### 5. Avoid deduplication of large array fields
The distinct operation on an array field containing a large number of elements can be slow:

```javascript
// ⚠️ Note: If the tags array is large, performance may be poor
const allTags = await collection('products').distinct('tags');

// Consider adding query conditions or using an aggregation pipeline
const popularTags = await collection('products').distinct('tags', {
  viewCount: { $gte: 100 }
});
```

### 6. Sorting results
The array returned by distinct is unordered and needs to be processed manually when sorting is required:

```javascript
const categories = await collection('products').distinct('category');
const sorted = categories.sort((a, b) => a.localeCompare(b));
```

### 7. Add query comments
Use the `comment` option to identify the query purpose to facilitate log analysis:

```javascript
const roles = await collection('users').distinct('role', {}, {
  comment: 'AdminPanel:getRoles:user_management'
});
```

### 8. Query in transaction
When data consistency is required, execute distinct in a transaction:

```javascript
const session = client.startSession();
try {
  await session.withTransaction(async () => {
    const roles = await collection('users').distinct('role', {}, { session });
    // Additional role-based transaction operations...
  });
} finally {
  await session.endSession();
}
```

### 9. Handling null values
Decide whether to include null values ​​based on business requirements:

```javascript
// Contains null
const allCategories = await collection('products').distinct('category');

// exclude null
const validCategories = await collection('products').distinct('category', {
  category: { $ne: null, $exists: true }
});
```

### 10. Use collation to handle multiple languages
Use collation in multi-language environments to ensure correct deduplication:

```javascript
// Case-insensitive deduplication
const usernames = await collection('users').distinct('username', {}, {
  collation: { locale: 'en', strength: 1 }
});

// Chinese sorting rules
const chineseNames = await collection('users').distinct('name', {}, {
  collation: { locale: 'zh' }
});
```

## Sample code

For more complete examples please refer to:
- [distinct.ts](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/distinct.ts) - Current TypeScript usage examples
- [queries.test.ts](../../test/integration/mongodb/queries.test.ts) - Integration test coverage
