# deleteOne() - delete a single document

## Syntax

```javascript
collection(name).deleteOne(filter, options?)
```

## Parameters

## filter (required)

**Type**: `Object`

Filter criteria used to match documents to be deleted. Use MongoDB query operators.

```javascript
//Delete specific user
await collection("users").deleteOne({ userId: "user123" });

//Use query operators
await collection("products").deleteOne({
  price: { $lt: 10 },
  stock: 0
});
```

## options (optional)

**Type**: `Object`

| Options | Type | Default | Description |
|------|------|--------|------|
| `collation` | Object | - | Specify collation |
| `hint` | string \| Object | - | Index hint, force the use of a specific index |
| `maxTimeMS` | number | - | Maximum execution time of the operation (milliseconds) |
| `writeConcern` | Object | - | Write follow options |
| `comment` | string | - | Operation comments, used for log tracking |

## Return value

**Type**: `Promise<Object>`

Return an object containing the results of the deletion:

```javascript
{
  deletedCount: 1,     //Number of deleted documents (0 or 1)
  acknowledged: true   //Is the operation confirmed?
}
```

## Core Features

## ✅ Only delete the first matching document

Even if multiple documents match the filter criteria, `deleteOne()` only deletes the first matching document.

```javascript
//Even if there are multiple users with status="inactive", only the first one will be deleted
const result = await collection("users").deleteOne({ status: "inactive" });
console.log(result.deletedCount); //1 (or 0 if no match)
```

## ✅ Explicit cache invalidation

After deletion succeeds, monSQLize does not clear query caches by default. Use `cache.invalidate` or `autoInvalidate: true` when the write should clear cache.

```javascript
//First query (from database)
const user = await collection("users").findOne(
  { userId: "user123" },
  { cache: 5000 }
);

//Delete user and precisely clear the cached query when needed
await collection("users").deleteOne(
  { userId: "user123" },
  {
    cache: {
      invalidate: [{
        operation: "findOne",
        query: { userId: "user123" },
        options: { cache: 5000 }
      }]
    }
  }
);

//Query again (will not be returned from cache because it has been cleaned)
const deletedUser = await collection("users").findOne(
  { userId: "user123" },
  { cache: 5000 }
); // null
```

## ✅ Slow query monitoring

Delete operations that exceed the threshold (default 1000ms) will automatically record a warning log.

```javascript
//Configure slow query threshold
const monsqlize = new MonSQLize({
  slowQueryMs: 500  //Log warning after more than 500ms
});

//Slow delete operations will be logged
await collection("logs").deleteOne({
  timestamp: { $lt: new Date("2024-01-01") }
});
//Log: [WARN] [deleteOne] Slow operation warning { duration: 650ms, ... }
```

## Common scenarios

## Scenario 1: Delete a single user

```javascript
//Delete based on user ID
const result = await collection("users").deleteOne({ userId: "user123" });

if (result.deletedCount === 1) {
  console.log("User has been deleted");
} else {
  console.log("User does not exist");
}
```

## Scenario 2: Cleaning up expired data

```javascript
//Delete the first expired session
const result = await collection("sessions").deleteOne({
  expiresAt: { $lt: new Date() }
});

console.log(`${result.deletedCount} expired sessions deleted`);
```

## Scenario 3: Delete records in a specific state

```javascript
//Delete the first pending task
const result = await collection("tasks").deleteOne({
  status: "pending",
  priority: { $lt: 3 }
});

if (result.deletedCount === 0) {
  console.log("There are no low priority tasks to be deleted");
}
```

## Scenario 4: Using index hints to optimize performance

```javascript
//Force the use of a specific index
const result = await collection("orders").deleteOne(
  {
    customerId: "cust123",
    status: "cancelled"
  },
  {
    hint: { customerId: 1, status: 1 },  //Use composite index
    comment: "cleanup-cancelled-orders"
  }
);
```

## Scenario 5: Set operation timeout

```javascript
//Limit the maximum execution time of delete operations
try {
  const result = await collection("logs").deleteOne(
    { level: "debug" },
    { maxTimeMS: 2000 }  //up to 2 seconds
  );
} catch (error) {
  if (error.code === ErrorCodes.OPERATION_TIMEOUT) {
    console.error("Delete operation timed out");
  }
}
```

## Differences from other methods

## vs deleteMany

| Features | deleteOne | deleteMany |
|------|-----------|------------|
| **Number of Delete** | Delete only the first matching document | Delete all matching documents |
| **Return value** | `deletedCount: 0 or 1` | `deletedCount: 0 or more` |
| **Performance** | Faster (stops when first found) | Slower (needs to scan all matches) |
| **Usage Scenarios** | Delete specific single records | Batch clean data |

