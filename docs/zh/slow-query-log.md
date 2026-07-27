# 慢查询日志持久化

## 功能概述

### 什么是慢查询日志持久化存储？

慢查询日志持久化会记录超过 `slowQueryMs` 阈值的操作，并让你后续查询聚合后的慢查询统计。当前 MongoDB runtime 默认写入 MongoDB，也可以在本地或自定义场景使用 memory 存储。

### 核心特性

- **简单启用**：通过 `slowQueryLog: true` 和 `slowQueryMs` 开启。
- **聚合记录**：相同 `queryHash`、database、collection、operation 的记录会 upsert 到同一条统计行。
- **批量写入**：默认启用，可配置批量大小、刷新间隔和缓冲上限。
- **自动过期**：MongoDB 存储会在 `lastSeen` 上创建 TTL 索引。
- **查询 API**：通过 `getSlowQueryLogs(filter, options)` 查询慢查询统计。
- **当前存储后端**：`mongodb` 和 `memory`。

### 工作原理

```text
┌─────────────┐
│ 业务查询执行 │
└──────┬──────┘
       │
       ▼
┌─────────────────┐
│ 慢查询检测       │ ← slowQueryMs: 500
│ (withSlowQueryLog)│
└──────┬──────────┘
       │ 如果执行时间 > 500ms
       ▼
┌─────────────────┐
│ 生成queryHash   │ ← SHA256(database+collection+operation+query)
└──────┬──────────┘
       │
       ▼
┌─────────────────┐
│ 添加到批量队列   │ ← BatchQueue (buffer)
└──────┬──────────┘
       │ 达到10条 或 5秒
       ▼
┌─────────────────┐
│ bulkWrite upsert│ ← MongoDB存储
│ 聚合统计行       │
└─────────────────┘
```

---

## 快速开始

### 最简配置（推荐）

```javascript
import MonSQLize from 'monsqlize';

const msq = new MonSQLize({
  type: 'mongodb',
  config: { uri: 'mongodb://localhost:27017/mydb' },
  slowQueryMs: 500,      // 慢查询阈值（毫秒）
  slowQueryLog: true     // ✅ 零配置启用
});

await msq.connect();

// 执行查询（慢查询自动保存）
const users = await msq.find('users', { status: 'active' });

// 查询慢查询日志
const logs = await msq.getSlowQueryLogs(
  { collection: 'users' },
  { sort: { count: -1 }, limit: 10 }
);

console.log('高频慢查询Top10:', logs);

await msq.close();
```

### 自动效果

- 慢查询自动保存到 `admin.slow_query_logs` 集合
- 相似查询按 `queryHash`、database、collection、operation 聚合
- TTL索引自动清理7天前的数据
- 复用业务连接，无额外连接开销

---

## 配置说明

### 全局慢查询配置

#### 基础配置（在初始化时设置）

```javascript
const msq = new MonSQLize({
  type: 'mongodb',
  config: { uri: 'mongodb://localhost:27017/mydb' },
  
  // 全局慢查询阈值（毫秒），默认 500
  slowQueryMs: 1000,

  // 启用持久化；也可以传入 slowQueryLog 配置对象
  slowQueryLog: true
});
```

#### 配置选项详解

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `slowQueryMs` | number | `500` | 全局阈值；用于 slow-query 事件，并在启用 `slowQueryLog` 时作为 `slowQueryLog.filter.minExecutionTimeMs` 的默认值，除非显式配置该字段。 |
| `slowQueryLog` | boolean 或 object | `false` | `true` 表示按默认值启用持久化；对象配置支持 `enabled`、`storage`、`batch`、`filter`、`advanced`。 |
| `slowQueryLog.storage.type` | `'mongodb' \| 'memory'` | MongoDB runtime 默认 `'mongodb'` | 存储后端。当前不支持其他存储名称。 |
| `slowQueryLog.storage.useBusinessConnection` | boolean | `true` | 是否复用主 MongoDB 连接；设为 `false` 时必须提供 `storage.uri`。 |
| `slowQueryLog.storage.database` | string | `'admin'` | MongoDB 存储使用的数据库。 |
| `slowQueryLog.storage.collection` | string | `'slow_query_logs'` | MongoDB 存储使用的集合。 |
| `slowQueryLog.storage.ttl` | number | `604800` | `lastSeen` TTL 索引的过期秒数。 |
| `slowQueryLog.batch.enabled` | boolean | `true` | 是否批量缓冲写入。 |
| `slowQueryLog.filter.*` | object | 空过滤 | 排除 database、collection、operation，或设置 `minExecutionTimeMs`。 |
| `slowQueryLog.advanced.errorHandling` | `'log' \| 'throw' \| 'silent'` | `'log'` | 持久化失败时的处理方式。 |

