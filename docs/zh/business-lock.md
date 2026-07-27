# 业务级分布式锁

> **弃用兼容页**：monSQLize 仍保留 `withLock()`、`acquireLock()`、`tryAcquireLock()` 以兼容老调用方，但业务锁不再作为 monSQLize 推荐能力。新的支付、订单等临界区请优先放到应用/框架层（例如 VextJS runtime）处理。

## 概述

monSQLize 保留业务锁 API 以兼容历史调用方。这些 API 是兼容辅助能力，不是新的跨进程临界区推荐边界。

> **当前运行时边界**：当前 runtime 的便捷 API `msq.withLock()`、`msq.acquireLock()`、`msq.tryAcquireLock()` 使用内置的进程内 `LockManager`。它只能协调同一个 Node.js 进程内的调用，默认不提供跨 worker / 跨实例互斥。进程内锁也不会在 callback 执行期间自动续租；如果 callback 执行时间超过 `ttl`，锁可能在 callback 返回前过期。Egg.js 多 worker、支付流程、订单去重等跨进程临界区，请显式接入并验证 Redis-backed `DistributedCacheLockManager` 路径，并在业务层配合幂等或 fencing。

### 兼容范围

- `withLock()`、`acquireLock()`、`tryAcquireLock()` 继续保留给既有 monSQLize 调用方。
- 便捷 API 默认使用内置进程内 `LockManager`，除非应用显式接入 Redis-backed lock manager。
- Redis-backed 兼容集成可以使用 TTL 与重试选项，但没有自动 watchdog 续租或 fencing token 契约。
- 新的支付、订单、履约临界区应把锁、幂等和恢复能力放在应用/框架层。

### 历史兼容场景

| 过去常用于 | 当前建议 |
|------|------|
| 复杂订单创建 | 仅保留给既有兼容代码；新代码优先使用框架层锁与幂等 |
| 库存扣减 | 根据一致性要求优先使用数据库条件、事务或应用层协调 |
| 定时任务防重 | 优先使用调度器/框架提供的 lease 机制 |
| 外部 API 调用 | 优先围绕外部副作用设计 durable outbox 与幂等 |

### 不适用场景

| 场景 | 推荐方案 |
|------|---------|
| 简单库存扣减（-1） | 事务 + 条件更新 |
| 防止用户重复点击 | 速率限制（框架层） |
| 跨服务强一致性 | 使用 Redlock 或 ZooKeeper |

---

## 兼容用法示例

### 1. 安装依赖

monSQLize 的包依赖已包含 Redis 适配器依赖；应用仍需提供 Redis 服务，并在应用侧创建 Redis 客户端，通过 `cache.distributed` 配置。

### 2. 配置

```javascript
import MonSQLize from 'monsqlize';
const Redis = require('ioredis');

const redis = new Redis('redis://localhost:6379');

const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'mydb',
    config: { uri: 'mongodb://localhost:27017' },
    cache: {
        transaction: {
            distributedLock: {
                redis: redis,                       // Redis 实例
                keyPrefix: 'myapp:lock:'           // 锁键前缀（可选）
            }
        }
    }
});
```

### 3. 使用

```javascript
await msq.connect();

// 既有兼容代码仍可使用 legacy 业务锁 API
await msq.withLock('inventory:SKU123', async () => {
    const product = await inventory.findOne({ sku: 'SKU123' });
    if (product.stock >= 1) {
        await inventory.updateOne(
            { sku: 'SKU123' },
            { $inc: { stock: -1 } }
        );
    }
});
```

---

## API 参考

### withLock(key, callback, options?)

围绕 callback 管理兼容锁生命周期的便捷封装。

**签名**：
```typescript
async withLock<T>(
    key: string,
    callback: () => Promise<T>,
    options?: LockOptions
): Promise<T>
```

**参数**：

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `key` | string | ✅ | - | 锁的唯一标识 |
| `callback` | Function | ✅ | - | 获取锁后执行的函数 |
| `options.ttl` | number | ❌ | 10000 | 锁过期时间（毫秒） |
| `options.retryTimes` | number | ❌ | 3 | 重试次数 |
| `options.retryDelay` | number | ❌ | 100 | 重试间隔（毫秒） |
| `options.fallbackToNoLock` | boolean | ❌ | false | Redis不可用时降级 |

