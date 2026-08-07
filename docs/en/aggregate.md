# aggregate method detailed documentation

## Overview

`aggregate` is the aggregation pipeline method provided by monSQLize, which is used to perform MongoDB's aggregation framework operations. Supports complex data processing, statistical analysis, joint table query, group calculation, streaming processing, caching and other functions.

## Method signature
```javascript
async aggregate(pipeline = [], options = {})
```
## Parameter description

### pipeline array

An aggregation pipeline is an array of stages, each stage performs specific processing operations on the data.

**Common pipeline stages**:

| Stages | Description | Examples |
|------|------|------|
| `$match` | Filter documents (similar to find query) | `{ $match: { status: 'active' } }` |
| `$group` | Group aggregation calculation | `{ $group: { _id: '$category', total: { $sum: 1 } } }` |
| `$project` | Field projection and conversion | `{ $project: { name: 1, total: { $add: ['$price', '$tax'] } } }` |
| `$sort` | Sort | `{ $sort: { createdAt: -1 } }` |
| `$limit` | Limit the number of returns | `{ $limit: 10 }` |
| `$skip` | Skip the specified quantity | `{ $skip: 20 }` |
| `$lookup` | Related to other collections (joint table query) | `{ $lookup: { from: 'users', ... } }` |
| `$unwind` | Expand array field | `{ $unwind: '$tags' }` |
| `$addFields` | Add new field | `{ $addFields: { fullName: { $concat: ['$firstName', ' ', '$lastName'] } } }` |
| `$count` | Number of statistical documents | `{ $count: 'total' }` |
| `$facet` | Multi-channel aggregation | `{ $facet: { stats: [...], list: [...] } }` |
| `$out` / `$merge` | Write the pipeline output to a collection | `{ $merge: { into: 'summary' } }` |

### options object properties

| Parameters | Type | Required | Default | Source | Description |
|------|------|------|--------|------|------|
| `maxTimeMS` | Number | No | Global Configuration | MongoDB Native ✅ | Query Timeout (milliseconds) |
| `allowDiskUse` | Boolean | No | `false` | MongoDB native ✅ | Whether to allow disk usage (when processing large data sets) |
| `collation` | Object | No | - | MongoDB native ✅ | String collation |
| `hint` | Object/String | No | - | MongoDB native ✅ | Specify the index to use |
| `comment` | String | No | - | MongoDB Native ✅ | Query Comments (for logging and analytics) |
| `batchSize` | Number | No | - | MongoDB native ✅ | Batch size when streaming or array query |
| `explain` | Boolean/String | No | - | MongoDB native ✅ | Return query execution plan |
| `stream` | Boolean | No | `false` | monSQLize extension 🔧 | Whether to return a stream object (can also be called through the `.stream()` chain method) |
| `cache` | Number | No | `0` | monSQLize extension 🔧 | Cache TTL (milliseconds), greater than 0 to enable caching |
| `meta` | Boolean/Object | No | `false` | monSQLize extension 🔧 | Return query metadata (execution time, cache hit rate, etc.) |

**Legend description**:
- ✅ **MongoDB native**: This parameter is a standard function officially supported by MongoDB
- 🔧 **monSQLize extension**: monSQLize’s unique extension function

When the final pipeline stage is `$out` or `$merge`, monSQLize treats the aggregate as a write pipeline: aggregate result caching is skipped. Target collection read caches are cleared only when `cache.invalidate`, `autoInvalidate: true`, or global `cache.autoInvalidate` is configured.

