# insertMany() - insert documents in batches

## Syntax

```javascript
collection(name).insertMany(documents, options?)
```

## Parameters

## documents (required)

**Type**: `Array<Object>`

Array of documents to insert. If the document does not have the `_id` field, MongoDB will automatically generate one.

```javascript
await collection("users").insertMany([
  { name: "Alice", email: "alice@example.com" },
  { name: "Bob", email: "bob@example.com" },
  { name: "Charlie", email: "charlie@example.com" }
]);
```

## options (optional)

**Type**: `Object`

| Options | Type | Default | Description |
|------|------|--------|------|
| `ordered` | boolean | true | Whether to insert in order (whether to continue if an error is encountered) |
| `writeConcern` | Object | - | Write follow options |
| `bypassDocumentValidation` | boolean | false | Whether to bypass document verification |
| `comment` | string | - | Operation comments, used for log tracking |

## Return value

**Type**: `Promise<Object>`

Return an object containing the results of the insertion:

```javascript
{
  insertedIds: {
    0: ObjectId("507f1f77bcf86cd799439011"),
    1: ObjectId("507f1f77bcf86cd799439012"),
    2: ObjectId("507f1f77bcf86cd799439013")
  },
  insertedCount: 3,      //Number of documents successfully inserted
  acknowledged: true     //Is the operation confirmed?
}
```

## Core Features

## High-throughput batch insertion

Compared with awaiting `insertOne()` in a loop, `insertMany()` reduces application-to-database round trips:

```javascript
//One acknowledged database call per document
for (const user of users) {
  await collection("users").insertOne(user);
}

//One bulk request for the array, subject to server and payload limits
await collection("users").insertMany(users);
```

**Performance characteristics**:

| Path | Database round trips | Main trade-off |
|---------|-----------------|------------|
| Awaited `insertOne()` loop | One per document | Simple per-document control, but repeated network and acknowledgement overhead |
| `insertMany()` | One bulk request when it fits deployment limits | Lower round-trip count; larger payload and partial-failure handling |

Actual throughput depends on document size, indexes, write concern, ordered mode, server topology, and concurrency. Benchmark the deployed workload using the [performance evidence contract](./performance-evidence.md).

## ✅ Ordered vs Unordered Insertion

**Ordered insertion (ordered: true, default)**:
- Insert in sequence in array order
- Stop immediately when encountering an error
- The previous document has been inserted, but the following document will not be inserted.

**Unordered insertion (ordered: false)**:
- Parallel insertion, no order guaranteed
- Continue inserting other documents if an error is encountered
- Insert as many documents as possible

```javascript
//Ordered insertion (default)
try {
  await collection("users").insertMany([
    { _id: 1, name: "Alice" },
    { _id: 1, name: "Bob" },    //❌ repeat _id, stop
    { _id: 2, name: "Charlie" } //will not be inserted
  ], { ordered: true });
} catch (error) {
  //Only the first document is inserted
}

//out-of-order insertion
try {
  await collection("users").insertMany([
    { _id: 1, name: "Alice" },
    { _id: 1, name: "Bob" },    //❌ Repeat _id, but continue
    { _id: 2, name: "Charlie" } //✅ Will be inserted
  ], { ordered: false });
} catch (error) {
  //The first and third documents are inserted
}
```

## ✅ Explicit cache invalidation

After the insertion succeeds, monSQLize does not clear query caches by default. Use `cache.invalidate` or `autoInvalidate: true` when the write should clear cache.

```javascript
//Query and cache
const users = await collection("users").find({}, { cache: 5000 });
console.log(users.length); // 10

//Batch insert and precisely clear the cached query when needed
await collection("users").insertMany(
  [
    { name: "Alice" },
    { name: "Bob" }
  ],
  {
    cache: {
      invalidate: [{
        operation: "find",
        query: {},
        options: { cache: 5000 }
      }]
    }
  }
);

//Query again (will not return from cache)
const updatedUsers = await collection("users").find({}, { cache: 5000 });
console.log(updatedUsers.length); // 12
```

