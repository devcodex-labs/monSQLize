# explain method detailed documentation

## Overview

The `explain` method is used to analyze query execution plans to help diagnose performance issues and optimize query strategies. **Use MongoDB's native `Cursor.explain()` method directly**, which returns the query execution plan instead of actual data and is specifically used for performance diagnosis.

## Core Features

- ✅ **Native MongoDB API**: Directly call the `cursor.explain()` method
- ✅ **3 detail levels**: `queryPlanner` (default) / `executionStats` / `allPlansExecution`
- ✅ **Full query support**: all native options such as filter, projection, sort, limit, skip, hint, collation, etc.
- ✅ **Multiple operations supported**: query operations such as find, aggregate, count, distinct, etc.
- ✅ **Performance Analysis**: Detailed statistics on index usage, number of scanned documents, execution time, etc.

## Usage scenarios

### 1. Verify index usage
Check whether the query uses the expected index and identify full table scan (COLLSCAN) issues.

### 2. Diagnose slow queries
Analyze query bottlenecks (full table scan, memory sorting, multi-stage processing, etc.) and find performance optimization points.

### 3. Comparative query strategies
Compare the performance differences of different hints/queries and choose the optimal index and query conditions.

### 4. Optimize complex queries
Analyze the execution plans of complex queries such as aggregation pipelines and multi-field queries, and optimize pipeline sequences and index designs.

## Method signature

monSQLize provides **two ways** to use explain, fully compatible with native MongoDB:

### Method 1: Chain call (consistent with native MongoDB)
```javascript
// find query - chained calls
await collection('products').find({ category: 'electronics' }).explain('executionStats');

// aggregate aggregation - chained calls
await collection('orders').aggregate([
  { $match: { status: 'paid' } },
  { $group: { _id: '$customerId', total: { $sum: '$amount' } } }
]).explain('executionStats');

// Complete example
await collection('products')
  .find({ category: 'electronics', inStock: true })
  .explain('queryPlanner');  // or 'executionStats' / 'allPlansExecution'
```
**Advantages**:
- ✅ Completely consistent with native MongoDB API
- ✅ Simple and intuitive syntax
- ✅ Suitable for quick performance analysis

**Note**:
- Options such as sort and limit cannot be used during chain calls.
- For these options, use option 2

### Method 2: options parameter (supports complete query options)
```javascript
// find query - full options
await collection('products').find(
  { category: 'electronics' },
  {
    sort: { price: 1 },
    limit: 10,
    projection: { name: 1, price: 1 },
    hint: { category: 1 },
    explain: 'executionStats'
  }
);

// aggregate aggregation
await collection('orders').aggregate(
  [
    { $match: { status: 'paid' } },
    { $group: { _id: '$customerId', total: { $sum: '$amount' } } }
  ],
  { explain: 'executionStats' }
);

// count count
await collection('users').count(
  { status: 'active' },
  { explain: true }
);

// distinct deduplication
await collection('products').distinct(
  'category',
  { inStock: true },
  { explain: 'queryPlanner' }
);
```
**Advantages**:
- ✅ Supports all query options such as sort, limit, skip, projection, hint, etc.
- ✅ Supports all query methods (find, aggregate, count, distinct)
- ✅ Concentrated parameters and clear code

## Parameter description

### verbosity parameter

Specify the verbosity level returned, which determines the amount of information included in the execution plan.

| Value | Type | Description | Whether to execute the query |
|---|------|------|------------|
| `'queryPlanner'` | String | Returns the execution plan chosen by the query optimizer (default) | ❌ No |
| `'executionStats'` | String | Return execution plan + actual execution statistics | ✅ Yes |
| `'allPlansExecution'` | String | Returns all candidate plans and their execution statistics | ✅ Yes |
| `true` | Boolean | Equivalent to `'queryPlanner'` | ❌ No |

### Query options (all options supported by find/aggregate)

**Core Options** (Natively supported by MongoDB):

| Parameters | Type | Required | Default value | Description |
|------|------|------|--------|------|
| `filter` / `query` | Object | No | `{}` | Query conditions (find operation) |
| `projection` | Object | No | - | Field projection |
| `sort` | Object | No | - | Collation |
| `limit` | Number | No | - | Limit on the number of returned documents |
| `skip` | Number | No | - | Number of skipped documents |
| `hint` | Object/String | No | - | Force the use of the specified index |
| `collation` | Object | No | - | Sorting rules (locale, strength, etc.) |
| `maxTimeMS` | Number | No | - | Query timeout (milliseconds) |
| `comment` | String | No | - | Query comments for log tracking |

