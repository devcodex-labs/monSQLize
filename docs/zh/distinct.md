# distinct 方法详细文档


## 概述

`distinct` 是 monSQLize 提供的字段去重查询方法，用于从 MongoDB 集合中获取指定字段的所有唯一值。**直接使用 MongoDB 原生 `Collection.distinct()` 方法**，支持查询条件过滤、排序规则和扩展选项。

## 方法签名

```javascript
async distinct(field, filter = {}, options = {})
```

## 参数说明

### field 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `field` | String | 是 | 要去重的字段名，支持嵌套字段（如 `'user.name'`、`'address.city'`） |

### filter 参数

查询条件对象，只对匹配的文档进行去重，使用 MongoDB 标准查询语法。

**类型**：`Object`
**必填**：否
**默认值**：`{}`（空对象表示对所有文档去重）

**示例**：

```javascript
// 简单条件
{ inStock: true }

// 范围查询
{ price: { $gte: 1000 } }

// 逻辑组合
{
  status: 'active',
  verified: true
}

// 空查询（对所有文档去重）
{}
```

### options 参数对象

**核心选项**（MongoDB 原生 ✅）：

| 参数 | 类型 | 必填 | 默认值 | 来源 | 说明 |
|------|------|------|--------|------|------|
| `maxTimeMS` | Number | 否 | - | MongoDB 原生 ✅ | 查询超时时间（毫秒），防止长时间查询阻塞 |
| `collation` | Object | 否 | - | MongoDB 原生 ✅ | 排序规则配置，用于字符串比较和去重（如不区分大小写） |
| `comment` | String | 否 | - | MongoDB 原生 ✅ | 查询注释，用于日志和性能分析 |
| `session` | ClientSession | 否 | - | MongoDB 原生 ✅ | 事务会话对象，用于事务操作 |

**扩展选项**（monSQLize 扩展 🔧）：

| 参数 | 类型 | 必填 | 默认值 | 来源 | 说明 |
|------|------|------|--------|------|------|
| `cache` | Number | 否 | `0` | monSQLize 扩展 🔧 | 缓存 TTL（毫秒），大于 0 时启用缓存 |
| `meta` | Boolean/Object | 否 | `false` | monSQLize 扩展 🔧 | 返回查询元数据（执行时间、缓存命中率等） |
| `explain` | Boolean/String | 否 | - | MongoDB 原生 ✅ | 返回查询执行计划，可选值：`true`、`'queryPlanner'`、`'executionStats'`、`'allPlansExecution'` |

