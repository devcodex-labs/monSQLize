# Error code reference

## Overview

monSQLize uses a unified error code system to identify different types of errors, helping developers accurately identify and handle exceptions. All error objects contain the `code` attribute, through which the error type can be determined and corresponding processing logic executed.

Common user paths such as configuration, cache, SSH, connection pools, query chains, collection management, transactions, and expression compilation throw error objects with `code`; error `message` remains human-readable.

The core runtime uses `MonSQLizeError` together with the exported `ErrorCodes` constants. Data Tasks form a separate domain contract: they throw `DataTaskJobError`, whose discriminated `code`, `phase`, and optional `collection` describe validation, approval, locking, apply, backup, and restore failures. Do not compare Data Task codes with `ErrorCodes`; handle the two error families explicitly at the boundary.

### Data Task error contract

```javascript
import { DataTaskJobError } from 'monsqlize';

try {
  await dataTasks.apply(job, approval);
} catch (error) {
  if (error instanceof DataTaskJobError) {
    console.error(error.code, error.phase, error.collection);
  }
  throw error;
}
```

| Code | Boundary |
|---|---|
| `INVALID_JOB` | Job shape or policy validation |
| `IDENTITY_CONFLICT` | Source/target identity mapping |
| `INDEX_CONFLICT` | Index plan conflict |
| `APPROVAL_STALE` | Approval expired or no longer matches the preview |
| `BACKUP_FAILED` | Backup creation or persistence |
| `LOCK_NOT_ACQUIRED` | Lease lock could not be acquired |
| `LOCK_LOST` | Lease ownership was lost during execution |
| `APPLY_PARTIAL` | Apply changed only part of the planned scope |
| `RESTORE_DRIFT` | Restore preview or approval no longer matches current state |
| `RESTORE_FAILED` | Restore execution or read-back verification |

See [Data Tasks](./data-tasks.md) for the preview, approval, apply, backup, and restore workflow.


## Core runtime error object structure

```javascript
{
  message: 'Error description information',
  code: 'ERROR_CODE',      //error code
  details: [...],          //Detailed error message (optional)
  cause: Error             //Original error object (optional)
}
```


## Error handling best practices


### User action quick check

| Error Codes | Common Sources | Priority Checks |
|--------|----------|----------|
| `INVALID_CONFIG` | Structure configuration, connection pool configuration, SSH configuration, Redis/distributed capability configuration, Model `schemaDsl` runtime configuration | Required fields, field types, URI prefix, authentication field, Redis/SSH runtime configuration, `schema-dsl/runtime` resolution and API shape |
| `CONNECTION_FAILED` | MongoDB connection or memory MongoDB startup failed | MongoDB address, network, authentication, service status, `error.cause` |
| `NOT_CONNECTED` | `connect()` before accessing the collection, Model, SSH tunnel address | `await msq.connect()` first to confirm the connection life cycle |
| `CACHE_UNAVAILABLE` | The cache instance is invalid and lacks available cache capability | Whether the incoming cache implements `get`/`set` and whether the Redis configuration is reachable |
| `POOL_NOT_FOUND` | The specified connection pool does not exist or the health checker cannot find the pool | Whether the pool name is registered, whether the case is consistent, and whether `pools` is passed in |
| `INVALID_OPERATION` | The query is executed repeatedly, all connection pools are unavailable, and the transaction status is not allowed | Whether to repeat `toArray()`, pool health status, transaction life cycle |
| `INVALID_ARGUMENT` | Query chain parameters, collection management parameters, function cache parameters | Parameter type, value range, non-empty string/object/array |
| `INVALID_VECTOR_SEARCH` | Local Vector Search option validation | Vector index/path, finite query vector, ANN/ENN combination, filter/projection shape |
| `INVALID_RELATION_SELECT` | Relation default or populate selection is outside P0 inclusion syntax | Use non-empty top-level inclusion fields only |
| `RELATION_IN_USE` | Protected Model deletion found declared inbound references | Inspect `error.details[0].usages`; remove or retain references intentionally |
| `RELATION_USAGE_UNAVAILABLE` | Protected deletion could not complete its declared-relation scan | Inspect coverage/skipped details; do not retry as an unchecked delete |
| `INVALID_EXPRESSION` | Expression DSL or aggregate expression function is illegal | Function name, number of parameters, lambda/object literal format |
| `LOCK_ACQUIRE_FAILED` / `LOCK_TIMEOUT` | Failed to obtain business lock or distributed lock | Lock TTL, number of retries, lock key granularity, Redis status |