## ✅ Slow query monitoring

Insert operations that exceed a threshold (default 1000ms) automatically log warnings.

```javascript
//Large inserts may trigger slow query warnings
await collection("products").insertMany(largeProductArray);
//Log: [WARN] [insertMany] Slow operation warning { duration: 1500ms, insertedCount: 10000 }
```

## Common scenarios

## Scenario 1: Create users in batches

```javascript
const newUsers = [
  { userId: "user1", name: "Alice", email: "alice@example.com" },
  { userId: "user2", name: "Bob", email: "bob@example.com" },
  { userId: "user3", name: "Charlie", email: "charlie@example.com" }
];

const result = await collection("users").insertMany(newUsers);
console.log(`Successfully created ${result.insertedCount} users`);
console.log("User IDs:", result.insertedIds);
```

## Scenario 2: Import CSV/JSON data

```javascript
const fs = require("fs");

//Read JSON file
const data = JSON.parse(fs.readFileSync("products.json", "utf8"));

//Batch insert
const result = await collection("products").insertMany(data);
console.log(`${result.insertedCount} products imported`);
```

## Scenario 3: Batch insert logs

```javascript
const logs = [
  { level: "info", message: "Server started", timestamp: new Date() },
  { level: "warn", message: "High memory usage", timestamp: new Date() },
  { level: "error", message: "Database connection failed", timestamp: new Date() }
];

await collection("logs").insertMany(logs);
```

## Scenario 4: Out-of-order insertion (maximum fault tolerance)

```javascript
//Even if some parts fail, insert as many documents as possible
try {
  const result = await collection("products").insertMany(
    products,
    { ordered: false }  //Unordered insertion, continue when an error is encountered
  );
  console.log(`Successfully inserted ${result.insertedCount} products`);
} catch (error) {
  //Check which documents failed to insert
  if (error.writeErrors) {
    console.error(`Failed to insert ${error.writeErrors.length} documents`);
    error.writeErrors.forEach(err => {
      console.error(`Document Index ${err.index}: ${err.errmsg}`);
    });
  }
  //Some documents are still inserted successfully
  console.log(`Actual insertion of ${error.result.insertedCount} documents`);
}
```

## Scenario 5: A large amount of data is inserted in batches

```javascript
//Very large data sets should be inserted in batches
const BATCH_SIZE = 1000;

async function insertLargeDataset(collectionName, documents) {
  let inserted = 0;

  for (let i = 0; i < documents.length; i += BATCH_SIZE) {
    const batch = documents.slice(i, i + BATCH_SIZE);
    const result = await collection(collectionName).insertMany(batch);
    inserted += result.insertedCount;

    console.log(`Progress: ${inserted}/${documents.length}`);
  }

  return inserted;
}

//Usage example
const totalInserted = await insertLargeDataset("products", allProducts);
console.log(`${totalInserted} documents inserted in total`);
```

## Error handling

## Duplicate key error (ordered insertion)

```javascript
try {
  await collection("users").insertMany([
    { _id: "user1", name: "Alice" },
    { _id: "user1", name: "Bob" },    //❌ Duplicate _id
    { _id: "user2", name: "Charlie" } //will not be inserted
  ], { ordered: true });  //Orderly insertion, stop on error
} catch (error) {
  if (error.code === ErrorCodes.DUPLICATE_KEY) {
    console.error("Duplicate _id exists");
    console.log(`${error.result.insertedCount} documents inserted`);
  }
}
```

## Duplicate key error (unordered insertion)

```javascript
try {
  await collection("users").insertMany([
    { _id: "user1", name: "Alice" },
    { _id: "user1", name: "Bob" },    //❌ Duplicate _id
    { _id: "user2", name: "Charlie" } //✅ Still plugged in
  ], { ordered: false });  //Unordered insertion, continue when an error is encountered
} catch (error) {
  console.log(`Successfully inserted ${error.result.insertedCount} documents`); // 2
  console.log(`Failed ${error.writeErrors.length} documents`); // 1

  //View the specific failed documentation
  error.writeErrors.forEach(err => {
    console.error(`Index ${err.index} failed: ${err.errmsg}`);
  });
}
```

