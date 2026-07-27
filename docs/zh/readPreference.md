# readPreference - MongoDB 副本集读偏好配置

## 概述

`readPreference` 用于控制 MongoDB 副本集中读操作的节点选择策略，支持副本集读写分离场景。通过配置 `readPreference`，可以降低主节点负载、实现全球分布式部署的低延迟读取。

**适用场景**:
- 副本集部署（Replica Set）
- 读写分离，降低主节点负载
- 全球分布式部署下的低延迟读取
- 可接受最终一致性的分析/报表查询

**限制**:
- `config.readPreference` 设置连接级默认读偏好。
- 单次读操作可以在 options 中传入 `readPreference` 覆盖默认值。
- 当前 monSQLize runtime 只支持 MongoDB；该选项对应 MongoDB driver 的读偏好行为。
- 读从节点可能有复制延迟，写后立即读建议使用 `primary` 或 `primaryPreferred`。
- MongoDB 事务内读操作应保持 `primary`；事务读建议使用连接默认值或显式覆盖为 `primary`。
- 单机模式下只有一个节点，配置读偏好没有实际意义。

---

## 核心特性

### ✅ 5 种读偏好模式

| 模式 | 读取节点 | 数据一致性 | 适用场景 |
|------|---------|-----------|---------|
| **primary** | 仅读主节点 | 强一致性 | 默认，需要最新数据 |
| **primaryPreferred** | 优先读主节点，主节点故障时读从节点 | 通常强一致 | 需要强一致性+容错 |
| **secondary** | 仅读从节点 | 最终一致性 | 分析/报表，隔离主节点 |
| **secondaryPreferred** | 优先读从节点，从节点不可用时读主节点 | 最终一致性 | 读多写少，降低主节点负载 |
| **nearest** | 读延迟最低的节点（主或从） | 最终一致性 | 全球分布式部署，低延迟 |

### 连接级别全局配置

```javascript
const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'test_db',
    config: {
        uri: 'mongodb://localhost:27017,localhost:27018,localhost:27019/?replicaSet=rs0',
        readPreference: 'secondaryPreferred'  // ← 全局配置
    }
});
```

**特点**:
- 配置一次，所有查询生效
- 少数需要不同读路由的操作可用查询级 options 覆盖
- 默认路径更简单，减少重复配置

---

## API 参数说明

### 连接配置

| 参数 | 类型 | 必需 | 默认值 | 说明 |
|------|------|------|--------|------|
| **config.readPreference** | string | ❌ | `'primary'` | 副本集读偏好模式 |
| **读操作 options.readPreference** | string | ❌ | 连接级默认值 | 对单次读操作覆盖读偏好 |

**可选值**:
- `'primary'` - 仅读主节点（默认）
- `'primaryPreferred'` - 优先读主节点，主节点不可用时读从节点
- `'secondary'` - 仅读从节点
- `'secondaryPreferred'` - 优先读从节点，从节点不可用时读主节点
- `'nearest'` - 读最近的节点（低延迟）

---

## 使用示例

### 基本用法

#### 示例 1: 默认读偏好（primary）

```javascript
const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'test_db',
    config: {
        uri: 'mongodb://localhost:27017',
        // 不配置 readPreference，默认为 'primary'（仅读主节点）
    }
});

await msq.connect();
const { collection } = msq;

// 查询操作会自动从主节点读取
const users = await collection('users').find({});
console.log(`✅ 从主节点读取到 ${users.length} 条数据`);

await msq.close();
```

---

#### 示例 2: secondaryPreferred（优先读从节点）

**适用场景**: 读多写少，降低主节点负载

```javascript
const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'test_db',
    config: {
        uri: 'mongodb://localhost:27017,localhost:27018,localhost:27019/?replicaSet=rs0',
        readPreference: 'secondaryPreferred'  // ← 优先读从节点
    }
});

await msq.connect();
const { collection } = msq;

// 查询优先从从节点读取（降低主节点负载）
const products = await collection('products').find({ category: 'electronics' });
console.log(`✅ 从从节点读取到 ${products.length} 条产品数据`);

// ⚠️ 注意：从节点可能有复制延迟
console.log('⚠️  注意：从节点数据可能有几毫秒到几秒的延迟');

await msq.close();
```

---

#### 示例 3: secondary（仅读从节点）

**适用场景**: 分析/报表查询，完全隔离主节点写负载