When you're not sure where to start troubleshooting, start by printing `error.code`, `error.message`, `error.details`, and `error.cause`.


### 1. Capture specific errors

```javascript
import { ErrorCodes } from 'monsqlize';

try {
  await collection('users').insertOne({});
} catch (error) {
  if (error.code === ErrorCodes.DOCUMENT_REQUIRED) {
    console.error('Document parameter is missing, please provide a valid document object');
  } else if (error.code === ErrorCodes.DUPLICATE_KEY) {
    console.error('Document already exists, please check the unique index field');
  } else {
    console.error('Other errors:', error.message);
  }
}
```


### 2. Unified error handling

```javascript
function handleDatabaseError(error) {
  switch (error.code) {
    case ErrorCodes.CONNECTION_FAILED:
      //reconnect
      return reconnect();
    case ErrorCodes.QUERY_TIMEOUT:
      //Record slow query log
      return logSlowQuery(error);
    case ErrorCodes.WRITE_CONFLICT:
      //Retry write operation
      return retryWrite();
    default:
      //Log unknown errors
      logger.error('Unknown error:', error);
      throw error;
  }
}
```


### 3. Detailed error information

```javascript
try {
  await collection('users').insertOne({ name: 'Alice' });
} catch (error) {
  console.log('Error code:', error.code);
  console.log('Error message:', error.message);

  //Some errors contain detailed information
  if (error.details) {
    console.log('Details:', error.details);
  }

  //Part of the error contains the original error
  if (error.cause) {
    console.log('Original error:', error.cause);
  }
}
```

---

## Error code list


## Validation related errors (Validation)


### VALIDATION_ERROR

**Explanation**: Parameter verification failed

**Trigger scenario**:
- The parameters provided do not meet the requirements
- Missing required parameters
- Wrong parameter type

**Example**:
```javascript
try {
  await collection('users').find({ age: 'invalid' });
} catch (error) {
  console.log(error.code); // 'VALIDATION_ERROR'
  console.log(error.details); //Detailed verification error information
}
```

**Handling Suggestions**:
- Check `error.details` for detailed verification errors
- Verify input parameters meet API requirements
- Refer to the API documentation to confirm the correct parameter format

---


### INVALID_ARGUMENT

**Explanation**: The parameter is invalid

**Trigger scenario**:
- The parameter value exceeds the allowed range
- Illegal parameter combination
- Incorrect parameter format

**Example**:
```javascript
try {
  await collection('users').find({}).limit(-10); //negative limit
} catch (error) {
  console.log(error.code); // 'INVALID_ARGUMENT'
}
```

**Handling Suggestions**:
- Check the type and value range of parameters
- Confirm whether the parameter combination is legal
- Refer to the API documentation for parameter constraints

---

### INVALID_VECTOR_SEARCH

**Explanation**: A local `vectorSearch()` option is invalid before MongoDB is called.

**Handling Suggestions**: Inspect `error.details` for the field/reason, then provide a non-empty index/path, finite vector, valid ANN or ENN combination, and a supported filter/projection shape. Server Vector Search or index errors are not converted to this code.

---

### INVALID_RELATION_SELECT

**Explanation**: A relation default or populate `select` is outside the supported P0 inclusion form.

**Handling Suggestions**: Use non-empty top-level field names such as `'title createdAt'` or `['title', 'createdAt']`. Exclusions, prefixes, and dot paths are not supported here.

---

### RELATION_IN_USE

**Explanation**: A protected Model delete found one or more registered, declared inbound references.

**Handling Suggestions**: Inspect `error.details[0].usages` and resolve the references or keep the target. No delete write is issued for this error.

---

### RELATION_USAGE_UNAVAILABLE

**Explanation**: The relation usage scan was unavailable, exceeded its target bound, or reported incomplete coverage.

**Handling Suggestions**: Inspect `error.details[0].coverage` and `skipped`, restore the required Model/source access or increase the explicit bound, then retry the protected operation. Do not replace it with an unchecked delete.

---


### INVALID_COLLECTION_NAME

**Explanation**: The collection name is invalid

**Trigger scenario**:
- Collection name is empty
- Collection name contains illegal characters
- The collection name does not comply with MongoDB naming conventions

