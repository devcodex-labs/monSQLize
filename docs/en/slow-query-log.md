# Slow query log persistence

## Overview

Slow query log persistence records operations that exceed the configured `slowQueryMs` threshold and lets you query aggregated slow-query statistics later. In the current MongoDB runtime, records are stored in MongoDB by default and may use memory storage for local or custom scenarios.


## Core Features

- **Simple enablement**: use `slowQueryLog: true` with `slowQueryMs`.
- **Aggregated records**: records with the same `queryHash`, database, collection, and operation are upserted into one statistic row.
- **Batch writing**: enabled by default with configurable size, interval, and buffer limit.
- **Automatic expiration**: MongoDB storage creates a TTL index on `lastSeen`.
- **Query API**: `getSlowQueryLogs(filter, options)` returns stored slow-query statistics.
- **Current storage backends**: `mongodb` and `memory`.


## Working principle

```text
┌─────────────┐
│ Business query execution │
└──────┬──────┘
       │
       ▼
┌─────────────────┐
│ Slow query detection │ ← slowQueryMs: 500
│ (withSlowQueryLog)│
└──────┬──────────┘
│ If execution time > 500ms
       ▼
┌─────────────────┐
│ Generate queryHash │ ← SHA256(database+collection+operation+query)
└──────┬──────────┘
       │
       ▼
┌─────────────────┐
│ Add to batch queue │ ← BatchQueue (buffer)
└──────┬──────────┘
│ Reach 10 items or 5 seconds
       ▼
┌─────────────────┐
│ bulkWrite upsert│ ← MongoDB storage
│ aggregate row    │
└─────────────────┘
```

---

## Quick start


## Simplest configuration (recommended)

```javascript
import MonSQLize from 'monsqlize';

const msq = new MonSQLize({
  type: 'mongodb',
  config: { uri: 'mongodb://localhost:27017/mydb' },
  slowQueryMs: 500,      //Slow query threshold (milliseconds)
  slowQueryLog: true     //✅ Zero configuration enabled
});

await msq.connect();

//Execute query (slow query automatically saved)
const users = await msq.find('users', { status: 'active' });

//Query slow query log
const logs = await msq.getSlowQueryLogs(
  { collection: 'users' },
  { sort: { count: -1 }, limit: 10 }
);

console.log('Top 10 high-frequency slow queries:', logs);

await msq.close();
```


## Automatic effects

- Slow queries are automatically saved to the `admin.slow_query_logs` collection
- Similar query records are aggregated by `queryHash`, database, collection, and operation
- TTL index automatically cleans data from 7 days ago
- Reuse business connections without additional connection overhead

---

## Configuration instructions


## Global slow query configuration


### Basic configuration (set during initialization)

```javascript
const msq = new MonSQLize({
  type: 'mongodb',
  config: { uri: 'mongodb://localhost:27017/mydb' },

  // Global slow query threshold in milliseconds. Default: 500.
  slowQueryMs: 1000,

  // Enable persistence with defaults, or pass a slowQueryLog object.
  slowQueryLog: true
});
```


### Detailed explanation of configuration options

| Options | Type | Default | Description |
|------|------|--------|------|
| `slowQueryMs` | number | `500` | Global threshold used by slow-query events and, when `slowQueryLog` is enabled, by `slowQueryLog.filter.minExecutionTimeMs` unless that field is set explicitly. |
| `slowQueryLog` | boolean or object | `false` | Enables persistence when `true`; an object may configure `enabled`, `storage`, `batch`, `filter`, and `advanced`. |
| `slowQueryLog.storage.type` | `'mongodb' \| 'memory'` | `'mongodb'` for MongoDB runtime | Storage backend. Other storage names are not currently supported. |
| `slowQueryLog.storage.useBusinessConnection` | boolean | `true` | Reuse the main MongoDB client. Set `false` only when also providing `storage.uri`. |
| `slowQueryLog.storage.database` | string | `'admin'` | Database used by MongoDB storage. |
| `slowQueryLog.storage.collection` | string | `'slow_query_logs'` | Collection used by MongoDB storage. |
| `slowQueryLog.storage.ttl` | number | `604800` | TTL in seconds for the `lastSeen` index. |
| `slowQueryLog.batch.enabled` | boolean | `true` | Buffer writes before saving. |
| `slowQueryLog.filter.*` | object | empty filters | Exclude databases, collections, operations, or set `minExecutionTimeMs`. |
| `slowQueryLog.advanced.errorHandling` | `'log' \| 'throw' \| 'silent'` | `'log'` | How persistence errors are handled. |