**返回值**：`Promise<T>` - callback 的返回值

**示例**：

```javascript
// 基础用法
await msq.withLock('resource:123', async () => {
    // 临界区代码
    await doSomething();
});

// 自定义选项
await msq.withLock('resource:123', async () => {
    await doSomething();
}, {
    ttl: 5000,        // 5秒后自动释放
    retryTimes: 5,    // 重试5次
    retryDelay: 200   // 每次间隔200ms
});

// 返回值
const result = await msq.withLock('resource:123', async () => {
    return await calculateSomething();
});
console.log(result);
```

---

### acquireLock(key, options?)

手动获取锁（阻塞重试）。

**签名**：
```typescript
async acquireLock(
    key: string,
    options?: LockOptions
): Promise<Lock>
```

**返回值**：`Promise<Lock>` - Lock 对象

**Lock 对象方法**：

| 方法 | 说明 |
|------|------|
| `release()` | 释放锁 |
| `renew(ttl?)` | 续期 |
| `isHeld()` | 检查锁是否仍被持有 |
| `getHoldTime()` | 获取锁持有时间（毫秒） |

**示例**：

```javascript
const lock = await db.acquireLock('resource:123', {
    ttl: 10000,
    retryTimes: 3
});

try {
    // 业务逻辑
    await doSomething();
    
    // 可选：续期
    await lock.renew(5000);
    
} finally {
    await lock.release();
}
```

---

### tryAcquireLock(key, options?)

尝试获取锁（不阻塞）。

**签名**：
```typescript
async tryAcquireLock(
    key: string,
    options?: Omit<LockOptions, 'retryTimes'>
): Promise<Lock | null>
```

**返回值**：`Promise<Lock | null>` - Lock 对象或 null

**示例**：

```javascript
const lock = await db.tryAcquireLock('resource:123', { ttl: 5000 });

if (lock) {
    try {
        // 业务逻辑
        await doSomething();
    } finally {
        await lock.release();
    }
} else {
    console.log('资源被占用');
}
```

---

### getLockStats()

获取锁统计信息。

**签名**：
```typescript
getLockStats(): LockStats
```

**返回值**：

```typescript
interface LockStats {
    locksAcquired: number;    // 成功获取锁的次数
    locksReleased: number;    // 成功释放锁的次数
    lockChecks: number;       // 锁检查次数
    errors: number;           // 错误次数
    lockKeyPrefix: string;    // 锁键前缀
    maxDuration: number;      // 锁最大持续时间
}
```

**示例**：

```javascript
const stats = db.getLockStats();
console.log(`获取锁: ${stats.locksAcquired}次`);
console.log(`释放锁: ${stats.locksReleased}次`);
console.log(`错误: ${stats.errors}次`);
```

---

## 配置选项

### 全局配置

在 `MonSQLize` 构造函数中配置：

```javascript
new MonSQLize({
    cache: {
        transaction: {
            distributedLock: {
                // Redis 实例（必填）
                redis: redisInstance,
                
                // 锁键前缀（可选，默认 'monsqlize:cache:lock:'）
                keyPrefix: 'myapp:lock:'
            }
        }
    }
});
```

### API 级别配置

在每次调用时可以覆盖默认值：

```javascript
await msq.withLock('key', callback, {
    ttl: 5000,          // 覆盖默认 TTL
    retryTimes: 5,      // 覆盖默认重试次数
    retryDelay: 200,    // 覆盖默认重试间隔
    fallbackToNoLock: true  // 启用降级
});
```

---

## 使用场景

### 场景1：库存扣减（复杂业务）

