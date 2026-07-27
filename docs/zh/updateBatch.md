# updateBatch - 批量更新文档


## 概述

`updateBatch` 方法通过流式查询分批更新大量文档，适用于需要更新成千上万甚至百万级数据的场景，避免一次性更新造成的内存压力和性能问题。

### 特点

- ✅ **流式查询** - 基于 `find()` 的流式API，恒定内存占用
- ✅ **进度监控** - 实时查看更新进度和百分比
- ✅ **错误处理** - 支持 stop/skip/collect/retry 四种策略
- ✅ **自动重试** - 网络不稳定时自动重试失败批次
- ✅ **缓存失效** - 支持显式清理相关集合缓存
- ✅ **全操作符** - 支持所有 MongoDB 更新操作符

### 适用场景

| 场景 | 数据量 | 推荐方法 | 原因 |
|------|--------|---------|------|
| 批量调价 | > 10万 | **updateBatch** | 避免一次性更新过多 |
| 数据迁移 | > 1万 | **updateBatch** | 可监控进度 |
| 批量状态修改 | > 10万 | **updateBatch** | 需要进度监控 |
| 更新少量数据 | < 1000 | updateMany | updateMany 更简单 |

---

## API 参数说明

### 方法签名

```typescript
collection(name: string).updateBatch(
  filter: object,
  update: object,
  options?: UpdateBatchOptions
): Promise<UpdateBatchResult>
```

### 参数详解

**第一个参数：filter**（必需）
- 类型：`object`
- 说明：更新条件，与 `updateMany` 相同

**第二个参数：update**（必需）
- 类型：`object`
- 说明：更新操作，**必须使用更新操作符**（`$set`, `$inc`, `$push` 等）
- ❌ 错误：`{ name: 'new' }`
- ✅ 正确：`{ $set: { name: 'new' } }`

**第三个参数：options**（可选）

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| **batchSize** | `number` | `1000` | 每批更新的文档数量 |
| **estimateProgress** | `boolean` | `true` | 是否预先 count 总数（用于进度百分比） |
| **onProgress** | `Function` | - | 进度回调函数 `(progress) => {}` |
| **onError** | `string` | `'stop'` | 错误处理策略: `'stop'`/`'skip'`/`'collect'`/`'retry'` |
| **retryAttempts** | `number` | `3` | 失败批次最大重试次数（onError='retry'时） |
| **retryDelay** | `number` | `1000` | 重试延迟时间（毫秒） |
| **onRetry** | `Function` | - | 重试回调函数 `(retryInfo) => {}` |
| **writeConcern** | `object` | `{ w: 1 }` | 写确认级别 |
| **upsert** | `boolean` | `false` | `updateBatch` 不支持；传入 `true` 会抛错。单文档 upsert 使用 `upsertOne`；只有需要 MongoDB 原生“无匹配时插入单个文档”的语义时才使用 `updateMany(..., { upsert: true })`。 |
| **arrayFilters** | `Array` | - | 数组过滤器 |
| **comment** | `string` | - | 操作注释（用于日志追踪） |

### 返回值

```typescript
{
  acknowledged: boolean,      // 是否被确认
  totalCount: number | null,  // 总文档数（estimateProgress=true时有值）
  matchedCount: number,       // 匹配文档数
  modifiedCount: number,      // 成功更新数
  upsertedCount: number,      // 始终为 0，因为 updateBatch 会拒绝 upsert=true
  batchCount: number,         // 总批次数
  errors: Array<Object>,      // 错误列表
  retries: Array<Object>      // 重试记录列表
}
```

### 进度回调参数

```typescript
{
  currentBatch: number,    // 当前批次号（从1开始）
  totalBatches: number,    // 总批次数
  modified: number,        // 已更新数量
  total: number | null,    // 总数量（estimateProgress=true时有值）
  percentage: number | null, // 完成百分比（0-100，estimateProgress=true时有值）
  errors: number,          // 错误数量
  retries: number          // 重试数量
}
```

---

## 使用示例

### 1. 基础用法 - 批量修改状态