## Operation level configuration

Slow query thresholds can be configured individually for certain operations:


### Method 1: Through options parameter

```javascript
//Set different thresholds for individual queries
await collection('products').find(
  { category: 'electronics' },
  {
    slowQueryMs: 500,  //The query threshold is 500ms
    maxTimeMS: 3000    //MongoDB query timeout
  }
);

//Aggregation queries are also supported
await collection('orders').aggregate(
  [
    { $match: { status: 'completed' } },
    { $group: { _id: '$userId', total: { $sum: '$amount' } } }
  ],
  {
    slowQueryMs: 2000  //Aggregation query threshold 2000ms
  }
);
```


### Method 2: Use global configuration

```javascript
//Use global threshold (without specifying slowQueryMs)
const products = await collection('products').find(
  { category: 'electronics' }
);  //Use globally configured slowQueryMs: 1000
```


## Log format


### JSON format (default)

```json
{
  "level": "warn",
  "message": "[SLOW QUERY] Operation exceeded threshold",
  "operation": "find",
  "collection": "products",
  "database": "mydb",
  "duration": 1523,
  "threshold": 1000,
  "query": { "category": "electronics" },
  "options": { "limit": 10 },
  "docCount": 10,
  "timestamp": "2026-01-20T08:30:15.123Z",
  "instanceId": "msq_abc123"
}
```


### Text format

```text
[2026-01-20 08:30:15] WARN: [SLOW QUERY] find on mydb.products took 1523ms (threshold: 1000ms)
Query: {"category":"electronics"}
Options: {"limit":10}
Documents returned: 10
```


## Log output configuration


### Use custom Logger

```javascript
const logger = {
  warn(message, fields) {
    process.stdout.write(`${JSON.stringify({ level: 'warn', message, ...fields })}\n`);
  },
  error(message, error) {
    process.stderr.write(`${JSON.stringify({ level: 'error', message, error: String(error) })}\n`);
  }
};

const msq = new MonSQLize({
  type: 'mongodb',
  config: { uri: '...' },
  logger,
  slowQueryMs: 1000,
  slowQueryLog: true
});
```


### Listen for slow query events

```javascript
//Method 1: Listen for events
msq.on('slow-query', (info) => {
  console.log('Slow query detected:', {
    operation: info.op,
    collection: info.collection,
    duration: info.durationMs,
    query: info.query
  });

  //Send alert
  if (info.durationMs > 5000) {
    alerting.send({
      type: 'critical',
      message: `Extremely slow query: ${info.durationMs}ms`,
      details: info
    });
  }
});

//Method 2: Use event listener
msq.addEventListener('slow-query', handleSlowQuery);
```


## Configuration level

monSQLize provides a three-tier configuration architecture to meet different usage scenarios:


### Level 1: Zero configuration (recommended)

```javascript
slowQueryLog: true  //Use all default values
```

**Default configuration**:
- `enabled: true` - Enable
- `storage.type: 'mongodb'` - MongoDB storage for the MongoDB runtime
- `storage.useBusinessConnection: true` - Multiplexed business connection
- `storage.database: 'admin'` - stored in admin database
- `storage.collection: 'slow_query_logs'` - collection name
- `storage.ttl: 604800` - Expires in 7 days
- `batch.enabled: true` - Enable batch writing
- `batch.size: 10` - batch size
- `batch.interval: 5000` - refresh in 5 seconds


### Level 2: Basic configuration (commonly used)