```javascript
const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'analytics_db',
    config: {
        uri: 'mongodb://localhost:27017,localhost:27018,localhost:27019/?replicaSet=rs0',
        readPreference: 'secondary'  // ← 仅读从节点
    }
});

await msq.connect();
const { collection } = msq;

// 适用场景：分析/报表查询，完全隔离主节点写负载
const reports = await collection('sales').aggregate([
    { $match: { date: { $gte: new Date('2025-01-01') } } },
    { $group: { _id: '$category', total: { $sum: '$amount' } } }
]);
console.log(`✅ 从从节点生成 ${reports.length} 条报表数据`);
console.log('✅ 主节点不受影响，专注处理写操作');

await msq.close();
```

---

#### 示例 4: primaryPreferred（优先读主节点）

**适用场景**: 需要强一致性，但希望主节点故障时有备用方案

```javascript
const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'test_db',
    config: {
        uri: 'mongodb://localhost:27017,localhost:27018,localhost:27019/?replicaSet=rs0',
        readPreference: 'primaryPreferred'  // ← 优先读主节点，主节点故障时读从节点
    }
});

await msq.connect();
const { collection } = msq;

// 适用场景：需要强一致性，但希望主节点故障时有备用方案
const orders = await collection('orders').find({ status: 'pending' });
console.log(`✅ 优先从主节点读取 ${orders.length} 条订单`);
console.log('✅ 如果主节点故障，自动切换到从节点');

await msq.close();
```

---

#### 示例 5: nearest（就近读取，低延迟）

**适用场景**: 全球分布式部署，就近读取降低延迟

```javascript
const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'test_db',
    config: {
        uri: 'mongodb://localhost:27017,localhost:27018,localhost:27019/?replicaSet=rs0',
        readPreference: 'nearest'  // ← 读延迟最低的节点（主或从）
    }
});

await msq.connect();
const { collection } = msq;

// 适用场景：全球分布式部署，就近读取降低延迟
const articles = await collection('articles').find(
    { published: true },
    { limit: 10 }
);
console.log(`✅ 从延迟最低的节点读取 ${articles.length} 篇文章`);
console.log('✅ 适用于全球分布式部署场景');

await msq.close();
```

---

### 高级用法

#### 示例 6: 结合其他选项使用

```javascript
const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'test_db',
    config: {
        uri: 'mongodb://localhost:27017,localhost:27018,localhost:27019/?replicaSet=rs0',
        readPreference: 'secondaryPreferred'  // ← 读偏好
    },
    maxTimeMS: 3000,  // 查询超时
    slowQueryMs: 500  // 慢查询阈值
});

await msq.connect();
const { collection } = msq;

// 查询级 readPreference 会覆盖本次操作的连接级默认值
const results = await collection('products').find(
    { price: { $gt: 100 } },
    {
        readPreference: 'primary',
        hint: { category: 1, price: 1 },  // 索引提示
        comment: 'expensive-products-query',  // 查询注释
        maxTimeMS: 2000  // 单次查询超时
    }
);
console.log(`✅ 使用多个选项组合查询: ${results.length} 条结果`);

await msq.close();
```

---

## 最佳实践

### 推荐做法

1. **读多写少场景使用 secondaryPreferred**
   ```javascript
   // ✅ 推荐：降低主节点负载
   readPreference: 'secondaryPreferred'
   ```

2. **强一致性场景使用 primary（默认）**
   ```javascript
   // ✅ 推荐：需要最新数据时使用默认值
   // 不配置 readPreference，或显式配置为 'primary'
   ```

3. **全球分布式部署使用 nearest**
   ```javascript
   // ✅ 推荐：低延迟读取
   readPreference: 'nearest'
   ```

4. **分析/报表查询使用 secondary**
   ```javascript
   // ✅ 推荐：完全隔离主节点写负载
   readPreference: 'secondary'
   ```

---

### 注意事项

1. **复制延迟问题**
   ```javascript
   // ❌ 避免：刚写入数据后立即从从节点读取
   await collection('users').insertOne({ name: 'Alice' });  // ← 写入主节点
   
   // ⚠️ 可能读不到刚写入的数据（复制延迟）
   const users = await collection('users').find({ name: 'Alice' });
   
   // 解决：写入后立即读取使用 'primary' 或等待复制完成
   const freshUsers = await collection('users').find(
       { name: 'Alice' },
       { readPreference: 'primary' }
   );
   ```