```javascript
// 将所有待处理订单标记为已处理
const result = await collection('orders').updateBatch(
    { status: 'pending' },
    { $set: { status: 'processed', processedAt: new Date() } },
    { batchSize: 5000 }
);

console.log(`更新 ${result.modifiedCount} 个订单`);
```

### 2. 带进度监控 - 数据迁移

```javascript
const result = await collection('users').updateBatch(
    { oldField: { $exists: true } },
    {
        $set: { newField: 'value' },
        $unset: { oldField: '' }
    },
    {
        batchSize: 5000,
        estimateProgress: true,
        onProgress: (progress) => {
            console.log(`迁移进度: ${progress.percentage}% (${progress.modified}/${progress.total} 条)`);
        }
    }
);
```

**输出示例**：
```text
迁移进度: 20% (100000/500000 条)
迁移进度: 40% (200000/500000 条)
迁移进度: 60% (300000/500000 条)
迁移进度: 80% (400000/500000 条)
迁移进度: 100% (500000/500000 条)
```

### 3. $set - 设置字段值

```javascript
// 批量设置用户的会员等级
await collection('users').updateBatch(
    { registeredDays: { $gte: 365 } },
    {
        $set: {
            vipLevel: 'gold',
            vipStartAt: new Date()
        }
    },
    { batchSize: 5000 }
);
```

### 4. $inc - 增减数值

```javascript
// 批量增加商品库存
await collection('products').updateBatch(
    { category: 'electronics' },
    {
        $inc: {
            stock: 100,        // 库存 +100
            version: 1         // 版本号 +1
        }
    },
    { batchSize: 3000 }
);
```

### 5. $push - 添加数组元素

```javascript
// 批量为用户添加标签
await collection('users').updateBatch(
    { isActive: true },
    {
        $push: {
            tags: 'promoted',
            notifications: {
                type: 'promo',
                createdAt: new Date()
            }
        }
    },
    { batchSize: 5000 }
);
```

### 6. $pull - 删除数组元素

```javascript
// 批量删除过期的通知
await collection('users').updateBatch(
    { 'notifications.0': { $exists: true } },
    {
        $pull: {
            notifications: {
                expiresAt: { $lt: new Date() }
            }
        }
    },
    { batchSize: 5000 }
);
```

### 7. $mul - 乘法运算

```javascript
// 批量调价（所有价格上涨 10%）
await collection('products').updateBatch(
    { price: { $gt: 0 } },
    {
        $mul: { price: 1.1 },
        $set: { updatedAt: new Date() }
    },
    {
        batchSize: 5000,
        estimateProgress: true,
        onProgress: (p) => console.log(`调价进度: ${p.percentage}%`)
    }
);
```

### 8. 多个操作符组合

```javascript
// 复杂的批量更新：调价 + 增库存 + 添加标签
await collection('products').updateBatch(
    { category: 'sale' },
    {
        $mul: { price: 0.8 },              // 价格打 8 折
        $inc: { stock: 50 },               // 库存 +50
        $push: { tags: 'discount' },       // 添加折扣标签
        $set: {
            onSale: true,
            saleStartAt: new Date()
        }
    },
    { batchSize: 3000 }
);
```

### 9. 使用 arrayFilters - 更新数组中的特定元素

```javascript
// 批量更新订单中特定商品的状态
await collection('orders').updateBatch(
    { 'items.status': 'pending' },
    {
        $set: {
            'items.$[elem].status': 'shipped',
            'items.$[elem].shippedAt': new Date()
        }
    },
    {
        batchSize: 3000,
        arrayFilters: [{ 'elem.status': 'pending' }]
    }
);
```

### 10. 错误处理 - retry 策略（推荐）

```javascript
const result = await collection('users').updateBatch(
    { lastActive: { $lt: new Date('2024-01-01') } },
    { $set: { status: 'inactive' } },
    {
        batchSize: 5000,
        onError: 'retry',
        retryAttempts: 3,
        retryDelay: 1000,
        onRetry: (info) => {
            console.log(`批次 ${info.batchIndex + 1} 第 ${info.attempt} 次重试`);
        }
    }
);

console.log(`更新完成，重试 ${result.retries.length} 次`);
```