### 操作级配置

某些操作可以单独配置慢查询阈值：

#### 方式1：通过 options 参数

```javascript
// 为单个查询设置不同的阈值
await collection('products').find(
  { category: 'electronics' },
  { 
    slowQueryMs: 500,  // 该查询阈值500ms
    maxTimeMS: 3000    // MongoDB查询超时
  }
);

// 聚合查询也支持
await collection('orders').aggregate(
  [
    { $match: { status: 'completed' } },
    { $group: { _id: '$userId', total: { $sum: '$amount' } } }
  ],
  {
    slowQueryMs: 2000  // 聚合查询阈值2000ms
  }
);
```

#### 方式2：使用全局配置

```javascript
// 使用全局阈值（不指定slowQueryMs）
const products = await collection('products').find(
  { category: 'electronics' }
);  // 使用全局配置的 slowQueryMs: 1000
```

### 日志格式

#### JSON 格式（默认）

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

#### 文本格式

```text
[2026-01-20 08:30:15] WARN: [SLOW QUERY] find on mydb.products took 1523ms (threshold: 1000ms)
Query: {"category":"electronics"}
Options: {"limit":10}
Documents returned: 10
```

### 日志输出配置

#### 使用自定义Logger

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

#### 监听慢查询事件

```javascript
// 方式1：监听事件
msq.on('slow-query', (info) => {
  console.log('Slow query detected:', {
    operation: info.op,
    collection: info.collection,
    duration: info.durationMs,
    query: info.query
  });
  
  // 发送告警
  if (info.durationMs > 5000) {
    alerting.send({
      type: 'critical',
      message: `Extremely slow query: ${info.durationMs}ms`,
      details: info
    });
  }
});

// 方式2：使用事件监听器
msq.addEventListener('slow-query', handleSlowQuery);
```

### 配置层级

monSQLize 提供三层配置架构，满足不同使用场景：

#### 层级1：零配置（推荐）

```javascript
slowQueryLog: true  // 使用所有默认值
```

**默认配置**：
- `enabled: true` - 启用
- `storage.type: 'mongodb'` - MongoDB runtime 使用 MongoDB 存储
- `storage.useBusinessConnection: true` - 复用业务连接
- `storage.database: 'admin'` - 存储到 admin 数据库
- `storage.collection: 'slow_query_logs'` - 集合名
- `storage.ttl: 604800` - 7 天过期
- `batch.enabled: true` - 启用批量写入
- `batch.size: 10` - 批量大小
- `batch.interval: 5000` - 5秒刷新

#### 层级2：基础配置（常用）

```javascript
slowQueryLog: {
  enabled: true,
  storage: {
    ttl: 3 * 24 * 3600  // 只修改 TTL 为 3 天
  }
}
```

#### 层级3：完整配置（高级）

```javascript
slowQueryLog: {
  enabled: true,
  
  // 存储配置
  storage: {
    type: 'mongodb',                    // 存储类型
    useBusinessConnection: false,        // 不复用连接
    uri: 'mongodb://admin-host:27017',  // 独立连接URI
    database: 'admin',
    collection: 'slow_query_logs',
    ttl: 7 * 24 * 3600
  },
  
  // 批量配置
  batch: {
    enabled: true,
    size: 20,                           // 20条刷新
    interval: 3000,                     // 3秒刷新
    maxBufferSize: 100                  // 最大缓冲100条
  },
  
  // 过滤配置
  filter: {
    excludeDatabases: [],               // 排除数据库
    excludeCollections: ['logs'],       // 排除集合
    excludeOperations: [],              // 排除操作
    minExecutionTimeMs: 0               // 最小执行时间
  }
}
```

