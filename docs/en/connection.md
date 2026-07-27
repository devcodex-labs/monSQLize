# Connection Management

## Overview

monSQLize provides connection management for MongoDB applications, including safe connection reuse, parameter validation, resource cleanup, and cross-database access. This document explains the connection API and the related configuration surface.

## Core Features

- Safe connection reuse: concurrent `connect()` calls wait for the same connection attempt.
- Parameter validation: collection and database names are validated before use.
- Resource cleanup: client resources and runtime caches are released by `close()`.
- Error handling: failed connection attempts can be retried safely.
- Cross-database access: a single instance can access collections in other databases.

---

## Connection Management API

### connect()

Establishes a database connection. The method is safe to call concurrently and reuses the same in-flight connection promise.

#### Method Signature

```javascript
async connect()
```

#### Return Value

```javascript
{
  collection: Function,      // Collection accessor for the default database.
  db: Function,              // Database-level accessor; db(name?) returns a DbAccessor.
  use: Function,             // Scoped collection/model access for another database.
  instance: MonSQLize        // Current MonSQLize instance.
}
```

#### Usage Example

```javascript
import MonSQLize from 'monsqlize';

const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'shop',
  config: { uri: 'mongodb://localhost:27017' }
});

const { collection, use } = await msq.connect();

// Connect to the database.
const users = collection('users');

// Use collection accessors.
const products = collection('products');

// Cross-database access.
const analyticsEvents = use('analytics').collection('events');
```

---

### Concurrent connect() calls

`connect()` is safe to call from concurrent startup tasks or request handlers. Concurrent callers wait for the same connection attempt instead of opening duplicate MongoDB clients.

#### What to expect

1. The first caller starts the connection attempt.
2. Other callers wait for that attempt to finish.
3. Successful callers receive the connected runtime accessors.
4. If the attempt fails, all waiting callers receive the same error and the next `connect()` call can retry.

#### High-Concurrency Example

```javascript
import MonSQLize from 'monsqlize';

const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'example',
  config: { uri: 'mongodb://localhost:27017' }
});

// High-concurrency scenario: 10 concurrent requests.
const promises = Array(10).fill(null).map(() => msq.connect());
const results = await Promise.all(promises);

// All requests return the same connection object.
console.log(results[0] === results[1]);  // true
console.log(results[0] === results[9]);  // true
console.log('Only one connection was established.');
```

#### Benefits

- Prevents connection-pool exhaustion.
- Reduces connection overhead.
- Avoids duplicate resource allocation.
- Improves stability under startup bursts.

---

### Accepted collection and database names

`collection()` and `db()` fail early when a collection or database name is missing or invalid.

#### collection() Validation

Rules:

- The collection name must be a non-empty string.
- `null`, `undefined`, empty strings, and whitespace-only strings are rejected.
- Numbers, objects, and other non-string values are rejected.

```javascript
const { collection } = await msq.connect();

// Valid usage.
const users = collection('users');
const orders = collection('my-orders');

// Invalid parameters. These throw.
try {
  collection('');
  collection('   ');
  collection(null);
  collection(undefined);
  collection(123);
  collection({ name: 'test' });
} catch (err) {
  console.error(err.code, err.message);
  // INVALID_COLLECTION_NAME Collection name must be a non-empty string.
}
```

#### db() Validation

Important: `db(name)` validates the database name immediately when `name` is provided. Omit the argument, or pass `undefined`, to use the default database. Pass `null` only if you intentionally want an `INVALID_DATABASE_NAME` error in JavaScript.

Rules:

- If `databaseName` is provided, it must be a non-empty string.
- `undefined` and an omitted argument use the default database.
- `null`, empty strings, and whitespace-only strings are rejected.

```javascript
const { db } = await msq.connect();

// Valid usage.
const shopDb = db('shop');
const analyticsDb = db('analytics');

// Use the default database. This is valid.
const defaultDb1 = db();
const defaultDb2 = db(undefined);

// Verify that collections can be obtained normally.
const shopOrders = shopDb.collection('orders');
const analyticsEvents = analyticsDb.collection('events');

// Invalid parameters. These throw immediately.
try {
  db(null);
  db('');
  db('   ');
} catch (err) {
  console.error(err.code, err.message);
  // INVALID_DATABASE_NAME Database name must be a non-empty string.
}

// Omitted and undefined use the default database.
const users1 = db().collection('users');
const users2 = db(undefined).collection('users');
// No error is thrown.
console.log('Default database access succeeded.');
```

#### Error Codes

| Error code | Description | Example |
|------------|-------------|---------|
| `INVALID_COLLECTION_NAME` | Invalid collection name. | `collection('')` |
| `INVALID_DATABASE_NAME` | Invalid database name, such as `null`, an empty string, or a whitespace-only string. | `db('')` |

