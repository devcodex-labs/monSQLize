# aggregate 方法详细文档


## 概述

`aggregate` 是 monSQLize 提供的聚合管道方法，用于执行 MongoDB 的聚合框架操作。支持复杂的数据处理、统计分析、联表查询、分组计算、流式处理和缓存等功能。

## 方法签名

```javascript
async aggregate(pipeline = [], options = {})
```

## 参数说明

### pipeline 数组

聚合管道是一个由多个阶段组成的数组，每个阶段对数据进行特定的处理操作。

**常用管道阶段**：

| 阶段 | 说明 | 示例 |
|------|------|------|
| `$match` | 过滤文档（类似 find 的 query） | `{ $match: { status: 'active' } }` |
| `$group` | 分组聚合计算 | `{ $group: { _id: '$category', total: { $sum: 1 } } }` |
| `$project` | 字段投影和转换 | `{ $project: { name: 1, total: { $add: ['$price', '$tax'] } } }` |
| `$sort` | 排序 | `{ $sort: { createdAt: -1 } }` |
| `$limit` | 限制返回数量 | `{ $limit: 10 }` |
| `$skip` | 跳过指定数量 | `{ $skip: 20 }` |
| `$lookup` | 关联其他集合（联表查询） | `{ $lookup: { from: 'users', ... } }` |
| `$unwind` | 展开数组字段 | `{ $unwind: '$tags' }` |
| `$addFields` | 添加新字段 | `{ $addFields: { fullName: { $concat: ['$firstName', ' ', '$lastName'] } } }` |
| `$count` | 统计文档数量 | `{ $count: 'total' }` |
| `$facet` | 多路聚合 | `{ $facet: { stats: [...], list: [...] } }` |
| `$out` / `$merge` | 将聚合结果写入集合 | `{ $merge: { into: 'summary' } }` |

### options 对象属性

| 参数 | 类型 | 必填 | 默认值 | 来源 | 说明 |
|------|------|------|--------|------|------|
| `maxTimeMS` | Number | 否 | 全局配置 | MongoDB 原生 ✅ | 查询超时时间（毫秒） |
| `allowDiskUse` | Boolean | 否 | `false` | MongoDB 原生 ✅ | 是否允许使用磁盘（处理大数据集时） |
| `collation` | Object | 否 | - | MongoDB 原生 ✅ | 字符串排序规则 |
| `hint` | Object/String | 否 | - | MongoDB 原生 ✅ | 指定使用的索引 |
| `comment` | String | 否 | - | MongoDB 原生 ✅ | 查询注释（用于日志和分析） |
| `batchSize` | Number | 否 | - | MongoDB 原生 ✅ | 流式查询或数组查询时的批次大小 |
| `explain` | Boolean/String | 否 | - | MongoDB 原生 ✅ | 返回查询执行计划 |
| `stream` | Boolean | 否 | `false` | monSQLize 扩展 🔧 | 是否返回流对象（也可通过 `.stream()` 链式方法调用） |
| `cache` | Number | 否 | `0` | monSQLize 扩展 🔧 | 缓存 TTL（毫秒），大于 0 时启用缓存 |
| `meta` | Boolean/Object | 否 | `false` | monSQLize 扩展 🔧 | 返回查询元数据（执行时间、缓存命中率等） |

**图例说明**:
- ✅ **MongoDB 原生**: 该参数是 MongoDB 官方支持的标准功能
- 🔧 **monSQLize 扩展**: monSQLize 独有的扩展功能

当聚合管道最后一个阶段是 `$out` 或 `$merge` 时，monSQLize 会把该 aggregate 视为写入型管道：跳过 aggregate 结果缓存。只有配置了 `cache.invalidate`、`autoInvalidate: true` 或全局 `cache.autoInvalidate` 时，才会清理目标集合的读缓存。