## Invalid document array

```javascript
try {
  //Error: documents must be an array
  await collection("users").insertMany({ name: "Alice" });
} catch (error) {
  console.error(error.code); // INVALID_ARGUMENT
  console.error(error.message); // "documents must be of array type"
}
```

## Empty array

```javascript
try {
  //Error: Array cannot be empty
  await collection("users").insertMany([]);
} catch (error) {
  console.error(error.message); // "documents array cannot be empty"
}
```

## Differences from other methods

## vs insertOne

| Features | insertOne | insertMany |
|------|-----------|------------|
| **Insert quantity** | Insert 1 at a time | Insert multiple at a time |
| **Performance** | More network round trips | Usually fewer network round trips; measure with your workload |
| **Return value** | `insertedId` (single) | `insertedIds` (object) |
| **Error Handling** | Simple (success or failure) | Complex (may be partially successful) |
| **Usage Scenarios** | Single document creation | Batch import of data |

```javascript
//insertOne - insert one by one (slow)
const ids = [];
for (const user of users) {
  const result = await collection("users").insertOne(user);
  ids.push(result.insertedId);
}

//insertMany - bulk insert (fast)
const result = await collection("users").insertMany(users);
const ids = Object.values(result.insertedIds);
```

## vs insertBatch

| Features | insertMany | insertBatch |
|------|-----------|-------------|
| **Maximum quantity** | Unlimited (manual batching) | Automatic batching (default 1000/batch) |
| **Performance** | Good | Better (auto-optimized) |
| **Memory Usage** | High (one-time loading) | Low (batch processing) |
| **Usage Scenarios** | Small and medium amounts of data | Very large amounts of data (millions) |

```javascript
//insertMany - suitable for small and medium amounts of data (<100,000)
await collection("users").insertMany(users);

//insertBatch - suitable for extremely large amounts of data (>100,000)
await collection("users").insertBatch(users, {
  batchSize: 1000  //1000 pcs per batch
});
```

## Performance optimization suggestions

## 1. Choose the appropriate batch size

```javascript
//Too small: performance improvement is not obvious
await collection("users").insertMany(users.slice(0, 10));

//Too big: possible timeout or insufficient memory
await collection("users").insertMany(millionUsers);

//Suitable: between 1000-10000
const BATCH_SIZE = 5000;
for (let i = 0; i < users.length; i += BATCH_SIZE) {
  const batch = users.slice(i, i + BATCH_SIZE);
  await collection("users").insertMany(batch);
}
```

## 2. Use unordered insertion to improve fault tolerance

```javascript
//When the data quality is uncertain, use unordered insertion
await collection("products").insertMany(products, {
  ordered: false  //Insert as much data as possible
});
```

## 3. Avoid overly large documents

```javascript
//Bad: Each document is huge
const largeDocuments = users.map(user => ({
  ...user,
  largeField: Buffer.alloc(1024 * 1024)  // 1MB
}));

//Good: Keep documentation lean
const compactDocuments = users.map(user => ({
  userId: user.id,
  name: user.name,
  email: user.email
}));
```

## 4. Insert a large amount of data after using the index

```javascript
//Strategy 1: Insert data first, create index later (faster)
await collection("users").insertMany(millionUsers);
await collection("users").createIndex({ email: 1 });

//Strategy 2: Create the index first, then insert the data (maintain the index during insertion, which is slower)
await collection("users").createIndex({ email: 1 });
await collection("users").insertMany(millionUsers);

//Recommended: Use strategy 1 when using large amounts of data
```

## Utility functions

## Insert function in batches