Notes:

- `db()` and `db(undefined)` use the default database configured on the MonSQLize instance.
- `db(null)` throws `INVALID_DATABASE_NAME` in JavaScript; TypeScript callers should omit the argument instead.
- `''` and strings such as `'   '` also trigger database-name validation errors.

---

### close()

Closes the database connection and releases internal resources.

#### Method Signature

```javascript
async close()
```

#### What close() releases

- Closes the MongoDB client connection.
- Releases the current connection attempt state.
- Clears cached runtime Model instances for this MonSQLize instance.
- Releases runtime-owned references that should not survive after shutdown.

#### Usage Example

```javascript
import MonSQLize from 'monsqlize';

const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'example',
  config: { uri: 'mongodb://localhost:27017' }
});

// Connect.
const { collection } = await msq.connect();

// Use the connection.
await collection('test').find({});

// Close the connection.
await msq.close();
console.log('Connection closed and resources cleaned.');
```

#### Repeated Connect-Close Cycles

```javascript
for (let i = 0; i < 5; i++) {
  const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'example',
    config: { uri: 'mongodb://localhost:27017' }
  });

  await msq.connect();
  const { collection } = await msq.connect();

  // Use the connection.
  await collection('test').find({});

  // Close the connection.
  await msq.close();
  console.log(`Cycle ${i + 1} completed`);
}

// Repeated connect-close cycles are safe.
console.log('All cycles completed and memory was cleaned correctly.');
```

#### Notes

- Calling `close()` more than once is safe.
- Calling `connect()` after `close()` creates a new connection.
- Call `close()` when the application shuts down.
- In tests, close the instance in `afterEach` or `after` hooks.

---

## Cross-Database Access

monSQLize can access collections in different databases through one instance.

### Access Another Database

```javascript
import MonSQLize from 'monsqlize';

const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'shop',
  config: { uri: 'mongodb://localhost:27017' }
});

const { collection, use } = await msq.connect();

// 1. Access a collection in the default database.
const products = await collection('products').find({});
console.log('shop.products ->', products);

// 2. Access a collection in another database.
const analyticsEvents = await use('analytics').collection('events').findOne(
  { type: 'click' },
  {
    cache: 3000,
    maxTimeMS: 1500
  }
);
console.log('analytics.events ->', analyticsEvents);

// 3. Query another database multiple times.
const [user1, user2] = await Promise.all([
  db('users_db').collection('users').findOne({ name: 'Alice' }, { cache: 2000 }),
  db('users_db').collection('users').findOne({ name: 'Bob' })
]);
console.log(user1, user2);
```

### Cross-Database Notes

- All cross-database access shares the same MongoDB client connection.
- Cache keys include the database name, so identical collection names in different databases have isolated cache entries.
- Per-query options such as `maxTimeMS` and `cache` work the same way for cross-database collections.
- Cross-database collections support monSQLize features such as caching and slow-query logging.

---

## Error Handling

### Connection Failure

```javascript
import MonSQLize from 'monsqlize';

try {
  const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'example',
    config: { uri: 'mongodb://invalid-host:27017' }
  });

  await msq.connect();
} catch (err) {
  // Connection failure.
  console.error('Connection failed:', err.message);

  // A failed attempt does not leave the instance stuck; retrying is safe.
  console.log('The connection can be retried.');
}
```

### Parameter Validation Failure

```javascript
const { collection, db } = await msq.connect();

try {
  // Invalid collection name.
  collection('');
} catch (err) {
  if (err.code === 'INVALID_COLLECTION_NAME') {
    console.error('Invalid collection name:', err.message);
    console.log('Provide a valid collection name.');
  }
}

try {
  // Invalid database name: empty string.
  // db() validates database names immediately.
  db('');
} catch (err) {
  if (err.code === 'INVALID_DATABASE_NAME') {
    console.error('Invalid database name:', err.message);
    console.log('Provide a valid database name, or omit it for the default database.');
  }
}

// Correct usage: omit the argument or use undefined for the default database.
const defaultDb = db().collection('users');
const defaultDb2 = db(undefined).collection('users');
```

---

## Best Practices

### 1. Reuse Connections

```javascript
// db-connection.js
import MonSQLize from 'monsqlize';

let msqInstance = null;

export async function getConnection() {
  if (!msqInstance) {
    msqInstance = new MonSQLize({
      type: 'mongodb',
      databaseName: process.env.DB_NAME || 'shop',
      config: { uri: process.env.MONGODB_URI }
    });
  }

  return await msqInstance.connect();
}

export async function closeConnection() {
  if (msqInstance) {
    await msqInstance.close();
    msqInstance = null;
  }
}
```

