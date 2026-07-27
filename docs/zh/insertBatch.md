# insertBatch - 分批批量插入（支持自动重试）


`insertBatch` 方法提供自动分批插入大量文档的功能，支持失败重试、进度监控等高级特性，避免内存溢出和网络超时问题。

---

## 概述

当需要插入大量数据（如数万或数十万条）时，直接使用 `insertMany` 可能导致：
- **内存溢出** - 一次性加载过多数据
- **网络超时** - 单次请求时间过长
- **难以监控** - 无法追踪插入进度

`insertBatch` 通过自动分批、进度监控、错误处理、自动重试等特性解决这些问题。

| 方法 | 适用场景 | 数据量 | 特性 |
|------|---------|--------|------|
| **insertOne** | 单条插入 | 1 条 | 实时性好 |
| **insertMany** | 批量插入 | 1-10K 条 | 性能高 |
| **insertBatch** | 大规模导入 | 10K-1M+ 条 | 自动分批、进度监控、自动重试、错误处理 |

---

## API 参数说明

### 方法签名

```typescript
collection(name: string).insertBatch(
  documents: object[],
  options?: InsertBatchOptions
): Promise<InsertBatchResult>
```

### 参数详解

**第一个参数：documents**（必需）
- 类型：`object[]`
- 说明：要插入的文档数组

**第二个参数：options**（可选）

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| **batchSize** | `number` | `1000` | 每批插入的文档数量 |
| **concurrency** | `number` | `1` | 并发批次数（1=串行，>1=并行） |
| **ordered** | `boolean` | `false` | 批次内是否按顺序插入 |
| **onProgress** | `Function` | - | 进度回调函数 `(progress) => {}` |
| **onError** | `string` | `'stop'` | 错误处理策略: `'stop'`/`'skip'`/`'collect'`/`'retry'` |
| **retryAttempts** | `number` | `3` | 失败批次最大重试次数（onError='retry'时有效） |
| **retryDelay** | `number` | `1000` | 重试延迟时间（毫秒） |
| **onRetry** | `Function` | - | 重试回调函数 `(retryInfo) => {}` |
| **writeConcern** | `object` | `{ w: 1 }` | 写确认级别 |
| **bypassDocumentValidation** | `boolean` | `false` | 是否绕过文档验证 |
| **comment** | `string` | - | 操作注释（用于日志追踪） |

### 返回值

```typescript
{
  acknowledged: boolean,      // 是否被确认
  totalCount: number,          // 总文档数
  insertedCount: number,       // 成功插入数
  batchCount: number,          // 总批次数
  errors: Array<Object>,       // 错误列表
  retries: Array<Object>,      // 重试记录列表（新增）
  insertedIds: Object          // 插入的文档 _id 映射表
}
```

### 进度回调参数

```typescript
{
  currentBatch: number,    // 当前批次号（从1开始）
  totalBatches: number,    // 总批次数
  inserted: number,        // 已插入数量
  total: number,           // 总数量
  percentage: number,      // 完成百分比（0-100）
  errors: number,          // 错误数量
  retries: number          // 重试数量（新增）
}
```

---

## 使用示例

### 1. 基础用法 - 自动分批插入

```javascript
const largeDataset = Array.from({ length: 10000 }, (_, i) => ({
  name: `User ${i + 1}`,
  email: `user${i + 1}@example.com`,
  createdAt: new Date()
}));

const result = await collection('users').insertBatch(largeDataset, {
  batchSize: 1000  // 每批 1000 条，自动分为 10 批
});

console.log(`成功插入 ${result.insertedCount}/${result.totalCount} 条数据`);
console.log(`共 ${result.batchCount} 批，${result.errors.length} 个错误`);
```

### 2. 进度监控

```javascript
await collection('products').insertBatch(largeDataset, {
  batchSize: 500,
  onProgress: (progress) => {
    console.log(
      `进度: ${progress.percentage}% ` +
      `(批次 ${progress.currentBatch}/${progress.totalBatches})`
    );
  }
});

// 输出:
// 进度: 20% (批次 1/5)
// 进度: 40% (批次 2/5)
// 进度: 60% (批次 3/5)
// 进度: 80% (批次 4/5)
// 进度: 100% (批次 5/5)
```

### 3. 自动重试机制 ⭐ 新特性