**MongoDB 参考文档**:
- [aggregate() 方法](https://www.mongodb.com/docs/manual/reference/method/db.collection.aggregate/)
- [聚合管道](https://www.mongodb.com/docs/manual/core/aggregation-pipeline/)

### allowDiskUse 说明

当聚合操作需要处理的数据量超过内存限制（默认 100MB）时，设置 `allowDiskUse: true` 允许 MongoDB 使用磁盘临时存储：

```javascript
// 处理大数据集的聚合操作
const result = await collection('orders').aggregate([
  { $match: { year: 2024 } },
  { $group: { _id: '$category', total: { $sum: '$amount' } } },
  { $sort: { total: -1 } }
], {
  allowDiskUse: true  // 允许使用磁盘
});
```

**使用场景**：
- 处理百万级以上的数据
- 复杂的分组和排序操作
- 多表联合查询（$lookup）
- 避免内存溢出错误

### explain 配置

用于分析聚合操作的执行计划和性能：

```javascript
const plan = await collection('orders').aggregate([
  { $match: { status: 'paid' } },
  { $group: { _id: '$customerId', total: { $sum: '$amount' } } }
], {
  explain: 'executionStats'
});
```

**explain 级别**：
- `true` 或 `'queryPlanner'`：基本执行计划
- `'executionStats'`：执行统计信息
- `'allPlansExecution'`：所有候选计划的详细信息

## 返回值

### 普通模式返回数组

默认情况下，`aggregate` 方法返回一个 Promise，resolve 为结果文档数组：

```javascript
const stats = await collection('orders').aggregate([
  { $match: { status: 'paid' } },
  { $group: {
      _id: '$category',
      total: { $sum: '$amount' },
      count: { $sum: 1 }
  } }
]);

// stats = [
//   { _id: 'electronics', total: 50000, count: 120 },
//   { _id: 'books', total: 30000, count: 200 },
//   ...
// ]
```

**返回值类型**：`Promise<Array<Object>>`

### 流式模式返回流对象

当 `stream: true` 时，返回一个 MongoDB Cursor Stream 对象：

```javascript
const stream = await collection('orders').aggregate([
  { $match: { year: 2024 } },
  { $project: { orderId: 1, amount: 1, customerId: 1 } }
], {
  stream: true,
  batchSize: 1000
});

stream.on('data', (doc) => console.log(doc));
stream.on('end', () => console.log('完成'));
stream.on('error', (err) => console.error('错误:', err));
```

**返回值类型**：`ReadableStream`

### explain 模式返回执行计划

当 `explain` 为 true 或指定级别时，返回聚合操作的执行计划：

```javascript
const plan = await collection('orders').aggregate([
  { $match: { status: 'paid' } },
  { $group: { _id: '$category', total: { $sum: 1 } } }
], {
  explain: 'executionStats'
});

// plan = {
//   stages: [...],
//   executionStats: {
//     executionTimeMillis: 15,
//     totalDocsExamined: 5000,
//     ...
//   }
// }
```

**返回值类型**：`Promise<Object>`

## 使用模式

### 1. 基础聚合统计

最常见的聚合操作，用于数据统计和分析：

```javascript
// 统计各状态订单的总金额和数量
const orderStats = await collection('orders').aggregate([
  {
    $match: {
      createdAt: { $gte: new Date('2024-01-01') }
    }
  },
  {
    $group: {
      _id: '$status',
      totalAmount: { $sum: '$amount' },
      count: { $sum: 1 },
      avgAmount: { $avg: '$amount' },
      maxAmount: { $max: '$amount' },
      minAmount: { $min: '$amount' }
    }
  },
  {
    $sort: { totalAmount: -1 }
  }
]);

// 统计每个分类的商品数量
const categoryStats = await collection('products').aggregate([
  {
    $group: {
      _id: '$category',
      productCount: { $sum: 1 },
      avgPrice: { $avg: '$price' },
      totalSales: { $sum: '$sales' }
    }
  },
  {
    $sort: { totalSales: -1 }
  },
  {
    $limit: 10
  }
]);
```

**适用场景**：
- 销售报表统计
- 用户行为分析
- 数据汇总计算
- Dashboard 数据展示

### 2. 联表查询（$lookup）

使用 `$lookup` 阶段关联其他集合，类似 SQL 的 JOIN：

```javascript
// 订单关联用户信息
const ordersWithUsers = await collection('orders').aggregate([
  {
    $match: { status: 'paid' }
  },
  {
    $lookup: {
      from: 'users',              // 关联的集合名
      localField: 'userId',       // 本集合的字段
      foreignField: '_id',        // 关联集合的字段
      as: 'userInfo'              // 结果字段名
    }
  },
  {
    $unwind: '$userInfo'          // 展开数组（一对一关联）
  },
  {
    $project: {
      orderId: 1,
      amount: 1,
      status: 1,
      userName: '$userInfo.name',
      userEmail: '$userInfo.email'
    }
  },
  {
    $limit: 20
  }
], {
  allowDiskUse: true
});

// 高级 $lookup 使用管道
const ordersWithDetails = await collection('orders').aggregate([
  {
    $match: { status: 'completed' }
  },
  {
    $lookup: {
      from: 'users',
      let: { customerId: '$userId' },
      pipeline: [
        {
          $match: {
            $expr: { $eq: ['$_id', '$$customerId'] },
            status: 'active'      // 额外过滤条件
          }
        },
        {
          $project: { name: 1, email: 1, level: 1 }
        }
      ],
      as: 'customer'
    }
  }
]);
```

**性能提示**：
- 确保关联字段有索引
- 对于大数据集，设置 `allowDiskUse: true`
- 使用 pipeline 形式可以添加额外过滤条件
- 避免多级嵌套 $lookup（性能差）

#### 关联查询边界与基数

`collection.aggregate<TResult>()` 是同库关联管道的直接集合 API。它不会新增 `join()` 或 `lookup()` 辅助方法：MongoDB 聚合管道保持可见，并可直接表达一对一、一对多和多对多关系，无需引入第二套查询语言。

| 关系 | 管道形态 | 结果形态 |
|---|---|---|
| 一对一 | `$lookup` 后接 `$unwind` | 每条源记录对应一个关联文档 |
| 一对多 | `$lookup`（可选 `let` + `pipeline`） | `as` 字段中保留关联数组 |
| 多对多 | 先 `$lookup` 中间集合、`$unwind`，再 `$lookup` 目标集合 | 每个关联一行，或通过 `$group` 重新聚合 |

```ts
type AuthorWithArticles = {
  name: string;
  articles: Array<{ title: string; rank: number }>;
};

const authors = runtime.collection('authors');
const authorsWithArticles = await authors.aggregate<AuthorWithArticles>([
  {
    $lookup: {
      from: 'articles',
      let: { authorId: '$_id' },
      pipeline: [
        { $match: { $expr: { $eq: ['$authorId', '$$authorId'] }, published: true } },
        { $project: { _id: 0, title: 1, rank: 1 } },
        { $sort: { rank: -1 } },
        { $limit: 3 },
      ],
      as: 'articles',
    },
  },
]);
```

这属于原始集合聚合，不会应用 Model hooks、Model hydrate 或 Model 软删除默认条件。如果关联集合使用软删除或租户隔离，必须在对应的 `$lookup.pipeline` 中显式加入过滤条件。`$out` 与 `$merge` 仍是可写聚合阶段，受配置的 `writePathPolicy` 约束，不属于只读关联查询契约。

### 3. 数据转换与计算

使用 `$project` 和 `$addFields` 进行字段转换和计算：

```javascript
// 字段计算和转换
const processedOrders = await collection('orders').aggregate([
  {
    $match: { status: 'paid' }
  },
  {
    $addFields: {
      // 计算折扣后价格
      finalAmount: {
        $subtract: [
          '$amount',
          { $multiply: ['$amount', { $divide: ['$discount', 100] }] }
        ]
      },
      // 计算订单利润
      profit: {
        $subtract: ['$amount', '$cost']
      },
      // 日期格式化
      orderDate: {
        $dateToString: {
          format: '%Y-%m-%d',
          date: '$createdAt'
        }
      }
    }
  },
  {
    $project: {
      orderId: 1,
      originalAmount: '$amount',
      finalAmount: 1,
      profit: 1,
      profitRate: {
        $multiply: [
          { $divide: ['$profit', '$amount'] },
          100
        ]
      },
      orderDate: 1
    }
  }
]);

// 条件计算
const userLevels = await collection('users').aggregate([
  {
    $addFields: {
      level: {
        $switch: {
          branches: [
            { case: { $gte: ['$totalSpent', 10000] }, then: 'VIP' },
            { case: { $gte: ['$totalSpent', 5000] }, then: 'Gold' },
            { case: { $gte: ['$totalSpent', 1000] }, then: 'Silver' }
          ],
          default: 'Bronze'
        }
      }
    }
  },
  {
    $group: {
      _id: '$level',
      count: { $sum: 1 }
    }
  }
]);
```

### 4. 数组操作

处理包含数组字段的文档：

```javascript
// 展开数组并统计
const tagStats = await collection('products').aggregate([
  {
    $match: { status: 'active' }
  },
  {
    $unwind: '$tags'  // 展开 tags 数组
  },
  {
    $group: {
      _id: '$tags',
      count: { $sum: 1 },
      products: { $push: '$name' }  // 收集产品名称
    }
  },
  {
    $sort: { count: -1 }
  },
  {
    $limit: 10
  }
]);

// 数组过滤
const filteredOrders = await collection('orders').aggregate([
  {
    $addFields: {
      highValueItems: {
        $filter: {
          input: '$items',
          as: 'item',
          cond: { $gte: ['$$item.price', 100] }
        }
      }
    }
  },
  {
    $match: {
      highValueItems: { $ne: [] }  // 只保留有高价商品的订单
    }
  }
]);
```

### 5. 按日期分组统计

常用于生成时间序列报表：

```javascript
// 按日统计订单
const dailyStats = await collection('orders').aggregate([
  {
    $match: {
      createdAt: {
        $gte: new Date('2024-01-01'),
        $lt: new Date('2024-02-01')
      }
    }
  },
  {
    $group: {
      _id: {
        $dateToString: {
          format: '%Y-%m-%d',
          date: '$createdAt'
        }
      },
      orderCount: { $sum: 1 },
      totalAmount: { $sum: '$amount' },
      avgAmount: { $avg: '$amount' }
    }
  },
  {
    $sort: { _id: 1 }
  }
]);

// 按月统计
const monthlyStats = await collection('orders').aggregate([
  {
    $match: {
      createdAt: { $gte: new Date('2024-01-01') }
    }
  },
  {
    $group: {
      _id: {
        year: { $year: '$createdAt' },
        month: { $month: '$createdAt' }
      },
      orderCount: { $sum: 1 },
      totalRevenue: { $sum: '$amount' }
    }
  },
  {
    $sort: { '_id.year': 1, '_id.month': 1 }
  }
]);
```

### 6. 多路聚合（$facet）

在一次查询中执行多个独立的聚合管道：

```javascript
const multiStats = await collection('orders').aggregate([
  {
    $match: {
      createdAt: { $gte: new Date('2024-01-01') }
    }
  },
  {
    $facet: {
      // 统计信息
      statistics: [
        {
          $group: {
            _id: null,
            totalOrders: { $sum: 1 },
            totalAmount: { $sum: '$amount' },
            avgAmount: { $avg: '$amount' }
          }
        }
      ],
      // 按状态分组
      byStatus: [
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 }
          }
        },
        {
          $sort: { count: -1 }
        }
      ],
      // Top 10 订单
      topOrders: [
        {
          $sort: { amount: -1 }
        },
        {
          $limit: 10
        },
        {
          $project: {
            orderId: 1,
            amount: 1,
            customerId: 1
          }
        }
      ]
    }
  }
]);

// 结果结构：
// {
//   statistics: [{ totalOrders: 1000, totalAmount: 500000, avgAmount: 500 }],
//   byStatus: [{ _id: 'paid', count: 800 }, ...],
//   topOrders: [{ orderId: '...', amount: 5000 }, ...]
// }
```

### 7. 流式处理大数据集

对于大量数据，使用流式处理避免内存溢出：

```javascript
const stream = await collection('orders').aggregate([
  {
    $match: {
      createdAt: { $gte: new Date('2024-01-01') }
    }
  },
  {
    $lookup: {
      from: 'users',
      localField: 'userId',
      foreignField: '_id',
      as: 'user'
    }
  },
  {
    $project: {
      orderId: 1,
      amount: 1,
      userName: { $arrayElemAt: ['$user.name', 0] }
    }
  }
], {
  stream: true,
  batchSize: 1000,
  allowDiskUse: true
});

let processedCount = 0;
let totalAmount = 0;

stream.on('data', (order) => {
  processedCount++;
  totalAmount += order.amount;

  // 逐条处理数据
  // processOrder(order);
});

stream.on('end', () => {
  console.log(`处理完成: ${processedCount} 条订单，总金额: ${totalAmount}`);
});

stream.on('error', (err) => {
  console.error('流处理错误:', err);
});
```

## 性能优化建议

### 1. 管道阶段顺序优化

将过滤操作（$match）尽早执行，减少后续阶段处理的数据量：

```javascript
// ✅ 好：先过滤再处理
const result = await collection('orders').aggregate([
  { $match: { status: 'paid', amount: { $gte: 100 } } },  // 先过滤
  { $lookup: { from: 'users', ... } },                     // 再关联
  { $project: { ... } }                                    // 最后投影
]);

// ❌ 不好：处理完再过滤
const result = await collection('orders').aggregate([
  { $lookup: { from: 'users', ... } },                     // 关联所有数据
  { $project: { ... } },
  { $match: { status: 'paid', amount: { $gte: 100 } } }   // 最后才过滤
]);
```

### 2. 使用索引

确保 $match 和 $sort 阶段使用的字段有索引：

```javascript
// 创建索引：db.orders.createIndex({ status: 1, createdAt: -1 })

const result = await collection('orders').aggregate([
  {
    $match: { status: 'paid' }  // 使用索引
  },
  {
    $sort: { createdAt: -1 }    // 使用索引
  },
  {
    $limit: 100
  }
], {
  hint: { status: 1, createdAt: -1 }  // 强制使用索引
});
```

### 3. 限制返回数据量

尽早使用 $limit 和 $project 减少数据量：

```javascript
// ✅ 好：尽早限制数据量
const result = await collection('orders').aggregate([
  { $match: { status: 'paid' } },
  { $sort: { amount: -1 } },
  { $limit: 10 },                    // 尽早限制
  { $lookup: { from: 'users', ... } }, // 只关联 10 条
  { $project: { orderId: 1, amount: 1, userName: '$user.name' } }
]);

// ❌ 不好：处理完所有数据再限制
const result = await collection('orders').aggregate([
  { $match: { status: 'paid' } },
  { $lookup: { from: 'users', ... } }, // 关联所有数据
  { $project: { ... } },
  { $limit: 10 }                     // 最后才限制
]);
```

### 4. 大数据集启用 allowDiskUse

```javascript
const result = await collection('orders').aggregate([
  { $match: { year: 2024 } },
  { $group: { _id: '$category', total: { $sum: '$amount' } } },
  { $sort: { total: -1 } }
], {
  allowDiskUse: true,  // 处理大数据集时必须
  maxTimeMS: 30000     // 适当增加超时时间
});
```

### 5. 使用 explain 分析性能

```javascript
const plan = await collection('orders').aggregate([
  { $match: { status: 'paid' } },
  { $group: { _id: '$category', total: { $sum: 1 } } }
], {
  explain: 'executionStats'
});

console.log('执行时间:', plan.executionStats?.executionTimeMillis, 'ms');
console.log('扫描文档数:', plan.executionStats?.totalDocsExamined);
```

### 6. 优化 $lookup 性能

```javascript
// ✅ 好：关联字段有索引，使用 pipeline 过滤
const result = await collection('orders').aggregate([
  { $match: { status: 'paid' } },
  {
    $lookup: {
      from: 'users',
      let: { userId: '$userId' },
      pipeline: [
        { $match: {
            $expr: { $eq: ['$_id', '$$userId'] },
            status: 'active'  // 在关联时过滤
        } },
        { $project: { name: 1, email: 1 } }  // 只投影需要的字段
      ],
      as: 'user'
    }
  }
], {
  allowDiskUse: true
});
```

## 错误处理

```javascript
try {
  const result = await collection('orders').aggregate([
    { $match: { status: 'paid' } },
    { $group: { _id: '$category', total: { $sum: '$amount' } } }
  ], {
    maxTimeMS: 5000
  });

  console.log('聚合结果:', result);
} catch (error) {
  if (error.code === 'TIMEOUT') {
    console.error('聚合操作超时');
  } else if (error.message?.includes('exceeded memory limit')) {
    console.error('内存溢出，请设置 allowDiskUse: true');
  } else if (error.code === 31249) {
    console.error('路径冲突或无效的管道阶段');
  } else {
    console.error('聚合失败:', error.message);
  }
}
```

## 与 find 的区别

| 特性 | find | aggregate |
|------|------|-----------|
| 用途 | 简单查询 | 复杂数据处理 |
| 联表查询 | ❌ | ✅ ($lookup) |
| 分组统计 | ❌ | ✅ ($group) |
| 数据转换 | 有限 | ✅ 强大 |
| 计算字段 | ❌ | ✅ |
| 多路聚合 | ❌ | ✅ ($facet) |
| 性能 | 快（简单查询） | 慢（复杂操作） |
| 内存使用 | 低 | 高（可用 allowDiskUse） |
| 流式处理 | ✅ | ✅ |
| 适用场景 | 基础 CRUD | 统计分析、报表 |

**选择建议**：
- 简单的文档查询：使用 `find`
- 需要统计、分组、计算：使用 `aggregate`
- 需要联表查询：使用 `aggregate` + `$lookup`
- 需要复杂的数据转换：使用 `aggregate`

## 常见聚合操作符

### 分组累加器

| 操作符 | 说明 | 示例 |
|--------|------|------|
| `$sum` | 求和 | `{ total: { $sum: '$amount' } }` |
| `$avg` | 平均值 | `{ avgPrice: { $avg: '$price' } }` |
| `$max` | 最大值 | `{ maxScore: { $max: '$score' } }` |
| `$min` | 最小值 | `{ minPrice: { $min: '$price' } }` |
| `$first` | 第一个值 | `{ firstOrder: { $first: '$orderId' } }` |
| `$last` | 最后一个值 | `{ lastOrder: { $last: '$orderId' } }` |
| `$push` | 推入数组 | `{ items: { $push: '$name' } }` |
| `$addToSet` | 去重推入数组 | `{ tags: { $addToSet: '$tag' } }` |

### 条件操作符

| 操作符 | 说明 | 示例 |
|--------|------|------|
| `$cond` | 三元条件 | `{ $cond: [{ $gte: ['$age', 18] }, 'adult', 'minor'] }` |
| `$switch` | 多分支条件 | `{ $switch: { branches: [...], default: '...' } }` |
| `$ifNull` | 空值处理 | `{ $ifNull: ['$email', 'N/A'] }` |

### 数学操作符

| 操作符 | 说明 | 示例 |
|--------|------|------|
| `$add` | 加法 | `{ $add: ['$price', '$tax'] }` |
| `$subtract` | 减法 | `{ $subtract: ['$amount', '$discount'] }` |
| `$multiply` | 乘法 | `{ $multiply: ['$price', '$quantity'] }` |
| `$divide` | 除法 | `{ $divide: ['$total', '$count'] }` |

### 字符串操作符

| 操作符 | 说明 | 示例 |
|--------|------|------|
| `$concat` | 字符串连接 | `{ $concat: ['$firstName', ' ', '$lastName'] }` |
| `$substr` | 子字符串 | `{ $substr: ['$name', 0, 3] }` |
| `$toUpper` | 转大写 | `{ $toUpper: '$code' }` |
| `$toLower` | 转小写 | `{ $toLower: '$email' }` |

### 日期操作符

| 操作符 | 说明 | 示例 |
|--------|------|------|
| `$dateToString` | 日期格式化 | `{ $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }` |
| `$year` | 提取年份 | `{ $year: '$createdAt' }` |
| `$month` | 提取月份 | `{ $month: '$createdAt' }` |
| `$dayOfMonth` | 提取日期 | `{ $dayOfMonth: '$createdAt' }` |

## 参考资料

- [MongoDB Aggregation 文档](https://docs.mongodb.com/manual/aggregation/)
- [aggregate 方法示例](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/aggregate.ts)
- [aggregate 方法测试](../../test/integration/mongodb/aggregate.test.ts)
- [find 方法文档](./find.md)

## 常见问题 FAQ

### Q1: aggregate 和 find 应该如何选择？

**A**: 根据查询复杂度选择：
- **使用 find**：简单的文档查询、条件过滤、排序、分页
- **使用 aggregate**：需要统计、分组、联表、复杂计算

### Q2: 为什么 aggregate 比 find 慢？

**A**: aggregate 需要经过多个处理阶段，每个阶段都会消耗资源。优化建议：
- 尽早使用 $match 过滤数据
- 确保过滤字段有索引
- 使用 $limit 限制处理数量
- 只投影需要的字段

### Q3: 如何优化大数据量的聚合操作？

**A**:
1. ✅ 设置 `allowDiskUse: true`
2. ✅ 确保关联字段和过滤字段有索引
3. ✅ 使用流式处理（`stream: true`）
4. ✅ 适当增加 `maxTimeMS`
5. ✅ 使用 explain 分析性能瓶颈

### Q4: $lookup 性能差怎么办？

**A**: 优化策略：
- 确保关联字段有索引
- 使用 pipeline 形式，在关联时就过滤数据
- 避免多级嵌套 $lookup
- 考虑数据冗余设计，减少 $lookup 使用
- 大数据量时设置 `allowDiskUse: true`

### Q5: 什么时候使用流式处理？

**A**: 适合场景：
- 数据量超过 10 万条
- 需要逐条处理或转换数据
- 内存有限制
- 数据导出或 ETL 操作

### Q6: 聚合管道的执行顺序重要吗？

**A**: 非常重要！优化顺序：
1. $match（尽早过滤）
2. $sort（使用索引排序）
3. $limit（尽早限制数量）
4. $lookup（关联其他集合）
5. $unwind（展开数组）
6. $group（分组计算）
7. $project（字段投影）

## 最佳实践

### 1. 尽早过滤数据

```javascript
// ✅ 好
await collection('orders').aggregate([
  { $match: { status: 'paid', amount: { $gte: 100 } } },  // 第一步过滤
  { $lookup: { from: 'users', ... } },
  { $project: { ... } }
]);
```

### 2. 使用索引（最佳实践）

```javascript
// 创建复合索引
// db.orders.createIndex({ status: 1, createdAt: -1 })

await collection('orders').aggregate([
  { $match: { status: 'paid' } },  // 使用索引
  { $sort: { createdAt: -1 } }     // 使用索引
], {
  hint: { status: 1, createdAt: -1 }
});
```

### 3. 只投影需要的字段

```javascript
await collection('orders').aggregate([
  { $match: { status: 'paid' } },
  {
    $project: {
      orderId: 1,
      amount: 1,
      createdAt: 1
      // 不要投影不需要的字段
    }
  }
]);
```

### 4. 大数据集使用流式处理

```javascript
const stream = await collection('orders').aggregate([
  { $match: { year: 2024 } },
  { $project: { orderId: 1, amount: 1 } }
], {
  stream: true,
  batchSize: 1000,
  allowDiskUse: true
});
```

### 5. 设置合理的超时时间

```javascript
await collection('orders').aggregate([
  { $match: { ... } },
  { $group: { ... } }
], {
  maxTimeMS: 10000  // 复杂聚合设置较长超时
});
```

---

## 🆕 统一表达式系统

### 概述（🆕 统一表达式系统）

monSQLize 内置统一表达式系统，提供常用操作符，让 MongoDB 聚合查询更清晰。

### 核心优势

1. **简洁易读** - 类似SQL的表达式语法
2. **类型安全** - 自动类型检查和转换
3. **高性能** - LRU缓存，>90%命中率
4. **上下文感知** - 自动适配$match/$project/$group
5. **100%兼容** - 无破坏性变更

### 快速开始

```javascript
import { expr } from 'monsqlize';

// ❌ MongoDB原生（繁琐）
await users.aggregate([
  {
    $project: {
      fullName: { $concat: ['$firstName', ' ', '$lastName'] },
      age: { $subtract: [{ $year: new Date() }, { $year: '$birthDate' }] }
    }
  }
]);

// ✅ 统一表达式（简洁）
await users.aggregate([
  {
    $project: {
      fullName: expr("CONCAT(firstName, ' ', lastName)"),
      age: expr("YEAR(CURRENT_DATE) - YEAR(birthDate)")
    }
  }
]);
```

### 支持的操作符 (67个)

#### 条件表达式 (2个)
- `? :` - 三元运算符：`score >= 60 ? 'Pass' : 'Fail'`
- `??` - 空值合并：`nickname ?? username`

#### 比较操作符 (6个)
- `>` `>=` `<` `<=` `===` `!==`
- 示例：`age >= 18 && status === 'active'`

#### 逻辑操作符 (3个)
- `&&` - 逻辑与
- `||` - 逻辑或
- `NOT()` - 逻辑非

#### 算术运算 (5个)
- `+` `-` `*` `/` `%`
- 示例：`price * (1 - discount / 100)`

#### 数学函数 (6个)
- `ABS(x)` - 绝对值
- `CEIL(x)` - 向上取整
- `FLOOR(x)` - 向下取整
- `ROUND(x)` - 四舍五入
- `SQRT(x)` - 平方根
- `POW(x, y)` - 幂运算

#### 字符串基础 (6个)
- `CONCAT(str1, str2, ...)` - 字符串拼接
- `UPPER(str)` - 转大写
- `LOWER(str)` - 转小写
- `TRIM(str)` - 去除首尾空格
- `SUBSTR(str, start, len)` - 子字符串
- `LENGTH(str)` - 字符串长度

#### 字符串高级 (6个)
- `SPLIT(str, delimiter)` - 字符串分割
- `REPLACE(str, find, replace)` - 字符串替换
- `INDEX_OF_STR(str, substr)` - 查找子串位置
- `LTRIM(str)` - 去除左侧空格
- `RTRIM(str)` - 去除右侧空格
- `SUBSTR_CP(str, start, len)` - Unicode安全子串

#### 数组基础 (6个)
- `SIZE(array)` - 数组长度
- `ARRAY_ELEM_AT(array, index)` - 访问数组元素（支持负索引）
- `IN(value, array)` - 包含判断
- `SLICE(array, start, end)` - 数组切片
- `FIRST(array)` - 首元素
- `LAST(array)` - 尾元素

#### 数组高级 (4个)
- `FILTER(array, var, condition)` - 数组过滤（Lambda表达式）
- `MAP(array, var, expression)` - 数组映射（Lambda表达式）
- `INDEX_OF(array, value)` - 元素查找
- `CONCAT_ARRAYS(array1, array2, ...)` - 数组合并

#### 日期操作 (6个)
- `YEAR(date)` - 提取年份
- `MONTH(date)` - 提取月份
- `DAY_OF_MONTH(date)` - 提取日
- `HOUR(date)` - 提取小时
- `MINUTE(date)` - 提取分钟
- `SECOND(date)` - 提取秒

#### 类型操作 (4个)
- `TYPE(value)` - 类型判断
- `IS_NUMBER(value)` - 是否数字
- `IS_ARRAY(value)` - 是否数组
- `EXISTS(field)` - 字段存在性

#### 类型转换 (4个)
- `TO_INT(value)` - 转整数
- `TO_STRING(value)` - 转字符串
- `OBJECT_TO_ARRAY(obj)` - 对象转数组
- `ARRAY_TO_OBJECT(array)` - 数组转对象

#### 高频操作 (3个)
- `REGEX(str, pattern)` - 正则匹配
- `MERGE_OBJECTS(obj1, obj2, ...)` - 对象合并
- `SET_UNION(array1, array2)` - 集合并集

#### 聚合累加器 (9个)
- `SUM(expr)` - 求和
- `AVG(expr)` - 平均值
- `MAX(expr)` - 最大值
- `MIN(expr)` - 最小值
- `COUNT()` - 计数
- `PUSH(expr)` - 数组收集
- `ADD_TO_SET(expr)` - 去重收集
- `FIRST(expr)` - $group中首元素
- `LAST(expr)` - $group中尾元素

#### 条件扩展 (1个)
- `SWITCH(cond1, val1, cond2, val2, ..., default)` - 多分支条件

### 完整示例

#### 示例 1: 用户信息处理

```javascript
await collection('users').aggregate([
  {
    $project: {
      // 字符串处理
      fullName: expr("CONCAT(firstName, ' ', lastName)"),
      email: expr("LOWER(TRIM(email))"),

      // 年龄计算
      age: expr("YEAR(CURRENT_DATE) - YEAR(birthDate)"),
      ageGroup: expr("SWITCH(age < 18, 'Minor', age < 65, 'Adult', 'Senior')"),

      // 状态判断
      status: expr("active === true && verified === true ? 'Active' : 'Inactive'"),

      // 数组统计
      tagCount: expr("SIZE(tags)"),
      hasPremiumTag: expr("IN('premium', tags)")
    }
  }
]);
```

#### 示例 2: 订单统计分析

```javascript
await collection('orders').aggregate([
  {
    $project: {
      // 价格计算
      originalPrice: 1,
      discount: 1,
      finalPrice: expr("originalPrice * (1 - discount / 100)"),
      savings: expr("originalPrice - finalPrice"),
      savingsPercent: expr("(savings / originalPrice * 100).toFixed(2)"),

      // 日期提取
      year: expr("YEAR(createdAt)"),
      month: expr("MONTH(createdAt)"),
      day: expr("DAY_OF_MONTH(createdAt)"),

      // 状态分类
      statusLabel: expr("SWITCH(status === 'paid', 'Paid', status === 'pending', 'Pending', 'Cancelled')")
    }
  },
  {
    $group: {
      _id: { year: '$year', month: '$month' },
      totalOrders: expr("COUNT()"),
      totalRevenue: expr("SUM(finalPrice)"),
      avgOrder: expr("AVG(finalPrice)"),
      maxOrder: expr("MAX(finalPrice)")
    }
  }
]);
```

#### 示例 3: 数组处理（Lambda表达式）

```javascript
await collection('products').aggregate([
  {
    $project: {
      name: 1,

      // Lambda表达式 - 过滤
      activeTags: expr("FILTER(tags, tag, tag.active === true)"),
      expensiveItems: expr("FILTER(items, item, item.price > 100)"),

      // Lambda表达式 - 映射
      tagNames: expr("MAP(tags, tag, tag.name)"),
      itemPrices: expr("MAP(items, item, item.price)"),

      // 数组操作
      firstTag: expr("FIRST(tags)"),
      lastTag: expr("LAST(tags)"),
      tagCount: expr("SIZE(tags)"),

      // 组合使用
      activeTagNames: expr("MAP(FILTER(tags, t, t.active === true), t, t.name)")
    }
  }
]);
```

#### 示例 4: 复杂业务逻辑

```javascript
await collection('students').aggregate([
  {
    $project: {
      name: 1,

      // 成绩等级（多分支）
      grade: expr("SWITCH(score >= 90, 'A', score >= 80, 'B', score >= 70, 'C', score >= 60, 'D', 'F')"),

      // 奖学金计算
      scholarship: expr("score >= 95 ? 5000 : (score >= 90 ? 3000 : (score >= 85 ? 2000 : 0))"),

      // 综合评价
      evaluation: expr("CONCAT(name, ' scored ', TO_STRING(score), ' points, grade: ', grade)"),

      // 是否优秀
      isExcellent: expr("score >= 90 && attendance > 0.95 && conduct === 'good'")
    }
  }
]);
```

### 性能优化

#### LRU缓存机制

统一表达式系统内置LRU缓存：

- **编译时间**: <1ms
- **缓存命中率**: >90%
- **显式失效**: 通过 `cache.invalidate`、`autoInvalidate` 或全局 `cache.autoInvalidate` 管理

```javascript
// 相同表达式会自动缓存
const expr1 = expr("CONCAT(firstName, ' ', lastName)");  // 首次编译
const expr2 = expr("CONCAT(firstName, ' ', lastName)");  // 缓存命中
```

#### 性能建议

1. **简化表达式** - 避免过度复杂的嵌套
2. **索引支持** - $match中使用表达式时确保有索引
3. **批量处理** - 利用$project减少后续处理量

### 最佳实践（🆕 统一表达式系统）

#### 1. 字段引用

```javascript
// ✅ 正确 - 直接使用字段名
expr("CONCAT(firstName, ' ', lastName)")

// ❌ 错误 - 不要加$前缀
expr("CONCAT($firstName, ' ', $lastName)")
```

#### 2. 字符串字面量

```javascript
// ✅ 支持单引号和双引号
expr("status === 'active'")
expr('status === "active"')
```

#### 3. 嵌套函数

```javascript
// ✅ 支持任意深度嵌套
expr("UPPER(TRIM(LOWER(email)))")
expr("CONCAT(UPPER(firstName), ' ', UPPER(lastName))")
```

#### 4. Lambda变量

```javascript
// ✅ Lambda变量名可自定义
expr("FILTER(tags, tag, tag.active === true)")
expr("FILTER(tags, t, t.active === true)")
expr("MAP(items, item, item.price)")
```

### 常见问题（🆕 统一表达式系统）

**Q: 是否兼容原生MongoDB语法？**
A: 完全兼容！可以在同一个查询中混合使用：

```javascript
await collection('users').aggregate([
  {
    $match: { status: 'active' }  // 原生语法
  },
  {
    $project: {
      fullName: expr("CONCAT(firstName, ' ', lastName)"),  // 统一表达式
      email: { $toLower: '$email' }  // 原生语法
    }
  }
]);
```

**Q: 性能如何？**
A:
- 编译时间: <1ms（首次）
- 缓存命中: >90%（重复表达式）
- 运行时: 与原生MongoDB相同（编译后就是原生语法）

**Q: 是否支持所有MongoDB操作符？**
A: 支持67个常用操作符，覆盖95%+使用场景。未来会根据需求继续扩展。

**Q: 如何调试表达式？**
A: 查看编译后的MongoDB原生语法：

```javascript
import { expr, compilePipelineExpressions } from 'monsqlize';

const pipeline = [
  {
    $project: {
      fullName: expr("CONCAT(firstName, ' ', lastName)")
    }
  }
];

const compiled = compilePipelineExpressions(pipeline);
console.log(compiled);  // 查看编译后的 MongoDB 原生语法
```

**Q: 是否影响向后兼容？**
A: 完全不影响！统一表达式是可选功能，不使用`expr()`就是原生MongoDB语法。

---

### 技术细节

#### 上下文感知

编译器会自动检测当前上下文（$match/$project/$group），生成最优的MongoDB操作符：

- **$match**: 使用查询操作符（$eq, $gt等）
- **$project**: 使用聚合表达式（$concat, $add等）
- **$group**: 使用累加器（$sum, $avg等）

#### Lambda表达式解析

FILTER和MAP的Lambda表达式完整支持：

```javascript
// 语法：FILTER(array, variable, condition)
expr("FILTER(items, item, item.price > 100 && item.stock > 0)")

// 编译为MongoDB原生：
{
  $filter: {
    input: '$items',
    as: 'item',
    cond: {
      $and: [
        { $gt: ['$$item.price', 100] },
        { $gt: ['$$item.stock', 0] }
      ]
    }
  }
}
```

---

## 相关链接

- [测试用例](../../test/unit/expression/) - 107个测试示例
- [验证进度](../../test/validation/VERIFICATION-PROGRESS.md) - 当前发布验证入口