```javascript
import { getConnection } from './db-connection.js';

// Use the singleton connection.
async function queryUsers() {
  const { collection } = await getConnection();
  return await collection('users').find({});
}
```

### 2. Manage Application Lifecycle

```javascript
import MonSQLize from 'monsqlize';

class Application {
  constructor() {
    this.msq = new MonSQLize({
      type: 'mongodb',
      databaseName: 'shop',
      config: { uri: process.env.MONGODB_URI }
    });
  }

  async start() {
    console.log('Starting application...');

    // Establish the connection.
    const { collection } = await this.msq.connect();
    this.collection = collection;

    console.log('Database connection established.');
  }

  async stop() {
    console.log('Stopping application...');

    // Close the connection.
    await this.msq.close();

    console.log('Database connection closed.');
  }
}

const app = new Application();

// Use the application lifecycle.
async function main() {
  await app.start();

  // Application is running...
  process.on('SIGINT', async () => {
    // Graceful shutdown.
    await app.stop();
    process.exit(0);
  });
}

main();
```

### 3. Retry Connection Failures

```javascript
async function connectWithRetry(maxRetries = 3, delay = 1000) {
  const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'shop',
    config: { uri: process.env.MONGODB_URI }
  });

  for (let i = 0; i < maxRetries; i++) {
    try {
      await msq.connect();
      console.log('Connection established.');
      return msq;
    } catch (err) {
      console.error(`Connection failed (${i + 1}/${maxRetries}):`, err.message);

      if (i < maxRetries - 1) {
        console.log(`Retrying after ${delay} ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw new Error('Connection failed after the maximum retry count.');
      }
    }
  }
}
```

### 4. Manage Connections in Tests

```javascript
const { describe, it, before, after } = require('mocha');
import MonSQLize from 'monsqlize';

describe('user service', () => {
  let msq;
  let collection;

  before(async () => {
    // Establish the connection before tests.
    msq = new MonSQLize({
      type: 'mongodb',
      databaseName: 'test',
      config: { useMemoryServer: true }
    });

    const conn = await msq.connect();
    collection = conn.collection;
  });

  after(async () => {
    // Close the connection after tests.
    await msq.close();
  });

  it('queries users', async () => {
    const users = await collection('users').find({});
    console.log('Users found:', users.length);
  });
});
```

`useMemoryServer` reuses the project-local `.cache/mongodb-memory-server/binaries` binary cache by default. Automatically created temporary data directories are placed under `.cache/mongodb-memory-server/db` and are cleaned when the instance closes. To pin a directory, pass `memoryServerOptions.instance.dbPath` or set `MONSQLIZE_MEMORY_SERVER_DB_DIR`.

---

## Constructor Configuration

Connection lifecycle and constructor options are intentionally documented separately. Use this page for `connect()`, `collection()`, `db()`, `use()`, and `close()`. Use [Configuration Reference](./configuration.md) for the full `new MonSQLize(options)` surface, including MongoDB connection options, cache, Redis, distributed invalidation, Model, schema-dsl, pools, sync, slow-query logging, ObjectId conversion, and write path policy.

---

## FAQ

### Q: How do I ensure that only one connection is established?

`connect()` has a built-in concurrent lock, so repeated or concurrent calls reuse the same connection.

```javascript
const msq = new MonSQLize({ /* ... */ });

// Concurrent calls establish only one connection.
const [conn1, conn2, conn3] = await Promise.all([
  msq.connect(),
  msq.connect(),
  msq.connect()
]);

console.log(conn1 === conn2);  // true
```

### Q: When should I call close()?

Call `close()` when:

- The application is shutting down.
- A test finishes and should release its database resources.
- A connection will not be used for a long time.
- A connect-close lifecycle test needs deterministic cleanup.

### Q: Does cross-database access create multiple client connections?

No. Cross-database access shares the same MongoDB client connection and only targets different databases.

```javascript
const { use } = await msq.connect();

// These three operations share the same connection.
await use('shop').collection('products').find({});
await use('analytics').collection('events').find({});
await use('logs').collection('errors').find({});
```

### Q: How do I retry after a failed connection?

After a connection failure, the instance can retry on the next `connect()` call.

```javascript
async function connectWithRetry() {
  const msq = new MonSQLize({ /* ... */ });

  while (true) {
    try {
      await msq.connect();
      return msq;
    } catch (err) {
      console.error('Connection failed; retrying in 3 seconds...');
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}
```

---

## References

- [MongoDB Node.js driver documentation](https://docs.mongodb.com/drivers/node/)
- [Connection string format](https://docs.mongodb.com/manual/reference/connection-string/)
- [Connection pool options](https://docs.mongodb.com/manual/reference/connection-string/#connection-pool-options)
- [monSQLize README](https://github.com/devcodex-labs/monSQLize/blob/main/README.md)
