# Connection Pools and Multi-Pool Configuration

## Introduction

Opening pools reserve capacity before the client factory completes. Closing the manager rejects new additions, waits for pending additions, and closes clients that finish opening after shutdown began.

Use this page when your application needs more than one MongoDB connection, such as a primary pool plus read replicas, an analytics pool, or tenant-specific pools. The recommended runtime path is to declare pools when creating the `MonSQLize` instance:

- `pools: PoolConfig[]` defines named connection pools.
- `poolStrategy` defines selection behavior.
- `poolFallback` defines failover behavior.
- `maxPoolsCount` limits the number of pools.

`ConnectionPoolManager` is still a public low-level manager for advanced use cases that need manual registration, removal, or direct pool selection. Application code should normally use `msq.pool(name)`, `msq.pool(name).use(db)`, `scopedCollection()`, and Model `connection.pool`.

## Features

- ✅ **Read/write separation**: Use the primary pool for write operations and read replicas for read operations, reducing pressure on the primary database
- ✅ **Load Balancing**: Intelligently distribute query load among multiple replicas to improve overall performance
- ✅ **Failover**: Automatically detect failures and switch to a healthy connection pool to ensure service continuity
- ✅ **Performance Optimization**: Route analysis queries to dedicated analysis nodes without affecting online services
- ✅ **Flexible Expansion**: Dynamically add/remove connection pools according to business needs
- ✅ **Health Monitoring**: Monitor the health status of all connection pools in real time
- ✅ **Statistical Analysis**: Provide detailed performance statistics and monitoring data

## Applicable scenarios

| Scenario | Description | Benefits |
|------|------|------|
| 🎯 **High-concurrency, read-heavy workloads** | Share read pressure through read replicas | Reduce primary database load by 60-80% |
| 🎯 **Report Analysis** | Route heavy queries to dedicated analysis nodes | Online services will not be affected |
| 🎯 **Multi-tenant system** | Use different database connections for different tenants | Data isolation and performance guarantee |
| 🎯 **Disaster recovery switch** | Automatically switch to the standby database when the primary database fails | Failure recovery time < 5 seconds |

## Runtime requirements

- **monSQLize**: current npm package `monsqlize`
- **Node.js**: ≥ 18.x
- **MongoDB**: ≥ 4.0

## Architecture Overview

```text
┌─────────────────────────────────────────────────────────────┐
│ Your App │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ ConnectionPoolManager (Connection Pool Manager) │
│  ┌────────────────┬───────────────┬─────────────────────┐   │
│  │  PoolSelector  │ HealthChecker │    PoolStats        │   │
│ │ (Select strategy) │ (Health check) │ (Statistics information) │ │
│  └────────────────┴───────────────┴─────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ Connection pool collection │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐              │
│  │ Primary   │  │Secondary-1│  │Secondary-2│  ...         │
│ │ (Primary DB)  │ │(Replica 1)│ │(Replica 2)│ │
│  └───────────┘  └───────────┘  └───────────┘              │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ MongoDB Cluster │
└─────────────────────────────────────────────────────────────┘
```

---

## Quick start

## Installation

```bash
npm install monsqlize
# or
yarn add monsqlize
```

## Get started in 5 minutes

```ts
import MonSQLize from 'monsqlize';

const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'app',
    config: { uri: 'mongodb://primary.example.com:27017' },
    pools: [
        {
            name: 'primary',
            uri: 'mongodb://primary.example.com:27017/app',
            role: 'primary',
            options: { maxPoolSize: 50 },
        },
        {
            name: 'analytics',
            uri: 'mongodb://analytics.example.com:27017/app',
            role: 'analytics',
            tags: ['reporting'],
            options: { maxPoolSize: 10 },
        },
    ],
    poolStrategy: 'auto',
    poolFallback: { enabled: true, fallbackStrategy: 'primary' },
    maxPoolsCount: 5,
});

await msq.connect();

const reports = msq.pool('analytics').collection('reports');
const rows = await reports.find({ status: 'ready' });

console.log(`${rows.length} report rows found`);
```

`connect()` automatically creates and starts the `ConnectionPoolManager` from `pools`. If `pools` is omitted, `msq.pool(name)` throws a `NO_POOL_MANAGER` / `INVALID_CONFIG`-class error. If the requested pool does not exist, it throws `POOL_NOT_FOUND` with the available pool names.

### Advanced low-level manager API

Most applications should configure pools in the `MonSQLize` constructor and access them through `msq.pool(name)`. Use `ConnectionPoolManager` directly only when a framework or platform layer needs to register, remove, or select pools outside a `MonSQLize` instance lifecycle.

The low-level manager reference and examples are later on this page.

---

## Core concepts

## Connection pool role

The connection pool role defines the purpose and behavior of the connection pool.

| Role | Purpose | Recommended usage scenarios | Examples |
|------|------|------------|------|
| **primary** | Main database, handles write operations and important read operations | All write operations, strong consistency reads | Order creation, user registration |
| **secondary** | Read replica, handles ordinary read operations | List query, detail query | Product list, user information |
| **analytics** | Analysis node, processing heavy queries | Reports, statistics, aggregate queries | Sales reports, data analysis |
| **custom** | Custom roles | Special business needs | Specific tenants, test environments |

**Role selection logic** (auto strategy):
```text
write → primary
Read operation (read) → secondary (priority) → primary (fallback)
Analytics Query → analytics (manually specified)
```

## Select strategy

The selection strategy determines how requests are distributed among multiple connection pools.