**MongoDB 参考文档**:
- [distinct()](https://www.mongodb.com/docs/manual/reference/method/db.collection.distinct/)

### comment 配置

查询注释用于在 MongoDB 日志和性能分析工具中标识去重查询的用途。

**格式建议**：
```javascript
comment: 'Module:Action:Context'
```

**使用场景**：
- **筛选器选项**：标识各种下拉列表、筛选器的数据来源
- **数据统计**：标识数据维度的统计查询
- **性能分析**：追踪慢查询来源，帮助定位优化点

**示例**：
```javascript
// 获取商品分类（用于筛选器）
const categories = await collection('products').distinct(
  'category',
  { inStock: true },
  { comment: 'FilterOptions:getCategories:shop_page' }
);

// 获取用户角色（用于管理后台）
const roles = await collection('users').distinct(
  'role',
  {},
  { comment: 'AdminPanel:getUserRoles:users_page' }
);
```

### session 配置

在事务中执行 distinct 查询：

```javascript
const session = client.startSession();
try {
  await session.withTransaction(async () => {
    // 在事务中获取去重数据
    const categories = await collection('products').distinct(
      'category',
      { inStock: true },
      { session }
    );

    // 其他事务操作...
  });
} finally {
  await session.endSession();
}
```

**使用场景**：
- 需要保证数据一致性的去重查询
- 与其他写操作在同一事务中执行
- 需要隔离级别保证的查询

**注意事项**：
- session 必须是有效的 MongoDB ClientSession 对象
- 事务中的 distinct 查询会受到事务隔离级别影响
- 不支持跨分片集合的事务

### collation 配置

指定字符串比较和去重的规则：

```javascript
collation: {
  locale: 'zh',           // 中文
  strength: 1,            // 1: 忽略大小写和重音，2: 区分大小写
  caseLevel: false,
  numericOrdering: true   // 数字字符串按数值排序
}
```

**常见场景**：
- 需要不区分大小写的去重（如邮箱、用户名）
- 多语言环境下的正确去重
- 数字字符串的自然去重

## 返回值

### 普通模式返回数组

默认情况下，`distinct` 方法返回一个 Promise，resolve 为去重后的值数组：

```javascript
const categories = await collection('products').distinct('category', { inStock: true });

// categories = ['electronics', 'books', 'clothing']
```

**返回值类型**：`Promise<Array<any>>`

**注意**：
- 返回的数组元素类型取决于字段的实际数据类型
- 如果字段是数组类型，会展开数组并去重
- `null` 和不存在的字段会被视为一个唯一值

### explain 模式返回执行计划

当 `explain` 为 true 或指定级别时，返回查询执行计划：

```javascript
const plan = await collection('products').distinct(
  'category',
  { inStock: true },
  { explain: 'executionStats' }
);

// plan = {
//   queryPlanner: { ... },
//   executionStats: {
//     executionTimeMillis: 5,
//     totalDocsExamined: 100,
//     ...
//   }
// }
```

**返回值类型**：`Promise<Object>`

## 使用模式

### 1. 基础去重查询

最简单的去重方式，获取指定字段的所有唯一值：

```javascript
// 获取所有商品分类
const categories = await collection('products').distinct('category');
// 返回：['electronics', 'books', 'clothing']

// 获取所有用户状态
const statuses = await collection('users').distinct('status');
// 返回：['active', 'inactive', 'pending']

// 获取所有订单年份
const years = await collection('orders').distinct('year');
// 返回：[2021, 2022, 2023, 2024]
```

**适用场景**：
- 获取分类、标签等枚举值
- 统计数据的维度值
- 构建筛选器选项

### 2. 带条件的去重查询

结合查询条件，只对匹配的文档进行去重：

```javascript
// 获取在售商品的所有分类
const activeCategories = await collection('products').distinct('category', { inStock: true });

// 获取活跃用户的角色列表
const activeRoles = await collection('users').distinct('role', { status: 'active' });

// 获取已完成订单的客户ID列表
const completedCustomers = await collection('orders').distinct('customerId', { status: 'completed' });
```

**适用场景**：
- 需要基于特定条件进行统计
- 动态筛选器选项
- 数据分析和报表

### 3. 嵌套字段去重

支持对嵌套字段进行去重：

```javascript
// 获取所有用户的城市
const cities = await collection('users').distinct('address.city');

// 获取所有订单的支付方式
const paymentMethods = await collection('orders').distinct('payment.method');

// 获取所有商品的主标签
const mainTags = await collection('products').distinct('tags.0');
```

**适用场景**：
- 复杂文档结构的字段统计
- 嵌套对象的维度分析

### 4. 数组字段去重

当字段本身是数组时，distinct 会展开数组并去重：

```javascript
// 假设商品文档结构：
// { name: "商品A", tags: ["sale", "hot", "new"] }
// { name: "商品B", tags: ["hot", "recommended"] }

const allTags = await collection('products').distinct('tags');
// 返回：["sale", "hot", "new", "recommended"]
// 自动展开所有商品的 tags 数组并去重
```

**适用场景**：
- 标签云、关键词统计
- 多选字段的所有可能值
- 分类聚合

### 5. 不区分大小写的去重

使用 `collation` 配置实现大小写不敏感的去重：

```javascript
// 不区分大小写获取用户名
const usernames = await collection('users').distinct('username', {}, {
  collation: {
    locale: 'en',
    strength: 1  // 1 = 忽略大小写和重音
  }
});

// 假设数据：['Alice', 'alice', 'Bob', 'bob', 'Charlie']
// 返回：['Alice', 'Bob', 'Charlie']
```

**适用场景**：
- 用户名、邮箱等不区分大小写的字段
- 多语言文本去重
- 规范化数据统计

### 6. 复杂查询条件

结合 MongoDB 查询操作符进行复杂的条件去重：

```javascript
// 获取高价商品的分类
const expensiveCategories = await collection('products').distinct('category', { price: { $gte: 1000 } });

// 获取近30天订单的客户ID
const recentCustomers = await collection('orders').distinct('customerId', {
  createdAt: { $gte: new Date(Date.now() - 30 * 86400000) }
});

// 获取评分高的商品标签
const topTags = await collection('products').distinct('tags', {
  rating: { $gte: 4.5 },
  inStock: true
});
```

**适用场景**：
- 数据分析和报表
- 条件筛选
- 业务逻辑统计

### 7. 启用缓存

对于频繁查询的去重结果，启用缓存可以显著提升性能：

```javascript
// 缓存商品分类列表 5 分钟
const categories = await collection('products').distinct('category', {}, { cache: 5 * 60 * 1000 });

// 缓存用户角色列表 10 分钟
const roles = await collection('users').distinct('role', { status: 'active' }, { cache: 10 * 60 * 1000 });
```

**适用场景**：
- 下拉列表、筛选器等 UI 组件数据
- 元数据和配置项
- 变化不频繁的统计数据

**注意事项**：
- 缓存时间不宜过长，避免数据不一致
- 数据更新频繁的场景不建议使用缓存
- 使用 `collection.invalidate('distinct')` 可手动清除缓存

### 8. 性能分析

使用 `explain` 参数查看查询性能和索引使用情况：

```javascript
// 查看基础执行计划
const plan1 = await collection('products').distinct('category', {}, { explain: true });

// 查看详细执行统计
const plan2 = await collection('products').distinct('category', { inStock: true }, { explain: 'executionStats' });

console.log('扫描文档数:', plan2.executionStats.totalDocsExamined);
console.log('执行时间:', plan2.executionStats.executionTimeMillis, 'ms');
```

**适用场景**：
- 性能优化和调试
- 索引效果验证
- 慢查询分析

### 9. 事务中的 distinct 查询

在事务上下文中执行 distinct 查询，保证数据一致性：

```javascript
const session = client.startSession();
try {
  await session.withTransaction(async () => {
    // 在事务中获取活跃用户的角色
    const roles = await collection('users').distinct(
      'role',
      { status: 'active' },
      { session }
    );

    // 基于角色进行其他操作
    for (const role of roles) {
      await collection('permissions').updateMany(
        { role },
        { $set: { lastChecked: new Date() } },
        { session }
      );
    }
  });
} finally {
  await session.endSession();
}
```

**适用场景**：
- 需要保证数据一致性的去重查询
- 与其他写操作在同一事务中执行
- 需要隔离级别保证的查询

**注意事项**：
- session 必须是有效的 MongoDB ClientSession 对象
- 事务中的查询会受到隔离级别影响
- 不支持跨分片集合的事务

## 性能优化建议

### 1. 使用索引

对频繁进行 distinct 查询的字段建立索引：

```javascript
// 为 category 字段创建索引
await collection('products').createIndex({ category: 1 });

// 为组合查询创建复合索引
await collection('products').createIndex({ inStock: 1, category: 1 });
```

**效果**：
- 大幅提升查询速度
- 减少扫描的文档数量
- 降低服务器负载

### 2. 合理使用查询条件

尽可能缩小查询范围，减少需要扫描的文档数量：

```javascript
// ❌ 不好：扫描所有文档
const allTags = await collection('products').distinct('tags');

// ✅ 更好：只扫描在售商品
const activeTags = await collection('products').distinct('tags', {
  inStock: true
});
```

### 3. 启用缓存

对于不常变化的数据，启用缓存：

```javascript
// 分类数据变化不频繁，缓存 30 分钟
const categories = await collection('products').distinct('category', {
  cache: 30 * 60 * 1000
});
```

### 4. 避免对大数组字段去重

对包含大量元素的数组字段进行 distinct 操作可能很慢：

```javascript
// ⚠️ 注意：如果 tags 数组很大，性能可能不佳
const allTags = await collection('products').distinct('tags');

// 考虑使用聚合管道进行更灵活的控制
```

## 常见问题

### Q1: monSQLize 的 distinct 与原生 MongoDB 的区别？

monSQLize 的 `distinct()` **直接调用原生 MongoDB 的 `Collection.distinct()` 方法**，并在此基础上提供了扩展功能：

**原生 MongoDB distinct**：
```javascript
db.collection('products').distinct('category', { inStock: true }, {
  maxTimeMS: 5000,
  collation: { locale: 'en', strength: 1 },
  comment: 'getCategories'
});
```

**monSQLize distinct（完全兼容 + 扩展）**：
```javascript
collection('products').distinct('category', { inStock: true }, {
  // 原生 MongoDB 选项（直接传递）
  maxTimeMS: 5000,
  collation: { locale: 'en', strength: 1 },
  comment: 'getCategories',
  session: clientSession,

  // monSQLize 扩展选项
  cache: 5 * 60 * 1000,  // 缓存 5 分钟
  explain: 'executionStats'  // 性能分析
});
```

**扩展功能说明**：

1. **缓存支持** (`cache`)
   - 自动缓存查询结果，减少数据库压力
   - 适用于不常变化的数据（分类、标签等）
   - 使用 `collection.invalidate('distinct')` 手动清除缓存

2. **性能分析** (`explain`)
   - 返回查询执行计划而非实际结果
   - 支持多种详细级别：`'queryPlanner'`、`'executionStats'`、`'allPlansExecution'`
   - 帮助优化索引和查询性能

3. **自动事件发射**
   - 发射 `beforeDistinct` 和 `afterDistinct` 事件
   - 支持查询日志记录和监控

4. **统一错误处理**
   - 包装原生错误，提供更友好的错误信息
   - 集成 monSQLize 的错误处理机制

**核心原则**：
- ✅ 所有原生 MongoDB 的 distinct 选项都被原样传递
- ✅ 扩展选项（cache、explain）由 monSQLize 处理后再调用原生方法
- ✅ 行为完全兼容原生 MongoDB，只是提供了额外的便利功能

### Q2: distinct 与 aggregate + $group 的区别？

### Q2: distinct 与 aggregate + $group 的区别？（常见问题）

**distinct**：
- 简单易用，语法直观
- 专门用于字段去重
- 性能优化较好
- 不支持复杂的数据转换

**aggregate + $group**：
- 功能更强大，支持复杂聚合
- 可以同时计算多个字段
- 支持数据转换和计算
- 语法相对复杂

**选择建议**：
- 简单去重使用 `distinct`
- 需要计算、转换或多字段聚合使用 `aggregate`

### Q3: distinct 返回的数组是否有序？

默认情况下，distinct 返回的数组**无序**。如果需要排序，应在获取结果后手动排序：

```javascript
const categories = await collection('products').distinct('category');
const sortedCategories = categories.sort();
```

### Q4: 如何处理 null 值？

distinct 会将 `null` 值作为一个唯一值返回：

```javascript
// 假设有些文档的 category 字段为 null
const categories = await collection('products').distinct('category');
// 返回：['electronics', 'books', null]

// 如果想排除 null 值，使用查询条件
const categoriesWithoutNull = await collection('products').distinct('category', { category: { $ne: null } });
```

### Q5: 如何统计每个唯一值的数量？

distinct 只返回唯一值，不返回计数。如需计数，使用 aggregate：

```javascript
// 使用 aggregate 统计每个分类的商品数量
const categoryCounts = await collection('products').aggregate([
  { $group: { _id: '$category', count: { $sum: 1 } } },
  { $sort: { count: -1 } }
]);
// 返回：[{ _id: 'electronics', count: 45 }, { _id: 'books', count: 30 }, ...]
```

### Q6: distinct 支持多字段去重吗？

distinct 只支持单字段去重。如需多字段组合去重，使用 aggregate：

```javascript
// 获取唯一的 (category, brand) 组合
const combinations = await collection('products').aggregate([
  { $group: { _id: { category: '$category', brand: '$brand' } } }
]);
```

### Q7: 如何在事务中使用 distinct？

将 ClientSession 对象通过 `session` 选项传递：

```javascript
const session = client.startSession();
try {
  await session.withTransaction(async () => {
    const roles = await collection('users').distinct(
      'role',
      { status: 'active' },
      { session }  // 传递 session
    );
    // 其他事务操作...
  });
} finally {
  await session.endSession();
}
```

## 使用建议

### 何时使用 distinct

**✅ 推荐使用场景**：
- 获取分类、标签等枚举值列表
- 构建下拉列表和筛选器选项
- 简单的数据维度统计
- 不需要计数或其他聚合计算

**❌ 不推荐场景**：
- 需要统计每个值的数量（使用 `aggregate` + `$group`）
- 需要多字段组合去重（使用 `aggregate`）
- 需要对结果进行复杂转换（使用 `aggregate`）
- 字段是超大数组且数据量很大（考虑性能影响）

### 性能考虑

**优化要点**：
1. **为 distinct 字段创建索引**
   ```javascript
   await collection('products').createIndex({ category: 1 });
   ```

2. **使用查询条件缩小范围**
   ```javascript
   // ❌ 扫描所有文档
   const tags = await collection('products').distinct('tags');

   // ✅ 只扫描在售商品
   const tags = await collection('products').distinct('tags', { inStock: true });
   ```

3. **启用缓存（不常变化的数据）**
   ```javascript
   const categories = await collection('products').distinct('category', {}, {
     cache: 30 * 60 * 1000  // 缓存 30 分钟
   });
   ```

4. **使用 explain 分析性能**
   ```javascript
   const plan = await collection('products').distinct('category', {}, {
     explain: 'executionStats'
   });
   console.log('执行时间:', plan.executionStats.executionTimeMillis, 'ms');
   ```

### 缓存策略

**适合缓存的数据**：
- 分类、标签等元数据（变化频率低）
- 枚举值列表（状态、角色等）
- 筛选器选项（不需要实时更新）

**不适合缓存的数据**：
- 频繁更新的字段
- 需要实时准确性的统计数据
- 用户相关的敏感数据

**缓存时长建议**：
```javascript
// 元数据：30 分钟 - 1 小时
const categories = await collection('products').distinct('category', {}, {
  cache: 30 * 60 * 1000
});

// 筛选器选项：5 - 10 分钟
const brands = await collection('products').distinct('brand', { inStock: true }, {
  cache: 5 * 60 * 1000
});

// 实时数据：不缓存
const recentStatuses = await collection('orders').distinct('status', {
  createdAt: { $gte: new Date(Date.now() - 3600000) }
});
```

## 相关方法

- **find**: 查询多条记录，返回完整文档
- **findOne**: 查询单条记录
- **count**: 统计文档数量
- **aggregate**: 执行聚合管道操作

## 最佳实践

### 1. 索引优化
为常用的 distinct 字段创建索引，显著提升查询性能：

```javascript
// 单字段索引
await collection('products').createIndex({ category: 1 });

// 复合索引（带查询条件时）
await collection('products').createIndex({ inStock: 1, category: 1 });
```

### 2. 缩小查询范围
使用查询条件减少需要扫描的文档数量：

```javascript
// ❌ 不好：扫描所有文档
const tags = await collection('products').distinct('tags');

// ✅ 更好：只扫描相关文档
const tags = await collection('products').distinct('tags', {
  inStock: true,
  category: 'electronics'
});
```

### 3. 合理使用缓存
对不常变化的数据启用缓存，减少数据库压力：

```javascript
// 元数据缓存 30 分钟
const categories = await collection('products').distinct('category', {}, {
  cache: 30 * 60 * 1000
});

// 需要实时数据时不使用缓存
const recentStatuses = await collection('orders').distinct('status', {
  createdAt: { $gte: new Date(Date.now() - 3600000) }
});
```

### 4. 性能分析
使用 `explain` 分析查询性能，优化索引：

```javascript
const plan = await collection('products').distinct('category', { inStock: true }, {
  explain: 'executionStats'
});

console.log('扫描文档数:', plan.executionStats.totalDocsExamined);
console.log('执行时间:', plan.executionStats.executionTimeMillis, 'ms');
console.log('是否使用索引:', plan.executionStats.executionStages.stage);
```

### 5. 避免大数组字段去重
对包含大量元素的数组字段进行 distinct 操作可能很慢：

```javascript
// ⚠️ 注意：如果 tags 数组很大，性能可能不佳
const allTags = await collection('products').distinct('tags');

// 考虑添加查询条件或使用聚合管道
const popularTags = await collection('products').distinct('tags', {
  viewCount: { $gte: 100 }
});
```

### 6. 结果排序
distinct 返回的数组无序，需要排序时手动处理：

```javascript
const categories = await collection('products').distinct('category');
const sorted = categories.sort((a, b) => a.localeCompare(b));
```

### 7. 添加查询注释
使用 `comment` 选项标识查询用途，便于日志分析：

```javascript
const roles = await collection('users').distinct('role', {}, {
  comment: 'AdminPanel:getRoles:user_management'
});
```

### 8. 事务中的查询
需要数据一致性时，在事务中执行 distinct：

```javascript
const session = client.startSession();
try {
  await session.withTransaction(async () => {
    const roles = await collection('users').distinct('role', {}, { session });
    // 基于角色的其他事务操作...
  });
} finally {
  await session.endSession();
}
```

### 9. 处理 null 值
根据业务需求决定是否包含 null 值：

```javascript
// 包含 null
const allCategories = await collection('products').distinct('category');

// 排除 null
const validCategories = await collection('products').distinct('category', {
  category: { $ne: null, $exists: true }
});
```

### 10. 使用 collation 处理多语言
多语言环境下使用 collation 确保正确去重：

```javascript
// 不区分大小写的去重
const usernames = await collection('users').distinct('username', {}, {
  collation: { locale: 'en', strength: 1 }
});

// 中文排序规则
const chineseNames = await collection('users').distinct('name', {}, {
  collation: { locale: 'zh' }
});
```

## 示例代码

更多完整示例请参考：
- [distinct.ts](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/distinct.ts) - 当前 TypeScript 使用示例
- [queries.test.ts](../../test/integration/mongodb/queries.test.ts) - 集成测试覆盖