```javascript
/**
 *Intelligent batch insertion (automatic retry, progress report)
 */
async function batchInsert(collectionName, documents, options = {}) {
  const {
    batchSize = 5000,
    ordered = false,
    maxRetries = 3,
    onProgress = null
  } = options;

  let inserted = 0;
  let failed = 0;

  for (let i = 0; i < documents.length; i += batchSize) {
    const batch = documents.slice(i, i + batchSize);
    let attempt = 0;
    let success = false;

    while (attempt < maxRetries && !success) {
      try {
        const result = await collection(collectionName).insertMany(batch, { ordered });
        inserted += result.insertedCount;
        success = true;

        //Progress callback
        if (onProgress) {
          onProgress({
            inserted,
            total: documents.length,
            percentage: ((inserted / documents.length) * 100).toFixed(2)
          });
        }
      } catch (error) {
        attempt++;

        if (error.result) {
          //Partially successful (out of order insertion)
          inserted += error.result.insertedCount || 0;
          failed += error.writeErrors?.length || 0;
          success = true;
        } else if (attempt < maxRetries) {
          console.warn(`Insertion of batch ${i} failed, try again (${attempt}/${maxRetries})...`);
          await new Promise(resolve => setTimeout(resolve, 1000));
        } else {
          throw error;
        }
      }
    }
  }

  return { inserted, failed, total: documents.length };
}

//Usage example
const result = await batchInsert("products", allProducts, {
  batchSize: 5000,
  ordered: false,
  maxRetries: 3,
  onProgress: (progress) => {
    console.log(`Progress: ${progress.percentage}% (${progress.inserted}/${progress.total})`);
  }
});

console.log(`Insertion completed: success ${result.inserted}, failure ${result.failed}`);
```

## CSV import function

```javascript
const fs = require("fs");
const { parse } = require("csv-parse/sync");

/**
 *Batch import data from CSV files
 */
async function importFromCSV(collectionName, csvFilePath, options = {}) {
  //Read CSV file
  const fileContent = fs.readFileSync(csvFilePath, "utf8");
  const records = parse(fileContent, {
    columns: true,  //Use first line as field name
    skip_empty_lines: true,
    ...options.parseOptions
  });

  //data conversion
  const documents = records.map(record => {
    //Data conversion can be done here
    return {
      ...record,
      importedAt: new Date()
    };
  });

  //Batch insert
  const result = await batchInsert(collectionName, documents, options.insertOptions);

  return result;
}

//Usage example
const result = await importFromCSV("users", "./data/users.csv", {
  insertOptions: {
    batchSize: 5000,
    ordered: false
  }
});
```

## Notes

## ⚠️ Memory limit

Large arrays take up a lot of memory:

```javascript
//Danger: Loading millions of documents into memory at once
const millionUsers = []; //Takes up a lot of memory
await collection("users").insertMany(millionUsers);

//Security: batch processing
await batchInsert("users", millionUsers, { batchSize: 5000 });
```

## ⚠️ Ordered vs Unordered Choice

```javascript
//Use ordered insertion: high data quality, completeness required
await collection("critical_data").insertMany(data, {
  ordered: true  //Stop on error
});

//Use unordered insertion: uncertain data quality, maximum fault tolerance
await collection("import_logs").insertMany(logs, {
  ordered: false  //Insert as many as possible
});
```

## ⚠️ Transactionality of batch operations

`insertMany` itself is not a transaction and may be partially successful:

```javascript
//If complete atomicity is required, use transactions
const session = client.startSession();
try {
  await session.withTransaction(async () => {
    await collection("users").insertMany(users, { session });
  });
} finally {
  await session.endSession();
}
```

## Related methods

- [insertOne()](./insert-one.md) - Insert a single document
- [insertBatch()](./insertBatch.md) - High-performance batch insertion (automatic batching, suitable for millions of data)
- [updateMany()](./update-many.md) - Batch update documents

## Sample code

For complete sample code, please refer to:
- [insertMany runnable example](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/insert-many.ts)
- [write operations guide](./write-operations.md)

## MongoDB Documentation

- [MongoDB insertMany document](https://www.mongodb.com/docs/manual/reference/method/db.collection.insertMany/)
- [MongoDB Bulk Write Operations](https://www.mongodb.com/docs/manual/core/bulk-write-operations/)
