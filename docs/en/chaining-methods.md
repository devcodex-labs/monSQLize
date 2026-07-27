# monSQLize chain calling method support documentation

## Overview

Now you can build queries using chained calls just like you would with the native MongoDB driver. Chained methods fully support caching, parameter validation and error handling.

---

## 🎯 Supported chain calling method (completely implemented)

## 1. `find()` method

## ✅ Supported chain calls (12 methods in total)

| Methods | Syntax | Description | Exposed capabilities |
|------|------|------|---------|
| **`.limit(n)`** | `.limit(number)` | Limit the number of returned documents | `find()` query chain |
| **`.skip(n)`** | `.skip(number)` | Number of skipped documents | `find()` query chain |
| **`.sort(spec)`** | `.sort(object)` | Sorting rules | `find()` query chain |
| **`.project(spec)`** | `.project(object)` | Field projection | `find()` query chain |
| **`.hint(spec)`** | `.hint(object\|string)` | Index prompt | `find()` query chain |
| **`.collation(spec)`** | `.collation(object)` | Sorting rules | `find()` query chain |
| **`.comment(str)`** | `.comment(string)` | Query comments | `find()` query chain |
| **`.maxTimeMS(ms)`** | `.maxTimeMS(number)` | Query timeout | `find()` query chain |
| **`.batchSize(n)`** | `.batchSize(number)` | batch size | `find()` query chain |
| **`.explain(v)`** | `.explain(string?)` | Return query execution plan | `find()` query chain |
| **`.stream()`** | `.stream()` | Return streaming results | `find()` query chain |
| **`.toArray()`** | `.toArray()` | Explicit conversion to array | `find()` query chain |

`limit(0)` intentionally keeps the MongoDB cursor semantics: it means "no limit" and may return all matching documents. Use a positive limit for bounded reads; explicit positive limits are capped by `findMaxLimit`.

## 📝 Usage example

```javascript
//Basic usage - limit and skip
const results = await collection('products')
  .find({ category: 'electronics' })
  .limit(10)
  .skip(5);

//sort query
const results = await collection('products')
  .find({ inStock: true })
  .sort({ price: -1 })
  .limit(10);

//Field projection
const results = await collection('products')
  .find({ category: 'books' })
  .project({ name: 1, price: 1 })
  .limit(5);

//Complex combinations - multiple chained methods
const results = await collection('products')
  .find({ category: 'electronics', inStock: true })
  .sort({ rating: -1, sales: -1 })
  .skip(5)
  .limit(10)
  .project({ name: 1, price: 1 })
  .hint({ category: 1, price: -1 })
  .maxTimeMS(5000)
  .comment('Complex query');

//Query execution plan
const plan = await collection('products')
  .find({ category: 'electronics' })
  .sort({ price: -1 })
  .limit(10)
  .explain('executionStats');

//Streaming query
const stream = collection('products')
  .find({ category: 'books' })
  .sort({ createdAt: -1 })
  .limit(100)
  .stream();
```

---

## 2. `aggregate()` method

## ✅ Supported chain calls (9 methods in total)

| Methods | Syntax | Description | Exposed capabilities |
|------|------|------|---------|
| **`.hint(spec)`** | `.hint(object\|string)` | Index prompt | `aggregate()` query chain |
| **`.collation(spec)`** | `.collation(object)` | Sorting rules | `aggregate()` query chain |
| **`.comment(str)`** | `.comment(string)` | Query comments | `aggregate()` query chain |
| **`.maxTimeMS(ms)`** | `.maxTimeMS(number)` | Query timeout | `aggregate()` query chain |
| **`.allowDiskUse(bool)`** | `.allowDiskUse(boolean)` | Allow disk use | `aggregate()` query chain |
| **`.batchSize(n)`** | `.batchSize(number)` | batch size | `aggregate()` query chain |
| **`.explain(v)`** | `.explain(string?)` | Return the aggregate execution plan | `aggregate()` query chain |
| **`.stream()`** | `.stream()` | Return streaming results | `aggregate()` query chain |
| **`.toArray()`** | `.toArray()` | Explicit conversion to array | `aggregate()` query chain |

## 📝 Usage example (2. aggregate() method)