**Example**:
```javascript
try {
  await collection('$invalid.collection'); //Contains illegal characters
} catch (error) {
  console.log(error.code); // 'INVALID_COLLECTION_NAME'
}
```

**Handling Suggestions**:
- Use legal collection names (letters, numbers, underscores)
- Avoid using reserved characters ($, .)
- Refer to MongoDB collection naming convention

---


### INVALID_DATABASE_NAME

**Explanation**: The database name is invalid

**Trigger scenario**:
- Database name is empty
- Database name contains illegal characters
- The database name does not comply with MongoDB naming conventions

**Example**:
```javascript
try {
  await msq.db('invalid/database'); //Contains illegal characters
} catch (error) {
  console.log(error.code); // 'INVALID_DATABASE_NAME'
}
```

**Handling Suggestions**:
- Use a valid database name
- Avoid using special characters
- Refer to MongoDB database naming convention

---


## Cursor related errors (Cursor)


### INVALID_CURSOR

**Explanation**: The cursor is invalid

**Trigger scenario**:
- The cursor has expired or been closed
- Cursor configuration error
- Inconsistent cursor status

**Example**:
```javascript
try {
  const cursor = await collection('users').find({}).cursor();
  await cursor.next();
  //...cursor expired
  await cursor.next(); //This error may be thrown
} catch (error) {
  console.log(error.code); // 'INVALID_CURSOR'
}
```

**Handling Suggestions**:
- Make sure the cursor is not closed or expired
- Check the cursor life cycle
- Consider using `toArray()` or streaming

---


### CURSOR_SORT_MISMATCH

**Description**: Cursor sorting does not match

**Trigger scenario**:
- Sorting fields are inconsistent when cursor is paging
- Different sorting conditions are used when jumping to the page

**Example**:
```javascript
try {
  //The first page is sorted by price
  const page1 = await collection('products')
    .find({})
    .sort({ price: 1 })
    .cursor({ pageSize: 10 });

  //The second page uses name sorting instead - Error!
  await page1.next({ sort: { name: 1 } });
} catch (error) {
  console.log(error.code); // 'CURSOR_SORT_MISMATCH'
}
```

**Handling Suggestions**:
- Ensure that the sorting conditions are consistent when paginating
- Use the same `sort` parameters
- Consider maintaining sorting state at the application layer

---


## Pagination related errors (Pagination)


### JUMP_TOO_FAR

**Description**: Page jump distance is too far

**Trigger scenario**:
- Attempt to jump to a page beyond the reasonable range
- Skipping too many pages at once

**Example**:
```javascript
try {
  const cursor = await collection('users').findPage({}, { pageSize: 10 });
  await cursor.jump(10000); //Jump too far
} catch (error) {
  console.log(error.code); // 'JUMP_TOO_FAR'
}
```

**Handling Suggestions**:
- Reduce page jump distance
- Use progressive page jumps
- Consider using normal queries instead of cursors

---


### STREAM_NO_JUMP

**Note**: Streaming mode does not support page jumps

**Trigger scenario**:
- Try page skipping in streaming mode

**Example**:
```javascript
try {
  const stream = collection('users').find({}).stream();
  await stream.jump(5); //Streaming mode does not support page jumps
} catch (error) {
  console.log(error.code); // 'STREAM_NO_JUMP'
}
```

**Handling Suggestions**:
- Can only be read sequentially in streaming mode
- If you need to jump to another page, use cursor mode

---


### STREAM_NO_TOTALS

**Note**: Streaming mode does not support getting the total number

**Trigger scenario**:
- Try to get the total number of records in streaming mode

**Example**:
```javascript
try {
  const stream = collection('users').find({}).stream();
  await stream.totalCount(); //Streaming mode is not supported
} catch (error) {
  console.log(error.code); // 'STREAM_NO_TOTALS'
}
```

**Handling Suggestions**:
- For total number, use `findAndCount()` or `count()`
- Streaming mode is only used for data processing and does not calculate totals

---


### STREAM_NO_EXPLAIN

**Note**: Streaming mode does not support query plans

**Trigger scenario**:
- Try to get execution plan in streaming mode

**Example**:
```javascript
try {
  const stream = collection('users').find({}).stream();
  await stream.explain(); //Streaming mode is not supported
} catch (error) {
  console.log(error.code); // 'STREAM_NO_EXPLAIN'
}
```