```javascript
await msq.withLock(`inventory:${sku}`, async () => {
    const product = await inventory.findOne({ sku });
    const user = await users.findOne({ userId });
    
    // 复杂计算：会员折扣、优惠券、积分抵扣
    const finalPrice = calculatePrice(product, user, coupon);
    
    if (user.balance < finalPrice) {
        throw new Error('余额不足');
    }
    
    // 多表更新
    await inventory.updateOne({ sku }, { $inc: { stock: -1 } });
    await users.updateOne({ userId }, { $inc: { balance: -finalPrice } });
    await orders.insertOne({ userId, sku, price: finalPrice });
});
```

### 场景2：订单创建（锁+事务）

```javascript
await msq.withLock(`order:${userId}:${sku}`, async () => {
    await msq.withTransaction(async (tx) => {
        // 事务内操作
        await inventory.updateOne(
            { sku, stock: { $gte: 1 } },
            { $inc: { stock: -1 } },
            { session: tx.session }
        );
        
        await orders.insertOne({
            userId, sku, createdAt: new Date()
        }, { session: tx.session });
    });
});
```

### 场景3：定时任务防重

```javascript
// 定时任务（每天0点执行）
async function dailyReportTask() {
    const lock = await db.tryAcquireLock('cron:daily-report', {
        ttl: 60000  // 60秒
    });
    
    if (!lock) {
        console.log('其他实例正在执行，跳过');
        return;
    }
    
    try {
        await generateDailyReport();
    } finally {
        await lock.release();
    }
}
```

### 场景4：外部API调用

```javascript
await msq.withLock(`payment:${orderId}`, async () => {
    // 调用第三方支付
    const paymentResult = await thirdPartyPayment.charge({
        orderId,
        amount: 100
    });
    
    // 更新订单状态
    await orders.updateOne(
        { _id: orderId },
        { 
            $set: { 
                status: 'paid',
                paymentId: paymentResult.id
            }
        }
    );
});
```

---

## 与事务配合

业务锁可以与 monSQLize 事务无缝配合：

```javascript
// 推荐：锁在外，事务在内
await msq.withLock('resource:123', async () => {
    await msq.withTransaction(async (tx) => {
        // 事务操作
        await collection1.updateOne({}, {}, { session: tx.session });
        await collection2.insertOne({}, { session: tx.session });
    });
});
```

**为什么锁在外？**
- 锁保护整个业务流程（包括事务前的查询和计算）
- 事务保证数据库操作的原子性
- 两者互补，不冲突

---

## 错误处理

### 错误类型

| 错误 | 说明 |
|------|------|
| `LockAcquireError` | 获取锁失败（重试后仍失败） |
| `LockTimeoutError` | 锁操作超时 |
| Redis 连接错误 | Redis 不可用 |

### 处理示例

```javascript
const { LockAcquireError } = require('monsqlize');

try {
    await msq.withLock('resource:123', async () => {
        await doSomething();
    });
} catch (error) {
    if (error instanceof LockAcquireError) {
        // 锁被占用
        console.log('资源繁忙，请稍后重试');
        return { success: false, reason: 'busy' };
    }
    throw error;
}
```

### 降级策略

```javascript
// Redis 不可用时降级为无锁执行（慎用）
await msq.withLock('resource:123', async () => {
    await doSomething();
}, {
    fallbackToNoLock: true  // ⚠️ 慎用！
});
```

**降级建议**：

| 场景 | 建议 |
|------|------|
| 核心业务（订单、支付） | 抛异常，不降级 |
| 非核心业务（统计、日志） | 可降级 |
| 定时任务 | 抛异常，跳过本次执行 |

---

## 最佳实践

### 1. 锁 Key 统一管理

```javascript
// constants/lock-keys.js
const LockKeys = {
    INVENTORY: {
        key: (sku) => `inventory:${sku}`,
        ttl: 5000
    },
    ORDER_CREATE: {
        key: (userId, sku) => `order:create:${userId}:${sku}`,
        ttl: 10000
    }
};

// 使用
await msq.withLock(
    LockKeys.INVENTORY.key(sku),
    callback,
    { ttl: LockKeys.INVENTORY.ttl }
);
```

### 2. 锁粒度选择

