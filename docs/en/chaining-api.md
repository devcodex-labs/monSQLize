# Chaining Methods

## Supported chain methods

## find() chain method

All methods are **MongoDB natively supported** ✅

| Method | Parameters | MongoDB native | Description | Example |
|------|------|-------------|------|------|
| **`.limit(n)`** | `number` | ✅ | Limit the number of returned documents | `.limit(10)` |
| **`.skip(n)`** | `number` | ✅ | Number of skipped documents | `.skip(20)` |
| **`.sort(spec)`** | `Object` | ✅ | Sorting rules | `.sort({ price: -1 })` |
| **`.project(spec)`** | `Object` | ✅ | Field projection | `.project({ name: 1, price: 1 })` |
| **`.hint(spec)`** | `Object\|String` | ✅ | Index Tips | `.hint({ category: 1 })` |
| **`.collation(spec)`** | `Object` | ✅ | Sorting rules | `.collation({ locale: 'zh' })` |
| **`.comment(str)`** | `String` | ✅ | Query comments | `.comment('test query')` |
| **`.maxTimeMS(ms)`** | `Number` | ✅ | Timeout | `.maxTimeMS(5000)` |
| **`.batchSize(n)`** | `Number` | ✅ | Batch size | `.batchSize(100)` |
| **`.explain(v)`** | `String` | ✅ | Execution plan | `.explain('executionStats')` |
| **`.stream()`** | - | ✅ | Return to stream | `.stream()` |
| **`.toArray()`** | - | ✅ | Explicit execution | `.toArray()` |

`limit(0)` intentionally matches MongoDB: it removes the result limit and may return all matches. Positive explicit limits are bounded by `findMaxLimit`, and explicit skips are bounded by `findMaxSkip`.