### 11. 不支持 upsert

`updateBatch` 会先通过游标选择匹配文档的 `_id`，再按 `_id` 分批更新。这个模型没有稳定的“未匹配则插入”目标，因此 `upsert: true` 会被拒绝。

单文档 upsert 请使用 `upsertOne()`；如果确实需要 MongoDB 原生多文档 update 语义，请直接使用 `updateMany(..., { upsert: true })`。

MongoDB 原生说明：`updateMany(filter, update, { upsert: true })` 支持 upsert，但如果没有任何文档匹配，MongoDB 只会基于 `filter` 中的等值条件和 `update` 文档插入一个新文档。它不是“按输入列表逐条 upsert”。多条独立 key 的 upsert 请循环调用 `upsertOne()`，或使用原生 `bulkWrite` 的 `updateOne` + `upsert: true` 模型。

```javascript
// 正确：单文档 upsert
await collection('user_settings').upsertOne(
    { userId: 'user_123' },
    {
        $set: {
            theme: 'light',
            language: 'zh-CN',
            updatedAt: new Date()
        },
        $setOnInsert: {
            createdAt: new Date()
        }
    }
);
```

### 12. 复杂查询条件

```javascript
// 批量更新满足多个条件的文档
await collection('orders').updateBatch(
    {
        status: 'pending',
        createdAt: { $lt: new Date('2024-01-01') },
        $or: [
            { paymentStatus: 'paid' },
            { amount: 0 }
        ]
    },
    {
        $set: {
            status: 'cancelled',
            cancelledAt: new Date(),
            cancelReason: '超时自动取消'
        }
    },
    {
        batchSize: 5000,
        estimateProgress: true,
        onProgress: (p) => console.log(`取消进度: ${p.percentage}%`)
    }
);
```

---

## 性能优化建议

### 1. 批次大小选择

| 数据量 | 推荐 batchSize | 原因 |
|--------|---------------|------|
| < 10万 | 1000-2000 | 小批次，快速响应 |
| 10万-100万 | 3000-5000 | 平衡性能和内存 |
| > 100万 | 5000-10000 | 大批次，减少网络开销 |

```javascript
// 动态调整批次大小
const totalCount = await collection('users').count({ status: 'inactive' });
const batchSize = totalCount > 1000000 ? 10000 : 5000;

await collection('users').updateBatch(
    { status: 'inactive' },
    { $set: { status: 'archived' } },
    { batchSize }
);
```

### 2. 索引优化

```javascript
// 更新前确保有索引
await collection('orders').createIndex({ status: 1, createdAt: 1 });

// 然后再更新
await collection('orders').updateBatch(
    { status: 'pending', createdAt: { $lt: expireDate } },
    { $set: { status: 'expired' } },
    { batchSize: 5000 }
);
```

### 3. 避免全表扫描

```javascript
// ❌ 不好：没有索引的字段
await collection('users').updateBatch(
    { customField: 'value' },  // 如果 customField 没有索引，会全表扫描
    { $set: { status: 'updated' } }
);

// ✅ 好：使用有索引的字段
await collection('users').updateBatch(
    { _id: { $in: userIds } },  // _id 有默认索引
    { $set: { status: 'updated' } }
);
```

### 4. 更新操作优化

```javascript
// ❌ 低效：多次更新同一批数据
await collection('users').updateBatch(filter, { $set: { field1: 'a' } });
await collection('users').updateBatch(filter, { $set: { field2: 'b' } });

// ✅ 高效：一次更新多个字段
await collection('users').updateBatch(filter, {
    $set: {
        field1: 'a',
        field2: 'b'
    }
});
```

---

## 常见问题

### Q1: updateBatch 和 updateMany 有什么区别？

| 对比项 | updateBatch | updateMany |
|--------|-------------|------------|
| **适用数据量** | > 10000 条 | < 10000 条 |
| **内存占用** | 恒定（流式） | 线性增长 |
| **进度监控** | ✅ 支持 | ❌ 不支持 |
| **错误处理** | ✅ 4种策略 | ❌ 只能全部失败 |
| **自动重试** | ✅ 支持 | ❌ 不支持 |
| **性能** | 大数据量更优 | 小数据量更快 |