**Aggregation pipeline options** (aggregate operation):

| Parameters | Type | Required | Default value | Description |
|------|------|------|--------|------|
| `pipeline` | Array | Yes | - | Array of aggregation pipeline stages |
| `allowDiskUse` | Boolean | No | `false` | Whether to allow the use of disks for sorting/grouping large amounts of data |
| `maxTimeMS` | Number | No | - | Aggregation operation timeout |
| `hint` | Object/String | No | - | Force the use of the specified index |
| `comment` | String | No | - | Query comments |

## verbosity mode

### 1. queryPlanner (default)

Returns the execution plan chosen by the query optimizer without executing the query. The most lightweight, suitable for quickly checking index usage.
```javascript
const plan = await collection('users').explain({
  query: { age: { $gte: 25 } }
  // verbosity: 'queryPlanner' //Default value
});

console.log('Use index:', plan.queryPlanner.winningPlan.inputStage?.indexName);
console.log('execution strategy:', plan.queryPlanner.winningPlan.stage);
```
**Return information**:
- `queryPlanner.winningPlan`: Plan selected by the query optimizer
- `queryPlanner.rejectedPlans`: Rejected candidate plan
- `queryPlanner.parsedQuery`: parsed query conditions

### 2. executionStats

Actually execute the query and return detailed statistical information (number of scanned documents, time taken, etc.). Suitable for performance analysis.
```javascript
const stats = await collection('products').explain({
  query: { category: 'Electronics', price: { $gte: 500 } },
  sort: { price: -1 },
  limit: 10,
  verbosity: 'executionStats'
});

console.log('Number of scanned documents:', stats.executionStats.totalDocsExamined);
console.log('Return the number of documents:', stats.executionStats.nReturned);
console.log('Execution time:', stats.executionStats.executionTimeMillis, 'ms');
console.log('Query efficiency:', (stats.executionStats.nReturned / stats.executionStats.totalDocsExamined * 100).toFixed(2) + '%');
```
**Return information**:
- `executionStats.executionTimeMillis`: Execution time (milliseconds)
- `executionStats.totalDocsExamined`: Number of scanned documents
- `executionStats.totalKeysExamined`: Number of index keys scanned
- `executionStats.nReturned`: Number of documents returned
- `executionStats.executionStages`: Detailed execution phase information

### 3. allPlansExecution

Returns all candidate execution plans and their trial execution results. Suitable for understanding the optimizer selection process.
```javascript
const allPlans = await collection('orders').explain({
  query: { customerId: 'CUS050', status: 'completed', total: { $gte: 1000 } },
  verbosity: 'allPlansExecution'
});

console.log('Number of candidate plans:', allPlans.executionStats.allPlansExecution?.length);
console.log('Winning plan index:', allPlans.queryPlanner.winningPlan.inputStage?.indexName);
```
**Return information**:
- Contains all information for `queryPlanner` and `executionStats`
- `executionStats.allPlansExecution`: Execution details of all candidate plans

## Usage example

