# Operation and maintenance monitoring API

Operation and maintenance monitoring methods are used to check database health status, obtain version information, monitor server performance, etc.

## ping()

Check whether the database connection is normal.


## Syntax

```javascript
const isAlive = await db.db().admin().ping();
```


## Return value

- **Type**: `Promise<boolean>`
- **Note**: If the connection is normal, `true` will be returned, otherwise `false` will be returned.


## Example

```javascript
import MonSQLize from 'monsqlize';

const msq = new MonSQLize({
    type: 'mongodb',
    config: { uri: 'mongodb://localhost:27017/mydb' }
});

await msq.connect();
const admin = msq.db().admin();

//Check connection
const isAlive = await admin.ping();
console.log('Database is alive:', isAlive);
```


## Usage scenarios

1. **Health Check**: The monitoring system regularly checks whether the database is available
2. **Container Orchestration**: Kubernetes health probe
3. **Load Balancing**: Detect the health status of database nodes


## Best Practices

```javascript
//Check connection when app starts
async function startup() {
    await msq.connect();

    const isAlive = await msq.db().admin().ping();
    if (!isAlive) {
        throw new Error('Database connection failed');
    }

    console.log('✅ Database connected');
}

//Regular health check-up
setInterval(async () => {
    const isAlive = await db.db().admin().ping();
    if (!isAlive) {
        console.error('❌ Database connection lost');
        //Trigger an alarm or reconnect
    }
}, 30000); //Check every 30 seconds
```

---

## buildInfo()

Get MongoDB version information and build details.


## Syntax (buildInfo())

```javascript
const info = await db.db().admin().buildInfo();
```


## Return value (buildInfo())

- **Type**: `Promise<Object>`
- **Properties**:
  - `version` (string): version number, such as "6.0.3"
  - `versionArray` (Array<number>): Array of version numbers, such as [6, 0, 3]
  - `gitVersion` (string): Git version hash
  - `bits` (number): System number of digits (32 or 64)
  - `debug` (boolean): whether it is Debug version
  - `maxBsonObjectSize` (number): maximum size of BSON object


## Example (buildInfo())

```javascript
const info = await admin.buildInfo();

console.log('MongoDB version:', info.version);
console.log('Version array:', info.versionArray);
console.log('Git version:', info.gitVersion);
console.log('System number of digits:', info.bits);
console.log('BSON maximum size:', info.maxBsonObjectSize, 'bytes');
```

**Example output**:
```text
MongoDB version: 6.0.3
Version array: [6, 0, 3]
Git version: 01a0d5a0e6e8e5f...
Number of system bits: 64
BSON maximum size: 16777216 bytes
```


## Usage scenarios (buildInfo())

1. **Compatibility Check**: Check whether the MongoDB version meets the minimum requirements
2. **Function detection**: Determine whether to use specific functions based on the version
3. **Monitoring Report**: Record the database version in the monitoring system


## Best Practices (buildInfo())

```javascript
//Check version compatibility
async function checkMongoDBVersion() {
    const info = await db.db().admin().buildInfo();
    const [major, minor] = info.versionArray;

    //Requires MongoDB 4.4+
    if (major < 4 || (major === 4 && minor < 4)) {
        throw new Error(
            `MongoDB version is too low: ${info.version}, requires 4.4+`
        );
    }

    console.log(`✅ MongoDB version check passed: ${info.version}`);
}

//Enable features based on version
async function initializeFeatures() {
    const info = await db.db().admin().buildInfo();
    const [major, minor] = info.versionArray;

    //MongoDB 5.0+ supports time series collections
    const supportsTimeSeries = major >= 5;

    //MongoDB 4.2+ supports wildcard indexes
    const supportsWildcardIndexes = major > 4 || (major === 4 && minor >= 2);

    return {
        supportsTimeSeries,
        supportsWildcardIndexes
    };
}
```

---

## serverStatus()

Obtain server status information, including number of connections, memory usage, operation statistics, etc.


## Syntax (serverStatus())

```javascript
const status = await db.db().admin().serverStatus(options);
```


## Parameters

- **options** (Object, optional):
  - `scale` (number): scaling factor, used to adjust the size unit
    - `1`: Bytes (default)
    - `1024`: KB
    - `1048576`: MB


## Return value (serverStatus())