**Handling Suggestions**:
- Use the `.explain()` method of the chained API
- Get the execution plan before creating the stream

---


## Connection related errors (Connection)


### CONNECTION_TIMEOUT

**Description**: Connection timeout

**Trigger scenario**:
- Database server response timeout
- Network latency is too high
- Connection pool wait timeout

**Example**:
```javascript
try {
  const msq = new MonSQLize({
    type: 'mongodb',
    config: {
      uri: 'mongodb://slow-server:27017',
      serverSelectionTimeoutMS: 5000
    }
  });
  await msq.connect();
} catch (error) {
  console.log(error.code); // 'CONNECTION_TIMEOUT'
}
```

**Handling Suggestions**:
- Check network connection
- Add timeout configuration
- Check database server status
- Check connection pool configuration

---


### CONNECTION_FAILED

**Explanation**: Database connection failed

**Trigger scenario**:
- The database server is unreachable
- Connection string error
- Authentication failed
- Network error

**Example**:
```javascript
try {
  const msq = new MonSQLize({
    type: 'mongodb',
    config: { uri: 'mongodb://invalid-host:27017' }
  });
  await msq.connect();
} catch (error) {
  console.log(error.code); // 'CONNECTION_FAILED'
  console.log(error.cause); //Original MongoDB error
}
```

**Handling Suggestions**:
- Verify connection string format
- Check database server status
- Check network connection
- Verify username and password
- See `error.cause` for detailed errors

---


### NOT_CONNECTED

**Description**: The database is not connected (v1.3.0+)

**Trigger scenario**:
- Use `pool()` / `use()` / `scopedCollection()` / `scopedModel()` before calling `connect()`

**Example**:
```javascript
const msq = new MonSQLize({ uri: '...' });
//await msq.connect() not called
try {
  msq.use('billing').collection('invoices'); //Throw
} catch (error) {
  console.log(error.code); // 'NOT_CONNECTED'
}
```

**Handling Suggestions**:
- Make sure to call `await msq.connect()` before using any data access method

---


### NO_POOL_MANAGER

**Note**: Multiple connection pool manager (v1.3.0+) is not configured

**Trigger scenario**:
- The MonSQLize constructor did not pass in the `pools` configuration when calling `pool()`

**Example**:
```javascript
const msq = new MonSQLize({ uri: 'mongodb://localhost:27017' }); // No pools
await msq.connect();
try {
  msq.pool('cn'); //Throw
} catch (error) {
  console.log(error.code); // 'NO_POOL_MANAGER'
}
```

**Handling Suggestions**:
- Configure the `pools` option in the constructor, or use `use()` to switch databases (single pool and multiple database scenarios)

---


### POOL_NOT_FOUND

**Description**: The specified connection pool does not exist (v1.3.0+)

**Trigger scenario**:
- `poolName` of `pool(poolName)` is not registered in `ConnectionPoolManager`

**Example**:
```javascript
try {
  msq.pool('missing-pool'); //Throw
} catch (error) {
  console.log(error.code);      // 'POOL_NOT_FOUND'
  console.log(error.available); //['cn', 'eu'] — List of currently available connection pools
}
```

**Handling Suggestions**:
- Check the `error.available` field to confirm available connection pool names
- Confirm that `poolName` is exactly the same as the name when initialized (case sensitive)

---


### MODEL_NOT_DEFINED

**Description**: The specified Model is not registered (v1.3.0+)

**Trigger scenario**:
- `pool().model(key)` or `key` of `scopedModel(key)` is not registered to the Model registry

**Example**:
```javascript
try {
  msq.pool('cn').model('NonExistentModel'); //Throw
} catch (error) {
  console.log(error.code); // 'MODEL_NOT_DEFINED'
}
```

**Handling Suggestions**:
- Confirm that the Model file has been loaded correctly (check `models.path` configuration)
- Confirm that the key string is consistent with `key` (or `name`) in the Model definition

---


### CONNECTION_CLOSED

**Description**: The connection has been closed

**Trigger scenario**:
- Perform operations on a closed connection
- Connection pool is closed
- The server actively closes the connection

**Example**:
```javascript
try {
  await msq.close();
  await collection('users').find({}); //connection closed
} catch (error) {
  console.log(error.code); // 'CONNECTION_CLOSED'
}
```