```javascript
//Basic aggregation
const results = await collection('orders')
  .aggregate([
    { $match: { status: 'paid' } },
    { $group: { _id: '$category', total: { $sum: '$amount' } } }
  ])
  .allowDiskUse(true);

//Complete chain call
const results = await collection('orders')
  .aggregate([
    { $match: { status: 'paid' } },
    { $group: { _id: '$category', total: { $sum: '$amount' } } },
    { $sort: { total: -1 } }
  ])
  .hint({ status: 1, createdAt: -1 })
  .allowDiskUse(true)
  .maxTimeMS(10000)
  .comment('Category Sales Statistics');

//aggregate execution plan
const plan = await collection('orders')
  .aggregate([
    { $match: { status: 'paid' } },
    { $group: { _id: '$customerId', total: { $sum: '$amount' } } }
  ])
  .explain('executionStats');

//streaming aggregation
const stream = collection('orders')
  .aggregate([
    { $match: { status: 'paid' } },
    { $limit: 100 }
  ])
  .stream();
```

---

## 🆚 MongoDB native chain method comparison

## Complete comparison table

| Method | MongoDB native support | monSQLize v3 | Description |
|------|-----------------|----------------|------|
| `.limit()` | ✅ | ✅ | Fully supported |
| `.skip()` | ✅ | ✅ | Fully supported |
| `.sort()` | ✅ | ✅ | Fully supported |
| `.project()` | ✅ | ✅ | Fully supported |
| `.hint()` | ✅ | ✅ | Fully supported |
| `.collation()` | ✅ | ✅ | Fully supported |
| `.comment()` | ✅ | ✅ | Fully supported |
| `.maxTimeMS()` | ✅ | ✅ | Fully supported |
| `.batchSize()` | ✅ | ✅ | Fully supported |
| `.explain()` | ✅ | ✅ | Fully supported |
| `.toArray()` | ✅ | ✅ | Fully supported |
| `.stream()` | ✅ | ✅ | Fully supported (use `.stream()` instead of `.forEach()`) |
| `.forEach()` | ✅ | Implemented via `.stream()` | Use streaming instead |
| `.map()` | ✅ | Implemented via `.stream()` | Use streaming instead |
| `.hasNext()` | ✅ | ❌ | Not supported (conflicts with cache architecture) |
| `.next()` | ✅ | ❌ | Not supported (conflicts with cache architecture) |
| `.close()` | ✅ | ❌ | Not required (automatic management) |

**Summary**: monSQLize v3 supports the 12 chaining methods listed above. Use the table as the capability contract; application coverage depends on the query patterns your service uses.

---

## ✨ Highlights of new features

## 1. Promise compatibility

The chained call object implements the complete Promise interface:

```javascript
//directly await
const results = await collection('products').find({}).limit(10);

//Use .then()
collection('products')
  .find({}).limit(10)
  .then(results => console.log(results));

//Use .catch()
const results = await collection('products')
  .find({}).limit(10)
  .catch(err => []);
```

## 2. Automatic parameter verification

```javascript
//✅ Correct
.limit(10)
.skip(5)

//❌ Error - automatically throw exception
.limit(-1)        // Error: limit() requires a non-negative integer
.skip("invalid")  // Error: skip() requires a non-negative integer
.sort("invalid")  // Error: sort() requires an object or array
```

## 3. Execution protection

To prevent accidental re-execution:

```javascript
const chain = collection('products').find({}).limit(5);

//First time execution ✅
await chain.toArray();

//The second execution ❌ throws an error
await chain.toArray(); // Error: Query already executed
```

## 4. Full cache support

The chained call uses the same cache key as the options parameter:

```javascript
//These two methods share the cache
await collection('products').find({}).limit(10).sort({ price: -1 });
await collection('products').find({}, { limit: 10, sort: { price: -1 } });
```

---

## 🔄 Backwards Compatibility

## 100% backwards compatible

All existing code **without modification**:

```javascript
//Old Code - Keep working ✅
const results = await collection('products').find(
  { category: 'electronics' },
  { limit: 10, sort: { price: -1 } }
);

//New Code - Chained Calls ✅
const results = await collection('products')
  .find({ category: 'electronics' })
  .limit(10)
  .sort({ price: -1 });
```

## Automatic detection

monSQLize will automatically detect the calling method:

- **No options parameter** → return chain builder
- **with options parameter** → execute query directly

---

## 📚 Related documents

- **[Chain call complete API documentation](./chaining-api.md)** - Detailed usage guide and best practices
- **[Chain call example](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/chaining-api.ts)** - Current TypeScript example
- **[find method document](./find.md)** - find method detailed description
- **[aggregate method document](./aggregate.md)** - detailed description of aggregate method
- **[explain method document](./explain.md)** - Performance analysis tool

**Feedback and Suggestions**: If you have questions or suggestions, please submit [GitHub Issue](https://github.com/devcodex-labs/monSQLize/issues).
