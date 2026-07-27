# insertOne() - Insert a single document

## Syntax

```javascript
collection(name).insertOne(document, options?)
```

## Parameters

## document (required)

**Type**: `Object`

The document object to be inserted. If the document does not have a `_id` field, MongoDB will automatically generate one.

```javascript
//Automatically generate _id
await collection("users").insertOne({
  name: "Alice",
  email: "alice@example.com",
  age: 30
});

//Manually specify _id
await collection("users").insertOne({
  _id: "custom-id-123",
  name: "Bob",
  email: "bob@example.com"
});
```

## options (optional)

**Type**: `Object`

| Options | Type | Default | Description |
|------|------|--------|------|
| `writeConcern` | Object | - | Write follow options |
| `bypassDocumentValidation` | boolean | false | Whether to bypass document verification |
| `comment` | string | - | Operation comments, used for log tracking |

## Return value

**Type**: `Promise<Object>`

Return an object containing the results of the insertion:

```javascript
{
  insertedId: ObjectId("507f1f77bcf86cd799439011"),  //Insert the _id of the document
  acknowledged: true                                  //Is the operation confirmed?
}
```

## Core Features

## ✅ Automatically generate _id

If the document does not have a `_id` field, MongoDB automatically generates a unique ObjectId.

```javascript
const result = await collection("users").insertOne({
  name: "Alice",
  email: "alice@example.com"
});

console.log(result.insertedId); // ObjectId("507f1f77bcf86cd799439011")
```

## ✅ Explicit cache invalidation

After the insertion succeeds, monSQLize does not clear query caches by default. Use `cache.invalidate` or `autoInvalidate: true` when the write should clear cache.

```javascript
//Query and cache
const users = await collection("users").find({}, { cache: 5000 });
console.log(users.length); // 10

//Insert new user and precisely clear the cached query when needed
await collection("users").insertOne(
  { name: "Alice" },
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

//Query again (will not return from cache, will query the database)
const updatedUsers = await collection("users").find({}, { cache: 5000 });
console.log(updatedUsers.length); // 11
```

## ✅ Slow query monitoring

Insert operations that exceed a threshold (default 1000ms) automatically log warnings.

```javascript
//Configure slow query threshold
const monsqlize = new MonSQLize({
  slowQueryMs: 500  //Log warning after more than 500ms
});

//Slow insert operations will be logged
await collection("large_docs").insertOne({
  data: { /* large amount of data */ }
});
//Log: [WARN] [insertOne] Slow operation warning { duration: 650ms, ... }
```

## Common scenarios

## Scenario 1: Create new user

```javascript
const result = await collection("users").insertOne({
  userId: "user123",
  name: "Alice",
  email: "alice@example.com",
  status: "active",
  createdAt: new Date()
});

console.log("User created successfully, ID:", result.insertedId);
```

## Scenario 2: Inserting nested documents

```javascript
const result = await collection("orders").insertOne({
  orderId: "order123",
  customerId: "cust456",
  items: [
    { productId: "prod1", quantity: 2, price: 29.99 },
    { productId: "prod2", quantity: 1, price: 49.99 }
  ],
  shippingAddress: {
    street: "123 Main St",
    city: "New York",
    zip: "10001"
  },
  total: 109.97,
  createdAt: new Date()
});

console.log("Order created successfully:", result.insertedId);
```

## Scenario 3: Using custom _id

```javascript
//Use business ID as _id
const result = await collection("products").insertOne({
  _id: "SKU-12345",
  name: "Laptop",
  price: 999.99,
  category: "electronics"
});

console.log("Product ID:", result.insertedId); // "SKU-12345"
```

## Scenario 4: Inserting timestamped documents

```javascript
const result = await collection("logs").insertOne({
  level: "info",
  message: "User logged in",
  userId: "user123",
  timestamp: new Date(),
  metadata: {
    ip: "192.168.1.1",
    userAgent: "Mozilla/5.0..."
  }
});
```

## Scenario 5: Insert and return complete document

```javascript
//Insert document
const result = await collection("users").insertOne({
  name: "Alice",
  email: "alice@example.com"
});

//Query the document just inserted (including automatically generated _id)
const newUser = await collection("users").findOne({
  _id: result.insertedId
});

console.log(newUser);
// {
//   _id: ObjectId("..."),
//   name: "Alice",
//   email: "alice@example.com"
// }
```