```javascript
slowQueryLog: {
  enabled: true,
  storage: {
    ttl: 3 * 24 * 3600  //Only modify the TTL to 3 days
  }
}
```


### Level 3: Complete Configuration (Advanced)

```javascript
slowQueryLog: {
  enabled: true,

  //Storage configuration
  storage: {
    type: 'mongodb',                    //storage type
    useBusinessConnection: false,        //Do not reuse connections
    uri: 'mongodb://admin-host:27017', // Independent connection URI
    database: 'admin',
    collection: 'slow_query_logs',
    ttl: 7 * 24 * 3600
  },

  //Batch configuration
  batch: {
    enabled: true,
    size: 20,                           //20 items refreshed
    interval: 3000,                     //Refresh in 3 seconds
    maxBufferSize: 100                  //Maximum buffer 100 items
  },

  //Filter configuration
  filter: {
    excludeDatabases: [],               //exclude database
    excludeCollections: ['logs'],       //exclude collection
    excludeOperations: [],              //exclude operations
    minExecutionTimeMs: 0               //Minimum execution time
  }
}
```


## Detailed explanation of configuration parameters


### storage storage configuration

| Parameters | Type | Default value | Description |
|------|------|--------|------|
| `type` | `'mongodb' \| 'memory'` | `'mongodb'` | Storage backend. Other values are rejected by config validation. |
| `useBusinessConnection` | boolean | true | Whether to reuse business connections |
| `uri` | string | null | Independent connection URI (required when useBusinessConnection=false) |
| `database` | string | 'admin' | Storage database |
| `collection` | string | 'slow_query_logs' | Storage collection |
| `ttl` | number | 604800 (7 days) | TTL expiration time (seconds) |


### batch batch configuration

| Parameters | Type | Default value | Description |
|------|------|--------|------|
| `enabled` | boolean | true | Whether to enable batch writing |
| `size` | number | 10 | batch size (bar) |
| `interval` | number | 5000 | Refresh interval (milliseconds) |
| `maxBufferSize` | number | 100 | maximum buffer size |


### filter filter configuration

| Parameters | Type | Default value | Description |
|------|------|--------|------|
| `excludeDatabases` | string[] | [] | Excluded databases |
| `excludeCollections` | string[] | [] | Excluded collection |
| `excludeOperations` | string[] | [] | Excluded operation types |
| `minExecutionTimeMs` | number | 0 | Minimum execution time (milliseconds) |

---

## API Reference


## getSlowQueryLogs(filter, options)

Query slow query log (supports scheme B aggregation data)

**Parameters**:

```javascript
//filter - query conditions
{
  database: 'mydb',        //Database name
  collection: 'users',     //Collection name
  operation: 'find',       //Operation type
  queryHash: 'abc123def456' //Optional exact query hash
}

//options - query options
{
  sort: { count: -1 },     //Sorting rules
  limit: 10,               //limited quantity
  skip: 0                  //skip quantity
}
```

**Return Value**:

```javascript
[
  {
    queryHash: 'abc123def456',          //Query Hash (unique identifier)
    database: 'mydb',                   //Database name
    collection: 'users',                //Collection name
    operation: 'find',                  //Operation type
    sampleQuery: { status: 'active' },  //Sample query payload
    count: 2400,                        //Number of executions
    totalTimeMs: 1248000,               //total execution time
    minTimeMs: 500,                     //Minimum execution time
    maxTimeMs: 1200,                    //Maximum execution time
    avgTimeMs: 520,                     //Average execution time (dynamic calculation)
    firstSeen: ISODate('...'),          //Time of first discovery
    lastSeen: ISODate('...'),           //last time
    metadata: {}
  }
]
```

**Usage Example**:

