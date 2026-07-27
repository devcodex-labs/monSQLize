# readPreference - MongoDB replica set read preference configuration

## Overview

`readPreference` is the MongoDB node-selection strategy for read operations in replica sets. It supports read/write separation by reducing load on the primary node and can help globally distributed deployments read from lower-latency nodes.

**Applicable scenarios**:
- Replica Set deployment
- Read/write separation to reduce load on the primary node
- Globally distributed deployments that need lower-latency reads
- Analytics/report queries that can tolerate eventual consistency

**Restrictions**:
- `config.readPreference` sets the connection-level default.
- Individual read operations can pass `readPreference` in their options to override the default for that operation.
- The current monSQLize runtime is MongoDB-only; this option maps to MongoDB driver read preference behavior.
- Reads from secondary nodes may observe replication lag, so read-after-write paths should use `primary` or `primaryPreferred`.
- Reads inside MongoDB transactions should stay on `primary`; keep transaction reads on the connection default or override them to `primary`.
- It has no useful effect in stand-alone mode because there is only one node.

---

## Core Features


### 5 read preference modes

| Mode | Read Node | Data Consistency | Applicable Scenarios |
|------|---------|-----------|---------|
| **primary** | Primary node only | Strong consistency | Default, latest data required |
| **primaryPreferred** | Primary first; secondary when the primary is unavailable | Usually strong consistency | Strong consistency with failover tolerance |
| **secondary** | Secondary nodes only | Eventual consistency | Analytics/reporting, primary write-load isolation |
| **secondaryPreferred** | Secondary first; primary when no secondary is available | Eventual consistency | Read-heavy workloads, reduced primary load |
| **nearest** | Lowest-latency node (primary or secondary) | Eventual consistency | Globally distributed deployment, low latency |


### Connection-level global configuration

```javascript
const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'test_db',
    config: {
        uri: 'mongodb://localhost:27017,localhost:27018,localhost:27019/?replicaSet=rs0',
        readPreference: 'secondaryPreferred'  // Global configuration
    }
});
```

**Features**:
- Configure once and all queries will take effect
- Use query-level options only for operations that need a different read route
- Simplify the default path and reduce repeated configuration

---

## API parameter description


### Connection configuration

| Parameters | Type | Required | Default | Description |
|------|------|------|--------|------|
| **config.readPreference** | string | ❌ | `'primary'` | Replica set read preference mode |
| **read operation options.readPreference** | string | ❌ | Connection default | Per-operation override for read methods that pass MongoDB driver options |

**Optional values**:
- `'primary'` - Read only from the primary node (default)
- `'primaryPreferred'` - Read from the primary first, then a secondary when the primary is unavailable
- `'secondary'` - Read only from secondary nodes
- `'secondaryPreferred'` - Read from secondary nodes first, then the primary when no secondary is available
- `'nearest'` - Read from the nearest node (low latency)

---

## Usage example


## Basic usage


### Example 1: Default read preference (primary)

```javascript
const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'test_db',
    config: {
        uri: 'mongodb://localhost:27017',
        // If readPreference is not configured, the default is 'primary' (read only from the primary)
    }
});

await msq.connect();
const { collection } = msq;

// Query operations automatically read from the primary node
const users = await collection('users').find({});
console.log(`✅ Read ${users.length} documents from the primary node`);

await msq.close();
```

---


### Example 2: secondaryPreferred (prefer secondary nodes)

**Applicable scenarios**: read-heavy workloads that should reduce load on the primary node.

```javascript
const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'test_db',
    config: {
        uri: 'mongodb://localhost:27017,localhost:27018,localhost:27019/?replicaSet=rs0',
        readPreference: 'secondaryPreferred'  // Prefer secondary nodes
    }
});

await msq.connect();
const { collection } = msq;

// Queries read from secondary nodes first (reduces load on the primary)
const products = await collection('products').find({ category: 'electronics' });
console.log(`✅ Read ${products.length} products from secondary nodes`);

// NOTE: secondary nodes may have replication lag
console.log('NOTE: secondary data may lag by a few milliseconds to a few seconds');

await msq.close();
```

---


### Example 3: secondary (read only from secondary nodes)

**Applicable scenarios**: analytics/reporting queries that should isolate primary write load.