| Strategy | Description | Algorithm | Applicable scenarios |
|------|------|------|---------|
| **auto** | Automatic strategy (recommended) | Select based on operation type and role | Most scenarios |
| **roundRobin** | Polling strategy | Poll each connection pool in turn | Load balancing |
| **weighted** | Weighted polling | Distributed in proportion to weight | Server performance varies greatly |
| **leastConnections** | Least connections | Select the pool with the least number of current connections | Connection number sensitive |
| **manual** | Manually specified | The pool name must be manually specified | Special business logic |

**Strategy Example**:
```javascript
//auto: Automatically select based on operation type
const pool = manager.selectPool('read');  // → secondary

//roundRobin: polling
//The 1st time → pool1, the 2nd time → pool2, the 3rd time → pool3, the 4th time → pool1...

//weighted: weight 1:3
// pool1(weight=1): 25%
// pool2(weight=3): 75%

//leastConnections: current number of connections
//pool1: 10 connections → unchecked
//pool2: 5 connections → Select ✅

//manual: manually specified
const pool = manager.selectPool('read', { pool: 'analytics' });
```

## Health Check

The health check regularly detects whether the connection pool is available and automatically marks the faulty pool.

**Health Status**:

| Status | Description | Behavior | Recovery Method |
|------|------|------|---------|
| **up** | Health | Normal use | - |
| **degraded** | Consecutive failures below the down threshold | Still selectable, but should be monitored | Restores to `up` after a successful health check or becomes `down` after the retry threshold |
| **down** | Failure | Not in use, waiting for recovery | Automatic recovery after successful health check |

**Checking mechanism**:
1. Use the `db.admin().ping()` command
2. Set timeout (default 3000ms)
3. A failed check first marks the pool as degraded
4. Continuous failures reach the retry threshold (default 3 times) → marked as down
5. Down status will still continue to be checked
6. Success once → immediately restore to up

## Failover

When the connection pool fails, it automatically switches to other healthy connection pools.

**Downgrade Strategy**:

| Strategy | Behavior | Applicable Scenarios |
|------|------|---------|
| **error** | Throw an error | Strict mode, no downgrade allowed |
| **readonly** | Only read operations are allowed | Read-only is allowed when the main database fails |
| **secondary** | Use secondary | Prefer a read replica |

**Failover Process**:
```text
Request → Select Connection Pool
  ↓
Check health status
├─ up → use ✅
└─ down → failover
      ↓
Choose a different health pool
├─ Find → Use ✅
└─ Not found → Downgrade strategy
├─ error → throw error ❌
├─ readonly → read-only mode ⚠️
└─ secondary → Use replica ✅
```

---

## API detailed documentation

## ConnectionPoolManager

The connection pool manager is the core class of the multi-connection pool function.

### Constructor

Create a new connection pool manager instance.

**Syntax**:
```typescript
new ConnectionPoolManager(options?: ManagerOptions)
```

**Parameters**:

| Parameters | Type | Required | Default | Description |
|------|------|------|--------|------|
| options | object | no | {} | manager configuration |
| options.maxPoolsCount | number | No | 10 | Maximum number of connection pools (1-100) |
| options.poolStrategy | string | no | 'auto' | select strategy |
| options.poolFallback | object | no | - | failover configuration |
| options.logger | object | no | none (silent) | optional log object; no logs are emitted when omitted |

**Example**:
```javascript
const manager = new ConnectionPoolManager({
    maxPoolsCount: 10,
    poolStrategy: 'auto',
    poolFallback: {
        enabled: true,
        fallbackStrategy: 'readonly',
        retryDelay: 1000,
        maxRetries: 3
    },
    logger: console
});
```

### addPool()

Add a new connection pool.

**Syntax**:
```typescript
async addPool(config: PoolConfig): Promise<void>
```

**Parameters**:

| Parameters | Type | Required | Default | Description |
|------|------|------|--------|------|
| config.name | string | ✅ Yes | - | Connection pool unique name |
| config.uri | string | ✅ Yes | - | MongoDB connection string |
| config.role | string | no | undefined | role: primary/secondary/analytics |
| config.weight | number | no | 1 | weight (1-100) |
| config.tags | string[] | no | [] | tag array |
| config.options | object | no | {} | MongoDB connection options |
| config.healthCheck | object | no | - | health check configuration |

**return value**:
- `Promise<void>`: resolve on success, reject on failure

**Error thrown**:
- `Error: Pool '${name}' already exists` - Duplicate connection pool name
- `Error: Maximum pool count (${max}) reached` - Connection pool limit reached
- `MongoServerError` - MongoDB connection failed

**Example**:

```javascript
//Basic example
await manager.addPool({
    name: 'primary',
    uri: 'mongodb://localhost:27017/mydb',
    role: 'primary'
});

//Complete example
await manager.addPool({
    name: 'secondary-1',
    uri: 'mongodb://replica1.example.com:27017/mydb',
    role: 'secondary',
    weight: 2,
    tags: ['replica', 'read-only', 'production'],
    options: {
        maxPoolSize: 50,
        minPoolSize: 10,
        maxIdleTimeMS: 30000,
        waitQueueTimeoutMS: 10000,
        connectTimeoutMS: 5000,
        serverSelectionTimeoutMS: 5000
    },
    healthCheck: {
        enabled: true,
        interval: 5000,
        timeout: 3000,
        retries: 3
    }
});
```

**Note**:
1. ⚠️ The connection pool name must be unique
2. ⚠️ Will immediately try to connect to MongoDB when added
3. ✅ If the health check is enabled, the new pool will automatically start checking
4. ✅ It is recommended to add all connection pools when the application starts

### removePool()

Remove an existing connection pool.

**Syntax**:
```typescript
async removePool(name: string): Promise<void>
```

**Parameters**:

| Parameters | Type | Required | Description |
|------|------|------|------|
| name | string | ✅ Yes | Connection pool name |

