# deleteBatch - 批量删除文档


## 概述

`deleteBatch` 方法通过流式查询分批删除大量文档，适用于需要删除成千上万甚至百万级数据的场景，避免一次性删除造成的内存压力和性能问题。

### 特点

- ✅ **流式查询** - 基于 `find()` 的流式API，恒定内存占用
- ✅ **进度监控** - 实时查看删除进度和百分比
- ✅ **错误处理** - 支持 stop/skip/collect/retry 四种策略
- ✅ **自动重试** - 网络不稳定时自动重试失败批次
- ✅ **缓存失效** - 支持显式清理相关集合缓存
- ✅ **慢查询日志** - 集成到现有慢查询日志系统

### 适用场景

| 场景 | 数据量 | 推荐方法 | 原因 |
|------|--------|---------|------|
| 清理过期日志 | > 10万 | **deleteBatch** | 避免一次性删除过多 |
| 删除测试数据 | > 1万 | **deleteBatch** | 可监控进度 |
| 数据归档清理 | > 10万 | **deleteBatch** | 需要进度监控 |
| 删除少量数据 | < 1000 | deleteMany | deleteMany 更简单 |

---

## API 参数说明

### 方法签名

```typescript
collection(name: string).deleteBatch(
  filter: object,
  options?: DeleteBatchOptions
): Promise<DeleteBatchResult>
```

### 参数详解

**第一个参数：filter**（必需）
- 类型：`object`
- 说明：删除条件，与 `deleteMany` 相同

**第二个参数：options**（可选）

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| **batchSize** | `number` | `1000` | 每批删除的文档数量 |
| **estimateProgress** | `boolean` | `true` | 是否预先 count 总数（用于进度百分比） |
| **onProgress** | `Function` | - | 进度回调函数 `(progress) => {}` |
| **onError** | `string` | `'stop'` | 错误处理策略: `'stop'`/`'skip'`/`'collect'`/`'retry'` |
| **retryAttempts** | `number` | `3` | 失败批次最大重试次数（onError='retry'时） |
| **retryDelay** | `number` | `1000` | 重试延迟时间（毫秒） |
| **onRetry** | `Function` | - | 重试回调函数 `(retryInfo) => {}` |
| **writeConcern** | `object` | `{ w: 1 }` | 写确认级别 |
| **comment** | `string` | - | 操作注释（用于日志追踪） |

### 返回值

```typescript
{
  acknowledged: boolean,      // 是否被确认
  totalCount: number | null,  // 总文档数（estimateProgress=true时有值）
  deletedCount: number,       // 成功删除数
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
  deleted: number,         // 已删除数量
  total: number | null,    // 总数量（estimateProgress=true时有值）
  percentage: number | null, // 完成百分比（0-100，estimateProgress=true时有值）
  errors: number,          // 错误数量
  retries: number          // 重试数量
}
```

---

## 使用示例

### 1. 基础用法 - 清理过期日志

```javascript
// 删除 90 天前的日志
const expireDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

const result = await collection('logs').deleteBatch(
    { createdAt: { $lt: expireDate } },
    { batchSize: 5000 }
);

console.log(`删除 ${result.deletedCount} 条过期日志`);
```

### 2. 带进度监控 - 清理大量数据

```javascript
const result = await collection('logs').deleteBatch(
    { level: 'debug' },
    {
        batchSize: 5000,
        estimateProgress: true,  // 预先 count，显示百分比
        onProgress: (progress) => {
            console.log(`进度: ${progress.percentage}% (${progress.deleted}/${progress.total} 条)`);
        }
    }
);
```

**输出示例**：
```text
进度: 20% (100000/500000 条)
进度: 40% (200000/500000 条)
进度: 60% (300000/500000 条)
进度: 80% (400000/500000 条)
进度: 100% (500000/500000 条)
```

### 3. 不预先 count - 避免性能开销

```javascript
// 数据量特别大时，预先 count 很慢，可以不 count
const result = await collection('logs').deleteBatch(
    { status: 'archived' },
    {
        batchSize: 5000,
        estimateProgress: false,  // 不预先 count
        onProgress: (progress) => {
            // percentage 为 null，但仍能看到已删除数量
            console.log(`已删除: ${progress.deleted} 条（批次 ${progress.currentBatch}）`);
        }
    }
);
```

### 4. 错误处理 - stop 策略（默认）

```javascript
const result = await collection('logs').deleteBatch(
    { userId: { $in: userIds } },
    {
        batchSize: 1000,
        onError: 'stop'  // 遇到错误立即停止
    }
);

if (result.errors.length > 0) {
    console.error('删除失败:', result.errors[0].message);
}
```

### 5. 错误处理 - skip 策略

```javascript
const result = await collection('temp_data').deleteBatch(
    { category: 'test' },
    {
        batchSize: 5000,
        onError: 'skip'  // 跳过失败的批次，继续后续批次
    }
);

console.log(`成功删除: ${result.deletedCount} 条`);
console.log(`失败批次: ${result.errors.length} 个`);
```

### 6. 错误处理 - retry 策略（推荐）

```javascript
const result = await collection('logs').deleteBatch(
    { status: 'expired' },
    {
        batchSize: 5000,
        onError: 'retry',      // 失败时自动重试
        retryAttempts: 3,      // 最多重试 3 次
        retryDelay: 1000,      // 每次重试间隔 1 秒
        onRetry: (info) => {
            console.log(`批次 ${info.batchIndex + 1} 第 ${info.attempt} 次重试...`);
        }
    }
);

console.log(`重试次数: ${result.retries.length}`);
```

### 7. 错误处理 - collect 策略