**MongoDB reference documentation**:
- [cursor.limit()](https://www.mongodb.com/docs/manual/reference/method/cursor.limit/)
- [cursor.skip()](https://www.mongodb.com/docs/manual/reference/method/cursor.skip/)
- [cursor.sort()](https://www.mongodb.com/docs/manual/reference/method/cursor.sort/)
- [cursor.project()](https://www.mongodb.com/docs/manual/reference/method/cursor.project/)
- [More cursor methods...](https://www.mongodb.com/docs/manual/reference/method/js-cursor/)

---

## aggregate() chain method

All methods are **MongoDB natively supported** ✅

## aggregate() chain method (supported chain method)

All methods are **MongoDB natively supported** ✅

| Method | Parameters | MongoDB native | Description | Example |
|------|------|-------------|------|------|
| **`.hint(spec)`** | `Object\|String` | ✅ | Index Tips | `.hint({ status: 1 })` |
| **`.collation(spec)`** | `Object` | ✅ | Sorting rules | `.collation({ locale: 'zh' })` |
| **`.comment(str)`** | `String` | ✅ | Query comments | `.comment('test')` |
| **`.maxTimeMS(ms)`** | `Number` | ✅ | Timeout | `.maxTimeMS(5000)` |
| **`.allowDiskUse(bool)`** | `Boolean` | ✅ | Disk usage allowed | `.allowDiskUse(true)` |
| **`.batchSize(n)`** | `Number` | ✅ | Batch size | `.batchSize(100)` |
| **`.explain(v)`** | `String` | ✅ | Execution plan | `.explain('executionStats')` |
| **`.stream()`** | - | ✅ | Return to stream | `.stream()` |
| **`.toArray()`** | - | ✅ | Explicit execution | `.toArray()` |

**MongoDB reference documentation**:
- [cursor.hint()](https://www.mongodb.com/docs/manual/reference/method/cursor.hint/)
- [cursor.collation()](https://www.mongodb.com/docs/manual/reference/method/cursor.collation/)
- [cursor.allowDiskUse()](https://www.mongodb.com/docs/manual/reference/method/cursor.allowDiskUse/)
- [More aggregation cursor methods...](https://www.mongodb.com/docs/manual/reference/method/js-cursor/)

---

## Usage example

## Basic chain call

```javascript
import MonSQLize from 'monsqlize';
const { collection } = await new MonSQLize({...}).connect();

//Simple limit and skip
const results = await collection("products")
    .find({ category: "electronics" })
    .limit(10)
    .skip(5);

console.log(`${results.length} products found`);
```

## Sort query

```javascript
//Sort by price in descending order
const results = await collection("products")
    .find({ inStock: true })
    .sort({ price: -1 })
    .limit(10);

console.log(`Highest price: ${results[0].price}`);
```

## Field projection

```javascript
//Return only specified fields
const results = await collection("products")
    .find({ category: "books" })
    .project({ name: 1, price: 1, author: 1 })
    .limit(5);

console.log("Fields:", Object.keys(results[0])); // ['_id', 'name', 'price', 'author']
```

## Complex query combination

```javascript
//Combining multiple chained methods
const results = await collection("products")
    .find({ category: "electronics", inStock: true })
    .sort({ rating: -1, sales: -1 })
    .skip(5)
    .limit(10)
    .project({ name: 1, price: 1, rating: 1 })
    .maxTimeMS(5000)
    .comment("Complex query example");

console.log(`${results.length} products found`);
```

## Use index hints

```javascript
//Force use of specified index
const results = await collection("products")
    .find({ category: "electronics", price: { $gte: 500 } })
    .hint({ category: 1, price: -1 })
    .limit(10);

console.log(`Use index query to find ${results.length} products`);
```

## Query execution plan

```javascript
//Analyze query performance
const plan = await collection("products")
    .find({ category: "electronics" })
    .sort({ price: -1 })
    .limit(10)
    .explain("executionStats");

console.log("Execution statistics:");
console.log(`Scan documents: ${plan.executionStats.totalDocsExamined}`);
console.log(`Returned document: ${plan.executionStats.nReturned}`);
console.log(`Execution time: ${plan.executionStats.executionTimeMillis}ms`);
```

## Streaming query

```javascript
//Use streaming to process large amounts of data
const stream = collection("products")
    .find({ category: "books" })
    .sort({ createdAt: -1 })
    .limit(100)
    .stream();

stream.on("data", (doc) => {
    console.log(`Process document: ${doc.name}`);
});

stream.on("end", () => {
    console.log("Streaming read completed");
});
```

## aggregate chain call

```javascript
//Aggregation pipeline chain call
const results = await collection("orders")
    .aggregate([
        { $match: { status: "paid" } },
        { $group: { _id: "$category", total: { $sum: "$amount" } } },
        { $sort: { total: -1 } }
    ])
    .allowDiskUse(true)
    .maxTimeMS(10000)
    .comment("Category Sales Statistics");

console.log(`Found ${results.length} categories`);
```

## Explicit toArray() call

```javascript
//Explicitly call toArray() (optional)
const results = await collection("products")
    .find({ rating: { $gte: 4.5 } })
    .sort({ rating: -1 })
    .limit(5)
    .toArray();  //explicit conversion to array

console.log(`Found ${results.length} highly rated products`);
```

---

## Compare with options parameter

## Chain calling method (new)

```javascript
const results = await collection("products")
    .find({ category: "electronics" })
    .sort({ price: -1 })
    .limit(10)
    .project({ name: 1, price: 1 });
```

## options parameter mode (original, still supported)

```javascript
const results = await collection("products").find(
    { category: "electronics" },
    {
        sort: { price: -1 },
        limit: 10,
        projection: { name: 1, price: 1 }
    }
);
```

**The two methods are completely equivalent and the results are the same**.

---

## Promise Compatibility

The object returned by the chain call implements the Promise interface and can be used like Promise:

```javascript
//Use .then()
collection("products")
    .find({ category: "books" })
    .limit(5)
    .then(results => {
        console.log(results);
    })
    .catch(err => {
        console.error(err);
    });

//Use await
const results = await collection("products")
    .find({ category: "books" })
    .limit(5);

//Use .catch()
const results = await collection("products")
    .find({ category: "books" })
    .limit(5)
    .catch(err => {
        console.error("Query failed:", err);
        return [];
    });
```

---

## Parameter verification

Chained methods automatically validate parameter types and values:

```javascript
//✅ Correct
.limit(10)
.skip(5)
.sort({ price: -1 })

//❌ Error - will throw an exception
.limit(-1)        // Error: limit() requires a non-negative integer
.skip("5")        // Error: skip() requires a non-negative integer
.sort("invalid")  // Error: sort() requires an object or array
```

---

## Execution protection

Chained objects can only be executed once to prevent accidental repeated execution:

```javascript
const chain = collection("products")
    .find({ category: "electronics" })
    .limit(5);

//First time execution ✅
const results1 = await chain.toArray();

//The second execution ❌ throws an error
try {
    const results2 = await chain.toArray();
} catch (err) {
    console.error(err.message); // "Query already executed"
}
```

---

## Cache support

Chained calls fully support monSQLize’s caching mechanism:

```javascript
//First query - get from database
const results1 = await collection("products")
    .find({ category: "electronics" })
    .limit(10);

//Second time of the same query - fetched from cache (if caching is enabled)
const results2 = await collection("products")
    .find({ category: "electronics" })
    .limit(10);
```

**Note**: The chain call and options parameter methods use the same cache key generation logic.

---

## Backward compatibility

## Fully backwards compatible

All existing options parameter code does not need to be modified and will still work correctly:

```javascript
//Old Code - Keep working ✅
const results = await collection("products").find(
    { category: "electronics" },
    { limit: 10, sort: { price: -1 } }
);

//New Code - Chained Calls ✅
const results = await collection("products")
    .find({ category: "electronics" })
    .limit(10)
    .sort({ price: -1 });
```

## Automatic detection

monSQLize will automatically detect the calling method:

- **No options parameter** → Returns the chain builder (supports chained calls)
- **with options parameter** → execute query directly (original behavior)

```javascript
//Case 1: No options → return chain builder
const chain = collection("products").find({ category: "electronics" });
//Type: FindChain, you can continue chain calls

//Case 2: With options → execute directly
const results = collection("products").find(
    { category: "electronics" },
    { limit: 10 }
);
//Type: Promise<Array>, returns the result directly
```

---

## Performance Notes

## Cache key generation

The chain call and options parameter methods generate the same cache key and share the cache:

```javascript
//Method 1: Chain call
const results1 = await collection("products")
    .find({ category: "electronics" })
    .limit(10)
    .sort({ price: -1 });

//Method 2: options parameter
const results2 = await collection("products").find(
    { category: "electronics" },
    { limit: 10, sort: { price: -1 } }
);

//results1 and results2 use the same cache key
//If results1 is cached, results2 will be fetched directly from cache
```

## Execution efficiency

Chained calls will not affect query execution efficiency:

- **Build Phase**: The chained method only modifies the internal option object, with no additional overhead
- **Execution phase**: Finally, the same underlying logic as the options parameter is called
- **cache hit**: enjoys the same cache optimization as the options parameter method

---

## Best Practices

## 1. Choose the appropriate calling method

**Chained calls apply**:
- Dynamically build queries (conditions are added step by step)
- Code readability is a priority
- Requires multiple steps to build complex queries

The **options parameter applies to**:
- Simple query (pass all options in one go)
- Centralized management when there are many options
- Existing code maintenance

## 2. Make full use of TypeScript type hints

```typescript
//TypeScript will automatically infer the type of the chained method
const results = await collection("products")
    .find({ category: "electronics" })
    .limit(10)        //TypeScript knows that limit requires number
    .sort({ price: -1 })  //TypeScript knows that sort requires object
    .project({ name: 1 }); //TypeScript knows the return type
```

## 3. Error handling

```javascript
try {
    const results = await collection("products")
        .find({ category: "electronics" })
        .limit(10)
        .sort({ price: -1 });
} catch (err) {
    if (err.message.includes("already executed")) {
        console.error("Query has been executed, please create a new chained object");
    } else {
        console.error("Query failed:", err);
    }
}
```

## 4. Avoid repeated execution

```javascript
//❌ Error - Repeat execution
const chain = collection("products").find({}).limit(10);
await chain.toArray();
await chain.toArray(); // Error!

//✅ Correct - create new chained objects every time
const results1 = await collection("products").find({}).limit(10);
const results2 = await collection("products").find({}).limit(10);
```

---

## Frequently Asked Questions (FAQ)

## Q: Which one is better, chain call or options parameter?

**A**: The functions of the two are completely equivalent, and the choice depends on personal preference and scenario:
- **Chain call**: more intuitive and suitable for dynamically building queries
- **options parameter**: more concise, suitable for simple static queries

## Q: Will chain calls affect caching?

**A**: No. Chained calls and options parameters use the same cache key generation logic and share the cache.

## Q: Can they be mixed?

**A**: Not recommended. While it's technically possible (by passing empty options and then chaining the calls), it leads to cluttered code. It is recommended to choose one method and be consistent with it.

## Q: Is the order of execution important?

**A**: Not important. The chained method only modifies the internal options object, and all options are applied on final execution.

```javascript
//These two ways of writing are completely equivalent
.limit(10).skip(5)
.skip(5).limit(10)
```

## Q: How to debug chained queries?

**A**: Use the `.explain()` method to view the execution plan:

```javascript
const plan = await collection("products")
    .find({ category: "electronics" })
    .limit(10)
    .explain("executionStats");

console.log("Query plan:", plan);
```

---

## Related documents

- [find method document](./find.md)
- [aggregate method document](./aggregate.md)
- [explain method document](./explain.md)
- [Full API Reference](../../README.md)

---

## Update log

| Version | Date | Updates |
|------|------|---------|
---

**Feedback and Suggestions**: If you have questions or suggestions, please submit [GitHub Issue](https://github.com/devcodex-labs/monSQLize/issues).