```javascript
//Top 10 high-frequency and slow queries
const topFrequent = await msq.getSlowQueryLogs(
  {},
  { sort: { count: -1 }, limit: 10 }
);

//Top 10 slowest queries
const topSlow = await msq.getSlowQueryLogs(
  {},
  { sort: { maxTimeMs: -1 }, limit: 10 }
);

//Slow query for specific collection
const userLogs = await msq.getSlowQueryLogs(
  { database: 'mydb', collection: 'users' },
  { sort: { avgTimeMs: -1 } }
);

//Query for a specific operation type
const aggregateLogs = await msq.getSlowQueryLogs(
  { operation: 'aggregate' },
  { limit: 20 }
);
```

---

## Usage example


## Example 1: Zero configuration enablement

```javascript
const msq = new MonSQLize({
  type: 'mongodb',
  config: { uri: 'mongodb://localhost:27017/mydb' },
  slowQueryMs: 500,
  slowQueryLog: true  //✅ Enable in one line
});
```


## Example 2: Independent connection (isolated resources)

```javascript
const msq = new MonSQLize({
  type: 'mongodb',
  config: { uri: 'mongodb://localhost:27017/mydb' },
  slowQueryMs: 500,
  slowQueryLog: {
    enabled: true,
    storage: {
      useBusinessConnection: false,
      uri: 'mongodb://admin-host:27017/admin'
    }
  }
});
```


## Example 3: Custom TTL

```javascript
const msq = new MonSQLize({
  type: 'mongodb',
  config: { uri: 'mongodb://localhost:27017/mydb' },
  slowQueryMs: 500,
  slowQueryLog: {
    enabled: true,
    storage: {
      ttl: 24 * 3600  //Keep for 1 day
    }
  }
});
```


## Example 4: Filter a specific collection

```javascript
const msq = new MonSQLize({
  type: 'mongodb',
  config: { uri: 'mongodb://localhost:27017/mydb' },
  slowQueryMs: 500,
  slowQueryLog: {
    enabled: true,
    filter: {
      excludeCollections: ['logs', 'temp'],  //Exclude log collection
      minExecutionTimeMs: 1000               //Only records >1 second
    }
  }
});
```


## Example 5: Memory storage for local analysis

```javascript
const msq = new MonSQLize({
  type: 'mongodb',
  config: { uri: 'mongodb://localhost:27017/mydb' },
  slowQueryMs: 500,
  slowQueryLog: {
    enabled: true,
    storage: {
      type: 'memory'
    }
  }
});
```


## Example 6: Real-time writing mode

```javascript
const msq = new MonSQLize({
  type: 'mongodb',
  config: { uri: 'mongodb://localhost:27017/mydb' },
  slowQueryMs: 500,
  slowQueryLog: {
    enabled: true,
    batch: {
      enabled: false  //Disable batch, real-time writing
    }
  }
});
```

---

## Best Practices


## Threshold setting suggestions

Choose an appropriate slow query threshold according to different scenarios:

| Scenario | Recommended Threshold | Description |
|------|---------|------|
| **High Concurrency API** | 100-300ms | Quick response to requirements, sensitive to user experience |
| **Background Task** | 1000-3000ms | Longer time is acceptable, pay attention to resource usage |
| **Analysis query** | 5000-10000ms | Complex aggregation query, focusing on optimizing extremely slow queries |
| **Batch operation** | 10000-30000ms | Large batch data processing, focusing on failure |


### Example: Different scenario configurations

```javascript
//Scenario 1: High Concurrency Web API
const apiMsq = new MonSQLize({
  type: 'mongodb',
  config: { uri: '...' },
  slowQueryMs: 200,  //200ms threshold
  slowQueryLog: {
    enabled: true,
    filter: {
      excludeOperations: []
    }
  }
});

//Scenario 2: Data analysis services
const analyticsMsq = new MonSQLize({
  type: 'mongodb',
  config: { uri: '...' },
  slowQueryMs: 5000,  //5 second threshold
  slowQueryLog: {
    enabled: true,
    filter: {
      excludeOperations: []
    }
  }
});

//Scenario 3: Mixed scenario (dynamic threshold)
await collection('users').find(
  { status: 'active' },
  { slowQueryMs: 100 }  //User query 100ms
);

await collection('analytics').aggregate(
  [...],
  { slowQueryMs: 5000 }  //Analyze query 5 seconds
);
```