### Example 1: Basic query plan analysis
```javascript
import MonSQLize from 'monsqlize';
const { collection } = await new MonSQLize({
  type: 'mongodb',
  databaseName: 'shop',
  config: { uri: 'mongodb://localhost:27017' }
}).connect();

// ========== Method 1: Chain call (consistent with native MongoDB) ==========
const plan1 = await collection('products')
  .find({ category: 'Electronics', inStock: true })
  .explain('queryPlanner');

// ========== Method 2: options parameter (supports more options) ==========
const plan2 = await collection('products').find(
  { category: 'Electronics', inStock: true },
  {
    sort: { price: 1 },
    limit: 20,
    explain: 'queryPlanner'
  }
);

console.log('query plan:', JSON.stringify(plan1.queryPlanner.winningPlan, null, 2));

// Check if index is used
if (plan1.queryPlanner.winningPlan.stage === 'COLLSCAN') {
  console.warn('⚠️ Full table scan! It is recommended to create an index');
} else {
  console.log('✅ Index used:', plan1.queryPlanner.winningPlan.inputStage?.indexName);
}
```
### Example 2: Perform statistical analysis
```javascript
// Analyze query performance
const stats = await collection('orders').find(
  {
    createdAt: { $gte: new Date('2024-01-01'), $lte: new Date('2024-12-31') },
    status: 'paid'
  },
  {
    sort: { createdAt: -1 },
    limit: 100,
    explain: 'executionStats'
  }
);

console.log('\n📊 Execution statistics:');
console.log('  - Execution time:', stats.executionStats.executionTimeMillis, 'ms');
console.log('  - Number of scanned documents:', stats.executionStats.totalDocsExamined);
console.log('  - Return the number of documents:', stats.executionStats.nReturned);
console.log('  - Scan index keys:', stats.executionStats.totalKeysExamined);

// Calculate query efficiency
const efficiency = (stats.executionStats.nReturned / stats.executionStats.totalDocsExamined * 100).toFixed(2);
console.log('  - Query efficiency:', efficiency, '%');

if (efficiency < 10) {
  console.warn('\n⚠️ Query efficiency is less than 10%, it is recommended to optimize the index');
}
```
### Example 3: Index optimization analysis
```javascript
// Compare the performance difference with and without indexes
console.log('===== No index query=====');
const noIndexPlan = await collection('logs').find(
  { level: 'ERROR', service: 'api-server' },
  { explain: 'executionStats' }
);
console.log('Number of scanned documents:', noIndexPlan.executionStats.totalDocsExamined);
console.log('Execution time:', noIndexPlan.executionStats.executionTimeMillis, 'ms');

// Create index
await collection('logs').createIndex({ level: 1, service: 1 });

console.log('\n===== There is an index query=====');
const withIndexPlan = await collection('logs').find(
  { level: 'ERROR', service: 'api-server' },
  { explain: 'executionStats' }
);
console.log('Number of scanned documents:', withIndexPlan.executionStats.totalDocsExamined);
console.log('Execution time:', withIndexPlan.executionStats.executionTimeMillis, 'ms');

const improvement = ((1 - withIndexPlan.executionStats.executionTimeMillis / noIndexPlan.executionStats.executionTimeMillis) * 100).toFixed(2);
console.log('\n✅ Performance improvements:', improvement, '%');
```
### Example 4: hint forces index selection
```javascript
// Create multiple indexes
await collection('inventory').createIndex({ category: 1, quantity: 1 }, { name: 'cat_qty_idx' });
await collection('inventory').createIndex({ warehouse: 1, quantity: 1 }, { name: 'wh_qty_idx' });

// Let the optimizer choose automatically
console.log('===== Automatically select index=====');
const autoPlan = await collection('inventory').find(
  { category: 'electronics', warehouse: 'wh-01', quantity: { $gte: 500 } },
  { explain: 'executionStats' }
);
console.log('selected index:', autoPlan.queryPlanner.winningPlan.inputStage?.indexName);
console.log('Number of scanned documents:', autoPlan.executionStats.totalDocsExamined);

// Force category index
console.log('\n===== Force category index=====');
const hintPlan = await collection('inventory').find(
  { category: 'electronics', warehouse: 'wh-01', quantity: { $gte: 500 } },
  {
    hint: { category: 1, quantity: 1 },
    explain: 'executionStats'
  }
);
console.log('index used:', hintPlan.queryPlanner.winningPlan.inputStage?.indexName);
console.log('Number of scanned documents:', hintPlan.executionStats.totalDocsExamined);

// Contrast effect
if (hintPlan.executionStats.totalDocsExamined < autoPlan.executionStats.totalDocsExamined) {
  console.log('\n✅ Forced indexing works better');
} else {
  console.log('\n⚠️ Automatically selected indexes perform better');
}
```
### Example 5: Analysis of all candidate plans
```javascript
const allPlans = await collection('orders').find(
  { customerId: 'CUS050', status: 'completed', total: { $gte: 1000 } },
  {
    sort: { createdAt: -1 },
    explain: 'allPlansExecution'
  }
);

console.log('📊 Query plan analysis:\n');
console.log('Number of candidate plans:', allPlans.executionStats.allPlansExecution?.length || 0);
console.log('winning plan:', allPlans.queryPlanner.winningPlan.inputStage?.indexName);

if (allPlans.executionStats.allPlansExecution) {
  console.log('\nAll candidate plans:');
  allPlans.executionStats.allPlansExecution.forEach((plan, index) => {
    console.log(`  ${index + 1}. index:`, plan.inputStage?.indexName || 'none');
    console.log(`     scanning: ${plan.totalDocsExamined} document`);
    console.log(`     time consuming: ${plan.executionTimeMillis} ms\n`);
  });
}
```
### Example 6: Slow query diagnosis
```javascript
// Diagnosing slow queries
const slowPlan = await collection('analytics').find(
  {
    timestamp: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), $lte: new Date() },
    'metadata.device': 'mobile'
  },
  {
    sort: { timestamp: -1 },
    limit: 100,
    explain: 'executionStats'
  }
);

console.log('🔍 Slow query diagnosis:\n');
console.log('Execution method:', slowPlan.queryPlanner.winningPlan.stage);
console.log('Scan documents:', slowPlan.executionStats.totalDocsExamined);
console.log('Return to document:', slowPlan.executionStats.nReturned);
console.log('Execution time:', slowPlan.executionStats.executionTimeMillis, 'ms\n');

// Diagnose the problem
if (slowPlan.queryPlanner.winningPlan.stage === 'COLLSCAN') {
  console.log('❌ question: Full table scan');
  console.log('💡 suggestion: Create index{ timestamp: -1, "metadata.device": 1 }');
}

if (slowPlan.queryPlanner.winningPlan.inputStage?.stage === 'SORT') {
  console.log('❌ question: Memory sorting');
  console.log('💡 suggestion: Create an index that supports sorting');
}

const efficiency = (slowPlan.executionStats.nReturned / slowPlan.executionStats.totalDocsExamined * 100).toFixed(2);
if (efficiency < 10) {
  console.log(`❌ question: Query efficiency is low(${efficiency}%)`);
  console.log('💡 suggestion: Optimize query conditions or index design');
}
```
## Performance optimization suggestions