#### 3.1 retry 策略 - 失败自动重试

```javascript
const result = await collection('items').insertBatch(unstableData, {
  batchSize: 1000,
  onError: 'retry',      // 失败自动重试
  retryAttempts: 3,      // 最多重试3次
  retryDelay: 1000,      // 每次重试延迟1秒
  onRetry: (retryInfo) => {
    console.log(
      `批次 ${retryInfo.batchIndex + 1} 重试中... ` +
      `(第 ${retryInfo.attempt}/${retryInfo.maxAttempts} 次)`
    );
  }
});

console.log(`成功: ${result.insertedCount}`);
console.log(`重试: ${result.retries.length} 个批次`);
console.log(`最终失败: ${result.errors.length} 个批次`);

// 查看重试详情
result.retries.forEach(retry => {
  console.log(
    `批次 ${retry.batchIndex + 1}: 重试 ${retry.attempts} 次, ` +
    `${retry.success ? '成功' : '失败'}`
  );
});
```

### 4. 错误处理策略对比

#### 4.1 stop 策略（默认）- 遇错停止

```javascript
try {
  await collection('items').insertBatch(dataWithDuplicate, {
    batchSize: 1000,
    onError: 'stop'  // 遇到错误立即停止
  });
} catch (error) {
  console.log('插入失败:', error.message);
  // 前面成功的批次已插入，后续批次未执行
}
```

#### 4.2 skip 策略 - 跳过失败批次

```javascript
const result = await collection('items').insertBatch(dataWithErrors, {
  batchSize: 1000,
  onError: 'skip'  // 跳过失败批次，继续后续批次
});

console.log(`成功: ${result.insertedCount}, 失败批次: ${result.errors.length}`);
// 输出: 成功: 8000, 失败批次: 2
```

#### 4.3 collect 策略 - 收集所有错误

```javascript
const result = await collection('items').insertBatch(dataWithErrors, {
  batchSize: 1000,
  onError: 'collect'  // 收集所有错误，全部执行完毕
});

if (result.errors.length > 0) {
  console.log('错误详情:');
  result.errors.forEach((err, idx) => {
    console.log(`批次 ${err.batchIndex + 1}: ${err.message}`);
  });
}
```

### 5. 并发插入（加速大数据导入）

```javascript
// 串行插入（默认）
await collection('data').insertBatch(largeDataset, {
  batchSize: 1000,
  concurrency: 1  // 一批一批地插入
});

// 并发插入（更快）
await collection('data').insertBatch(largeDataset, {
  batchSize: 1000,
  concurrency: 3  // 3 个批次并行插入
});

// ⚠️ 注意: concurrency 过大可能压垮数据库，建议值：2-5
```

### 6. 结合 comment 参数（生产环境）

```javascript
await collection('logs').insertBatch(logData, {
  batchSize: 2000,
  comment: 'DataMigration:logs:v2.0',  // 便于追踪
  onProgress: (progress) => {
    if (progress.percentage % 10 === 0) {
      console.log(`迁移进度: ${progress.percentage}%`);
    }
  }
});
```

---

## 错误处理策略对比

| 策略 | 行为 | 适用场景 | 性能 |
|------|------|---------|------|
| **stop** | 遇错立即停止 | 数据一致性要求高 | 最快（遇错即停） |
| **skip** | 跳过失败批次 | 允许部分失败 | 中等 |
| **collect** | 收集所有错误 | 需要完整错误报告 | 较慢（全部执行） |
| **retry** ⭐ | 自动重试失败批次 | 网络不稳定、临时故障 | 最慢（有重试延迟） |

### 策略选择指南

```javascript
// 数据导入 - 使用 skip 或 retry
await collection('products').insertBatch(importData, {
  onError: 'retry',  // 自动重试临时故障
  retryAttempts: 3,
  onProgress: (p) => console.log(`已导入 ${p.inserted} 条`)
});

// 数据迁移 - 使用 stop
await collection('users').insertBatch(migrationData, {
  onError: 'stop',  // 遇错停止，保证数据完整性
  writeConcern: { w: 'majority', j: true }
});

// 数据验证 - 使用 collect
const result = await collection('test').insertBatch(testData, {
  onError: 'collect'  // 收集所有错误，生成完整报告
});

console.log(`验证完成: ${result.insertedCount} 成功, ${result.errors.length} 失败`);
```