**return value**:
- `Promise<void>`: resolve successfully

**Error thrown**:
- `Error: Pool '${name}' not found` - The connection pool does not exist

**Example**:
```javascript
//Remove the specified connection pool
await manager.removePool('secondary-1');

//With error handling
try {
    await manager.removePool('non-existent');
} catch (error) {
    if (error.message.includes('not found')) {
        console.log('The connection pool does not exist');
    }
}
```

**Note**:
1. ✅ MongoDB connection will be automatically closed
2. ✅ Will automatically stop the health check of the pool
3. ✅ Relevant statistical information will be cleared
4. ⚠️ After removal, the connection pool can no longer be used.

### selectPool()

Choose an appropriate connection pool based on your strategy.

**Syntax**:
```typescript
selectPool(operation: string, options?: SelectOptions): PoolResult
```

**Parameters**:

| Parameters | Type | Required | Description |
|------|------|------|------|
| operation | string | ✅ Yes | Operation type: 'read' / 'write' |
| options | object | no | select options |
| options.pool | string | No | Manually specify pool name |
| options.poolPreference | object | no | connection pool preference |
| options.poolPreference.role | string | no | priority role |
| options.poolPreference.tags | string[] | no | preference tags |

**return value**:
```typescript
{
    name: string,              //Connection pool name
    client: MongoClient,       //MongoDB client
    db: Db,                    //database object
    collection: (name) => Collection  //collection accessor
}
```

**Error thrown**:
- `Error: Pool '${name}' not found` - The specified connection pool does not exist
- `Error: No available connection pool` - No connection pool available

**Example**:
```javascript
//Automatic selection (read → secondary)
const pool = manager.selectPool('read');

//Automatic selection (write → primary)
const writePool = manager.selectPool('write');

//Manually specify
const specificPool = manager.selectPool('read', {
    pool: 'secondary-1'
});

//Based on role preference
const analyticsPool = manager.selectPool('read', {
    poolPreference: { role: 'analytics' }
});

//According to label preference
const taggedPool = manager.selectPool('read', {
    poolPreference: { tags: ['production'] }
});

//Use the returned connection pool
const users = await pool.collection('users').find({}).toArray();
const db = pool.db;
const client = pool.client;
```

**Note**:
1. ✅ Automatically select to use only healthy (up) connection pools
2. ✅ If all pools fail, the downgrade strategy will be triggered
3. ⚠️ manual strategy must manually specify the pool parameter

### getPoolNames()

Get the names of all connection pools.

**Syntax**:
```typescript
getPoolNames(): string[]
```

**return value**:
- `string[]`: array of connection pool names

**Example**:
```javascript
const names = manager.getPoolNames();
console.log(names);  // ['primary', 'secondary-1', 'secondary-2']

//Check if the connection pool exists
if (names.includes('analytics')) {
    console.log('Analysis node is configured');
}

//Count the number of connection pools
console.log(`There are currently ${names.length} connection pools`);
```

### getPoolStats()

Get statistics for all connection pools.

**Syntax**:
```typescript
getPoolStats(): Record<string, PoolStats>
```

**return value**:
```typescript
{
    [poolName: string]: {
        status: 'up' | 'degraded' | 'down' | 'unknown',
        connections: number,       //Current number of connections
        available: number,         //Number of available connections
        waiting: number,           //Number of waiting connections
        avgResponseTime: number,   //Average response time (ms)
        totalRequests: number,     //Total requests
        errorRate: number          //Error rate (0-1)
    }
}
```

**Example**:
```javascript
const stats = manager.getPoolStats();

//Print all statistics
console.log(stats);
// {
//   'primary': { status: 'up', connections: 45, ... },
//   'secondary-1': { status: 'up', connections: 78, ... }
// }

//Analyze a single pool
const primaryStats = stats['primary'];
console.log(`Number of primary database connections: ${primaryStats.connections}`);
console.log(`Average response time: ${primaryStats.avgResponseTime}ms`);
console.log(`Error rate: ${(primaryStats.errorRate * 100).toFixed(2)}%`);

//Find the busiest pool
const entries = Object.entries(stats);
const busiest = entries.sort((a, b) =>
    b[1].totalRequests - a[1].totalRequests
)[0];
console.log(`Busiest pool: ${busiest[0]} (${busiest[1].totalRequests} requests)`);

//Monitor alarms
for (const [name, stat] of entries) {
    if (stat.errorRate > 0.05) {  //Error rate > 5%
        console.warn(`⚠️ ${name} error rate is too high: ${(stat.errorRate * 100).toFixed(2)}%`);
    }
    if (stat.avgResponseTime > 100) {  //Response time > 100ms
        console.warn(`⚠️ ${name} slow response: ${stat.avgResponseTime}ms`);
    }
}
```

### getPoolHealth()

Get the health status of all connection pools.

**Syntax**:
```typescript
getPoolHealth(): Map<string, HealthStatus>
```

**return value**:
```typescript
Map<string, {
    status: 'up' | 'down' | 'degraded',
    consecutiveFailures: number,   //Number of consecutive failures
    lastCheckTime: Date | null,    //Last check time
    lastError: Error | null,       //last error message
    uptime: number                 //Uptime ratio
}>
```

**Example**:
```javascript
const health = manager.getPoolHealth();

//Print all health status
for (const [name, status] of health.entries()) {
    console.log(`${name}: ${status.status}`);
}

//Check if there is a fault pool
const downPools = [];
for (const [name, status] of health.entries()) {
    if (status.status === 'down') {
        downPools.push(name);
    }
}

if (downPools.length > 0) {
    console.error(`⚠️ Fault pool: ${downPools.join(', ')}`);
}

//Detailed health report
for (const [name, status] of health.entries()) {
    const lastCheckTime = status.lastCheckTime?.toISOString() ?? 'not checked yet';
    console.log(`