```javascript
const result = await collection('logs').deleteBatch(
    { type: 'temp' },
    {
        batchSize: 1000,
        onError: 'collect'  // 收集所有错误，继续执行
    }
);

// 查看所有错误
result.errors.forEach((err, idx) => {
    console.log(`批次 ${err.batchIndex + 1} 错误: ${err.message}`);
});
```

### 8. 复杂查询条件

```javascript
// 删除符合多个条件的文档
const result = await collection('orders').deleteBatch(
    {
        status: 'cancelled',
        createdAt: { $lt: new Date('2024-01-01') },
        $or: [
            { paymentStatus: 'unpaid' },
            { amount: { $eq: 0 } }
        ]
    },
    {
        batchSize: 5000,
        estimateProgress: true,
        onProgress: (p) => {
            console.log(`删除进度: ${p.percentage}%`);
        }
    }
);
```

### 9. 使用 comment 追踪操作

```javascript
const result = await collection('logs').deleteBatch(
    { level: 'debug' },
    {
        batchSize: 5000,
        comment: 'cleanup-debug-logs'  // 在慢查询日志中会显示
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
// 示例：根据数据量动态调整
const totalCount = await collection('logs').count({ status: 'expired' });
const batchSize = totalCount > 1000000 ? 10000 : 5000;

await collection('logs').deleteBatch(
    { status: 'expired' },
    { batchSize }
);
```

### 2. 是否预先 count

```javascript
// ✅ 小数据量：预先 count，显示进度
if (estimatedCount < 1000000) {
    await collection('logs').deleteBatch(filter, {
        estimateProgress: true  // 显示百分比
    });
}

// ✅ 大数据量：不 count，避免性能开销
else {
    await collection('logs').deleteBatch(filter, {
        estimateProgress: false  // 不显示百分比，但更快
    });
}
```

### 3. 索引优化

```javascript
// 删除前确保有索引
await collection('logs').createIndex({ createdAt: 1 });

// 然后再删除
await collection('logs').deleteBatch(
    { createdAt: { $lt: expireDate } },
    { batchSize: 5000 }
);
```

### 4. 错误策略选择

| 场景 | 推荐策略 | 原因 |
|------|---------|------|
| 生产环境清理 | **retry** | 自动重试，减少失败 |
| 测试数据清理 | **skip** | 快速清理，跳过失败 |
| 关键数据删除 | **stop** | 遇错立即停止，保证一致性 |
| 批量清理任务 | **collect** | 收集所有错误，事后处理 |

---

## 常见问题

### Q1: deleteBatch 和 deleteMany 有什么区别？

| 对比项 | deleteBatch | deleteMany |
|--------|-------------|------------|
| **适用数据量** | > 10000 条 | < 10000 条 |
| **内存占用** | 恒定（流式） | 线性增长 |
| **进度监控** | ✅ 支持 | ❌ 不支持 |
| **错误处理** | ✅ 4种策略 | ❌ 只能全部失败 |
| **自动重试** | ✅ 支持 | ❌ 不支持 |
| **性能** | 大数据量更优 | 小数据量更快 |

**建议**：
- 数据量 < 10000 条 → 使用 `deleteMany`
- 数据量 ≥ 10000 条 → 使用 `deleteBatch`

### Q2: deleteBatch 会造成数据不一致吗？

**答**: `deleteBatch` 会通过游标读取匹配文档的 `_id`，再按批次删除。它本身不会自动创建 MongoDB 事务，也不承诺快照隔离。如果需要事务快照，请在显式事务中执行并传入事务 `session`。

```javascript
// ✅ 安全：即使其他操作同时插入新数据，也不会被误删
await collection('logs').deleteBatch(
    { createdAt: { $lt: expireDate } },
    { batchSize: 5000 }
);
```

### Q3: 如何知道删除了哪些文档？

```javascript
// 方法1：删除前先查询
const toDelete = await collection('logs').find({ status: 'expired' });
console.log('将删除:', toDelete.map(d => d._id));

// 然后删除
await collection('logs').deleteBatch({ status: 'expired' });

// 方法2：使用软删除
await collection('logs').updateBatch(
    { status: 'expired' },
    { $set: { deleted: true, deletedAt: new Date() } }
);
```

### Q4: deleteBatch 会触发慢查询日志吗？

**答**: 会。如果删除操作超过阈值（默认 500ms），会记录慢查询日志。

```javascript
// 在慢查询日志中可以看到
// [WARN] [deleteBatch] 慢操作警告 {
//   ns: 'mydb.logs',
//   duration: 25000,
//   deletedCount: 500000,
//   batchCount: 100
// }
```

### Q5: 可以在事务中使用 deleteBatch 吗？

**答**: 可以，但需要注意：

```javascript
const session = await msq.startSession();

try {
    await session.withTransaction(async () => {
        // ✅ 支持在事务中使用
        await collection('orders').deleteBatch(
            { status: 'cancelled' },
            { batchSize: 1000 }
        );

        await collection('payments').deleteBatch(
            { orderId: { $in: cancelledIds } },
            { batchSize: 1000 }
        );
    });
} finally {
    await session.endSession();
}
```

### Q6: 如何估算删除时间？

```javascript
// 性能参考（内存数据库）
// 删除速度：约 30000-50000 条/秒

const totalCount = 1000000;
const estimatedTime = totalCount / 40000;  // 约 25 秒

console.log(`预计耗时: ${Math.ceil(estimatedTime)} 秒`);
```

---

## 参考资料

- [updateBatch - 批量更新文档](./updateBatch.md)
- [insertBatch - 批量插入文档](./insertBatch.md)
- [find - 流式查询](./find.md)
- [deleteMany - 批量删除（小数据量）](./delete-many.md)
- [使用示例](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/batch-operations.ts)
- [Batch 写入测试](../../test/unit/writes/batch.test.ts)