- **Type**: `Promise<Object>`
- **Properties**:
  - `connections` (Object): Connection information
    - `current` (number): current number of connections
    - `available` (number): Number of available connections
    - `totalCreated` (number): total number of connections created
  - `mem` (Object): Memory usage information
    - `resident` (number): resident memory (MB)
    - `virtual` (number): virtual memory (MB)
    - `mapped` (number): mapped memory (MB)
  - `opcounters` (Object): Operation counter
    - `insert` (number): insert operand
    - `query` (number): Query operand
    - `update` (number): update operand
    - `delete` (number): delete operand
    - `getmore` (number): getMore operand
    - `command` (number): command operand
  - `network` (Object): Network statistics
    - `bytesIn` (number): Number of bytes received
    - `bytesOut` (number): number of bytes sent
    - `numRequests` (number): total number of requests
  - `uptime` (number): running time (seconds)
  - `localTime` (Date): local time
- `version` (string): MongoDB version
  - `process` (string): process type


## Example (serverStatus())


### Basic usage

```javascript
const status = await admin.serverStatus();

console.log('=== Connection information ===');
console.log('Current connection:', status.connections.current);
console.log('Available connections:', status.connections.available);

console.log('\n=== Memory usage ===');
console.log('Resident memory:', status.mem.resident, 'MB');
console.log('Virtual memory:', status.mem.virtual, 'MB');

console.log('\n=== Operation statistics ===');
console.log('Insert:', status.opcounters.insert);
console.log('Query:', status.opcounters.query);
console.log('Update:', status.opcounters.update);
console.log('Delete:', status.opcounters.delete);

console.log('\n=== System information ===');
console.log('Running time:', Math.floor(status.uptime / 3600), 'hours');
console.log('Version:', status.version);
```


### Use the scale parameter

```javascript
//Use KB as the unit
const statusKB = await db.db().admin().serverStatus({ scale: 1024 });
console.log('Memory usage:', statusKB.mem.resident, 'KB');

//Use MB as unit
const statusMB = await db.db().admin().serverStatus({ scale: 1048576 });
console.log('Memory usage:', statusMB.mem.resident, 'MB');
```


## Usage scenarios (serverStatus())

1. **Performance Monitoring**: Real-time monitoring of database performance indicators
2. **Capacity Planning**: Analyze connection usage and plan connection pool size
3. **Troubleshooting**: Check memory usage, number of connections and other abnormalities
4. **Alarm System**: Set thresholds to trigger alarms


## Best Practices (serverStatus())

```javascript
//Monitor the number of connections
async function monitorConnections() {
    const status = await db.db().admin().serverStatus();
    const usagePercent = (status.connections.current /
        (status.connections.current + status.connections.available)) * 100;

    if (usagePercent > 80) {
        console.warn(`⚠️ Connection usage is too high: ${usagePercent.toFixed(2)}%`);
        //trigger alarm
    }

    return {
        current: status.connections.current,
        total: status.connections.current + status.connections.available,
        usagePercent: usagePercent.toFixed(2)
    };
}

//Monitor memory usage
async function monitorMemory() {
    const status = await db.db().admin().serverStatus({ scale: 1048576 }); // MB

    if (status.mem.resident > 1024) { //More than 1GB
        console.warn(`⚠️ Memory usage too high: ${status.mem.resident} MB`);
    }

    return {
        resident: status.mem.resident,
        virtual: status.mem.virtual,
        unit: 'MB'
    };
}

//Collect performance metrics regularly
async function collectMetrics() {
    const status = await db.db().admin().serverStatus();

    //Send to monitoring system (such as Prometheus, Grafana)
    return {
        timestamp: new Date(),
        connections: {
            current: status.connections.current,
            available: status.connections.available
        },
        memory: {
            resident: status.mem.resident,
            virtual: status.mem.virtual
        },
        operations: {
            insert: status.opcounters.insert,
            query: status.opcounters.query,
            update: status.opcounters.update,
            delete: status.opcounters.delete
        },
        uptime: status.uptime
    };
}
```

---

## stats()

Get the statistics of the current database.


## Syntax (stats())

```javascript
const stats = await db.db().admin().stats(options);
```


## Parameters (stats())

- **options** (Object, optional):
  - `scale` (number): scaling factor
    - `1`: Bytes (default)
    - `1024`: KB
    - `1048576`: MB