Pool name: ${name}
Status: ${status.status}
Consecutive failures: ${status.consecutiveFailures}
Last check: ${lastCheckTime}
    `.trim());
}
```

### startHealthCheck()

Start health check.

**Syntax**:
```typescript
startHealthCheck(): void
```

**Example**:
```javascript
//Start health check (effective for all pools with health check enabled)
manager.startHealthCheck();

//Repeated calls will not start again
manager.startHealthCheck();  //No impact
```

**Note**:
1. ✅ Only effective for pools configured with `healthCheck.enabled: true`
2. ✅ Repeated calls will not start again.
3. ✅ It is recommended to start after adding all connection pools

### stopHealthCheck()

Stop health check.

**Syntax**:
```typescript
stopHealthCheck(): void
```

**Example**:
```javascript
//Stop health check
manager.stopHealthCheck();
```

### close()

Close the manager and release all resources.

**Syntax**:
```typescript
async close(): Promise<void>
```

**Example**:
```javascript
//Close manager
await manager.close();

//With error handling
try {
    await manager.close();
    console.log('The connection pool manager is closed');
} catch (error) {
    console.error('Close failed:', error);
}

//Clean up on app exit
process.on('SIGTERM', async () => {
    await manager.close();
    process.exit(0);
});
```

**BEHAVIOR**:
1. ✅ Stop all health checks
2. ✅ Close all MongoDB connections
3. ✅ Clear all connection pools and configurations
4. ✅ Tag Manager is closed

**Note**:
- ⚠️ The manager can no longer be used after closing it
- ⚠️ Make sure all operations are completed before closing
- ✅ It is recommended to call when the application exits

---

## Return value structure

### PoolResult (selectPool return value)

```typescript
interface PoolResult {
    //Connection pool name
    name: string;

    //MongoDB native client
    client: MongoClient;

    //Database object (correct database selected)
    db: Db;

    //Collection accessor
    collection: (collectionName: string) => Collection;
}
```

**Usage Example**:
```javascript
const pool = manager.selectPool('read');

//Method 1: Use collection accessor (recommended)
const users = await pool.collection('users').find({}).toArray();

//Method 2: Use db object
const orders = await pool.db.collection('orders').find({}).toArray();

//Method 3: Use native client
const client = pool.client;
const adminDb = client.db('admin');
await adminDb.admin().ping();
```

---

## Configuration details

## Manager configuration

```typescript
interface ManagerOptions {
    //Maximum number of connection pools
    maxPoolsCount?: number;        //Default: 10, Range: 1-100

    //Choose a strategy
    poolStrategy?: 'auto' | 'roundRobin' | 'weighted' | 'leastConnections' | 'manual';
    //Default: 'auto'

    //Failover configuration
    poolFallback?: {
        enabled?: boolean;         //Default: true
        fallbackStrategy?: 'error' | 'readonly' | 'secondary';
        //Default: 'readonly'
        retryDelay?: number;       //Default: 1000 (milliseconds)
        maxRetries?: number;       //Default: 3
    };

    //log object
    logger?: {
        info: (message: string, meta?: any) => void;
        warn: (message: string, meta?: any) => void;
        error: (message: string, meta?: any) => void;
    };
}
```

## Connection pool configuration

```typescript
interface PoolConfig {
    //=== Required parameters ===
    name: string;                    //unique name
    uri: string;                     //MongoDB connection string

    //=== Optional parameters ===
    role?: 'primary' | 'secondary' | 'analytics' | 'custom';
    weight?: number;                 //Weight (1-100)
    tags?: string[];                 //tag array

    //=== MongoDB connection options ===
    options?: {
        maxPoolSize?: number;        //Default: 100
        minPoolSize?: number;        //Default: 10
        maxIdleTimeMS?: number;      //Default: 30000
        waitQueueTimeoutMS?: number; //Default: 10000
        connectTimeoutMS?: number;   //Default: 5000
        serverSelectionTimeoutMS?: number; //Default: 5000
    };

    //=== Health check configuration ===
    healthCheck?: {
        enabled?: boolean;           //Default: false
        interval?: number;           //Default: 5000 (milliseconds)
        timeout?: number;            //Default: 3000 (milliseconds)
        retries?: number;            //Default: 3
    };
}
```

## Health check configuration

| Parameters | Type | Default value | Description | Recommended values |
|------|------|--------|------|--------|
| enabled | boolean | false | Whether to enable | true (production environment) |
| interval | number | 5000 | Check interval (milliseconds) | 5000-10000 |
| timeout | number | 3000 | Check timeout (milliseconds) | 3000-5000 |
| retries | number | 3 | Number of failed retries | 3-5 |

**Configuration suggestions**:
```javascript
//Production environment (recommended)
healthCheck: {
    enabled: true,
    interval: 5000,   //Check every 5 seconds
    timeout: 3000,    //3 seconds timeout
    retries: 3        //Failure 3 times is marked as down.
}

//High availability scenario (check more frequently)
healthCheck: {
    enabled: true,
    interval: 2000,   //Check every 2 seconds
    timeout: 2000,    //2 seconds timeout
    retries: 2        //Switch immediately after 2 failures
}

//Low load scenario (reduce check frequency)
healthCheck: {
    enabled: true,
    interval: 10000,  //Check every 10 seconds
    timeout: 5000,    //5 seconds timeout
    retries: 5        //More forgiving retries
}
```

## Failover configuration