## Error handling

## Duplicate _id

```javascript
try {
  await collection("users").insertOne({
    _id: "user123",
    name: "Alice"
  });

  //Inserting the same _id again will fail
  await collection("users").insertOne({
    _id: "user123",  //Duplicate _id
    name: "Bob"
  });
} catch (error) {
  if (error.code === ErrorCodes.DUPLICATE_KEY) {
    console.error("Document already exists");
  }
}
```

## Invalid document

```javascript
try {
  //Error: document must be an object
  await collection("users").insertOne("not an object");
} catch (error) {
  console.error(error.code); // INVALID_ARGUMENT
  console.error(error.message); // "document must be of type object"
}
```

## Unique index conflict

```javascript
//Assume the email field has a unique index
try {
  await collection("users").insertOne({
    name: "Alice",
    email: "alice@example.com"
  });

  //Inserting the same email will fail
  await collection("users").insertOne({
    name: "Bob",
    email: "alice@example.com"  //Duplicate email
  });
} catch (error) {
  if (error.code === ErrorCodes.DUPLICATE_KEY) {
    console.error("Email has been used");
  }
}
```

## Document verification failed

```javascript
//Assume that the collection has validation rules
try {
  await collection("users").insertOne({
    name: "Alice"
    //Missing required email field
  });
} catch (error) {
  if (error.code === ErrorCodes.WRITE_ERROR) {
    console.error("Document validation failed:", error.message);
  }
}
```

## Differences from other methods

## vs insertMany

| Features | insertOne | insertMany |
|------|-----------|------------|
| **Number of Inserts** | Insert 1 document at a time | Insert multiple documents at a time |
| **Return value** | `insertedId` (single) | `insertedIds` (array) |
| **Performance** | Low (individual insert each time) | High (batch insert) |
| **Atomicity** | Yes (single document insertion) | No (can be partially successful) |
| **Usage Scenarios** | Single document creation | Batch import of data |

```javascript
//insertOne - single insert
const result1 = await collection("users").insertOne({ name: "Alice" });
console.log(result1.insertedId); // ObjectId

//insertMany - bulk insert
const result2 = await collection("users").insertMany([
  { name: "Bob" },
  { name: "Charlie" }
]);
console.log(result2.insertedIds); // { 0: ObjectId, 1: ObjectId }
```

## vs updateOne with upsert

| Features | insertOne | updateOne (upsert: true) |
|------|-----------|--------------------------|
| **Behavior** | Only insert, fail if it exists | Insert if it does not exist, update if it exists |
| **Repeat processing** | Throw error | Update existing document |
| **Usage Scenario** | Make sure it is a new document | Not sure if the document exists |

```javascript
//insertOne - fails on duplicate
try {
  await collection("users").insertOne({ _id: "user123", name: "Alice" });
  await collection("users").insertOne({ _id: "user123", name: "Bob" }); //❌ failed
} catch (error) {
  console.error("Document already exists");
}

//updateOne with upsert - update when repeated
await collection("users").updateOne(
  { _id: "user123" },
  { $set: { name: "Alice" } },
  { upsert: true }  //Insert if it does not exist, update if it exists
);

await collection("users").updateOne(
  { _id: "user123" },
  { $set: { name: "Bob" } },
  { upsert: true }  //✅Update successful
);
```

## Performance optimization suggestions

## 1. Use insertMany when inserting in batches

```javascript
//Bad: looping call to insertOne
for (const user of users) {
  await collection("users").insertOne(user);  //Slow, one network round trip at a time
}

//Good: use insertMany
await collection("users").insertMany(users);  //Fast, one network round trip
```

## 2. Avoid inserting in loops

```javascript
//Bad: Insert inside loop
const results = [];
for (let i = 0; i < 1000; i++) {
  const result = await collection("items").insertOne({ index: i });
  results.push(result);
}

//Good: prepare data first, then insert in batches
const items = Array.from({ length: 1000 }, (_, i) => ({ index: i }));
const result = await collection("items").insertMany(items);
```

## 3. Use appropriate _id type

```javascript
//ObjectId (default) - 12 bytes, including timestamp
await collection("users").insertOne({ name: "Alice" });

//String - can be used if there is a business ID
await collection("products").insertOne({
  _id: "SKU-12345",  //Business ID
  name: "Laptop"
});

//Number - if there is a serial number
await collection("orders").insertOne({
  _id: 100001,  //Order number
  customerId: "cust123"
});
```