```javascript
// ❌ 粒度太粗：所有订单共用一把锁
await msq.withLock('order', async () => { ... });

// ✅ 粒度合适：每个用户+商品一把锁
await msq.withLock(`order:${userId}:${sku}`, async () => { ... });

// ⚠️ 粒度太细：每个请求一把锁（无意义）
await msq.withLock(`order:${requestId}`, async () => { ... });
```

### 3. TTL 设置

```javascript
// 经验值
{
    ttl: 5000    // 简单操作（库存扣减）
    ttl: 10000   // 一般操作（订单创建）
    ttl: 60000   // 定时任务
    ttl: 300000  // 长时间任务（报表生成）
}
```

### 4. 错误处理

```javascript
// ✅ 推荐：完整错误处理
try {
    await msq.withLock('key', async () => {
        await doSomething();
    });
} catch (error) {
    if (error instanceof LockAcquireError) {
        // 锁被占用
        return { success: false, reason: 'busy' };
    }
    // 其他错误
    throw error;
}
```

### 5. 监控统计

```javascript
// 定期检查锁统计
setInterval(() => {
    const stats = db.getLockStats();
    if (stats.errors > 100) {
        console.warn('锁错误率过高:', stats);
    }
}, 60000);
```

---

## 常见问题

### Q1: 业务锁 vs 事务锁有什么区别？

| 对比项 | 事务锁 | 业务锁兼容 API |
|--------|--------------|----------------|
| **用途** | 保护缓存一致性 | 保护业务逻辑 |
| **生命周期** | 事务期间 | 用户定义 |
| **API** | 内部使用 | 公开 API |
| **Key管理** | session绑定 | 用户指定 |

### Q2: 既有代码什么时候可能继续使用业务锁？

**既有代码过去常用于**：
- 复杂业务（查询→计算→多表更新）
- 定时任务防重
- 外部 API 调用后更新数据库

**新代码通常应放在其他边界处理**：
- 简单扣减（数据库条件 + 事务）
- 防止用户重复点击（速率限制）
- 需要跨进程保证、续租、恢复或 fencing 的支付/订单临界区

### Q3: Redis 不可用怎么办？

```javascript
// 方式1：抛异常
try {
    await msq.withLock('key', callback);
} catch (error) {
    if (error.message.includes('Redis unavailable')) {
        // 记录告警
    }
}

// 方式2：降级（慎用）
await msq.withLock('key', callback, {
    fallbackToNoLock: true
});
```

### Q4: 锁超时了会怎样？

锁会自动释放（TTL机制），不会造成死锁。

### Q5: 如何避免死锁？

- 新的临界区优先使用应用/框架层协调。
- 既有兼容代码可用 `withLock` 在单进程内自动释放。
- 手动获取锁时使用 `try...finally`。
- 设置合理的 TTL，并让 callback 执行时间短于 TTL。

### Q6: 支持锁续期吗？

支持，使用 `lock.renew(ttl)`：

```javascript
const lock = await db.acquireLock('key');
try {
    await doSomething();
    await lock.renew(5000);  // 续期5秒
    await doMoreThings();
} finally {
    await lock.release();
}
```

---

## 与专业锁库的对比

| 特性 | monSQLize 兼容锁 | Redlock | node-redis-warlock |
|------|----------------|---------|-------------------|
| **安装** | 包依赖已包含 Redis 适配器依赖；应用提供 Redis 服务/客户端 | 额外安装 | 额外安装 |
| **Redis 节点** | 单节点 | 多节点 | 单节点 |
| **一致性** | 最终一致 | 强一致 | 最终一致 |
| **复杂度** | 简单 | 复杂 | 简单 |
| **适用场景** | 既有 monSQLize 调用方 | 金融/核心 | 简单场景 |
| **与 monSQLize 集成** | 内置兼容 API | 需手动 | 需手动 |

**当前建议**：
- monSQLize 业务锁只保留给既有兼容代码。
- 新的支付/订单临界区请使用应用/框架层锁、幂等能力或专用分布式锁库。
- 金融/支付路径需要在 monSQLize 外验证 Redlock、共识或 fencing 语义。

---

## 参考

- [方案文档]
- [示例代码](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/lock.ts)
- [单元测试](../../test/unit/lock/lock.test.ts)