| Parameters | Type | Default value | Description |
|------|------|--------|------|
| enabled | boolean | true | Whether to enable failover |
| fallbackStrategy | string | 'readonly' | fallback strategy |
| retryDelay | number | 1000 | Retry delay (milliseconds) |
| maxRetries | number | 3 | Maximum number of retries |

**Downgrade strategy comparison**:

| Strategy | Behavior | Advantages | Disadvantages | Applicable scenarios |
|------|------|------|------|---------|
| error | throw error | strict, no downgrade | service unavailable | strict consistency requirements |
| readonly | read-only mode | guaranteed read service | write operation failed | read more and write less |
| secondary | use replicas | full downgrade | possible data delays | high availability first |

## Configuration example

### Small applications (<1000 QPS)

```javascript
const manager = new ConnectionPoolManager({
    maxPoolsCount: 5,
    poolStrategy: 'auto'
});

await manager.addPool({
    name: 'primary',
    uri: 'mongodb://localhost:27017/mydb',
    role: 'primary',
    options: {
        maxPoolSize: 50,
        minPoolSize: 5
    }
});

await manager.addPool({
    name: 'secondary',
    uri: 'mongodb://localhost:27018/mydb',
    role: 'secondary',
    options: {
        maxPoolSize: 100,
        minPoolSize: 10
    }
});
```

### Medium application (1000-10000 QPS)

```javascript
const manager = new ConnectionPoolManager({
    maxPoolsCount: 10,
    poolStrategy: 'weighted',
    poolFallback: {
        enabled: true,
        fallbackStrategy: 'readonly'
    }
});

// Primary pool
await manager.addPool({
    name: 'primary',
    uri: process.env.MONGO_PRIMARY_URI,
    role: 'primary',
    weight: 1,
    options: {
        maxPoolSize: 100,
        minPoolSize: 20
    },
    healthCheck: {
        enabled: true,
        interval: 5000,
        timeout: 3000,
        retries: 3
    }
});

// 2 read replicas
for (let i = 1; i <= 2; i++) {
    await manager.addPool({
        name: `secondary-${i}`,
        uri: process.env[`MONGO_SECONDARY_${i}_URI`],
        role: 'secondary',
        weight: 2,
        options: {
            maxPoolSize: 200,
            minPoolSize: 50
        },
        healthCheck: {
            enabled: true,
            interval: 5000
        }
    });
}
```

### Large applications (>10000 QPS)

```javascript
const manager = new ConnectionPoolManager({
    maxPoolsCount: 20,
    poolStrategy: 'leastConnections',
    poolFallback: {
        enabled: true,
        fallbackStrategy: 'secondary',
        retryDelay: 500,
        maxRetries: 5
    },
    logger: customLogger
});

// Primary pools (dual-primary topology)
await manager.addPool({
    name: 'primary-1',
    uri: process.env.MONGO_PRIMARY_1_URI,
    role: 'primary',
    weight: 1,
    options: {
        maxPoolSize: 200,
        minPoolSize: 50,
        maxIdleTimeMS: 60000,
        waitQueueTimeoutMS: 5000
    },
    healthCheck: {
        enabled: true,
        interval: 2000,
        timeout: 2000,
        retries: 2
    }
});

await manager.addPool({
    name: 'primary-2',
    uri: process.env.MONGO_PRIMARY_2_URI,
    role: 'primary',
    weight: 1,
    options: { maxPoolSize: 200, minPoolSize: 50 },
    healthCheck: { enabled: true, interval: 2000 }
});

// 4 read replicas
for (let i = 1; i <= 4; i++) {
    await manager.addPool({
        name: `secondary-${i}`,
        uri: process.env[`MONGO_SECONDARY_${i}_URI`],
        role: 'secondary',
        weight: 3,
        options: {
            maxPoolSize: 500,
            minPoolSize: 100
        },
        healthCheck: {
            enabled: true,
            interval: 3000
        }
    });
}

//2 analysis nodes
for (let i = 1; i <= 2; i++) {
    await manager.addPool({
        name: `analytics-${i}`,
        uri: process.env[`MONGO_ANALYTICS_${i}_URI`],
        role: 'analytics',
        tags: ['heavy-query', 'report'],
        options: {
            maxPoolSize: 100,
            minPoolSize: 10
        },
        healthCheck: {
            enabled: true,
            interval: 10000
        }
    });
}
```

---

## Usage scenarios

## Read and write separation

**Scenario**: Read operations account for 80%, write operations account for 20%

**Plan**:
```javascript
// 1 primary + 2 replicas
await manager.addPool({ name: 'primary', role: 'primary', ... });
await manager.addPool({ name: 'sec-1', role: 'secondary', ... });
await manager.addPool({ name: 'sec-2', role: 'secondary', ... });

// Write operations automatically use the primary pool
const writePool = manager.selectPool('write');
await writePool.collection('orders').insertOne({...});

// Read operations automatically use replicas
const readPool = manager.selectPool('read');
const orders = await readPool.collection('orders').find({}).toArray();
```

**Benefit**:
- ✅ Write pressure on the primary stays unchanged
- ✅ Read pressure is distributed to 2 replicas
- ✅ Primary load is reduced by ~80%

## Load balancing

**Scenario**: Multiple replicas have different performance

**Plan**:
```javascript
//Use a weighted strategy
const manager = new ConnectionPoolManager({
    poolStrategy: 'weighted'
});

//High-performance servers have high weights
await manager.addPool({
    name: 'high-perf',
    role: 'secondary',
    weight: 5  //83% traffic
});

//Ordinary servers have low weight
await manager.addPool({
    name: 'normal',
    role: 'secondary',
    weight: 1  //17% traffic
});
```

## Report analysis

**Scenario**: Generate reports regularly without affecting online services