### 配置参数详解

#### storage 存储配置

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `type` | `'mongodb' \| 'memory'` | `'mongodb'` | 存储后端。其他值会被配置校验拒绝。 |
| `useBusinessConnection` | boolean | true | 是否复用业务连接 |
| `uri` | string | null | 独立连接URI（useBusinessConnection=false时必填） |
| `database` | string | 'admin' | 存储数据库 |
| `collection` | string | 'slow_query_logs' | 存储集合 |
| `ttl` | number | 604800（7天） | TTL过期时间（秒） |

#### batch 批量配置

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | boolean | true | 是否启用批量写入 |
| `size` | number | 10 | 批量大小（条） |
| `interval` | number | 5000 | 刷新间隔（毫秒） |
| `maxBufferSize` | number | 100 | 最大缓冲区大小 |

#### filter 过滤配置

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `excludeDatabases` | string[] | [] | 排除的数据库 |
| `excludeCollections` | string[] | [] | 排除的集合 |
| `excludeOperations` | string[] | [] | 排除的操作类型 |
| `minExecutionTimeMs` | number | 0 | 最小执行时间（毫秒） |

---

## API参考

### getSlowQueryLogs(filter, options)

查询慢查询日志聚合数据。

**参数**：

```javascript
// filter - 查询条件
{
  database: 'mydb',        // 数据库名
  collection: 'users',     // 集合名
  operation: 'find',       // 操作类型
  queryHash: 'abc123def456' // 可选的精确查询 Hash
}

// options - 查询选项
{
  sort: { count: -1 },     // 排序规则
  limit: 10,               // 限制数量
  skip: 0                  // 跳过数量
}
```

**返回值**：

```javascript
[
  {
    queryHash: 'abc123def456',          // 查询Hash（唯一标识）
    database: 'mydb',                   // 数据库名
    collection: 'users',                // 集合名
    operation: 'find',                  // 操作类型
    sampleQuery: { status: 'active' },  // 查询样本
    count: 2400,                        // 执行次数
    totalTimeMs: 1248000,               // 总执行时间
    minTimeMs: 500,                     // 最小执行时间
    maxTimeMs: 1200,                    // 最大执行时间
    avgTimeMs: 520,                     // 平均执行时间（动态计算）
    firstSeen: ISODate('...'),          // 首次发现时间
    lastSeen: ISODate('...'),           // 最后一次时间
    metadata: {}
  }
]
```

**使用示例**：

```javascript
// 查询高频慢查询Top10
const topFrequent = await msq.getSlowQueryLogs(
  {},
  { sort: { count: -1 }, limit: 10 }
);

// 查询最慢的查询Top10
const topSlow = await msq.getSlowQueryLogs(
  {},
  { sort: { maxTimeMs: -1 }, limit: 10 }
);

// 查询特定集合的慢查询
const userLogs = await msq.getSlowQueryLogs(
  { database: 'mydb', collection: 'users' },
  { sort: { avgTimeMs: -1 } }
);

// 查询特定操作类型
const aggregateLogs = await msq.getSlowQueryLogs(
  { operation: 'aggregate' },
  { limit: 20 }
);
```

---

## 使用示例

### 示例1：零配置启用

```javascript
const msq = new MonSQLize({
  type: 'mongodb',
  config: { uri: 'mongodb://localhost:27017/mydb' },
  slowQueryMs: 500,
  slowQueryLog: true  // ✅ 一行启用
});
```

### 示例2：独立连接（隔离资源）

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

### 示例3：自定义TTL

```javascript
const msq = new MonSQLize({
  type: 'mongodb',
  config: { uri: 'mongodb://localhost:27017/mydb' },
  slowQueryMs: 500,
  slowQueryLog: {
    enabled: true,
    storage: {
      ttl: 24 * 3600  // 保留1天
    }
  }
});
```