```javascript
const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'analytics_db',
    config: {
        uri: 'mongodb://localhost:27017,localhost:27018,localhost:27019/?replicaSet=rs0',
        readPreference: 'secondary'  // Read only from secondary nodes
    }
});

await msq.connect();
const { collection } = msq;

// Applicable scenarios: analytics/reporting query with primary write-load isolation
const reports = await collection('sales').aggregate([
    { $match: { date: { $gte: new Date('2025-01-01') } } },
    { $group: { _id: '$category', total: { $sum: '$amount' } } }
]);
console.log(`✅ Generated ${reports.length} report rows from secondary nodes`);
console.log('✅ The primary node can continue focusing on write operations.');

await msq.close();
```

---


### Example 4: primaryPreferred (read primary node first)

**Applicable scenario**: strong consistency is required, but reads should have a fallback when the primary node is unavailable.

```javascript
const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'test_db',
    config: {
        uri: 'mongodb://localhost:27017,localhost:27018,localhost:27019/?replicaSet=rs0',
        readPreference: 'primaryPreferred'  // Read from the primary first, then from a secondary if needed
    }
});

await msq.connect();
const { collection } = msq;

// Applicable scenario: strong consistency with a fallback when the primary is unavailable
const orders = await collection('orders').find({ status: 'pending' });
console.log(`✅ Read ${orders.length} orders from the primary node first`);
console.log('✅ If the primary is unavailable, reads can fall back to a secondary');

await msq.close();
```

---


### Example 5: nearest (nearest read, low latency)

**Applicable scenarios**: Global distributed deployment, nearby reading to reduce latency

```javascript
const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'test_db',
    config: {
        uri: 'mongodb://localhost:27017,localhost:27018,localhost:27019/?replicaSet=rs0',
        readPreference: 'nearest'  // Lowest-latency node (primary or secondary)
    }
});

await msq.connect();
const { collection } = msq;

// Applicable scenario: global deployments where nearby reads reduce latency
const articles = await collection('articles').find(
    { published: true },
    { limit: 10 }
);
console.log(`✅ Read ${articles.length} articles from the node with the lowest latency`);
console.log('✅ Suitable for global distributed deployment scenarios');

await msq.close();
```

---


## Advanced usage


### Example 6: Use with other options

```javascript
const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'test_db',
    config: {
        uri: 'mongodb://localhost:27017,localhost:27018,localhost:27019/?replicaSet=rs0',
        readPreference: 'secondaryPreferred'  // Read preference
    },
    maxTimeMS: 3000,  // Query timeout
    slowQueryMs: 500  // Slow query threshold
});

await msq.connect();
const { collection } = msq;

// Query-level readPreference overrides the connection default for this operation.
const results = await collection('products').find(
    { price: { $gt: 100 } },
    {
        readPreference: 'primary',
        hint: { category: 1, price: 1 },  // Index hint
        comment: 'expensive-products-query',  // Query comment
        maxTimeMS: 2000  // Per-query timeout
    }
);
console.log(`✅ Query with multiple options returned ${results.length} results`);

await msq.close();
```

---

## Best Practices


### Recommended practices

1. **Use `secondaryPreferred` for read-heavy workloads**
   ```javascript
   // Recommendation: reduce load on the primary node
   readPreference: 'secondaryPreferred'
   ```

2. **Use `primary` (default) for strong-consistency reads**
   ```javascript
   // Recommendation: use the default when the latest data is required
   // Do not configure readPreference, or explicitly configure it as 'primary'
   ```

3. **Use `nearest` for globally distributed deployments**
   ```javascript
   // Recommendation: lower-latency reads
   readPreference: 'nearest'
   ```

4. **Use `secondary` for analytics/reporting queries**
   ```javascript
   // Recommendation: isolate primary write load
   readPreference: 'secondary'
   ```

---


### Notes

1. **Replication delay problem**
   ```javascript
   // Avoid: reading from secondary nodes immediately after writing data
   await collection('users').insertOne({ name: 'Alice' });  // Write to primary

   // The newly written data may not be visible yet because of replication lag
   const users = await collection('users').find({ name: 'Alice' });

   // Solution: use 'primary' for read-after-write or wait for replication to complete.
   const freshUsers = await collection('users').find(
       { name: 'Alice' },
       { readPreference: 'primary' }
   );
   ```