**Handling Suggestions**:
- Check connection status
- Re-establish connection
- Avoid performing actions after shutdown

---


## Database operation error (Database)


### DATABASE_ERROR

**Explanation**: Generic database error

**Trigger scenario**:
- Uncategorized error returned by MongoDB driver
- Database internal error
- Other database related issues

**Example**:
```javascript
try {
  await collection('users').find({ $invalidOp: true });
} catch (error) {
  console.log(error.code); // 'DATABASE_ERROR'
  console.log(error.cause); //Original MongoDB error
}
```

**Handling Suggestions**:
- See `error.cause` for the original error
- Check query syntax
- Check out the MongoDB documentation

---


### QUERY_TIMEOUT

**Description**: Query timeout

**Trigger scenario**:
- Query execution time exceeds `maxTimeMS` configuration
- Slow queries result in timeouts

**Example**:
```javascript
try {
  await collection('users').find(
    { age: { $gt: 18 } },
    { maxTimeMS: 1000 } //1 second timeout
  );
} catch (error) {
  console.log(error.code); // 'QUERY_TIMEOUT'
}
```

**Handling Suggestions**:
- Optimize query conditions
- Create appropriate indexes
- Increase `maxTimeMS` value
- Analyze performance using query plans

---


## Cache related errors (Cache)


### CACHE_ERROR

**Description**: Cache operation error

**Trigger scenario**:
- Cache read and write failed
- Cache serialization/deserialization errors
- Cache configuration error

**Example**:
```javascript
try {
  await collection('users').find({}).cache(60000);
  //Cache system failure
} catch (error) {
  console.log(error.code); // 'CACHE_ERROR'
}
```

**Handling Suggestions**:
- Check cache configuration
- View cache service status (such as Redis)
- Consider downgrading to not using caching
- Check if the data is serializable

---


### CACHE_TIMEOUT

**Description**: Cache operation timed out

**Trigger scenario**:
- Cache read timeout
- cache write timeout
- The cache service responds slowly

**Example**:
```javascript
try {
  await collection('users').find({}).cache(60000);
  //Redis response timeout
} catch (error) {
  console.log(error.code); // 'CACHE_TIMEOUT'
}
```

**Handling Suggestions**:
- Check cache service status
- Add timeout configuration
- Consider downgrading to not using caching

---


## Configuration related errors (Configuration)


### INVALID_CONFIG

**Explanation**: Invalid configuration

**Trigger scenario**:
- Configuration parameter error
- Missing required configuration items
- Configuration format is incorrect
- Model `schemaDsl` runtime cannot resolve `schema-dsl/runtime`, exposes an incompatible API shape, or receives invalid runtime options

**Example**:
```javascript
try {
  const msq = new MonSQLize({
    type: 'mongodb',
    config: { /* missing uri */ }
  });
} catch (error) {
  console.log(error.code); // 'INVALID_CONFIG'
}
```

**Handling Suggestions**:
- Check configuration parameters
- Refer to documentation to confirm required configuration
- Verify configuration format
- For Model schema validation, check bundled dependency installation, package-manager pruning, runtime module resolution, and the `schemaDsl` runtime/options/extensions configuration

---


### UNSUPPORTED_DATABASE

**Description**: Unsupported database type

**Trigger scenario**:
- An unsupported database type was specified
- Database version is incompatible

**Example**:
```javascript
try {
  const msq = new MonSQLize({
    type: 'mysql', //Not supported
    config: { /* ... */ }
  });
} catch (error) {
  console.log(error.code); // 'UNSUPPORTED_DATABASE'
}
```

**Handling Suggestions**:
- Use supported database types (currently MongoDB only)
- Check database version compatibility

---


## Write Operations Error (Write Operations)


### WRITE_ERROR

**Explanation**: Generic write operation error

**Trigger scenario**:
- The write operation failed to execute
- Server refuses write
- Other write related errors

**Example**:
```javascript
try {
  await collection('users').insertOne({ _id: 'duplicate' });
  await collection('users').insertOne({ _id: 'duplicate' });
} catch (error) {
  console.log(error.code); //Probably 'WRITE_ERROR'
  console.log(error.cause); //Original MongoDB error
}
```

**Handling Suggestions**:
- See `error.cause` for detailed errors
- Check write permission
- Verify data format

---


### DOCUMENT_REQUIRED

**Explanation**: Missing document parameter