**Plan**:
```javascript
//Dedicated analysis node
await manager.addPool({
    name: 'analytics',
    uri: 'mongodb://analytics.example.com:27017/mydb',
    role: 'analytics',
    tags: ['report', 'heavy-query']
});

//Report query uses analysis node
const analyticsPool = manager.selectPool('read', {
    poolPreference: { role: 'analytics' }
});

const salesReport = await analyticsPool.collection('orders').aggregate([
    { $match: { date: { $gte: startDate, $lte: endDate } } },
    { $group: { _id: '$category', totalSales: { $sum: '$amount' } } },
    { $sort: { totalSales: -1 } }
]).toArray();
```

## Multi-tenant system

**Scenario**: Use different connection pools for different tenants

**Plan**:
```javascript
//Tenant A (VIP)
await manager.addPool({
    name: 'tenant-a',
    uri: 'mongodb://db-a.example.com:27017/tenant_a',
    tags: ['vip', 'tenant-a'],
    options: {
        maxPoolSize: 200  //Larger connection pool
    }
});

//Tenant B (ordinary)
await manager.addPool({
    name: 'tenant-b',
    uri: 'mongodb://db-b.example.com:27017/tenant_b',
    tags: ['normal', 'tenant-b'],
    options: {
        maxPoolSize: 50
    }
});

//Based on tenant selection
const tenantId = req.user.tenantId;
const pool = manager.selectPool('read', {
    pool: `tenant-${tenantId}`
});
```

## Disaster recovery switch

**Scenario**: Automatically switch to the standby database when the main database fails

**Plan**:
```javascript
//Enable failover
const manager = new ConnectionPoolManager({
    poolFallback: {
        enabled: true,
        fallbackStrategy: 'secondary',  //Use replicas when the main database fails
        maxRetries: 3
    }
});

// Primary pool
await manager.addPool({
    name: 'primary',
    role: 'primary',
    healthCheck: {
        enabled: true,
        interval: 2000,  //Quickly detect faults
        retries: 2
    }
});

//Standby database (writable)
await manager.addPool({
    name: 'standby',
    role: 'primary',  //Also configured as primary role
    healthCheck: { enabled: true, interval: 2000 }
});

manager.startHealthCheck();

//Automatically switches to the standby database when the primary database fails
const pool = manager.selectPool('write');  //Automatically select healthy primary
```

---

## Best Practices

## Connection pool planning

### Recommended number of connection pools

| Application scale | QPS | Recommended number of connection pools | Configuration |
|---------|-----|------------|------|
| Small | <1K | 2-3 | 1 primary + 1-2 replicas |
| Medium | 1K-10K | 4-8 | 1-2 primary pools + 3-6 replicas |
| Large | >10K | 8-20 | 2-4 primary + 6-16 replicas |

### maxPoolSize suggestion

```javascript
//Formula: maxPoolSize = expected number of concurrencies × 1.2
//Example: 1000 concurrency → maxPoolSize = 1200

//small application
options: {
    maxPoolSize: 50,
    minPoolSize: 5
}

//Medium application
options: {
    maxPoolSize: 200,
    minPoolSize: 20
}

//Large application
options: {
    maxPoolSize: 500,
    minPoolSize: 50
}
```

## Performance optimization

### 1. Set weights appropriately

```javascript
//Set weight based on server performance
//Servers with powerful CPUs have high weights
await manager.addPool({
    name: 'high-cpu',
    weight: 5,
    options: { maxPoolSize: 500 }
});

//Ordinary servers have low weight
await manager.addPool({
    name: 'normal',
    weight: 1,
    options: { maxPoolSize: 100 }
});
```

### 2. Reduce connection pool switching

```javascript
//Use the leastConnections strategy to reduce switching
const manager = new ConnectionPoolManager({
    poolStrategy: 'leastConnections'
});
```

### 3. Optimize health check

```javascript
//Production environment: 5 seconds is enough
healthCheck: {
    interval: 5000,
    timeout: 3000
}

//Not too often to avoid extra expenses
//❌ Not recommended
healthCheck: {
    interval: 500  //too often
}
```

## Monitoring and Alerting

### Regular monitoring

```javascript
//Check every minute
setInterval(() => {
    const stats = manager.getPoolStats();
    const health = manager.getPoolHealth();

    //Send to monitoring system
    sendToMonitoring({
        timestamp: Date.now(),
        stats,
        health: Array.from(health.entries())
    });
}, 60000);
```

### Alarm rules

```javascript
function checkAlerts() {
    const stats = manager.getPoolStats();
    const health = manager.getPoolHealth();

    //1. Check the fault pool
    for (const [name, status] of health.entries()) {
        if (status.status === 'down') {
            sendAlert({
                level: 'critical',
                message: `Connection pool ${name} failure`,
                details: status
            });
        }
    }

    //2. Check the error rate
    for (const [name, stat] of Object.entries(stats)) {
        if (stat.errorRate > 0.05) {  // >5%
            sendAlert({
                level: 'warning',
                message: `Connection pool ${name} error rate is too high`,
                errorRate: `${(stat.errorRate * 100).toFixed(2)}%`
            });
        }
    }

    //3. Check response time
    for (const [name, stat] of Object.entries(stats)) {
        if (stat.avgResponseTime > 100) {  // >100ms
            sendAlert({
                level: 'warning',
                message: `Connection pool ${name} responds slowly`,
                avgResponseTime: `${stat.avgResponseTime}ms`
            });
        }
    }

    //4. Check the number of connections
    for (const [name, stat] of Object.entries(stats)) {
        const usage = stat.connections / stat.maxPoolSize;
        if (usage > 0.9) {  // >90%
            sendAlert({
                level: 'warning',
                message: `Connection pool ${name} is nearly full`,
                usage: `${(usage * 100).toFixed(1)}%`
            });
        }
    }
}

//Check every 30 seconds
setInterval(checkAlerts, 30000);
```