## Return value (stats())

- **Type**: `Promise<Object>`
- **Properties**:
  - `db` (string): database name
  - `collections` (number): number of sets
  - `views` (number): number of views
  - `objects` (number): total number of documents
  - `avgObjSize` (number): average document size
  - `dataSize` (number): data size
  - `storageSize` (number): storage size
  - `indexes` (number): index number
  - `indexSize` (number): index size
  - `totalSize` (number): total size
  - `scaleFactor` (number): scaling factor


## Example (stats())


### Basic usage (example (stats()))

```javascript
const stats = await admin.stats();

console.log('Database:', stats.db);
console.log('Number of sets:', stats.collections);
console.log('Number of views:', stats.views);
console.log('Total number of documents:', stats.objects);
console.log('Average document size:', stats.avgObjSize, 'bytes');
console.log('Data size:', stats.dataSize, 'bytes');
console.log('Storage size:', stats.storageSize, 'bytes');
console.log('Number of indexes:', stats.indexes);
console.log('Index size:', stats.indexSize, 'bytes');
```


### Use different units

```javascript
//Use MB as unit
const statsMB = await db.db().admin().stats({ scale: 1048576 });

console.log('=== Database Statistics (MB) ===');
console.log('Data size:', statsMB.dataSize, 'MB');
console.log('Storage size:', statsMB.storageSize, 'MB');
console.log('Index size:', statsMB.indexSize, 'MB');
console.log('Total size:', statsMB.totalSize, 'MB');
```


## Usage scenarios (stats())

1. **Capacity Planning**: Assess database storage needs
2. **Performance Optimization**: Analyze index space occupied
3. **Cost Estimation**: Calculate storage costs
4. **Monitoring Alarm**: Alarm when the database size exceeds the threshold


## Best Practices (stats())

```javascript
//Capacity monitoring
async function monitorDatabaseCapacity() {
    const stats = await db.db().admin().stats({ scale: 1073741824 }); // GB

    const capacityReport = {
        database: stats.db,
        dataSize: stats.dataSize.toFixed(2) + ' GB',
        indexSize: stats.indexSize.toFixed(2) + ' GB',
        totalSize: stats.totalSize.toFixed(2) + ' GB',
        collections: stats.collections,
        documents: stats.objects,
        avgDocSize: (stats.avgObjSize / 1024).toFixed(2) + ' KB'
    };

    //Check capacity threshold
    if (stats.totalSize > 50) { //More than 50GB
        console.warn('⚠️ Database capacity exceeds 50GB');
    }

    return capacityReport;
}

//Index analysis
async function analyzeIndexes() {
    const stats = await db.db().admin().stats();

    //Calculate index proportion
    const indexRatio = (stats.indexSize / stats.dataSize) * 100;

    if (indexRatio > 50) {
        console.warn(
            `⚠️ Index usage is too high: ${indexRatio.toFixed(2)}% of the data size`
        );
    }

    return {
        indexCount: stats.indexes,
        indexSize: stats.indexSize,
        dataSize: stats.dataSize,
        indexRatio: indexRatio.toFixed(2) + '%'
    };
}

//Generate statistical reports
async function generateDatabaseReport() {
    const stats = await db.db().admin().stats({ scale: 1048576 }); // MB

    return {
        database: stats.db,
        summary: {
            collections: stats.collections,
            views: stats.views,
            documents: stats.objects,
            avgDocSize: (stats.avgObjSize / 1024).toFixed(2) + ' KB'
        },
        storage: {
            data: stats.dataSize.toFixed(2) + ' MB',
            storage: stats.storageSize.toFixed(2) + ' MB',
            indexes: stats.indexSize.toFixed(2) + ' MB',
            total: stats.totalSize.toFixed(2) + ' MB'
        },
        indexes: {
            count: stats.indexes,
            size: stats.indexSize.toFixed(2) + ' MB',
            ratio: ((stats.indexSize / stats.dataSize) * 100).toFixed(2) + '%'
        }
    };
}
```

---

## Related documents

- [Database Operation](./database-ops.md) - listDatabases, dropDatabase
- [Collection Management](./collection-management.md) - Collection statistics and management
- [Collection Management Example](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/collection-management.ts) - Current TypeScript example