## Monitoring and Analysis


### 1. Real-time monitoring

```javascript
//Listen for slow query events
msq.on('slow-query', (info) => {
  //Real-time recording to monitoring system
  monitoring.record('slow_query', {
    operation: info.op,
    collection: info.collection,
    duration: info.durationMs,
    timestamp: new Date()
  });

  //Send an alarm (5 seconds beyond the threshold)
  if (info.durationMs > 5000) {
    alerting.send({
      type: 'critical',
      title: 'Extremely Slow Query Detected',
      message: `${info.op} on ${info.collection} took ${info.durationMs}ms`,
      details: info
    });
  }
});
```


### 2. Regular analysis

```javascript
//Analyze slow queries every hour
setInterval(async () => {
  //Obtain the Top 10 high-frequency slow queries
  const topFrequent = await msq.getSlowQueryLogs(
    {},
    { sort: { count: -1 }, limit: 10 }
  );

  console.log('=== High-frequency slow query analysis ===');
  topFrequent.forEach((log, index) => {
    console.log(`${index + 1}. ${log.collection}.${log.operation}:`);
    console.log(`Number of executions: ${log.count}`);
    console.log(`Average time taken: ${log.avgTimeMs}ms`);
    console.log(`Maximum time taken: ${log.maxTimeMs}ms`);
    console.log(`Sample query:`, JSON.stringify(log.sampleQuery));
    console.log('');
  });
}, 3600000);  //hourly
```


### 3. Export slow query statistics

```javascript
//Export slow query statistics report
async function exportSlowQueryReport(startDate, endDate) {
  const logs = await msq.getSlowQueryLogs(
    {
      lastSeen: {
        $gte: startDate,
        $lte: endDate
      }
    },
    { sort: { avgTimeMs: -1 } }
  );

  const report = {
    period: { start: startDate, end: endDate },
    totalQueries: logs.reduce((sum, log) => sum + log.count, 0),
    uniquePatterns: logs.length,
    topSlow: logs.slice(0, 10),
    byCollection: {}
  };

  //Statistics grouped by collection
  logs.forEach(log => {
    if (!report.byCollection[log.collection]) {
      report.byCollection[log.collection] = {
        count: 0,
        totalTimeMs: 0,
        queries: []
      };
    }
    report.byCollection[log.collection].count += log.count;
    report.byCollection[log.collection].totalTimeMs += log.totalTimeMs;
    report.byCollection[log.collection].queries.push(log);
  });

  return report;
}

//Usage example
const report = await exportSlowQueryReport(
  new Date('2026-01-01'),
  new Date('2026-01-31')
);
console.log(JSON.stringify(report, null, 2));
```


## Optimization suggestions


### 1. Create index

```javascript
//Create index after analyzing slow queries
const slowQuery = {
  collection: 'users',
  sampleQuery: { status: 'active', createdAt: { $gte: someDate } }
};

//Create index based on query pattern
await msq.db('mydb').collection('users').createIndex(
  { status: 1, createdAt: -1 },
  { name: 'idx_status_createdAt' }
);

//Verify index effect
const result = await collection('users')
  .find({ status: 'active', createdAt: { $gte: someDate } })
  .explain('executionStats');

console.log('Index usage:', result.executionStats.totalKeysExamined);
```


### 2. Optimize query conditions

```javascript
//❌ Inefficient query
await collection('products').find({
  $where: 'this.price > 100'  //JavaScript expression, cannot use index
});

//✅ After optimization
await collection('products').find({
  price: { $gt: 100 }  //Standard operators, indexes can be used
});

//❌ Inefficient regular rules
await collection('users').find({
  email: { $regex: '.*@gmail.com' }  //Prefix wildcard, cannot use index
});

//✅ After optimization
await collection('users').find({
  email: { $regex: '^.*@gmail\\.com$' }  //Using anchor points, partial indexing can be used
});
```