### 1. Identify full table scan
```javascript
const plan = await collection('users').find(
  { email: 'user@example.com' },
  { explain: 'executionStats' }
);

if (plan.queryPlanner.winningPlan.stage === 'COLLSCAN') {
  console.warn('⚠️ Full table scan detected!');
  console.log('It is recommended to create an index: db.users.createIndex({ email: 1 })');
}
```
### 2. Check index coverage
```javascript
const plan = await collection('products').find(
  { category: 'electronics', price: { $lt: 1000 } },
  {
    projection: { name: 1, price: 1 },
    explain: 'executionStats'
  }
);

// Check if covering index is used (IXSCAN + PROJECTION_COVERED)
const isCovered = plan.queryPlanner.winningPlan.stage === 'PROJECTION_COVERED';
if (isCovered) {
  console.log('✅ Covered index used (best performance)');
} else {
  console.log('⚠️ Covering index not used');
  console.log('It is recommended to create a covering index: { category: 1, price: 1, name: 1 }');
}
```
### 3. Analyze sorting performance
```javascript
const plan = await collection('orders').find(
  { status: 'paid' },
  {
    sort: { createdAt: -1 },
    limit: 100,
    explain: 'executionStats'
  }
);

// Check if sorted in memory
const hasMemorySort = plan.queryPlanner.winningPlan.inputStage?.stage === 'SORT';
if (hasMemorySort) {
  console.warn('⚠️ Memory sorting (poor performance)');
  console.log('It is recommended to create a composite index: { status: 1, createdAt: -1 }');
} else {
  console.log('✅ Sort using index');
}
```
## Explain of aggregation pipeline

