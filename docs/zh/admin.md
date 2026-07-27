# 运维监控 API

运维监控方法用于检查数据库健康状态、获取版本信息、监控服务器性能等。

## ping()

检测数据库连接是否正常。

### 语法

```javascript
const isAlive = await db.db().admin().ping();
```

### 返回值

- **类型**: `Promise<boolean>`
- **说明**: 连接正常返回 `true`，否则返回 `false`

### 示例

```javascript
import MonSQLize from 'monsqlize';

const msq = new MonSQLize({
    type: 'mongodb',
    config: { uri: 'mongodb://localhost:27017/mydb' }
});

await msq.connect();
const admin = msq.db().admin();

// 检测连接
const isAlive = await admin.ping();
console.log('Database is alive:', isAlive);
```

### 使用场景

1. **健康检查**: 监控系统定期检测数据库是否可用
2. **容器编排**: Kubernetes 健康探针
3. **负载均衡**: 检测数据库节点健康状态

### 最佳实践

```javascript
// 在应用启动时检查连接
async function startup() {
    await msq.connect();
    
    const isAlive = await msq.db().admin().ping();
    if (!isAlive) {
        throw new Error('Database connection failed');
    }
    
    console.log('✅ Database connected');
}

// 定期健康检查
setInterval(async () => {
    const isAlive = await db.db().admin().ping();
    if (!isAlive) {
        console.error('❌ Database connection lost');
        // 触发告警或重连
    }
}, 30000); // 每30秒检查一次
```

---

## buildInfo()

获取 MongoDB 版本信息和构建详情。

### 语法（buildInfo()）

```javascript
const info = await db.db().admin().buildInfo();
```

### 返回值（buildInfo()）

- **类型**: `Promise<Object>`
- **属性**:
  - `version` (string): 版本号，如 "6.0.3"
  - `versionArray` (Array<number>): 版本号数组，如 [6, 0, 3]
  - `gitVersion` (string): Git 版本哈希
  - `bits` (number): 系统位数（32 或 64）
  - `debug` (boolean): 是否为 Debug 版本
  - `maxBsonObjectSize` (number): BSON 对象最大大小

### 示例（buildInfo()）

```javascript
const info = await admin.buildInfo();

console.log('MongoDB 版本:', info.version);
console.log('版本数组:', info.versionArray);
console.log('Git 版本:', info.gitVersion);
console.log('系统位数:', info.bits);
console.log('BSON 最大大小:', info.maxBsonObjectSize, 'bytes');
```

**输出示例**:
```text
MongoDB 版本: 6.0.3
版本数组: [ 6, 0, 3 ]
Git 版本: 01a0d5a0e6e8e5f...
系统位数: 64
BSON 最大大小: 16777216 bytes
```

### 使用场景（buildInfo()）

1. **兼容性检测**: 检查 MongoDB 版本是否满足最低要求
2. **功能检测**: 根据版本决定是否使用特定功能
3. **监控报告**: 在监控系统中记录数据库版本

### 最佳实践（buildInfo()）

```javascript
// 检查版本兼容性
async function checkMongoDBVersion() {
    const info = await db.db().admin().buildInfo();
    const [major, minor] = info.versionArray;
    
    // 要求 MongoDB 4.4+
    if (major < 4 || (major === 4 && minor < 4)) {
        throw new Error(
            `MongoDB 版本过低: ${info.version}，要求 4.4+`
        );
    }
    
    console.log(`✅ MongoDB 版本检查通过: ${info.version}`);
}

// 根据版本启用功能
async function initializeFeatures() {
    const info = await db.db().admin().buildInfo();
    const [major, minor] = info.versionArray;
    
    // MongoDB 5.0+ 支持时间序列集合
    const supportsTimeSeries = major >= 5;
    
    // MongoDB 4.2+ 支持通配符索引
    const supportsWildcardIndexes = major > 4 || (major === 4 && minor >= 2);
    
    return {
        supportsTimeSeries,
        supportsWildcardIndexes
    };
}
```

---

## serverStatus()

获取服务器状态信息，包括连接数、内存使用、操作统计等。

### 语法（serverStatus()）

```javascript
const status = await db.db().admin().serverStatus(options);
```

### 参数

- **options** (Object, 可选):
  - `scale` (number): 缩放因子，用于调整大小单位
    - `1`: 字节（默认）
    - `1024`: KB
    - `1048576`: MB

### 返回值（serverStatus()）

- **类型**: `Promise<Object>`
- **属性**:
  - `connections` (Object): 连接信息
    - `current` (number): 当前连接数
    - `available` (number): 可用连接数
    - `totalCreated` (number): 总创建连接数
  - `mem` (Object): 内存使用信息
    - `resident` (number): 常驻内存（MB）
    - `virtual` (number): 虚拟内存（MB）
    - `mapped` (number): 映射内存（MB）
  - `opcounters` (Object): 操作计数器
    - `insert` (number): 插入操作数
    - `query` (number): 查询操作数
    - `update` (number): 更新操作数
    - `delete` (number): 删除操作数
    - `getmore` (number): getMore 操作数
    - `command` (number): 命令操作数
  - `network` (Object): 网络统计
    - `bytesIn` (number): 接收字节数
    - `bytesOut` (number): 发送字节数
    - `numRequests` (number): 请求总数
  - `uptime` (number): 运行时间（秒）
  - `localTime` (Date): 本地时间
  - `version` (string): MongoDB 版本
  - `process` (string): 进程类型

### 示例（serverStatus()）

#### 基础使用