## Production environment configuration

### Complete production environment example

```javascript
import MonSQLize from 'monsqlize';

const logger = {
    info: (message, meta) => console.info(message, meta ?? ''),
    warn: (message, meta) => console.warn(message, meta ?? ''),
    error: (message, meta) => console.error(message, meta ?? ''),
};

const pools = JSON.parse(process.env.MONGO_POOLS ?? '[]');

const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: process.env.MONGO_DATABASE ?? 'mydb',
    config: {
        uri: process.env.MONGO_URI ?? 'mongodb://primary.example.com:27017/mydb',
    },
    pools: pools.map((pool) => ({
        healthCheck: {
            enabled: true,
            interval: 5000,
            timeout: 3000,
            retries: 3,
        },
        ...pool,
    })),
    poolStrategy: 'leastConnections',
    poolFallback: {
        enabled: true,
        fallbackStrategy: 'secondary',
        retryDelay: 500,
        maxRetries: 5,
    },
    maxPoolsCount: 20,
    logger,
});

async function start() {
    await msq.connect();
    logger.info(`monSQLize connected with ${pools.length} configured pools`);
}

async function gracefulShutdown() {
    logger.info('Closing monSQLize...');
    await msq.close();
    logger.info('monSQLize closed');
    process.exit(0);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

start().catch((error) => {
    logger.error('Initialization failed:', error);
    process.exit(1);
});
```

### Environment variable configuration

```ini
MONGO_POOLS=[
  {
    "name": "primary",
    "uri": "mongodb://user:pass@primary.example.com:27017/mydb?replicaSet=rs0",
    "role": "primary",
    "weight": 1,
    "options": {
      "maxPoolSize": 200,
      "minPoolSize": 50
    }
  },
  {
    "name": "secondary-1",
    "uri": "mongodb://user:pass@replica1.example.com:27017/mydb?replicaSet=rs0",
    "role": "secondary",
    "weight": 2,
    "options": {
      "maxPoolSize": 500,
      "minPoolSize": 100
    }
  },
  {
    "name": "secondary-2",
    "uri": "mongodb://user:pass@replica2.example.com:27017/mydb?replicaSet=rs0",
    "role": "secondary",
    "weight": 2,
    "options": {
      "maxPoolSize": 500,
      "minPoolSize": 100
    }
  }
]
```

---

## Troubleshooting

## FAQ

### Problem 1: The connection pool cannot be added

**Phenomena**:
```javascript
await manager.addPool({...});
// Error: Maximum pool count (10) reached
```

**Cause**: Maximum connection pool limit reached

**Solution**:
```javascript
//Increase maxPoolsCount
const manager = new ConnectionPoolManager({
    maxPoolsCount: 20  //increase to 20
});
```

### Issue 2: Health check not working

**Phenomenon**: The connection pool fails but the status is still up

**Cause**: Health check is not started or not configured

**Solution**:
```javascript
//1. Configure health checks
await manager.addPool({
    name: 'primary',
    uri: '...',
    healthCheck: {
        enabled: true  //Must be enabled
    }
});

//2. Start health check
manager.startHealthCheck();  //Must be called
```

### Problem 3: selectPool throws an error

**Phenomena**:
```javascript
const pool = manager.selectPool('read');
// Error: No available connection pool
```

**Cause**: All connection pools are faulty or no connection pool is added

**Solution**:
```javascript
//1. Check health status
const health = manager.getPoolHealth();
console.log(Array.from(health.entries()));

//2. Enable failover
const manager = new ConnectionPoolManager({
    poolFallback: {
        enabled: true,
        fallbackStrategy: 'secondary'
    }
});

//3. Make sure at least one connection pool is added
const names = manager.getPoolNames();
console.log(`Current connection pool number: ${names.length}`);
```

### Problem 4: High error rate

**Phenomena**: getPoolStats() displays errorRate > 0.1

**Reason**:
- The network is unstable
- MongoDB load is too high
- Query timeout

**Solution**:
```javascript
//1. Increase the timeout period
await manager.addPool({
    name: 'primary',
    uri: '...',
    options: {
        connectTimeoutMS: 10000,        //10 seconds
        serverSelectionTimeoutMS: 10000 //10 seconds
    }
});

//2. Check MongoDB load
const pool = manager.selectPool('read');
const serverStatus = await pool.db.admin().serverStatus();
console.log('MongoDB load:', serverStatus);

//3. Increase the connection pool size
options: {
    maxPoolSize: 500  //increase
}
```

## Error code

| Error message | Cause | Solution |
|---------|------|---------|
| `Pool '${name}' already exists` | Duplicate connection pool name | Use unique name |
| `Pool '${name}' not found` | Connection pool does not exist | Check name spelling |
| `Maximum pool count (${max}) reached` | Quantity limit reached | Increase maxPoolsCount |
| `No available connection pool` | No connection pool available | Check health status or add a connection pool |
| `MongoServerError` | MongoDB connection failed | Check URI, network, authentication |

## Debugging Tips

### Enable detailed logging

```javascript
const manager = new ConnectionPoolManager({
    logger: {
        info: (msg, meta) => console.log('[INFO]', msg, meta),
        warn: (msg, meta) => console.warn('[WARN]', msg, meta),
        error: (msg, meta) => console.error('[ERROR]', msg, meta)
    }
});
```

### Periodically print status