2. **Transaction reads**
   ```javascript
   // MongoDB transaction reads should use the primary node.
   await msq.withTransaction(async (tx) => {
       const order = await collection('orders').findOne(
           { orderNo: 'SO-1001' },
           { session: tx.session, readPreference: 'primary' }
       );

       // ...write operations in the same transaction
   });
   ```

3. **Single mode is invalid**
   ```javascript
   // In stand-alone mode, readPreference is ineffective because there is only one node.
   const msq = new MonSQLize({
       config: {
           uri: 'mongodb://localhost:27017', // stand-alone mode
           readPreference: 'secondary'  // Ineffective configuration
       }
   });
   ```

4. **Replica Set URI Format**
   ```javascript
   // Correct: contains multiple nodes + replicaSet parameter
   uri: 'mongodb://host1:27017,host2:27018,host3:27019/?replicaSet=rs0'

   // Incorrect: single-node URI (cannot separate reads and writes)
   uri: 'mongodb://localhost:27017'
   ```

5. **Cross-database compatibility**
   ```javascript
   // readPreference is MongoDB-specific.
   // PostgreSQL/MySQL do not have the same concept.
   // Remove this configuration when switching database adapters.
   ```

---

## Performance impact


### Impact of read preference on performance

| Read preference | Master node load | Latency | Data consistency | Applicable scenarios |
|--------|-----------|------|-----------|---------|
| **primary** | High | Low | Strong consistency | Write-heavy workloads, latest data required |
| **primaryPreferred** | High | Low | Usually strongly consistent | Requires consistency + fault tolerance |
| **secondary** | Low | Medium (replication latency) | Eventually consistent | Analytics/reporting, primary isolation |
| **secondaryPreferred** | Low | Medium (replication latency) | Eventually consistent | Read-heavy workloads, reduced primary load |
| **nearest** | Medium | Lowest | Eventually consistent | Globally distributed, low latency |


### Performance optimization suggestions

1. **Read-heavy workloads**: Use `secondaryPreferred` to move tolerant reads away from the primary.
2. **Globally distributed**: Use `nearest` when lower latency matters more than always reading from the primary.
3. **Analytics/reporting**: Use `secondary` to isolate primary write load

---

## FAQ


## Q: Does readPreference support query-level configuration?
**A**: Yes. `config.readPreference` is the default, and read methods that pass MongoDB driver options can override it per operation:

```javascript
const users = await collection('users').find(
    { status: 'active' },
    { readPreference: 'primary' }
);
```

Use this sparingly. Keep the connection-level default for most reads, and override only read-after-write or analytics queries that need a different route.

---


## Q: How to verify that readPreference is effective?
**A**:
1. Check the MongoDB log/profile to confirm that the read operation hits a secondary node
2. Add delay on a secondary node and observe whether query results lag.
3. Use `db.currentOp()` to view the read preferences of active connections

---


## Q: How long is the replication delay?
**A**:
- LAN replica set: typically 10-100ms
- Cross-region replica set: maybe 100ms-1s
- When the network jitters: maybe 1s-5s
- It is recommended to monitor `optimeDate` differences in `rs.status()`

---


## Q: How to deal with replication delays?
**A**:
1. **Read immediately after writing**: use `primary` or `primaryPreferred`
2. **Acceptable delay**: Use `secondaryPreferred` or `secondary`
3. **Mixed strategy**: Use `primary` for key queries and `secondary` for analytical queries.

---


## Q: How to test in stand-alone mode?
**A**:
`readPreference` is invalid in stand-alone mode. Suggestions:
1. Use Docker Compose to build a local replica set
2. Use MongoDB Atlas free cluster (M0)
3. Use `mongodb-memory-server` to simulate a replica set (configuration required)

---

## References

- [MongoDB official documentation - Read Preference](https://www.mongodb.com/docs/manual/core/read-preference/)
- [MongoDB Replica Set Deployment Guide](https://www.mongodb.com/docs/manual/tutorial/deploy-replica-set/)
- [monSQLize connection configuration](./connection.md)
- [Example of multiple connection pools and read preferences](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/pool.ts)