### 示例4：过滤特定集合

```javascript
const msq = new MonSQLize({
  type: 'mongodb',
  config: { uri: 'mongodb://localhost:27017/mydb' },
  slowQueryMs: 500,
  slowQueryLog: {
    enabled: true,
    filter: {
      excludeCollections: ['logs', 'temp'],  // 排除日志集合
      minExecutionTimeMs: 1000               // 只记录>1秒的
    }
  }
});
```

### 示例5：本地分析使用 memory 存储

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

### 示例6：实时写入模式

```javascript
const msq = new MonSQLize({
  type: 'mongodb',
  config: { uri: 'mongodb://localhost:27017/mydb' },
  slowQueryMs: 500,
  slowQueryLog: {
    enabled: true,
    batch: {
      enabled: false  // 禁用批量，实时写入
    }
  }
});
```

---

## 最佳实践

### 阈值设置建议

根据不同场景选择合适的慢查询阈值：

| 场景 | 建议阈值 | 说明 |
|------|---------|------|
| **高并发API** | 100-300ms | 快速响应要求，对用户体验敏感 |
| **后台任务** | 1000-3000ms | 可接受较长时间，关注资源占用 |
| **分析查询** | 5000-10000ms | 复杂聚合查询，重点优化极慢查询 |
| **批量操作** | 10000-30000ms | 大批量数据处理，重点关注失败 |

#### 示例：不同场景配置

```javascript
// 场景1：高并发Web API
const apiMsq = new MonSQLize({
  type: 'mongodb',
  config: { uri: '...' },
  slowQueryMs: 200,  // 200ms阈值
  slowQueryLog: {
    enabled: true,
    filter: {
      excludeOperations: []
    }
  }
});

// 场景2：数据分析服务
const analyticsMsq = new MonSQLize({
  type: 'mongodb',
  config: { uri: '...' },
  slowQueryMs: 5000,  // 5秒阈值
  slowQueryLog: {
    enabled: true,
    filter: {
      excludeOperations: []
    }
  }
});

// 场景3：混合场景（动态阈值）
await collection('users').find(
  { status: 'active' },
  { slowQueryMs: 100 }  // 用户查询100ms
);

await collection('analytics').aggregate(
  [...],
  { slowQueryMs: 5000 }  // 分析查询5秒
);
```

### 监控和分析

#### 1. 实时监控

```javascript
// 监听慢查询事件
msq.on('slow-query', (info) => {
  // 实时记录到监控系统
  monitoring.record('slow_query', {
    operation: info.op,
    collection: info.collection,
    duration: info.durationMs,
    timestamp: new Date()
  });
  
  // 发送告警（超过阈值5秒）
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

#### 2. 定期分析

```javascript
// 每小时分析一次慢查询
setInterval(async () => {
  // 获取高频慢查询Top 10
  const topFrequent = await msq.getSlowQueryLogs(
    {},
    { sort: { count: -1 }, limit: 10 }
  );
  
  console.log('=== 高频慢查询分析 ===');
  topFrequent.forEach((log, index) => {
    console.log(`${index + 1}. ${log.collection}.${log.operation}:`);
    console.log(`   执行次数: ${log.count}`);
    console.log(`   平均耗时: ${log.avgTimeMs}ms`);
    console.log(`   最大耗时: ${log.maxTimeMs}ms`);
    console.log(`   查询样本:`, JSON.stringify(log.sampleQuery));
    console.log('');
  });
}, 3600000);  // 每小时
```

#### 3. 导出慢查询统计

```javascript
// 导出慢查询统计报告
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
  
  // 按集合分组统计
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

// 使用示例
const report = await exportSlowQueryReport(
  new Date('2026-01-01'),
  new Date('2026-01-31')
);
console.log(JSON.stringify(report, null, 2));
```

### 优化建议

#### 1. 创建索引

```javascript
// 分析慢查询后创建索引
const slowQuery = {
  collection: 'users',
  sampleQuery: { status: 'active', createdAt: { $gte: someDate } }
};