```javascript
setInterval(() => {
    console.log('=== Connection pool status ===');

    const names = manager.getPoolNames();
    console.log(`Number of connection pools: ${names.length}`);
    console.log(`Connection pool list: ${names.join(', ')}`);

    const stats = manager.getPoolStats();
    console.table(stats);

    const health = manager.getPoolHealth();
    console.log('\nHealth status:');
    for (const [name, status] of health.entries()) {
        console.log(`${name}: ${status.status} (Failures: ${status.consecutiveFailures})`);
    }

    console.log('==================\n');
}, 10000);  //every 10 seconds
```

### Catch all errors

```javascript
process.on('unhandledRejection', (error) => {
    console.error('Unhandled Promise error:', error);
});

try {
    const pool = manager.selectPool('read');
    const data = await pool.collection('test').find({}).toArray();
} catch (error) {
    console.error('Query failed:', {
        name: error.name,
        message: error.message,
        stack: error.stack
    });
}
```

---

## Complete low-level manager example

## Basic example

```javascript
import { ConnectionPoolManager } from 'monsqlize';

async function basicExample() {
    const manager = new ConnectionPoolManager();

    // Add a primary pool and a read replica
    await manager.addPool({
        name: 'primary',
        uri: 'mongodb://localhost:27017/mydb',
        role: 'primary'
    });

    await manager.addPool({
        name: 'secondary',
        uri: 'mongodb://localhost:27018/mydb',
        role: 'secondary'
    });

    manager.startHealthCheck();

    // Write operation
    const writePool = manager.selectPool('write');
    await writePool.collection('users').insertOne({
        name: 'Alice',
        email: 'alice@example.com'
    });

    // Read operation
    const readPool = manager.selectPool('read');
    const users = await readPool.collection('users').find({}).toArray();
    console.log(`Number of users: ${users.length}`);

    await manager.close();
}

basicExample().catch(console.error);
```

## Advanced examples

```javascript
import { ConnectionPoolManager } from 'monsqlize';

async function advancedExample() {
    // Create manager with full configuration
    const manager = new ConnectionPoolManager({
        maxPoolsCount: 10,
        poolStrategy: 'weighted',
        poolFallback: {
            enabled: true,
            fallbackStrategy: 'secondary',
            retryDelay: 1000,
            maxRetries: 3
        },
        logger: console
    });

    // Add primary pools (dual-primary topology)
    for (let i = 1; i <= 2; i++) {
        await manager.addPool({
            name: `primary-${i}`,
            uri: `mongodb://primary${i}.example.com:27017/mydb`,
            role: 'primary',
            weight: 1,
            options: {
                maxPoolSize: 100,
                minPoolSize: 20
            },
            healthCheck: {
                enabled: true,
                interval: 5000,
                timeout: 3000,
                retries: 3
            }
        });
    }

    // Add read replicas (4)
    for (let i = 1; i <= 4; i++) {
        await manager.addPool({
            name: `secondary-${i}`,
            uri: `mongodb://replica${i}.example.com:27017/mydb`,
            role: 'secondary',
            weight: 2,
            tags: ['read-only', 'replica'],
            options: {
                maxPoolSize: 200,
                minPoolSize: 50
            },
            healthCheck: {
                enabled: true,
                interval: 5000
            }
        });
    }

    //Add analysis node
    await manager.addPool({
        name: 'analytics',
        uri: 'mongodb://analytics.example.com:27017/mydb',
        role: 'analytics',
        tags: ['heavy-query', 'report'],
        options: {
            maxPoolSize: 50,
            minPoolSize: 10
        }
    });

    manager.startHealthCheck();

    //monitoring loop
    const monitorInterval = setInterval(() => {
        const stats = manager.getPoolStats();
        const health = manager.getPoolHealth();

        console.log('\n=== Connection pool monitoring ===');
        console.log(`Time: ${new Date().toISOString()}`);

        for (const [name, stat] of Object.entries(stats)) {
            const healthStatus = health.get(name);
            console.log(`\n${name}:`);
            console.log(`Status: ${healthStatus?.status || 'unknown'}`);
            console.log(`Number of connections: ${stat.connections}`);
            console.log(`Average response: ${stat.avgResponseTime}ms`);
            console.log(`Total requests: ${stat.totalRequests}`);
            console.log(`Error rate: ${(stat.errorRate * 100).toFixed(2)}%`);
        }
    }, 60000);  //per minute

    //business logic
    try {
        //write operation
        const writePool = manager.selectPool('write');
        await writePool.collection('orders').insertOne({
            userId: 123,
            amount: 99.99,
            createdAt: new Date()
        });

        //Read operation
        const readPool = manager.selectPool('read');
        const orders = await readPool.collection('orders')
            .find({ userId: 123 })
            .sort({ createdAt: -1 })
            .limit(10)
            .toArray();

        //Analyze query
        const analyticsPool = manager.selectPool('read', {
            poolPreference: { role: 'analytics' }
        });
        const report = await analyticsPool.collection('orders').aggregate([
            {
                $match: {
                    createdAt: {
                        $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
                    }
                }
            },
            {
                $group: {
                    _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
                    totalAmount: { $sum: '$amount' },
                    orderCount: { $sum: 1 }
                }
            },
            { $sort: { _id: 1 } }
        ]).toArray();

        console.log('\nSales report:', report);

    } finally {
        clearInterval(monitorInterval);
        await manager.close();
    }
}

advancedExample().catch(console.error);
```

## Production environment example

See [Production environment configuration](#production-environment-configuration)

---

## Related documents

- [Connection Management](./connection.md)
- [Pool Chain API](./pool-chain-api.md)
- [Health Checks](./multi-pool-health-check.md)
- [Distributed Deployment](./distributed-deployment.md)
- [Error Code Reference](./error-codes.md)