**建议**：
- 数据量 < 10000 条 → 使用 `updateMany`
- 数据量 ≥ 10000 条 → 使用 `updateBatch`

### Q2: updateBatch 会造成数据不一致吗？

**答**: `updateBatch` 会通过游标读取匹配文档的 `_id`，再按批次写入。它本身不会自动创建 MongoDB 事务，也不承诺快照隔离。如果需要事务快照，请在显式事务中执行并传入事务 `session`。

```javascript
// 如需事务快照，请在事务中执行，并传入事务 session
await collection('users').updateBatch(
    { status: 'inactive' },
    { $set: { status: 'archived' } },
    { batchSize: 5000 }
);
```

### Q3: 为什么必须使用更新操作符？

**答**: 这是 MongoDB 的要求，`updateMany` 也是如此。

```javascript
// ❌ 错误：直接赋值
await collection('users').updateBatch(
    { status: 'old' },
    { status: 'new' }  // 会抛出错误
);

// ✅ 正确：使用 $set
await collection('users').updateBatch(
    { status: 'old' },
    { $set: { status: 'new' } }
);
```

### Q4: 如何批量更新 _id？

**答**: 不推荐更新 _id。如果必须，请使用 `replaceOne` 或重新插入。

```javascript
// ❌ 不支持：更新 _id
await collection('users').updateBatch(
    { oldId: { $exists: true } },
    { $set: { _id: newId } }  // 会失败
);

// ✅ 推荐：保留旧 ID，添加新字段
await collection('users').updateBatch(
    { oldId: { $exists: true } },
    {
        $set: { newId: generateNewId() },
        $unset: { oldId: '' }
    }
);
```

### Q5: updateBatch 支持哪些更新操作符？

**答**: 支持所有 MongoDB 更新操作符。

**字段操作符**：
- `$set` - 设置字段值
- `$unset` - 删除字段
- `$rename` - 重命名字段
- `$setOnInsert` - MongoDB update 文档可包含该操作符，但只有 upsert 才有实际意义；`updateBatch` 会拒绝 `upsert: true`

**数值操作符**：
- `$inc` - 增减
- `$mul` - 乘法
- `$min` - 取最小值
- `$max` - 取最大值

**数组操作符**：
- `$push` - 添加元素
- `$pop` - 删除首/尾元素
- `$pull` - 删除匹配元素
- `$pullAll` - 删除多个元素
- `$addToSet` - 添加唯一元素

**其他操作符**：
- `$currentDate` - 设置当前日期

### Q6: 如何估算更新时间？

```javascript
// 性能参考（内存数据库）
// 更新速度：约 30000-40000 条/秒

const totalCount = 1000000;
const estimatedTime = totalCount / 35000;  // 约 29 秒

console.log(`预计耗时: ${Math.ceil(estimatedTime)} 秒`);
```

### Q7: 可以在事务中使用吗？

**答**: 可以。

```javascript
const session = await msq.startSession();

try {
    await session.withTransaction(async () => {
        await collection('orders').updateBatch(
            { status: 'pending' },
            { $set: { status: 'processing' } },
            { batchSize: 1000 }
        );

        await collection('inventory').updateBatch(
            { productId: { $in: productIds } },
            { $inc: { reserved: -1 } },
            { batchSize: 1000 }
        );
    });
} finally {
    await session.endSession();
}
```

---

## 参考资料

- [deleteBatch - 批量删除文档](./deleteBatch.md)
- [insertBatch - 批量插入文档](./insertBatch.md)
- [find - 流式查询](./find.md)
- [updateMany - 批量更新（小数据量）](./update-many.md)
- [MongoDB 更新操作符](https://www.mongodb.com/docs/manual/reference/operator/update/)
- [使用示例](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/batch-operations.ts)
- [Batch 写入测试](../../test/unit/writes/batch.test.ts)