### 3. Use projection to reduce data transmission

```javascript
//❌ Return all fields
const users = await collection('users').find({
  status: 'active'
});

//✅ Only return required fields
const users = await collection('users').find(
  { status: 'active' },
  {
    projection: { name: 1, email: 1, _id: 0 }
  }
);
```


### 4. Enable caching

```javascript
//Enable caching for high-frequency queries
const activeUsers = await collection('users').find(
  { status: 'active' },
  {
    cache: 60000,  //Cache for 1 minute
    slowQueryMs: 100
  }
);

//The second query is read from the cache and does not trigger the slow query log
```


## Best Practices for Production Environments


### 1. Set TTL appropriately

```javascript
//Set TTL based on storage capacity and analysis needs
storage: {
  ttl: 7 * 24 * 3600    //1 week (recommended) - balance storage and analysis needs
  // ttl: 30 * 24 * 3600 // 30 days - Long-term trend analysis
  // ttl: 1 * 24 * 3600 // 1 day - storage sensitive scenes
}
```


### 2. Use reuse connection (default)

```javascript
//✅ Recommendation: Reuse connection (default)
storage: {
  useBusinessConnection: true  //Zero additional connection overhead
}

//⚠️ Special scenario: independent connection
storage: {
  useBusinessConnection: false,
  uri: 'mongodb://admin-host:27017/admin'
}
```

**When to use independent connections**:
- Production database performance is extremely sensitive
- The amount of slow query logs is large (>10,000 entries/day)
- Requires independent permission control and resource isolation


### 3. Configure alarms

```javascript
//Send an alarm when slow query reaches the threshold
msq.on('slow-query', (info) => {
  if (info.durationMs > 5000) {
    //critical alarm
    alerting.send({
      type: 'critical',
      message: `Extremely slow query: ${info.durationMs}ms`,
      details: {
        operation: info.op,
        collection: info.collection,
        database: info.db,
        query: info.query,
        duration: info.durationMs
      },
      tags: ['mongodb', 'performance', 'slow-query']
    });
  } else if (info.durationMs > 2000) {
    //warning level
    alerting.send({
      type: 'warning',
      message: `Slow query detected: ${info.durationMs}ms`,
      details: info
    });
  }
});
```


### 4. Monitor storage space

```javascript
//Periodically check slow query log collection size
setInterval(async () => {
  const stats = await msq.db('admin').collection('slow_query_logs').stats();
  const sizeMB = stats.size / 1024 / 1024;

  console.log('Slow query log storage:', {
    size: `${sizeMB.toFixed(2)} MB`,
    count: stats.count,
    avgObjectSize: `${stats.avgObjSize} bytes`
  });

  //Warning: Storage exceeds 1GB
  if (sizeMB > 1024) {
    alerting.send({
      type: 'warning',
      message: 'Slow query logs collection exceeds 1GB',
      details: { sizeMB, count: stats.count }
    });
  }
}, 86400000);  //Check every day
```


### 5. Integrated log system

```javascript
const logger = {
  info(message, fields) {
    process.stdout.write(`${JSON.stringify({ level: 'info', message, ...fields })}\n`);
  },
  warn(message, fields) {
    process.stdout.write(`${JSON.stringify({ level: 'warn', message, ...fields })}\n`);
  },
  error(message, error) {
    process.stderr.write(`${JSON.stringify({ level: 'error', message, error: String(error) })}\n`);
  }
};

const msq = new MonSQLize({
  type: 'mongodb',
  config: { uri: '...' },
  logger,
  slowQueryMs: 1000,
  slowQueryLog: true
});
```

---

## Troubleshooting


## Problem 1: Slow query log is not saved

**Possible reasons**:

1. Function not enabled
   ```javascript
   //❌ Error
   slowQueryLog: false

   //✅ Correct
   slowQueryLog: true
   ```

2. The query does not exceed the threshold
   ```javascript
   //Check slowQueryMs settings
   slowQueryMs: 500  //Make sure the query does take >500ms
   ```

