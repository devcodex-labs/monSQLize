# 事务性能优化指南

## 概述

本文档说明调优事务吞吐与缓存一致性时真正需要关注的行为：

1. **只读事务统计** - 未执行 monSQLize 写 helper 的事务会在 `getTransactionStats()` 中单独计数。
2. **进程内缓存失效屏障** - 显式配置缓存失效的事务写入会记录 intent，成功 commit 后执行；commit 结果未知时也会保守清理。

### 适用场景

| 优化 | 适用场景 | 预期效果 |
|------|---------|------|
| **只读事务统计** | 查询密集型应用、报表任务 | 衡量事务流量中只读占比 |
| **缓存失效屏障** | 缓存读 + 事务写混合场景 | 缩短同进程 stale cache 回填窗口；跨实例仍是 best-effort |

---

## 优化1: 只读优化

### 工作原理

```javascript
await msq.withTransaction(async (tx) => {
    // 读操作
    const user = await collection('users').findOne(
        { _id: 1 },
        { session: tx.session }
    );
    
    // 没有执行写 helper，因此事务统计会把它计为只读事务。
});
```

### 使用方式

只读事务无需额外代码。事务没有执行 monSQLize 写 helper 时，会被统计为只读事务。

```javascript
// 自动识别为只读事务
await msq.withTransaction(async (tx) => {
    const user = await collection('users').findOne(
        { _id: 1 },
        { session: tx.session }
    );
    
    const orders = await collection('orders').find(
        { userId: 1 },
        { session: tx.session }
    ).toArray();
    
    // 没有写操作，因此事务统计会记录为只读。
});
```

## 优化2: 缓存失效屏障

### 工作原理

事务通过 monSQLize helper 写入且显式配置了缓存失效时，runtime 会记录读缓存失效 intent。MongoDB commit 成功后再执行已记录的失效并释放进程内缓存锁。commit 结果未知时也会保守清理，不会报告已回滚或重跑回调。结果已知的 abort 会丢弃这些意图。同一个 CacheLike 对象上的在途回填会被撤销，跨进程 Redis 通知仍是最终一致性。

```javascript
await msq.withTransaction(async (tx) => {
    await collection('users').updateOne(
        { _id: 1 },
        { $set: { balance: 100 } },
        {
            session: tx.session,
            cache: {
                invalidate: [{
                    operation: 'findOne',
                    query: { _id: 1 },
                    options: { cache: 5000 }
                }]
            }
        }
    );
    // 已配置的缓存失效意图会在 commit 后 flush。
});
```

### 使用方式

需要事务写入清理读缓存时，同时传入 `session: tx.session` 与 `cache.invalidate` 或 `autoInvalidate: true`。

```javascript
await Promise.all([
    msq.withTransaction(async (tx) => {
        await collection('users').updateOne(
            { _id: 1 },
            { $inc: { balance: 100 } },
            {
                session: tx.session,
                cache: { invalidate: true }
            }
        );
    }),
    msq.withTransaction(async (tx) => {
        await collection('users').updateOne(
            { _id: 2 },
            { $inc: { balance: 200 } },
            {
                session: tx.session,
                cache: { invalidate: true }
            }
        );
    })
]);

// MongoDB 控制写冲突；monSQLize 只协调缓存失效。
```

### 边界

| 主题 | 当前行为 |
|------|----------|
| 锁范围 | 进程内 `CacheLockManager`，不是分布式互斥锁 |
| 缓存失效 | MongoDB commit 后 best-effort；缓存失败不会回滚数据库提交 |
| 跨实例缓存 | 配置 distributed invalidation 后最终收敛 |
| 性能 | 取决于实际 workload，应看 `getTransactionStats()` 和应用指标，不承诺固定倍数 |

---

## 使用建议

### 1. 缩小事务写入范围

推荐：
- 让事务尽量短。
- 只给必须进入事务的操作传入 `session: tx.session`。
- 使用有索引的目标过滤条件，让 MongoDB 更容易处理写冲突。

避免：
- 在事务回调里执行长耗时网络调用。
- 未测量前把大量批量更新塞进一个事务。
- 把 monSQLize 缓存锁当成跨进程业务锁。

### 2. 充分利用只读优化

✅ **推荐场景**:
- 报表查询
- 数据分析
- 只读副本