**Trigger scenario**:
- `insertOne` No documentation provided
- The document provided is `null` or `undefined`

**Example**:
```javascript
try {
  await collection('users').insertOne(); //missing documentation
} catch (error) {
  console.log(error.code); // 'DOCUMENT_REQUIRED'
}
```

**Handling Suggestions**:
- Provide a valid document object
- Check if the document parameter is `null` or `undefined`

---


### DOCUMENTS_REQUIRED

**Explanation**: Missing document array parameter

**Trigger scenario**:
- `insertMany` No document array provided
- The provided document array is empty

**Example**:
```javascript
try {
  await collection('users').insertMany([]); //empty array
} catch (error) {
  console.log(error.code); // 'DOCUMENTS_REQUIRED'
}
```

**Handling Suggestions**:
- Provide at least one document
- Verify that the document array is not empty

---


### DUPLICATE_KEY

**Description**: Unique key conflict

**Trigger scenario**:
- Insert duplicate `_id`
- Violation of unique index constraint

**Example**:
```javascript
try {
  await collection('users').insertOne({ _id: 1, name: 'Alice' });
  await collection('users').insertOne({ _id: 1, name: 'Bob' }); //Repeat
} catch (error) {
  console.log(error.code); // 'DUPLICATE_KEY'
  console.log(error.details); //Contains duplicate key information
}
```

**Handling Suggestions**:
- Check unique index fields
- Use the `upsert` option of `updateOne`
- Catch and handle duplicate errors

---


### WRITE_CONFLICT

**Description**: Write conflict

**Trigger scenario**:
- Concurrent write conflicts
- Transaction conflicts
- Optimistic lock conflict

**Example**:
```javascript
try {
  //Two concurrent transactions modify the same document
  await msq.withTransaction(async (session) => {
    await collection('users').updateOne(
      { _id: 1 },
      { $inc: { balance: 100 } },
      { session }
    );
  });
} catch (error) {
  console.log(error.code); // 'WRITE_CONFLICT'
}
```

**Handling Suggestions**:
- Retry the write operation
- Use transaction isolation levels
- Implement optimistic locking mechanism

---


## Lock related errors (Locking) 🆕 v1.4.0


### LOCK_ACQUIRE_FAILED

**Explanation**: Lock acquisition failed

**Trigger scenario**:
- The distributed lock is already held by another process
- Lock service is unavailable
- Lock configuration error

**Example**:
```javascript
try {
  const lock = await msq.acquireLock('user:123', { timeout: 5000 });
} catch (error) {
  console.log(error.code); // 'LOCK_ACQUIRE_FAILED'
}
```

**Handling Suggestions**:
- Wait for the lock to be released and try again
- Check lock service status (such as Redis)
- Implement lock timeout and retry mechanism
- Consider using a shorter lock timeout

---


### LOCK_TIMEOUT

**Description**: Lock wait timeout

**Trigger scenario**:
- Waiting for lock for longer than configured timeout
- Other processes hold locks for a long time

**Example**:
```javascript
try {
  const lock = await msq.acquireLock('resource:1', {
    timeout: 3000,
    waitTimeout: 10000
  });
} catch (error) {
  console.log(error.code); // 'LOCK_TIMEOUT'
}
```

**Handling Suggestions**:
- Increase wait timeout
- Check lock holder status
- Implement the forced release mechanism of locks
- Optimize business logic to reduce lock holding time

---

## Quick index of error codes