### Aggregation pipeline explain example
```javascript
// Analyze the execution plan of an aggregation pipeline
const aggPlan = await collection('orders').aggregate(
  [
    { $match: { status: 'paid', createdAt: { $gte: new Date('2024-01-01') } } },
    { $group: { _id: '$customerId', total: { $sum: '$amount' }, count: { $sum: 1 } } },
    { $sort: { total: -1 } },
    { $limit: 10 }
  ],
  { explain: 'executionStats' }
);

console.log('📊 Aggregation pipeline analysis:');
console.log('total execution time:', aggPlan.executionStats.executionTimeMillis, 'ms');

// Analyze each stage
aggPlan.executionStats.executionStages.forEach((stage, index) => {
  console.log(`\nstage${index + 1}: ${stage.stage}`);
  console.log('  - Number of documents processed:', stage.nReturned);
  console.log('  - Execution time:', stage.executionTimeMillis, 'ms');
});

// Check if index is used
if (aggPlan.executionStats.executionStages[0]?.indexName) {
  console.log('\n✅ $match Stage uses index:', aggPlan.executionStats.executionStages[0].indexName);
} else {
  console.log('\n⚠️ $match The index is not used in this stage. Optimization is recommended.');
}
```
### Aggregation pipeline optimization suggestions
```javascript
// ❌ Bad: $project then $match (cannot use index)
const badPipeline = [
  { $project: { category: 1, price: 1, inStock: 1 } },
  { $match: { category: 'electronics', inStock: true } }
];

// ✅ Better: $match first then $project (can use index)
const goodPipeline = [
  { $match: { category: 'electronics', inStock: true } },  // Index can be used
  { $project: { category: 1, price: 1, inStock: 1 } }
];

// Compare execution plans
const badPlan = await collection('products').aggregate(badPipeline, { explain: 'executionStats' });
const goodPlan = await collection('products').aggregate(goodPipeline, { explain: 'executionStats' });

console.log('Not optimized pipeline:');
console.log('  - Number of scanned documents:', badPlan.executionStats.totalDocsExamined);
console.log('  - Execution time:', badPlan.executionStats.executionTimeMillis, 'ms');

console.log('\nOptimized pipeline:');
console.log('  - Number of scanned documents:', goodPlan.executionStats.totalDocsExamined);
console.log('  - Execution time:', goodPlan.executionStats.executionTimeMillis, 'ms');
```
## monSQLize explain versus native MongoDB

### Native MongoDB explain (chain call)
```javascript
// Native MongoDB driver - chained calls
const cursor = db.collection('products').find({ category: 'electronics' })
  .sort({ price: 1 })
  .limit(10);

const plan = await cursor.explain('executionStats');

// Or direct chain call
const plan2 = await db.collection('products')
  .find({ category: 'electronics' })
  .sort({ price: 1 })
  .limit(10)
  .explain('executionStats');
```
### monSQLize explain (fully compatible)

**Method 1: Chain call (consistent with native)**
```javascript
// monSQLize - chained calls (completely consistent with native MongoDB)
const plan = await collection('products')
  .find({ category: 'electronics' })
  .explain('executionStats');
```
**Note**: When calling in a chain, options such as sort/limit/skip need to be specified in the second parameter of find:
```javascript
// ❌ Not supported: sort/limit cannot be added to the chain call
// await collection('products').find({ ... }).sort({ price: 1 }).explain()

// ✅ Correct: Specify options in find parameters
const plan = await collection('products')
  .find({ category: 'electronics' }, { sort: { price: 1 }, limit: 10 })
  .explain('executionStats');
```
**Method 2: options parameter (recommended, more complete functions)**
```javascript
// monSQLize - using the options parameter
const plan = await collection('products').find(
  { category: 'electronics' },
  {
    sort: { price: 1 },
    limit: 10,
    explain: 'executionStats'
  }
);
```
### Implementation principle

monSQLize implements chain calls by adding the `explain()` method on the Promise object:
```javascript
// Internal implementation example
const resultPromise = run('find', { query, ...options }, async () => { ... });

// Add explain method
resultPromise.explain = async (verbosity = 'queryPlanner') => {
  const cursor = collection.find(query, driverOpts);
  return cursor.explain(verbosity);
};

return resultPromise;  // Return an enhanced Promise
```
This works either way:
- Directly `await collection('products').find({ ... })` to obtain query results
- You can also get the execution plan with `await collection('products').find({ ... }).explain('executionStats')`

### Core Principles

- ✅ **Fully Compatible**: Supports native MongoDB chain call syntax
- ✅ **Same return value**: Return exactly the same execution plan object
- ✅ **Backward Compatibility**: Still supports options parameter method
- ✅ **Supports all operations**: find, aggregate, count, distinct, etc. all support the explain option

## Notes

- **explain does not return actual data**: only returns execution plans and statistical information, not query results
- **executionStats will execute the query**: `executionStats` and `allPlansExecution` modes will actually execute the query to collect statistics
- **Use with caution in production environment**: Using `executionStats` in production environment may affect performance. It is recommended to use it during off-peak periods or in test environment.
- **hint Use with caution**: Forcibly specifying an index may bypass the optimizer's intelligent selection. The effect should be verified by explain before use.
- **verbosity parameter**:
  - `queryPlanner`: No query execution, minimal overhead
  - `executionStats`: Execute query and return statistical information
  - `allPlansExecution`: Execute all candidate plans, with the largest overhead