// 根据查询模式创建索引
await msq.db('mydb').collection('users').createIndex(
  { status: 1, createdAt: -1 },
  { name: 'idx_status_createdAt' }
);

// 验证索引效果
const result = await collection('users')
  .find({ status: 'active', createdAt: { $gte: someDate } })
  .explain('executionStats');
  
console.log('索引使用情况:', result.executionStats.totalKeysExamined);
```

#### 2. 优化查询条件

```javascript
// ❌ 低效查询
await collection('products').find({
  $where: 'this.price > 100'  // JavaScript表达式，无法使用索引
});

// ✅ 优化后
await collection('products').find({
  price: { $gt: 100 }  // 标准操作符，可使用索引
});

// ❌ 低效正则
await collection('users').find({
  email: { $regex: '.*@gmail.com' }  // 前缀通配符，无法使用索引
});

// ✅ 优化后
await collection('users').find({
  email: { $regex: '^.*@gmail\\.com$' }  // 使用锚点，可使用部分索引
});
```

#### 3. 使用投影减少数据传输

```javascript
// ❌ 返回所有字段
const users = await collection('users').find({
  status: 'active'
});

// ✅ 只返回需要的字段
const users = await collection('users').find(
  { status: 'active' },
  { 
    projection: { name: 1, email: 1, _id: 0 }
  }
);
```

#### 4. 启用缓存

```javascript
// 对高频查询启用缓存
const activeUsers = await collection('users').find(
  { status: 'active' },
  { 
    cache: 60000,  // 缓存1分钟
    slowQueryMs: 100
  }
);

// 第二次查询从缓存读取，不会触发慢查询日志
```

### 生产环境最佳实践

#### 1. 合理设置TTL

```javascript
// 根据存储容量和分析需求设置TTL
storage: {
  ttl: 7 * 24 * 3600    // 1周（推荐）- 平衡存储和分析需求
  // ttl: 30 * 24 * 3600   // 30天 - 长期趋势分析
  // ttl: 1 * 24 * 3600    // 1天 - 存储敏感场景
}
```

#### 2. 使用复用连接（默认）

```javascript
// ✅ 推荐：复用连接（默认）
storage: {
  useBusinessConnection: true  // 零额外连接开销
}

// ⚠️ 特殊场景：独立连接
storage: {
  useBusinessConnection: false,
  uri: 'mongodb://admin-host:27017/admin'
}
```

**何时使用独立连接**：
- 业务库性能极度敏感
- 慢查询日志量很大（>10000条/天）
- 需要独立的权限控制和资源隔离

#### 3. 配置告警

```javascript
// 慢查询达到阈值时发送告警
msq.on('slow-query', (info) => {
  if (info.durationMs > 5000) {
    // 关键告警
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
    // 警告级别
    alerting.send({
      type: 'warning',
      message: `Slow query detected: ${info.durationMs}ms`,
      details: info
    });
  }
});
```

#### 4. 监控存储空间

```javascript
// 定期检查慢查询日志集合大小
setInterval(async () => {
  const stats = await msq.db('admin').collection('slow_query_logs').stats();
  const sizeMB = stats.size / 1024 / 1024;
  
  console.log('慢查询日志存储:', {
    size: `${sizeMB.toFixed(2)} MB`,
    count: stats.count,
    avgObjectSize: `${stats.avgObjSize} bytes`
  });
  
  // 告警：存储超过1GB
  if (sizeMB > 1024) {
    alerting.send({
      type: 'warning',
      message: 'Slow query logs collection exceeds 1GB',
      details: { sizeMB, count: stats.count }
    });
  }
}, 86400000);  // 每天检查
```

#### 5. 集成日志系统

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

## 故障排查

### 问题1：慢查询日志未保存

**可能原因**：

1. 未启用功能
   ```javascript
   // ❌ 错误
   slowQueryLog: false
   
   // ✅ 正确
   slowQueryLog: true
   ```

2. 查询未超过阈值
   ```javascript
   // 检查slowQueryMs设置
   slowQueryMs: 500  // 确保查询确实>500ms
   ```

3. 批量队列未刷新
   ```javascript
   // 等待队列刷新（默认5秒）
   await new Promise(resolve => setTimeout(resolve, 6000));
   ```

**解决方案**：
1. 检查配置是否正确
2. 检查日志输出是否有错误
3. 如果启用了批量写入，可在读取最近日志前调用 `await msq.getSlowQueryLogManager()?.queue?.flush()`

### 问题2：存储连接失败

**错误信息**：
```text
[SlowQueryLog] Failed to initialize MongoDB storage: MongoServerError...
```

**可能原因**：
- MongoDB连接URI错误
- 网络不可达
- 权限不足

**解决方案**：
```javascript
// 检查URI是否正确
storage: {
  useBusinessConnection: false,
  uri: 'mongodb://localhost:27017/admin'  // 确认URI正确
}