2. **事务内读取**
   ```javascript
   // MongoDB 事务内读操作应使用主节点。
   await msq.withTransaction(async (tx) => {
       const order = await collection('orders').findOne(
           { orderNo: 'SO-1001' },
           { session: tx.session, readPreference: 'primary' }
       );

       // ...同一事务内的写操作
   });
   ```

3. **单机模式无效**
   ```javascript
   // ⚠️ 单机模式下，readPreference 配置无效，始终读唯一的节点
   const msq = new MonSQLize({
       config: {
           uri: 'mongodb://localhost:27017',  // ← 单机模式
           readPreference: 'secondary'  // ← 配置无效
       }
   });
   ```

4. **副本集 URI 格式**
   ```javascript
   // ✅ 正确：包含多个节点 + replicaSet 参数
   uri: 'mongodb://host1:27017,host2:27018,host3:27019/?replicaSet=rs0'
   
   // ❌ 错误：单节点 URI（无法读写分离）
   uri: 'mongodb://localhost:27017'
   ```

5. **跨数据库兼容性**
   ```javascript
   // ⚠️ readPreference 是 MongoDB 专属特性
   // PostgreSQL/MySQL 无对应概念
   // 切换数据库时需要移除此配置
   ```

---

## 性能影响

### 读偏好对性能的影响

| 读偏好 | 主节点负载 | 延迟 | 数据一致性 | 适用场景 |
|--------|-----------|------|-----------|---------|
| **primary** | 高 | 低 | 强一致 | 写多读少，需要最新数据 |
| **primaryPreferred** | 高 | 低 | 通常强一致 | 需要一致性+容错 |
| **secondary** | 低 | 中（复制延迟） | 最终一致 | 分析/报表，隔离主节点 |
| **secondaryPreferred** | 低 | 中（复制延迟） | 最终一致 | 读多写少，降低主节点 |
| **nearest** | 中 | 最低 | 最终一致 | 全球分布式，低延迟 |

### 性能优化建议

1. **读多写少场景**: 使用 `secondaryPreferred` 将可容忍延迟的读取转移出主节点
2. **全球分布式**: 当低延迟比固定读主更重要时使用 `nearest`
3. **分析/报表**: 使用 `secondary` 完全隔离主节点写负载

---

## 常见问题

### Q: readPreference 是否支持查询级别配置？
**A**: 支持。`config.readPreference` 是默认值，传递 MongoDB driver options 的读方法可以在单次操作中覆盖：

```javascript
const users = await collection('users').find(
    { status: 'active' },
    { readPreference: 'primary' }
);
```

建议少量使用查询级覆盖。大多数读操作沿用连接级默认值，仅在写后立即读或分析查询需要不同读路由时覆盖。

---

### Q: 如何验证 readPreference 生效？
**A**: 
1. 检查 MongoDB 日志/profile，确认读操作命中从节点
2. 在从节点设置延迟，观察查询结果是否有滞后
3. 使用 `db.currentOp()` 查看活跃连接的读偏好

---

### Q: 复制延迟多久？
**A**: 
- 局域网副本集：通常 10-100ms
- 跨地域副本集：可能 100ms-1s
- 网络抖动时：可能 1s-5s
- 建议监控 `rs.status()` 中的 `optimeDate` 差异

---

### Q: 如何处理复制延迟问题？
**A**: 
1. **写入后立即读取**: 使用 `primary` 或 `primaryPreferred`
2. **可接受延迟**: 使用 `secondaryPreferred` 或 `secondary`
3. **混合策略**: 关键查询用 `primary`，分析查询用 `secondary`

---

### Q: 单机模式下如何测试？
**A**: 
单机模式下 `readPreference` 无效。建议：
1. 使用 Docker Compose 搭建本地副本集
2. 使用 MongoDB Atlas 免费集群（M0）
3. 使用 `mongodb-memory-server` 模拟副本集（需要配置）

---

## 参考资料

- [MongoDB 官方文档 - Read Preference](https://www.mongodb.com/docs/manual/core/read-preference/)
- [MongoDB 副本集部署指南](https://www.mongodb.com/docs/manual/tutorial/deploy-replica-set/)
- [monSQLize 连接配置](./connection.md)
- [多连接池与读偏好示例](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/pool.ts)