---

## 性能优化建议

### 1. 批次大小（batchSize）

```javascript
// ❌ 太小 - 批次过多，网络开销大
await collection('data').insertBatch(data, { batchSize: 10 });

// ❌ 太大 - 可能内存溢出或超时
await collection('data').insertBatch(data, { batchSize: 100000 });

// ✅ 推荐范围: 500-2000
await collection('data').insertBatch(data, { batchSize: 1000 });
```

**选择指南**:
- **小文档** (< 1KB): `batchSize: 1000-2000`
- **中文档** (1-10KB): `batchSize: 500-1000`
- **大文档** (> 10KB): `batchSize: 100-500`

### 2. 并发控制（concurrency）

```javascript
// ✅ 本地数据库 - 可以更高并发
await collection('data').insertBatch(data, {
  batchSize: 1000,
  concurrency: 5  // 本地网络快，可以开高
});

// ✅ 远程数据库 - 保守一点
await collection('data').insertBatch(data, {
  batchSize: 1000,
  concurrency: 2  // 远程网络慢，避免超时
});

// ✅ 生产环境 - 更保守
await collection('data').insertBatch(data, {
  batchSize: 500,
  concurrency: 1,  // 串行最稳定
  writeConcern: { w: 'majority', j: true }
});
```

### 3. 重试策略配置

```javascript
// ✅ 网络不稳定环境
await collection('data').insertBatch(data, {
  onError: 'retry',
  retryAttempts: 5,      // 多重试几次
  retryDelay: 2000,      // 延迟长一点
  onRetry: (info) => {
    console.log(`批次 ${info.batchIndex + 1} 第 ${info.attempt} 次重试`);
  }
});

// ✅ 稳定环境，快速失败
await collection('data').insertBatch(data, {
  onError: 'stop',       // 不重试，立即失败
  retryAttempts: 0
});
```

---

## 常见问题

### Q: insertBatch vs insertMany 如何选择？

**A**: 根据数据量选择：
- **< 5K 条**: 使用 `insertMany`（更简单）
- **5K-50K 条**: 使用 `insertBatch`（更安全）
- **> 50K 条**: 必须使用 `insertBatch`（避免超时）

### Q: batchSize 如何设置？

**A**: 考虑以下因素：
1. **文档大小**: 文档越大，`batchSize` 越小
2. **网络速度**: 网络越慢，`batchSize` 越小
3. **数据库性能**: 数据库越弱，`batchSize` 越小
4. **推荐起点**: 先用 `1000`，根据实际情况调整

### Q: 重试机制什么时候用？

**A**: 以下场景适合使用重试：
- ✅ 网络不稳定（WiFi、移动网络）
- ✅ 数据库负载高（临时连接失败）
- ✅ 锁冲突（等待后可能成功）
- ❌ 数据错误（重试也不会成功）
- ❌ 权限问题（重试也不会成功）

### Q: 并发会不会导致数据不一致？

**A**: 不会。`insertBatch` 确保：
- 每个批次独立插入
- `insertedIds` 按原始顺序映射
- 错误处理与批次关联
- 支持显式缓存失效

### Q: 如何处理部分失败的情况？

**A**: 使用 `collect` 或 `retry` 策略：
```javascript
const result = await collection('data').insertBatch(data, {
  onError: 'retry',      // 或 'collect'
  retryAttempts: 3
});

// 重试失败的批次
for (const err of result.errors) {
  const failedDocs = data.slice(
    err.batchStartIndex,
    err.batchStartIndex + err.batchSize
  );

  // 分析失败原因，清洗数据后重试
  console.log(`批次 ${err.batchIndex + 1} 失败: ${err.message}`);
  console.log(`重试了 ${err.attempts} 次`);
}
```

---

## 参考资料

- [批量操作可运行示例](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/batch-operations.ts) - 当前 TypeScript 示例
- [test/unit/writes/batch.test.ts](../../test/unit/writes/batch.test.ts) - 测试用例
- [写入操作指南](./write-operations.md) - 写入操作总览
- [缓存系统](./cache.md) - 缓存失效机制
- [insertBatch 改进说明](./insertBatch.md) - 进一步改进建议