**MongoDB reference documentation**:
- [aggregate() method ](https://www.mongodb.com/docs/manual/reference/method/db.collection.aggregate/)
- [Aggregation pipeline ](https://www.mongodb.com/docs/manual/core/aggregation-pipeline/)

### allowDiskUse Description

Setting `allowDiskUse: true` allows MongoDB to use disk temporary storage when the amount of data an aggregation operation needs to process exceeds the memory limit (default 100MB):
```javascript
// Aggregation operations for processing large data sets
const result = await collection('orders').aggregate([
  { $match: { year: 2024 } },
  { $group: { _id: '$category', total: { $sum: '$amount' } } },
  { $sort: { total: -1 } }
], {
  allowDiskUse: true  // Disk allowed
});
```
**Usage Scenario**:
- Process more than millions of data
- Complex grouping and sorting operations
- Multi-table joint query ($lookup)
- Avoid memory overflow errors

### explain configuration

For analyzing execution plans and performance of aggregation operations:
```javascript
const plan = await collection('orders').aggregate([
  { $match: { status: 'paid' } },
  { $group: { _id: '$customerId', total: { $sum: '$amount' } } }
], {
  explain: 'executionStats'
});
```
**explain level**:
- `true` or `'queryPlanner'`: Basic execution plan
- `'executionStats'`: execution statistics
- `'allPlansExecution'`: Details of all candidate plans

## Return value

### Normal mode returns array

By default, the `aggregate` method returns a Promise and resolve is the result document array:
```javascript
const stats = await collection('orders').aggregate([
  { $match: { status: 'paid' } },
  { $group: {
      _id: '$category',
      total: { $sum: '$amount' },
      count: { $sum: 1 }
  } }
]);

// stats = [
//   { _id: 'electronics', total: 50000, count: 120 },
//   { _id: 'books', total: 30000, count: 200 },
//   ...
// ]
```
**Return value type**: `Promise<Array<Object>>`

### Streaming mode returns stream object

When `stream: true`, a MongoDB Cursor Stream object is returned:
```javascript
const stream = await collection('orders').aggregate([
  { $match: { year: 2024 } },
  { $project: { orderId: 1, amount: 1, customerId: 1 } }
], {
  stream: true,
  batchSize: 1000
});

stream.on('data', (doc) => console.log(doc));
stream.on('end', () => console.log('Finish'));
stream.on('error', (err) => console.error('mistake:', err));
```
**Return value type**: `ReadableStream`

### explain mode returns execution plan

When `explain` is true or the specified level, returns the execution plan for the aggregation operation:
```javascript
const plan = await collection('orders').aggregate([
  { $match: { status: 'paid' } },
  { $group: { _id: '$category', total: { $sum: 1 } } }
], {
  explain: 'executionStats'
});

// plan = {
//   stages: [...],
//   executionStats: {
//     executionTimeMillis: 15,
//     totalDocsExamined: 5000,
//     ...
//   }
// }
```
**Return value type**: `Promise<Object>`

## Usage mode

### 1. Basic aggregation statistics

The most common aggregation operations used for data statistics and analysis:
```javascript
// Statistics of the total amount and quantity of orders in each status
const orderStats = await collection('orders').aggregate([
  {
    $match: {
      createdAt: { $gte: new Date('2024-01-01') }
    }
  },
  {
    $group: {
      _id: '$status',
      totalAmount: { $sum: '$amount' },
      count: { $sum: 1 },
      avgAmount: { $avg: '$amount' },
      maxAmount: { $max: '$amount' },
      minAmount: { $min: '$amount' }
    }
  },
  {
    $sort: { totalAmount: -1 }
  }
]);

// Count the number of products in each category
const categoryStats = await collection('products').aggregate([
  {
    $group: {
      _id: '$category',
      productCount: { $sum: 1 },
      avgPrice: { $avg: '$price' },
      totalSales: { $sum: '$sales' }
    }
  },
  {
    $sort: { totalSales: -1 }
  },
  {
    $limit: 10
  }
]);
```
**Applicable scenarios**:
- Sales report statistics
- User behavior analysis
- Data summary calculation
- Dashboard data display

### 2. Joint table query ($lookup)

Use the `$lookup` stage to associate other collections, similar to SQL JOIN:
```javascript
// Order associated user information
const ordersWithUsers = await collection('orders').aggregate([
  {
    $match: { status: 'paid' }
  },
  {
    $lookup: {
      from: 'users',              // associated collection name
      localField: 'userId',       // Fields of this collection
      foreignField: '_id',        // Fields of associated collections
      as: 'userInfo'              // Result field name
    }
  },
  {
    $unwind: '$userInfo'          // Expand array (one-to-one association)
  },
  {
    $project: {
      orderId: 1,
      amount: 1,
      status: 1,
      userName: '$userInfo.name',
      userEmail: '$userInfo.email'
    }
  },
  {
    $limit: 20
  }
], {
  allowDiskUse: true
});

// Advanced $lookup using pipes
const ordersWithDetails = await collection('orders').aggregate([
  {
    $match: { status: 'completed' }
  },
  {
    $lookup: {
      from: 'users',
      let: { customerId: '$userId' },
      pipeline: [
        {
          $match: {
            $expr: { $eq: ['$_id', '$$customerId'] },
            status: 'active'      // Additional filters
          }
        },
        {
          $project: { name: 1, email: 1, level: 1 }
        }
      ],
      as: 'customer'
    }
  }
]);
```
**Performance Tips**:
- Make sure the related fields are indexed
- For large data sets, set `allowDiskUse: true`
- Use pipeline form to add additional filtering conditions
- Avoid multi-level nested $lookups (poor performance)

#### Relation-query boundary and cardinality

`collection.aggregate<TResult>()` is the supported direct-collection API for same-database relation pipelines. It deliberately does **not** add `join()` or `lookup()` helper methods: the MongoDB pipeline remains visible and can express one-to-one, one-to-many, and many-to-many relationships without a second query language.

| Relationship | Pipeline shape | Result shape |
|---|---|---|
| One-to-one | `$lookup` followed by `$unwind` | One related document per source row |
| One-to-many | `$lookup` (optionally `let` + `pipeline`) | An array in the `as` field |
| Many-to-many | `$lookup` the junction collection, `$unwind`, then `$lookup` the target collection | One row per link, or regroup with `$group` |

```ts
type AuthorWithArticles = {
  name: string;
  articles: Array<{ title: string; rank: number }>;
};

const authors = runtime.collection('authors');
const authorsWithArticles = await authors.aggregate<AuthorWithArticles>([
  {
    $lookup: {
      from: 'articles',
      let: { authorId: '$_id' },
      pipeline: [
        { $match: { $expr: { $eq: ['$authorId', '$$authorId'] }, published: true } },
        { $project: { _id: 0, title: 1, rank: 1 } },
        { $sort: { rank: -1 } },
        { $limit: 3 },
      ],
      as: 'articles',
    },
  },
]);
```

This is raw collection aggregation. It does not apply Model hooks, Model hydration, or Model soft-delete defaults. If a joined collection uses soft deletion or tenant boundaries, put the required predicate inside its `$lookup.pipeline` explicitly. `$out` and `$merge` remain write-capable aggregation stages and are governed by the configured `writePathPolicy`; they are outside the read-only relation-query contract.

### 3. Data conversion and calculation

Use `$project` and `$addFields` for field conversions and calculations:
```javascript
// Field calculations and conversions
const processedOrders = await collection('orders').aggregate([
  {
    $match: { status: 'paid' }
  },
  {
    $addFields: {
      // Calculate price after discount
      finalAmount: {
        $subtract: [
          '$amount',
          { $multiply: ['$amount', { $divide: ['$discount', 100] }] }
        ]
      },
      // Calculate order profit
      profit: {
        $subtract: ['$amount', '$cost']
      },
      // date formatting
      orderDate: {
        $dateToString: {
          format: '%Y-%m-%d',
          date: '$createdAt'
        }
      }
    }
  },
  {
    $project: {
      orderId: 1,
      originalAmount: '$amount',
      finalAmount: 1,
      profit: 1,
      profitRate: {
        $multiply: [
          { $divide: ['$profit', '$amount'] },
          100
        ]
      },
      orderDate: 1
    }
  }
]);

// Conditional calculation
const userLevels = await collection('users').aggregate([
  {
    $addFields: {
      level: {
        $switch: {
          branches: [
            { case: { $gte: ['$totalSpent', 10000] }, then: 'VIP' },
            { case: { $gte: ['$totalSpent', 5000] }, then: 'Gold' },
            { case: { $gte: ['$totalSpent', 1000] }, then: 'Silver' }
          ],
          default: 'Bronze'
        }
      }
    }
  },
  {
    $group: {
      _id: '$level',
      count: { $sum: 1 }
    }
  }
]);
```
### 4. Array operations

Process documents containing array fields:
```javascript
// Expand array and count
const tagStats = await collection('products').aggregate([
  {
    $match: { status: 'active' }
  },
  {
    $unwind: '$tags'  // Expand tags array
  },
  {
    $group: {
      _id: '$tags',
      count: { $sum: 1 },
      products: { $push: '$name' }  // Collect product names
    }
  },
  {
    $sort: { count: -1 }
  },
  {
    $limit: 10
  }
]);

// Array filtering
const filteredOrders = await collection('orders').aggregate([
  {
    $addFields: {
      highValueItems: {
        $filter: {
          input: '$items',
          as: 'item',
          cond: { $gte: ['$$item.price', 100] }
        }
      }
    }
  },
  {
    $match: {
      highValueItems: { $ne: [] }  // Only keep orders with high-priced items
    }
  }
]);
```
### 5. Group statistics by date

Commonly used to generate time series reports:
```javascript
// Order statistics by day
const dailyStats = await collection('orders').aggregate([
  {
    $match: {
      createdAt: {
        $gte: new Date('2024-01-01'),
        $lt: new Date('2024-02-01')
      }
    }
  },
  {
    $group: {
      _id: {
        $dateToString: {
          format: '%Y-%m-%d',
          date: '$createdAt'
        }
      },
      orderCount: { $sum: 1 },
      totalAmount: { $sum: '$amount' },
      avgAmount: { $avg: '$amount' }
    }
  },
  {
    $sort: { _id: 1 }
  }
]);

// Statistics by month
const monthlyStats = await collection('orders').aggregate([
  {
    $match: {
      createdAt: { $gte: new Date('2024-01-01') }
    }
  },
  {
    $group: {
      _id: {
        year: { $year: '$createdAt' },
        month: { $month: '$createdAt' }
      },
      orderCount: { $sum: 1 },
      totalRevenue: { $sum: '$amount' }
    }
  },
  {
    $sort: { '_id.year': 1, '_id.month': 1 }
  }
]);
```
### 6. Multi-way aggregation ($facet)

Execute multiple independent aggregation pipelines in a single query:
```javascript
const multiStats = await collection('orders').aggregate([
  {
    $match: {
      createdAt: { $gte: new Date('2024-01-01') }
    }
  },
  {
    $facet: {
      // Statistics
      statistics: [
        {
          $group: {
            _id: null,
            totalOrders: { $sum: 1 },
            totalAmount: { $sum: '$amount' },
            avgAmount: { $avg: '$amount' }
          }
        }
      ],
      // Group by status
      byStatus: [
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 }
          }
        },
        {
          $sort: { count: -1 }
        }
      ],
      // Top 10 orders
      topOrders: [
        {
          $sort: { amount: -1 }
        },
        {
          $limit: 10
        },
        {
          $project: {
            orderId: 1,
            amount: 1,
            customerId: 1
          }
        }
      ]
    }
  }
]);

// Result structure:
// {
//   statistics: [{ totalOrders: 1000, totalAmount: 500000, avgAmount: 500 }],
//   byStatus: [{ _id: 'paid', count: 800 }, ...],
//   topOrders: [{ orderId: '...', amount: 5000 }, ...]
// }
```
### 7. Streaming large data sets

For large amounts of data, use streaming to avoid memory overflow:
```javascript
const stream = await collection('orders').aggregate([
  {
    $match: {
      createdAt: { $gte: new Date('2024-01-01') }
    }
  },
  {
    $lookup: {
      from: 'users',
      localField: 'userId',
      foreignField: '_id',
      as: 'user'
    }
  },
  {
    $project: {
      orderId: 1,
      amount: 1,
      userName: { $arrayElemAt: ['$user.name', 0] }
    }
  }
], {
  stream: true,
  batchSize: 1000,
  allowDiskUse: true
});

let processedCount = 0;
let totalAmount = 0;

stream.on('data', (order) => {
  processedCount++;
  totalAmount += order.amount;

  // Process data item by item
  // processOrder(order);
});

stream.on('end', () => {
  console.log(`Processing completed: ${processedCount} orders, total amount: ${totalAmount}`);
});

stream.on('error', (err) => {
  console.error('Stream processing error:', err);
});
```
## Performance optimization suggestions

### 1. Pipeline stage sequence optimization

Execute the filtering operation ($match) as early as possible to reduce the amount of data processed in subsequent stages:
```javascript
// ✅ Good: filter first and then process
const result = await collection('orders').aggregate([
  { $match: { status: 'paid', amount: { $gte: 100 } } },  // filter first
  { $lookup: { from: 'users', ... } },                     // Re-associate
  { $project: { ... } }                                    // final projection
]);

// ❌ Bad: filter after processing
const result = await collection('orders').aggregate([
  { $lookup: { from: 'users', ... } },                     // Link all data
  { $project: { ... } },
  { $match: { status: 'paid', amount: { $gte: 100 } } }   // filter last
]);
```
### 2. Use index

Make sure the fields used by the $match and $sort stages are indexed:
```javascript
// Create index: db.orders.createIndex({ status: 1, createdAt: -1 })

const result = await collection('orders').aggregate([
  {
    $match: { status: 'paid' }  // Use index
  },
  {
    $sort: { createdAt: -1 }    // Use index
  },
  {
    $limit: 100
  }
], {
  hint: { status: 1, createdAt: -1 }  // Force the use of indexes
});
```
### 3. Limit the amount of returned data

Use $limit and $project early to reduce data size:
```javascript
// ✅ Good: Limit data volume as early as possible
const result = await collection('orders').aggregate([
  { $match: { status: 'paid' } },
  { $sort: { amount: -1 } },
  { $limit: 10 },                    // Limit early
  { $lookup: { from: 'users', ... } }, // Only related to 10 items
  { $project: { orderId: 1, amount: 1, userName: '$user.name' } }
]);

// ❌ Bad: limit after processing all data
const result = await collection('orders').aggregate([
  { $match: { status: 'paid' } },
  { $lookup: { from: 'users', ... } }, // Link all data
  { $project: { ... } },
  { $limit: 10 }                     // Limit at the end
]);
```
### 4. Enable allowDiskUse for large data sets
```javascript
const result = await collection('orders').aggregate([
  { $match: { year: 2024 } },
  { $group: { _id: '$category', total: { $sum: '$amount' } } },
  { $sort: { total: -1 } }
], {
  allowDiskUse: true,  // Required when working with large data sets
  maxTimeMS: 30000     // Increase the timeout appropriately
});
```
### 5. Use explain to analyze performance
```javascript
const plan = await collection('orders').aggregate([
  { $match: { status: 'paid' } },
  { $group: { _id: '$category', total: { $sum: 1 } } }
], {
  explain: 'executionStats'
});

console.log('Execution time:', plan.executionStats?.executionTimeMillis, 'ms');
console.log('Number of scanned documents:', plan.executionStats?.totalDocsExamined);
```
### 6. Optimize $lookup performance
```javascript
// ✅ Good: The related fields have indexes and use pipeline filtering
const result = await collection('orders').aggregate([
  { $match: { status: 'paid' } },
  {
    $lookup: {
      from: 'users',
      let: { userId: '$userId' },
      pipeline: [
        { $match: {
            $expr: { $eq: ['$_id', '$$userId'] },
            status: 'active'  // Filter on association
        } },
        { $project: { name: 1, email: 1 } }  // Project only required fields
      ],
      as: 'user'
    }
  }
], {
  allowDiskUse: true
});
```
## Error handling
```javascript
try {
  const result = await collection('orders').aggregate([
    { $match: { status: 'paid' } },
    { $group: { _id: '$category', total: { $sum: '$amount' } } }
  ], {
    maxTimeMS: 5000
  });

  console.log('Aggregation results:', result);
} catch (error) {
  if (error.code === 'TIMEOUT') {
    console.error('Aggregation operation timed out');
  } else if (error.message?.includes('exceeded memory limit')) {
    console.error('Memory overflow, please set allowDiskUse: true');
  } else if (error.code === 31249) {
    console.error('Path conflict or invalid pipeline stage');
  } else {
    console.error('Aggregation failed:', error.message);
  }
}
```
## Difference from find

| properties | find | aggregate |
|------|------|-----------|
| Purpose | Simple query | Complex data processing |
| Joint table query | ❌ | ✅ ($lookup) |
| Group statistics | ❌ | ✅ ($group) |
| Data Conversion | Limited | ✅ Powerful |
| Calculated fields | ❌ | ✅ |
| Multi-way aggregation | ❌ | ✅ ($facet) |
| Performance | Fast (simple query) | Slow (complex operation) |
| Memory usage | Low | High (allowDiskUse available) |
| Streaming | ✅ | ✅ |
| Applicable scenarios | Basic CRUD | Statistical analysis, reports |

**Selection Suggestions**:
- Simple document query: use `find`
- Need statistics, grouping, calculation: use `aggregate`
- Need to join table query: use `aggregate` + `$lookup`
- Requires complex data conversion: use `aggregate`

## Common aggregation operators

### Grouped Accumulator

| Operator | Description | Example |
|--------|------|------|
| `$sum` | Sum | `{ total: { $sum: '$amount' } }` |
| `$avg` | Average | `{ avgPrice: { $avg: '$price' } }` |
| `$max` | Maximum value | `{ maxScore: { $max: '$score' } }` |
| `$min` | Minimum value | `{ minPrice: { $min: '$price' } }` |
| `$first` | first value | `{ firstOrder: { $first: '$orderId' } }` |
| `$last` | Last value | `{ lastOrder: { $last: '$orderId' } }` |
| `$push` | Push into array | `{ items: { $push: '$name' } }` |
| `$addToSet` | Push into array without duplication | `{ tags: { $addToSet: '$tag' } }` |

### Conditional operator

| Operator | Description | Example |
|--------|------|------|
| `$cond` | Ternary condition | `{ $cond: [{ $gte: ['$age', 18] }, 'adult', 'minor'] }` |
| `$switch` | Multi-branch conditions | `{ $switch: { branches: [...], default: '...' } }` |
| `$ifNull` | Null value handling | `{ $ifNull: ['$email', 'N/A'] }` |

### Mathematical operators

| Operator | Description | Example |
|--------|------|------|
| `$add` | Addition | `{ $add: ['$price', '$tax'] }` |
| `$subtract` | Subtraction | `{ $subtract: ['$amount', '$discount'] }` |
| `$multiply` | Multiplication | `{ $multiply: ['$price', '$quantity'] }` |
| `$divide` | Division | `{ $divide: ['$total', '$count'] }` |

### String operators

| Operator | Description | Example |
|--------|------|------|
| `$concat` | String concatenation | `{ $concat: ['$firstName', ' ', '$lastName'] }` |
| `$substr` | substring | `{ $substr: ['$name', 0, 3] }` |
| `$toUpper` | Convert to uppercase letters | `{ $toUpper: '$code' }` |
| `$toLower` | Convert to lowercase | `{ $toLower: '$email' }` |

### Date operator

| Operator | Description | Example |
|--------|------|------|
| `$dateToString` | Date formatting | `{ $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }` |
| `$year` | Year of extraction | `{ $year: '$createdAt' }` |
| `$month` | Extract month | `{ $month: '$createdAt' }` |
| `$dayOfMonth` | Extraction date | `{ $dayOfMonth: '$createdAt' }` |

## References

- [MongoDB Aggregation Document ](https://docs.mongodb.com/manual/aggregation/)
- [aggregate method example ](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/aggregate.ts)
- [aggregate method test ](../../test/integration/mongodb/aggregate.test.ts)
- [find method document ](./find.md)

## FAQ

### Q1: How to choose between aggregate and find?

**A**: Select based on query complexity:
- **Use find**: simple document query, conditional filtering, sorting, paging
- **Use aggregate**: Statistics, grouping, joint tables, and complex calculations are required

### Q2: Why is aggregate slower than find?

**A**: aggregate requires multiple processing stages, each of which consumes resources. Optimization suggestions:
- Use $match to filter data early
- Make sure filter fields are indexed
- Use $limit to limit the number of processes
- Project only the required fields

### Q3: How to optimize aggregation operations for large amounts of data?

**A**:
1. ✅ Setting up `allowDiskUse: true`
2. ✅ Ensure that related fields and filter fields are indexed
3. ✅ Use streaming (`stream: true`)
4. ✅ Increase `maxTimeMS` appropriately
5. ✅ Use explain to analyze performance bottlenecks

### Q4: What should I do if $lookup performance is poor?

**A**: Optimization strategy:
- Make sure the related fields are indexed
- Use pipeline form to filter data during association
- Avoid multiple levels of nested $lookups
- Consider data redundancy design and reduce the use of $lookup
- Set `allowDiskUse: true` when the amount of data is large

### Q5: When to use streaming?

**A**: Suitable scenarios:
- Data volume exceeds 100,000 items
- Need to process or transform data item by item
- Memory is limited
- Data export or ETL operations

### Q6: Is the execution order of the aggregation pipeline important?

**A**: Very important! Optimization order:
1. $match (filter early)
2. $sort (sort using index)
3. $limit (limit quantity as early as possible)
4. $lookup (associated with other collections)
5. $unwind (expand array)
6. $group (group calculation)
7. $project (field projection)

## Best Practices

### 1. Filter data as early as possible
```javascript
// ✅ Good
await collection('orders').aggregate([
  { $match: { status: 'paid', amount: { $gte: 100 } } },  // The first step of filtering
  { $lookup: { from: 'users', ... } },
  { $project: { ... } }
]);
```
### 2. Using indexes (best practice)
```javascript
// Create composite index
// db.orders.createIndex({ status: 1, createdAt: -1 })

await collection('orders').aggregate([
  { $match: { status: 'paid' } },  // Use index
  { $sort: { createdAt: -1 } }     // Use index
], {
  hint: { status: 1, createdAt: -1 }
});
```
### 3. Project only the required fields
```javascript
await collection('orders').aggregate([
  { $match: { status: 'paid' } },
  {
    $project: {
      orderId: 1,
      amount: 1,
      createdAt: 1
      // Don't project unnecessary fields
    }
  }
]);
```
### 4. Use streaming processing for large data sets
```javascript
const stream = await collection('orders').aggregate([
  { $match: { year: 2024 } },
  { $project: { orderId: 1, amount: 1 } }
], {
  stream: true,
  batchSize: 1000,
  allowDiskUse: true
});
```
### 5. Set a reasonable timeout
```javascript
await collection('orders').aggregate([
  { $match: { ... } },
  { $group: { ... } }
], {
  maxTimeMS: 10000  // Setting long timeouts for complex aggregations
});
```
---

## 🆕 Unified Expression System

### Overview (🆕 Unified Expression System)

monSQLize includes a unified expression system with common operators for building MongoDB aggregation queries more clearly.

### Core Advantages

1. **Concise and easy to read** - SQL-like expression syntax
2. **Type Safety** - Automatic type checking and conversion
3. **High performance** - LRU cache, >90% hit rate
4. **Context aware** - Automatically adapt $match/$project/$group
5. **100% Compatible** - No breaking changes

### Quick Start
```javascript
import { expr } from 'monsqlize';

// ❌ MongoDB native (complex)
await users.aggregate([
  {
    $project: {
      fullName: { $concat: ['$firstName', ' ', '$lastName'] },
      age: { $subtract: [{ $year: new Date() }, { $year: '$birthDate' }] }
    }
  }
]);

// ✅ Unified expression (concise)
await users.aggregate([
  {
    $project: {
      fullName: expr("CONCAT(firstName, ' ', lastName)"),
      age: expr("YEAR(CURRENT_DATE) - YEAR(birthDate)")
    }
  }
]);
```
### Supported operators (67)

#### Conditional expression (2)
- `? :` - Ternary operator: `score >= 60 ? 'Pass' : 'Fail'`
- `??` - Null value merging: `nickname ?? username`

#### Comparison operators (6)
- `>` `>=` `<` `<=` `===` `!==`
- Example: `age >= 18 && status === 'active'`

#### Logical operators (3)
- `&&` - Logical AND
- `||` - Logical OR
- `NOT()` - Logical NOT

#### Arithmetic operations (5)
- `+` `-` `*` `/` `%`
- Example: `price * (1 - discount / 100)`

#### Math functions (6)
- `ABS(x)` - absolute value
- `CEIL(x)` - round up
- `FLOOR(x)` - round down
- `ROUND(x)` - Rounding
- `SQRT(x)` - square root
- `POW(x, y)` - Exponentiation

#### String Basics (6)
- `CONCAT(str1, str2, ...)` - String concatenation
- `UPPER(str)` - Convert to uppercase letters
- `LOWER(str)` - Convert to lower case
- `TRIM(str)` - Remove leading and trailing spaces
- `SUBSTR(str, start, len)` - substring
- `LENGTH(str)` - string length

#### String Advanced (6)
- `SPLIT(str, delimiter)` - String splitting
- `REPLACE(str, find, replace)` - string replacement
- `INDEX_OF_STR(str, substr)` - Find substring position
- `LTRIM(str)` - remove left space
- `RTRIM(str)` - Remove right space
- `SUBSTR_CP(str, start, len)` - Unicode safe substring

#### Array Basics (6)
- `SIZE(array)` - array length
- `ARRAY_ELEM_AT(array, index)` - access array elements (supports negative indexing)
- `IN(value, array)` - Contains judgment
- `SLICE(array, start, end)` - array slicing
- `FIRST(array)` - first element
- `LAST(array)` - tail element

#### Array Advanced (4)
- `FILTER(array, var, condition)` - Array filtering (Lambda expression)
- `MAP(array, var, expression)` - Array mapping (Lambda expression)
- `INDEX_OF(array, value)` - Element search
- `CONCAT_ARRAYS(array1, array2, ...)` - array merging

#### Date operations (6)
- `YEAR(date)` - Year of extraction
- `MONTH(date)` - Extract month
- `DAY_OF_MONTH(date)` - Withdrawal date
- `HOUR(date)` - Extraction hours
- `MINUTE(date)` - Extraction minutes
- `SECOND(date)` - Extract seconds

#### Type operations (4)
- `TYPE(value)` - Type judgment
- `IS_NUMBER(value)` - Is it numeric?
- `IS_ARRAY(value)` - whether it is an array
- `EXISTS(field)` - field existence

#### Type conversion (4)
- `TO_INT(value)` - Convert to integer
- `TO_STRING(value)` - Convert to string
- `OBJECT_TO_ARRAY(obj)` - object to array
- `ARRAY_TO_OBJECT(array)` - Array to object

#### High frequency operation (3 pieces)
- `REGEX(str, pattern)` - Regular matching
- `MERGE_OBJECTS(obj1, obj2, ...)` - Object merge
- `SET_UNION(array1, array2)` - set union

#### Aggregation accumulators (9)
- `SUM(expr)` - Sum
- `AVG(expr)` - average
- `MAX(expr)` - maximum
- `MIN(expr)` - minimum value
- `COUNT()` - count
- `PUSH(expr)` - array collection
- `ADD_TO_SET(expr)` - Duplicate collection
- `FIRST(expr)` - the first element in $group
- `LAST(expr)` - tail element in $group

#### Conditional expansion (1)
- `SWITCH(cond1, val1, cond2, val2, ..., default)` - Multiple branch conditions

### Complete example

#### Example 1: User information processing
```javascript
await collection('users').aggregate([
  {
    $project: {
      // String processing
      fullName: expr("CONCAT(firstName, ' ', lastName)"),
      email: expr("LOWER(TRIM(email))"),

      // age calculation
      age: expr("YEAR(CURRENT_DATE) - YEAR(birthDate)"),
      ageGroup: expr("SWITCH(age < 18, 'Minor', age < 65, 'Adult', 'Senior')"),

      // Status judgment
      status: expr("active === true && verified === true ? 'Active' : 'Inactive'"),

      // Array statistics
      tagCount: expr("SIZE(tags)"),
      hasPremiumTag: expr("IN('premium', tags)")
    }
  }
]);
```
#### Example 2: Order statistical analysis
```javascript
await collection('orders').aggregate([
  {
    $project: {
      // price calculation
      originalPrice: 1,
      discount: 1,
      finalPrice: expr("originalPrice * (1 - discount / 100)"),
      savings: expr("originalPrice - finalPrice"),
      savingsPercent: expr("(savings / originalPrice * 100).toFixed(2)"),

      // Date extraction
      year: expr("YEAR(createdAt)"),
      month: expr("MONTH(createdAt)"),
      day: expr("DAY_OF_MONTH(createdAt)"),

      // Status classification
      statusLabel: expr("SWITCH(status === 'paid', 'Paid', status === 'pending', 'Pending', 'Cancelled')")
    }
  },
  {
    $group: {
      _id: { year: '$year', month: '$month' },
      totalOrders: expr("COUNT()"),
      totalRevenue: expr("SUM(finalPrice)"),
      avgOrder: expr("AVG(finalPrice)"),
      maxOrder: expr("MAX(finalPrice)")
    }
  }
]);
```
#### Example 3: Array processing (Lambda expression)
```javascript
await collection('products').aggregate([
  {
    $project: {
      name: 1,

      // Lambda expression - filtering
      activeTags: expr("FILTER(tags, tag, tag.active === true)"),
      expensiveItems: expr("FILTER(items, item, item.price > 100)"),

      // Lambda expression - mapping
      tagNames: expr("MAP(tags, tag, tag.name)"),
      itemPrices: expr("MAP(items, item, item.price)"),

      // Array operations
      firstTag: expr("FIRST(tags)"),
      lastTag: expr("LAST(tags)"),
      tagCount: expr("SIZE(tags)"),

      // Use in combination
      activeTagNames: expr("MAP(FILTER(tags, t, t.active === true), t, t.name)")
    }
  }
]);
```
#### Example 4: Complex business logic
```javascript
await collection('students').aggregate([
  {
    $project: {
      name: 1,

      // Grade Level (Multiple Branches)
      grade: expr("SWITCH(score >= 90, 'A', score >= 80, 'B', score >= 70, 'C', score >= 60, 'D', 'F')"),

      // Scholarship Calculation
      scholarship: expr("score >= 95 ? 5000 : (score >= 90 ? 3000 : (score >= 85 ? 2000 : 0))"),

      // Comprehensive evaluation
      evaluation: expr("CONCAT(name, ' scored ', TO_STRING(score), ' points, grade: ', grade)"),

      // Is it excellent?
      isExcellent: expr("score >= 90 && attendance > 0.95 && conduct === 'good'")
    }
  }
]);
```
### Performance optimization

#### LRU caching mechanism

The unified expression system has built-in LRU cache:

- **Compilation time**: <1ms
- **Cache Hit Rate**: >90%
- **Automatic expiration**: Intelligent management
```javascript
// Identical expressions are automatically cached
const expr1 = expr("CONCAT(firstName, ' ', lastName)");  // Compile for the first time
const expr2 = expr("CONCAT(firstName, ' ', lastName)");  // cache hit
```
#### Performance recommendations

1. **Simplify expressions** - avoid overly complex nesting
2. **Index support** - Make sure there is an index when using expressions in $match
3. **Batch processing** - Use $project to reduce the amount of subsequent processing

### Best Practices (🆕 Unified Expression System)

#### 1. Field reference
```javascript
// ✅ Correct - use field names directly
expr("CONCAT(firstName, ' ', lastName)")

// ❌ Error - do not prefix with $
expr("CONCAT($firstName, ' ', $lastName)")
```
#### 2. String literal
```javascript
// ✅Supports single quotes and double quotes
expr("status === 'active'")
expr('status === "active"')
```
#### 3. Nested functions
```javascript
// ✅ Supports nesting at any depth
expr("UPPER(TRIM(LOWER(email)))")
expr("CONCAT(UPPER(firstName), ' ', UPPER(lastName))")
```
#### 4. Lambda variable
```javascript
// ✅ Lambda variable name can be customized
expr("FILTER(tags, tag, tag.active === true)")
expr("FILTER(tags, t, t.active === true)")
expr("MAP(items, item, item.price)")
```
### Frequently Asked Questions (FAQ) (🆕 Unified Expression System)

**Q: Is it compatible with native MongoDB syntax? **
A: Fully compatible! Can be mixed in the same query:
```javascript
await collection('users').aggregate([
  {
    $match: { status: 'active' }  // native syntax
  },
  {
    $project: {
      fullName: expr("CONCAT(firstName, ' ', lastName)"),  // unified expression
      email: { $toLower: '$email' }  // native syntax
    }
  }
]);
```
**Q: How is the performance? **
A:
- Compilation time: <1ms (first time)
- Cache hits: >90% (duplicate expressions)
- Runtime: Same as native MongoDB (it is native syntax after compilation)

**Q: Are all MongoDB operators supported? **
A: Supports 67 common operators, covering 95%+ usage scenarios. It will continue to expand in the future based on demand.

**Q: How to debug expressions? **
A: View the compiled MongoDB native syntax:
```javascript
import { expr, compilePipelineExpressions } from 'monsqlize';

const pipeline = [
  {
    $project: {
      fullName: expr("CONCAT(firstName, ' ', lastName)")
    }
  }
];

const compiled = compilePipelineExpressions(pipeline);
console.log(compiled);  // View the compiled MongoDB native syntax
```
**Q: Does it affect backward compatibility? **
A: No impact at all! Unified expressions are an optional feature. Not using `expr()` is the native MongoDB syntax.

---

### Technical details

#### Context aware

The compiler will automatically detect the current context ($match/$project/$group) and generate the optimal MongoDB operator:

- **$match**: use query operators ($eq, $gt, etc.)
- **$project**: use aggregate expressions ($concat, $add, etc.)
- **$group**: use accumulators ($sum, $avg, etc.)

#### Lambda expression parsing

Full support for Lambda expressions of FILTER and MAP:
```javascript
// Syntax: FILTER(array, variable, condition)
expr("FILTER(items, item, item.price > 100 && item.stock > 0)")

// Compile to MongoDB native:
{
  $filter: {
    input: '$items',
    as: 'item',
    cond: {
      $and: [
        { $gt: ['$$item.price', 100] },
        { $gt: ['$$item.stock', 0] }
      ]
    }
  }
}
```
---

## Related links

- [Test Case ](../../test/unit/expression/) - 107 test examples
- [Verification progress ](../../test/validation/VERIFICATION-PROGRESS.md) - Current release verification entry