```javascript
//deleteOne - delete only one
await collection("users").deleteOne({ status: "inactive" });
//Result: Remove the first inactive user

//deleteMany - delete all matches
await collection("users").deleteMany({ status: "inactive" });
//Result: Remove all inactive users
```

## vs findOneAndDelete

| Features | deleteOne | findOneAndDelete |
|------|-----------|------------------|
| **Return content** | Deletion result (`deletedCount`) | Deleted document content |
| **Atomicity** | Yes (the delete operation itself is atomic) | Yes (the search and delete operations are atomic) |
| **Performance** | Slightly faster (no need to return documents) | Slightly slower (need to read and return documents) |
| **Usage scenario** | Just need to know whether the deletion is successful | The content of the document before deletion needs to be |

```javascript
//deleteOne - only returns the delete count
const result1 = await collection("users").deleteOne({ userId: "user123" });
console.log(result1); // { deletedCount: 1, acknowledged: true }

//findOneAndDelete - returns deleted documents
const result2 = await collection("users").findOneAndDelete({ userId: "user456" });
console.log(result2); // { _id: ..., userId: "user456", name: "Alice", ... }
```

## Error handling

## Invalid filter criteria

```javascript
try {
  //Error: filter must be an object
  await collection("users").deleteOne("user123");
} catch (error) {
  console.error(error.code); // INVALID_ARGUMENT
  console.error(error.message); // "filter must be of object type"
}
```

## Operation timeout

```javascript
try {
  await collection("logs").deleteOne(
    { timestamp: { $lt: new Date("2020-01-01") } },
    { maxTimeMS: 100 }  //very short timeout
  );
} catch (error) {
  if (error.code === ErrorCodes.OPERATION_TIMEOUT) {
    console.error("Delete operation timed out");
  }
}
```

## Write attention error

```javascript
try {
  await collection("users").deleteOne(
    { userId: "user123" },
    {
      writeConcern: { w: "majority", wtimeout: 1000 }
    }
  );
} catch (error) {
  if (error.code === ErrorCodes.WRITE_ERROR) {
    console.error("Write operation failed:", error.message);
  }
}
```

## Performance optimization suggestions

## 1. Use index

Make sure the fields in the filter are indexed:

```javascript
//Create index first
await collection("users").createIndex({ userId: 1 });

//Then delete (index will be used)
await collection("users").deleteOne({ userId: "user123" });
```

## 2. Use index hints

For complex queries, explicitly specify which index to use:

```javascript
await collection("orders").deleteOne(
  {
    customerId: "cust123",
    status: "cancelled",
    createdAt: { $lt: new Date("2024-01-01") }
  },
  {
    hint: { customerId: 1, createdAt: 1 }  //Use composite index
  }
);
```

## 3. Set a reasonable timeout

```javascript
//Avoid long blocking
await collection("logs").deleteOne(
  { level: "debug" },
  { maxTimeMS: 5000 }  //5 seconds timeout
);
```

## 4. Use precise filters

```javascript
//Good: Use exact criteria (fast lookup via index)
await collection("users").deleteOne({ userId: "user123" });

//Bad: Use range queries (may need to scan multiple documents)
await collection("users").deleteOne({ age: { $gt: 18 } });
```

## Notes

## ⚠️ Deletion is irreversible

```javascript
//Unable to recover after deletion
const result = await collection("users").deleteOne({ userId: "user123" });

//If records need to be retained, consider using soft delete (mark as deleted)
await collection("users").updateOne(
  { userId: "user123" },
  { $set: { deleted: true, deletedAt: new Date() } }
);
```

## ⚠️ Unsure of deletion order

If multiple documents match, which one to delete is undefined (unless using sorting):

```javascript
//Not sure which inactive user to delete
await collection("users").deleteOne({ status: "inactive" });

//If determinism is required, use findOneAndDelete and specify the ordering
await collection("users").findOneAndDelete(
  { status: "inactive" },
  { sort: { createdAt: 1 } }  //Delete the oldest created
);
```

## ⚠️ Deletion does not affect the index

Deleting a document does not delete the index, it is automatically updated.

## ⚠️ Scope of cache invalidation

`autoInvalidate: true` clears the cache for the entire collection, not just deleted documents:

```javascript
//Delete a user and request collection-wide broad invalidation
await collection("users").deleteOne(
  { userId: "user123" },
  { autoInvalidate: true }
);

//The cache of all users collections will be cleared
//Include cached queries from other users
```

## Related methods

- [deleteMany()](./delete-many.md) - delete all matching documents
- [findOneAndDelete()](./find-one-and-delete.md) - Atomically find and delete documents, returning the deleted documents
- [updateOne()](./update-one.md) - Update a single document (alternative to soft delete)

## Sample code

For complete sample code, please refer to the [delete runnable example](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/delete.ts).

## MongoDB Documentation

- [MongoDB deleteOne document](https://www.mongodb.com/docs/manual/reference/method/db.collection.deleteOne/)