## Best Practices

## ✅ Contains creation timestamp

```javascript
await collection("users").insertOne({
  name: "Alice",
  email: "alice@example.com",
  createdAt: new Date(),  //creation time
  updatedAt: new Date()   //Update time
});
```

## ✅ Use validation to ensure data quality

```javascript
//Validate data before inserting
function validateUser(user) {
  if (!user.name || typeof user.name !== "string") {
    throw new Error("name is a required string");
  }
  if (!user.email || !user.email.includes("@")) {
    throw new Error("Invalid email format");
  }
  return true;
}

//Use verification
const newUser = { name: "Alice", email: "alice@example.com" };
if (validateUser(newUser)) {
  await collection("users").insertOne(newUser);
}
```

## ✅ Handling duplicate key errors

```javascript
async function createUser(userData) {
  try {
    const result = await collection("users").insertOne(userData);
    return { success: true, id: result.insertedId };
  } catch (error) {
    if (error.code === ErrorCodes.DUPLICATE_KEY) {
      return { success: false, error: "User already exists" };
    }
    throw error;
  }
}
```

## ✅ Use transactions (multiple document insertion)

```javascript
//If you need to insert into multiple collections atomically
const session = client.startSession();
try {
  await session.withTransaction(async () => {
    //insert user
    const userResult = await collection("users").insertOne(
      { userId: "user123", name: "Alice" },
      { session }
    );

    //Insert user configuration
    await collection("user_settings").insertOne(
      { userId: "user123", theme: "dark" },
      { session }
    );
  });
} finally {
  await session.endSession();
}
```

## Notes

## ⚠️ _id is immutable

Once inserted, the `_id` field cannot be modified:

```javascript
const result = await collection("users").insertOne({
  _id: "user123",
  name: "Alice"
});

//Unable to modify _id
await collection("users").updateOne(
  { _id: "user123" },
  { $set: { _id: "user456" } }  //❌ Error: cannot modify _id
);
```

## ⚠️Performance impact of large documents

MongoDB document size is limited to 16MB, but large documents can impact performance:

```javascript
//Avoid inserting documents that are too large
await collection("files").insertOne({
  name: "large-file.pdf",
  content: Buffer.alloc(15 * 1024 * 1024)  //15MB, close to the limit
});

//Consider using GridFS to store large files
```

## ⚠️ Scope of cache invalidation

`autoInvalidate: true` clears the entire collection's related cache:

```javascript
//Query and cache
await collection("users").find({ status: "active" }, { cache: 5000 });

//Insert new user and request collection-wide broad invalidation
await collection("users").insertOne(
  { name: "Alice" },
  { autoInvalidate: true }
);

//The cache above is cleared even if the new user's status is not "active"
```

## Utility functions

## Safe insertion function (with retry)

```javascript
/**
 *Insert documents safely (automatic retries)
 */
async function safeInsertOne(collectionName, document, options = {}) {
  const { maxRetries = 3, retryDelay = 100 } = options;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await collection(collectionName).insertOne(document);
      return { success: true, insertedId: result.insertedId };
    } catch (error) {
      if (error.code === ErrorCodes.DUPLICATE_KEY) {
        //Repeated keys are not retried
        return { success: false, error: "Document already exists", code: error.code };
      }

      if (attempt < maxRetries) {
        console.warn(`Insert failed (try ${attempt}/${maxRetries}), retry after ${retryDelay}ms...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      } else {
        return { success: false, error: error.message, code: error.code };
      }
    }
  }
}

//Usage example
const result = await safeInsertOne("users", { name: "Alice" });
if (result.success) {
  console.log("Insertion successful:", result.insertedId);
} else {
  console.error("Insertion failed:", result.error);
}
```

## Related methods

- [insertMany()](./insert-many.md) - Batch insert multiple documents
- [insertBatch()](./insertBatch.md) - high-performance batch insertion (batch processing)
- [updateOne()](./update-one.md) - Update document (insert or update can be achieved with upsert)

## Sample code

For complete sample code, please refer to:
- [insert runnable example](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/insert.ts)
- [write operations guide](./write-operations.md)

## MongoDB Documentation

- [MongoDB insertOne document](https://www.mongodb.com/docs/manual/reference/method/db.collection.insertOne/)