```javascript
const status = await admin.serverStatus();

console.log('=== 连接信息 ===');
console.log('当前连接:', status.connections.current);
console.log('可用连接:', status.connections.available);

console.log('\n=== 内存使用 ===');
console.log('常驻内存:', status.mem.resident, 'MB');
console.log('虚拟内存:', status.mem.virtual, 'MB');

console.log('\n=== 操作统计 ===');
console.log('插入:', status.opcounters.insert);
console.log('查询:', status.opcounters.query);
console.log('更新:', status.opcounters.update);
console.log('删除:', status.opcounters.delete);

console.log('\n=== 系统信息 ===');
console.log('运行时间:', Math.floor(status.uptime / 3600), '小时');
console.log('版本:', status.version);
```

#### 使用 scale 参数

```javascript
// 使用 KB 为单位
const statusKB = await db.db().admin().serverStatus({ scale: 1024 });
console.log('内存使用:', statusKB.mem.resident, 'KB');

// 使用 MB 为单位
const statusMB = await db.db().admin().serverStatus({ scale: 1048576 });
console.log('内存使用:', statusMB.mem.resident, 'MB');
```

### 使用场景（serverStatus()）

1. **性能监控**: 实时监控数据库性能指标
2. **容量规划**: 分析连接使用情况，规划连接池大小
3. **故障诊断**: 检查内存使用、连接数等异常情况
4. **告警系统**: 设置阈值触发告警

### 最佳实践（serverStatus()）

```javascript
// 监控连接数
async function monitorConnections() {
    const status = await db.db().admin().serverStatus();
    const usagePercent = (status.connections.current / 
        (status.connections.current + status.connections.available)) * 100;
    
    if (usagePercent > 80) {
        console.warn(`⚠️ 连接使用率过高: ${usagePercent.toFixed(2)}%`);
        // 触发告警
    }
    
    return {
        current: status.connections.current,
        total: status.connections.current + status.connections.available,
        usagePercent: usagePercent.toFixed(2)
    };
}

// 监控内存使用
async function monitorMemory() {
    const status = await db.db().admin().serverStatus({ scale: 1048576 }); // MB
    
    if (status.mem.resident > 1024) { // 超过 1GB
        console.warn(`⚠️ 内存使用过高: ${status.mem.resident} MB`);
    }
    
    return {
        resident: status.mem.resident,
        virtual: status.mem.virtual,
        unit: 'MB'
    };
}

// 定期收集性能指标
async function collectMetrics() {
    const status = await db.db().admin().serverStatus();
    
    // 发送到监控系统（如 Prometheus、Grafana）
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

获取当前数据库的统计信息。

### 语法（stats()）

```javascript
const stats = await db.db().admin().stats(options);
```

### 参数（stats()）

- **options** (Object, 可选):
  - `scale` (number): 缩放因子
    - `1`: 字节（默认）
    - `1024`: KB
    - `1048576`: MB

### 返回值（stats()）

- **类型**: `Promise<Object>`
- **属性**:
  - `db` (string): 数据库名称
  - `collections` (number): 集合数量
  - `views` (number): 视图数量
  - `objects` (number): 文档总数
  - `avgObjSize` (number): 平均文档大小
  - `dataSize` (number): 数据大小
  - `storageSize` (number): 存储大小
  - `indexes` (number): 索引数量
  - `indexSize` (number): 索引大小
  - `totalSize` (number): 总大小
  - `scaleFactor` (number): 缩放因子

### 示例（stats()）

#### 基础使用（示例（stats()））

```javascript
const stats = await admin.stats();

console.log('数据库:', stats.db);
console.log('集合数:', stats.collections);
console.log('视图数:', stats.views);
console.log('文档总数:', stats.objects);
console.log('平均文档大小:', stats.avgObjSize, 'bytes');
console.log('数据大小:', stats.dataSize, 'bytes');
console.log('存储大小:', stats.storageSize, 'bytes');
console.log('索引数:', stats.indexes);
console.log('索引大小:', stats.indexSize, 'bytes');
```

#### 使用不同单位

```javascript
// 使用 MB 为单位
const statsMB = await db.db().admin().stats({ scale: 1048576 });

console.log('=== 数据库统计（MB）===');
console.log('数据大小:', statsMB.dataSize, 'MB');
console.log('存储大小:', statsMB.storageSize, 'MB');
console.log('索引大小:', statsMB.indexSize, 'MB');
console.log('总大小:', statsMB.totalSize, 'MB');
```

### 使用场景（stats()）

1. **容量规划**: 评估数据库存储需求
2. **性能优化**: 分析索引占用空间
3. **成本估算**: 计算存储成本
4. **监控告警**: 当数据库大小超过阈值时告警

### 最佳实践（stats()）

```javascript
// 容量监控
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
    
    // 检查容量阈值
    if (stats.totalSize > 50) { // 超过 50GB
        console.warn('⚠️ 数据库容量超过 50GB');
    }
    
    return capacityReport;
}

// 索引分析
async function analyzeIndexes() {
    const stats = await db.db().admin().stats();
    
    // 计算索引占比
    const indexRatio = (stats.indexSize / stats.dataSize) * 100;
    
    if (indexRatio > 50) {
        console.warn(
            `⚠️ 索引占用过高: ${indexRatio.toFixed(2)}% 的数据大小`
        );
    }
    
    return {
        indexCount: stats.indexes,
        indexSize: stats.indexSize,
        dataSize: stats.dataSize,
        indexRatio: indexRatio.toFixed(2) + '%'
    };
}

// 生成统计报告
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

## 相关文档

- [数据库操作](./database-ops.md) - listDatabases, dropDatabase
- [集合管理](./collection-management.md) - 集合统计和管理
- [集合管理示例](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/collection-management.ts) - 当前 TypeScript 示例