3. The batch queue is not refreshed
   ```javascript
   //Wait for the queue to be refreshed (default 5 seconds)
   await new Promise(resolve => setTimeout(resolve, 6000));
   ```

**Solution**:
1. Check whether the configuration is correct
2. Check the log output for errors
3. If batch mode is enabled, call `await msq.getSlowQueryLogManager()?.queue?.flush()` before reading recent logs.


## Problem 2: Storage connection failed

**Error message**:
```text
[SlowQueryLog] Failed to initialize MongoDB storage: MongoServerError...
```

**Possible reasons**:
- MongoDB connection URI error
- The network is unreachable
- Insufficient permissions

**Solution**:
```javascript
//Check if the URI is correct
storage: {
  useBusinessConnection: false,
  uri: 'mongodb://localhost:27017/admin' // Confirm that the URI is correct
}

//Or use multiplexing connection
storage: {
  useBusinessConnection: true  //Use business connections
}
```


## Question 3: Querying the slow query log returns empty

**Possible reasons**:
1. Slow query log is not generated
2. Expired (TTL deleted)
3. Query conditions do not match

**Solution**:
```javascript
//Query all slow query logs
const allLogs = await msq.getSlowQueryLogs({}, { limit: 100 });
console.log('Total:', allLogs.length);

//Check TTL settings
const manager = msq.getSlowQueryLogManager();
console.log('TTL:', manager?.config.storage.ttl);
```

---

## Performance optimization


## Performance impact analysis

| Metrics | Not enabled | After enabled | Impact |
|------|--------|--------|------|
| Single query time | X ms | X + 2ms | +2ms (queue add) |
| Memory usage | Y MB | Y + 0.3MB | +0.3MB (queue buffer) |
| Number of connections | N | N (multiplexed) | 0 |

**Conclusion**: Logging overhead depends on sampling, storage, serialization, and workload. Measure it in the target environment and set an explicit budget; do not assume it is negligible.


## Optimization suggestions (performance optimization)

1. **Use batch writes** (enabled by default)
   ```javascript
   batch: {
     enabled: true,     //✅ Enable batching
     size: 10,          //batch size
     interval: 5000     //refresh interval
   }
   ```

2. **Keep the built-in aggregation key**
   ```javascript
   // MongoDB storage upserts by queryHash + database + collection + operation.
   // There is no user-facing aggregation switch to configure.
   ```

3. **Set TTL reasonably**
   ```javascript
   storage: {
     ttl: 7 * 24 * 3600  //Expires in 7 days
   }
   ```

4. **Filter unimportant collections**
   ```javascript
   filter: {
     excludeCollections: ['logs', 'temp']  //Exclude log collection
   }
   ```

---

## Appendix


## A. Data model

**slow_query_logs collection structure**:

```javascript
{
  queryHash: 'abc123def456',          //Query Hash (unique)
  database: 'mydb',                   //Database name
  collection: 'users',                //Collection name
  operation: 'find',                  //Operation type
  sampleQuery: { status: 'active' },  //Sample query payload
  count: 2400,                        //Number of executions
  totalTimeMs: 1248000,               //total execution time
  minTimeMs: 500,                     //Minimum execution time
  maxTimeMs: 1200,                    //Maximum execution time
  firstSeen: ISODate('...'),          //Time of first discovery
  lastSeen: ISODate('...'),           //Last time (TTL field)
  metadata: {}
}
```

**Index**:

```javascript
//Unique index used by the storage backend
db.slow_query_logs.createIndex(
  { queryHash: 1, database: 1, collection: 1, operation: 1 },
  { unique: true, name: 'slow_query_log_unique' }
);

//TTL index (lastSeen)
db.slow_query_logs.createIndex(
  { lastSeen: 1 },
  { expireAfterSeconds: 604800 }
);

//query optimization index
db.slow_query_logs.createIndex({ database: 1, collection: 1 });
db.slow_query_logs.createIndex({ count: -1 });
```


## B. Related links

- [Usage Example](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/slow-query-log.ts)