| Error code | Category | Description |
|--------|------|------|
| `VALIDATION_ERROR` | Verification | Parameter verification failed |
| `INVALID_ARGUMENT` | Validation | Invalid parameter |
| `INVALID_VECTOR_SEARCH` | Vector Search | Invalid local Vector Search option |
| `INVALID_RELATION_SELECT` | Relations | Unsupported relation inclusion selection |
| `RELATION_IN_USE` | Relations | Protected delete found declared references |
| `RELATION_USAGE_UNAVAILABLE` | Relations | Protected delete scan coverage is incomplete or unavailable |
| `INVALID_COLLECTION_NAME` | Validation | Invalid collection name |
| `INVALID_DATABASE_NAME` | Validation | Invalid database name |
| `INVALID_EXPRESSION` | Expression | Invalid expression DSL |
| `INVALID_OPERATION` | Operation status | The current status does not allow this operation |
| `INVALID_CURSOR` | Cursor | Invalid cursor |
| `INVALID_PAGINATION` | Paging | Invalid paging parameter or cursor |
| `CURSOR_SORT_MISMATCH` | Cursor | Cursor sort mismatch |
| `JUMP_TOO_FAR` | Paging | Page jump distance is too far |
| `STREAM_NO_JUMP` | Paging | Streaming mode does not support page jumps |
| `STREAM_NO_TOTALS` | Paging | Streaming mode does not support getting the total number |
| `STREAM_NO_EXPLAIN` | Pagination | Query plan is not supported in streaming mode |
| `CONNECTION_TIMEOUT` | Connection | Connection timeout |
| `CONNECTION_FAILED` | Connection | Connection failed |
| `NOT_CONNECTED` | Connected | Not connected yet |
| `CONNECTION_CLOSED` | Connection | Connection closed |
| `NO_POOL_MANAGER` | Connection pool | No connection pool manager configured |
| `POOL_NOT_FOUND` | Connection pool | The specified connection pool does not exist |
| `DATABASE_ERROR` | Database | General database error |
| `QUERY_TIMEOUT` | Database | Query timeout |
| `MANAGEMENT_OPERATION_FAILED` | Management Operations | Index, bookmark, or collection management operation failed |
| `CACHE_ERROR` | Cache | Cache operation error |
| `CACHE_TIMEOUT` | Cache | Cache operation timed out |
| `CACHE_UNAVAILABLE` | Caching | Caching capability is not available |
| `INVALID_CONFIG` | Configuration | Invalid configuration |
| `UNSUPPORTED_DATABASE` | Configuration | Unsupported database type |
| `WRITE_ERROR` | Write operation | Generic write operation error |
| `DOCUMENT_REQUIRED` | Write operation | Missing document parameter |
| `DOCUMENTS_REQUIRED` | Write operation | Missing document array parameter |
| `DUPLICATE_KEY` | Write operation | Unique key conflict |
| `WRITE_CONFLICT` | Write operation | Write conflict |
| `LOCK_ACQUIRE_FAILED` | Lock | Lock acquisition failed 🆕 v1.4.0 |
| `LOCK_TIMEOUT` | Lock | Lock wait timeout 🆕 v1.4.0 |

---

## FAQ


## How to catch all database related errors?

```javascript
import { ErrorCodes } from 'monsqlize';

const DATABASE_ERRORS = [
  ErrorCodes.DATABASE_ERROR,
  ErrorCodes.QUERY_TIMEOUT,
  ErrorCodes.CONNECTION_FAILED,
  ErrorCodes.CONNECTION_TIMEOUT,
  ErrorCodes.CONNECTION_CLOSED
];

try {
  await collection('users').find({});
} catch (error) {
  if (DATABASE_ERRORS.includes(error.code)) {
    console.error('Database error:', error.message);
  }
}
```


## How to implement error retry mechanism?

```javascript
async function retryOnError(fn, retries = 3) {
  const RETRYABLE_ERRORS = [
    ErrorCodes.CONNECTION_TIMEOUT,
    ErrorCodes.QUERY_TIMEOUT,
    ErrorCodes.WRITE_CONFLICT
  ];

  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (RETRYABLE_ERRORS.includes(error.code) && i < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
        continue;
      }
      throw error;
    }
  }
}

//Usage example
await retryOnError(async () => {
  await collection('users').insertOne({ name: 'Alice' });
});
```


## Error logging best practices

```javascript
function logError(error, context = {}) {
  const logData = {
    code: error.code,
    message: error.message,
    timestamp: new Date().toISOString(),
    ...context
  };

  if (error.details) {
    logData.details = error.details;
  }

  if (error.cause) {
    logData.cause = {
      name: error.cause.name,
      message: error.cause.message,
      stack: error.cause.stack
    };
  }

  //Select log level based on error type
  if (error.code === ErrorCodes.VALIDATION_ERROR) {
    logger.warn(logData);
  } else if (error.code === ErrorCodes.CONNECTION_FAILED) {
    logger.error(logData);
  } else {
    logger.info(logData);
  }
}
```

---

## References

- [API Reference](./api-index.md)
- [Transaction Management](./transaction.md)
- [Pool configuration](./multi-pool.md)
- [Chain Pool/Library Access API](./pool-chain-api.md)
- [Connection configuration](./connection.md)