- **Relationship with cache**: explain query will not trigger the caching mechanism of monSQLize
- **Slow Query Log**: When `executionStats` is used and the execution time exceeds the configured slow query threshold, the slow query log will be recorded

## Error handling
```javascript
try {
  const plan = await collection('users').find(
    { age: { $gte: 18 } },
    { explain: 'invalidMode' }  // Invalid verbosity
  );
} catch (error) {
  console.error('Explain fail:', error.message);

  // Common error types
  if (error.message.includes('verbosity')) {
    console.log('Valid verbosity values: queryPlanner, executionStats, allPlansExecution');
  }

  if (error.message.includes('hint')) {
    console.log('The specified hint index does not exist');
  }
}
```
## FAQ

### Q1: Which verbosity should I choose for explain?

**Selection Suggestions**:
- **Quick check index usage**: Use `queryPlanner` (default), no query is executed, minimal overhead
- **Analyze actual performance**: Use `executionStats` to obtain actual statistics such as execution time, number of scanned documents, etc.
- **Compare multiple index plans**: Use `allPlansExecution` to see the performance of all candidate plans

### Q2: Will explain affect database performance?

**Extent of impact**:
- `queryPlanner`: no impact, only analyzes the query plan and does not execute the query
- `executionStats`: It has a certain impact and needs to be actually executed to collect statistics.
- `allPlansExecution`: The impact is large and all candidate plans need to be tried and executed.

**Suggestions**:
- Development/testing environment: free to use
- Production environment: Give priority to using `queryPlanner`, and choose the off-peak period when `executionStats` is needed.

### Q3: How to understand the execution plan returned by explain?

**Key fields**:
- `stage: 'COLLSCAN'`: full table scan (poor performance)
- `stage: 'IXSCAN'`: index scan (good performance)
- `stage: 'FETCH'`: Get the complete document based on the index
- `stage: 'SORT'`: memory sorting (can be optimized)
- `stage: 'PROJECTION_COVERED'`: covering index (optimal)

**Performance Index**:
- `totalDocsExamined`: Number of scanned documents (the fewer, the better)
- `totalKeysExamined`: Number of index keys scanned
- `nReturned`: Number of documents returned
- `executionTimeMillis`: Execution time (milliseconds)
- Query efficiency = `nReturned / totalDocsExamined` (nearly 100% is the best)

### Q4: Why does explain still display COLLSCAN when I create an index?

**Possible reasons**:
1. **Query condition does not match the index**: The index is `{ name: 1 }`, but the query condition is `{ email: 'xxx' }`
2. **Data volume is too small**: When the number of collection documents is less than 100, the optimizer may choose to scan the full table
3. **Poor index selectivity**: The number of documents matching the query conditions exceeds 30% of the collection, and the optimizer believes that the full table scan is faster
4. **Index not valid**: The index is being built (view by `db.currentOp()`)

**Solution**:
```javascript
// 1. Use hint to force the use of indexes
const plan = await collection('users').find(
  { name: 'Alice' },
  {
    hint: { name: 1 },
    explain: 'executionStats'
  }
);

// 2. Compare the performance difference with and without hint
console.log('Is it faster to use hint?');
```
### Q5: How should the aggregation pipeline be optimized?

**Optimization Principles**:
1. **$match prefix**: filter data as early as possible to reduce the processing volume in subsequent stages
2. **$project defer**: Project fields only when needed to avoid passing unnecessary data
3. **Use index**: Use index as much as possible in stages such as $match and $sort.
4. **Avoid $lookup large collections**: Joint table query is expensive, consider data redundancy design

**Example**:
```javascript
// ❌ Not good
const badPipeline = [
  { $project: { name: 1, status: 1 } },
  { $match: { status: 'active' } }  // Unable to use index
];

// ✅ Better
const goodPipeline = [
  { $match: { status: 'active' } },  // Index can be used
  { $project: { name: 1, status: 1 } }
];
```
## References

- [MongoDB Explain Document](https://docs.mongodb.com/manual/reference/method/cursor.explain/)
- [explain sample code ](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/explain.ts)
- [Performance Optimization Guide](./count-queue.md)
- [Best Practices in Index Design](./create-index.md)