**最佳实践**:
```javascript
// ✅ 好的设计：分离只读和写入
// 只读事务
const reportData = await msq.withTransaction(async (tx) => {
    const users = await collection('users').find({}, { session: tx.session }).toArray();
    const orders = await collection('orders').find({}, { session: tx.session }).toArray();
    return { users, orders };
});

// 写入事务（单独执行）
await msq.withTransaction(async (tx) => {
    await collection('logs').insertOne({ report: reportData }, { session: tx.session });
});

// ❌ 不好的设计：混合只读和写入
await msq.withTransaction(async (tx) => {
    const users = await collection('users').find({}, { session: tx.session }).toArray();
    await collection('logs').insertOne({ users }, { session: tx.session });
    // 包含写入操作，不会被优化
});
```

### 3. 监控事务统计

```javascript
// 定期检查统计
const stats = msq.getTransactionStats();

if (stats) {
    console.log('事务统计:');
    console.log(`- 只读事务占比: ${stats.readOnlyRatio}`);
    console.log(`- 平均耗时: ${stats.averageDuration.toFixed(2)}ms`);
    console.log(`- P95 耗时: ${stats.p95Duration.toFixed(2)}ms`);
    console.log(`- 成功率: ${stats.successRate}`);

    // 判断是否需要优化
    if (parseFloat(stats.readOnlyRatio) > 30) {
        console.log('✅ 只读优化生效良好');
    }
}
```

### 4. 配置调优

```javascript
const msq = new MonSQLize({
    // ...基础配置
    transaction: {
        // 缓存锁最大持续时间（默认：5分钟）
        lockMaxDuration: 300000,
        
        // 锁清理间隔（默认：10秒）
        lockCleanupInterval: 10000,
        
        // 统计样本数量（默认：1000）
        maxStatsSamples: 1000
    }
});
```

---

## 监控指标

### 关键指标

| 指标 | 说明 | 告警阈值 |
|------|------|---------|
| `readOnlyRatio` | 只读事务占比 | <10% 则优化收益有限 |
| `successRate` | 事务成功率 | <95% 需要调查 |
| `averageDuration` | 平均耗时 | >1000ms 需要优化 |
| `p95Duration` | P95 耗时 | >3000ms 需要优化 |
| `activeTransactions` | 当前活跃事务数量 | 长时间异常非 0 需要排查 |

### 监控脚本示例

```javascript
// 定期输出统计（每分钟）
setInterval(() => {
    const stats = msq.getTransactionStats();
    if (!stats) return;
    
    console.log('📊 事务监控:', {
        时间: new Date().toISOString(),
        总数: stats.totalTransactions,
        只读占比: stats.readOnlyRatio,
        成功率: stats.successRate,
        平均耗时: `${stats.averageDuration.toFixed(2)}ms`,
        P95耗时: `${stats.p95Duration.toFixed(2)}ms`
    });
    
    // 告警检查
    if (parseFloat(stats.successRate) < 95) {
        console.warn('⚠️  警告: 事务成功率低于 95%');
    }
    
    if (stats.p95Duration > 3000) {
        console.warn('⚠️  警告: P95 耗时超过 3 秒');
    }
}, 60000);
```

---

## 常见问题

### Q1: 缓存屏障会增加内存使用吗？

**A**: 屏障和缓存锁元数据是进程内、短生命周期的。若有大量并发长事务，应同时观察 `activeTransactions` 与进程 RSS。

### Q2: 如何观察事务行为？

**A**: 使用单个事务统计和聚合统计：

```javascript
const tx = await msq.startSession();
await tx.start();
// ... 执行操作
const stats = tx.getStats();
console.log('记录的失效操作数:', stats.operationCount);
console.log('锁定键数量:', stats.lockedKeysCount);

console.log(msq.getTransactionStats());
```

### Q3: 只读优化会影响数据一致性吗？

**A**: 不会。

- 只读事务仍然在事务隔离级别下执行
- 只是不失效缓存，不影响数据准确性
- 事务内读取的数据仍然是一致的快照

### Q4: 单次事务可以禁用缓存锁吗？

**A**: 可以。向事务 options 传入 `enableCacheLock: false` 后，会保留 MongoDB driver 事务语义，但不启用进程内缓存锁。缓存失效仍遵循文档中的 best-effort 边界。

```javascript
await msq.withTransaction(async (tx) => {
    await collection('users').updateOne(
        { _id: 1 },
        { $set: { status: 'active' } },
        { session: tx.session }
    );
}, {
    enableCacheLock: false
});
```

---

## 总结

### 应该观测什么

| 场景 | 有用指标 |
|------|----------|
| 查询密集事务流 | `readOnlyRatio`、事务外 cache hit rate |
| 写入密集事务流 | `successRate`、`p95Duration`、MongoDB write conflict |
| 混合读写 | 事务时长与 callback 内操作数 |

### 建议

1. 保持事务 callback 短小且幂等。
2. 定期查看 `getTransactionStats()`。
3. 基于观测结果调 timeout、retry 与 cache-lock 配置。