// 或使用复用连接
storage: {
  useBusinessConnection: true  // 使用业务连接
}
```

### 问题3：查询慢查询日志返回空

**可能原因**：
1. 慢查询日志未生成
2. 已过期（TTL删除）
3. 查询条件不匹配

**解决方案**：
```javascript
// 查询所有慢查询日志
const allLogs = await msq.getSlowQueryLogs({}, { limit: 100 });
console.log('总数:', allLogs.length);

// 检查TTL设置
const manager = msq.getSlowQueryLogManager();
console.log('TTL:', manager?.config.storage.ttl);
```

---

## 性能优化

### 性能影响分析

| 指标 | 未启用 | 启用后 | 影响 |
|------|--------|--------|------|
| 单次查询耗时 | X ms | X + 2ms | +2ms（队列add） |
| 内存占用 | Y MB | Y + 0.3MB | +0.3MB（队列缓冲） |
| 连接数 | N | N（复用） | 0 |

**结论**：日志开销取决于采样、存储、序列化和负载。应在目标环境中测量并设置预算，不能默认忽略。

### 优化建议（性能优化）

1. **使用批量写入**（默认启用）
   ```javascript
   batch: {
     enabled: true,     // ✅ 启用批量
     size: 10,          // 批量大小
     interval: 5000     // 刷新间隔
   }
   ```

2. **保留内置聚合键**
   ```javascript
   // MongoDB 存储按 queryHash + database + collection + operation upsert。
   // 当前没有面向用户的聚合开关。
   ```

3. **合理设置TTL**
   ```javascript
   storage: {
     ttl: 7 * 24 * 3600  // 7天过期
   }
   ```

4. **过滤不重要的集合**
   ```javascript
   filter: {
     excludeCollections: ['logs', 'temp']  // 排除日志集合
   }
   ```

---

## 附录

### A. 数据模型

**slow_query_logs 集合结构**：

```javascript
{
  queryHash: 'abc123def456',          // 查询Hash（唯一）
  database: 'mydb',                   // 数据库名
  collection: 'users',                // 集合名
  operation: 'find',                  // 操作类型
  sampleQuery: { status: 'active' },  // 查询样本
  count: 2400,                        // 执行次数
  totalTimeMs: 1248000,               // 总执行时间
  minTimeMs: 500,                     // 最小执行时间
  maxTimeMs: 1200,                    // 最大执行时间
  firstSeen: ISODate('...'),          // 首次发现时间
  lastSeen: ISODate('...'),           // 最后一次时间（TTL字段）
  metadata: {}
}
```

**索引**：

```javascript
// 存储后端使用的唯一索引
db.slow_query_logs.createIndex(
  { queryHash: 1, database: 1, collection: 1, operation: 1 },
  { unique: true, name: 'slow_query_log_unique' }
);

// TTL索引（lastSeen）
db.slow_query_logs.createIndex(
  { lastSeen: 1 },
  { expireAfterSeconds: 604800 }
);

// 查询优化索引
db.slow_query_logs.createIndex({ database: 1, collection: 1 });
db.slow_query_logs.createIndex({ count: -1 });
```

### B. 相关链接

- [使用示例](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/slow-query-log.ts)

