# 分布式部署指南

## 概述

monSQLize 支持单实例和多实例部署。**单实例**环境通常只需要本地查询缓存。多实例部署中，如果缓存读需要跨进程收敛，应使用 Redis 远端缓存与分布式失效。

### 为什么需要分布式支持？

在多实例部署中，每个实例都有独立的本地缓存和锁管理器。如果不做特殊处理，会导致：

1. **缓存不一致窗口**：实例 A 更新数据后，实例 B 的本地缓存可能在失效广播到达前短暂保留旧值。
2. **事务与缓存边界**：MongoDB 事务保持 session 语义，缓存失效在 commit 后 best-effort flush。
3. **关键业务临界区**：余额、库存、支付类路径仍需要业务侧幂等、fencing 或显式锁。

---

## 架构选择

### 1. 单实例部署（✅ 推荐：小型应用）

```text
┌─────────────────────────────┐
│   Node.js 实例               │
│                              │
│  ┌───────────────┐          │
│  │ 本地缓存 LRU  │          │
│  └───────────────┘          │
└─────────────────────────────┘
         │
         ▼
    MongoDB (副本集)
```

**特点**：
- ✅ 所有功能完整支持
- ✅ 无需 Redis
- ✅ 配置简单
- ⚠️ 无高可用

**适用场景**：
- 开发/测试环境
- 流量不大的生产环境
- 单体应用

**配置示例**：
```javascript
const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'mydb',
  config: { uri: 'mongodb://localhost:27017' },
  cache: {
    maxEntries: 1000,
    defaultTtl: 60000
  }
});
```

---

### 2. 多实例 + 独立本地缓存（🔴 不推荐）

```text
┌───────────────────┐    ┌───────────────────┐
│  实例 A           │    │  实例 B           │
│ ┌──────────┐      │    │ ┌──────────┐      │
│ │本地缓存A │      │    │ │本地缓存B │      │
│ └──────────┘      │    │ └──────────┘      │
└────────┬──────────┘    └────────┬──────────┘
         │                         │
         └────────┬────────────────┘
                  ▼
             MongoDB (副本集)
```

**风险**：
- 🔴 **高风险**：缓存不一致
- 🔴 **事务隔离性失效**
- ❌ **不推荐生产环境**

---

### 3. 多实例 + Redis + 分布式缓存失效（🟢 推荐）

```text
┌───────────────────┐    ┌───────────────────┐
│  实例 A           │    │  实例 B           │
│ ┌──────────┐      │    │ ┌──────────┐      │
│ │本地缓存A │      │    │ │本地缓存B │      │
│ └────┬─────┘      │    │ └────┬─────┘      │
└──────┼────────────┘    └──────┼────────────┘
       │                         │
       └────────┬────────────────┘
                ▼
         ┌─────────────┐
         │   Redis     │
         │ (缓存+广播)  │
         └──────┬──────┘
                │
                ▼
           MongoDB (副本集)
```

**特点**：
- ✅ 高可用
- ✅ 缓存一致性好（毫秒级延迟）
- ✅ 性能优异
- ⚠️ 依赖 Redis

**适用场景**：
- 生产环境（推荐）
- 高并发场景
- 可容忍短期（毫秒级）数据不一致

**配置示例**：
```javascript
const Redis = require('ioredis');
const redis = new Redis('redis://localhost:6379');

const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'mydb',
  config: { uri: 'mongodb://localhost:27017' },
  
  cache: {
    multiLevel: true,
    local: { maxEntries: 1000 },
    remote: MonSQLize.createRedisCacheAdapter(redis),  // Redis 缓存
    
    // 启用分布式缓存失效
    distributed: {
      enabled: true,           // ✅ 必需：启用
      instanceId: 'instance-1' // ❌ 可选：默认自动生成（建议手动设置）
      // redis                 // ❌ 可选：默认自动从 remote 复用（ES6 简写）
      // channel: 'myapp:cache:invalidate'  // ❌ 可选：自定义频道
    }
  }
});
```

---

### 4. 多实例 + 显式业务协调（🟡 金融/交易）

```text
┌───────────────────┐    ┌───────────────────┐
│  实例 A           │    │  实例 B           │
│ ┌──────────┐      │    │ ┌──────────┐      │
│ │本地缓存A │      │    │ │本地缓存B │      │
│ └────┬─────┘      │    │ └────┬─────┘      │
└──────┼────────────┘    └──────┼────────────┘
       │                         │
       └────────┬────────────────┘
                ▼
         ┌─────────────┐
         │   Redis     │
         │ (缓存+显式业务锁) │
         └──────┬──────┘
                │
                ▼
           MongoDB (副本集)
```

**特点**：
- ✅ 多实例共享缓存失效
- ✅ 应用/框架层显式选择业务锁与幂等策略
- ✅ 配合持久化业务保护后适合金融/交易场景
- ⚠️ 缓存失效仍是 best-effort，不与数据库提交原子绑定

**适用场景**：
- 金融系统
- 支付/转账
- 库存扣减
- 业务层已经具备幂等、fencing 或关键读路径绕过缓存的场景

**配置示例**：
```javascript
const Redis = require('ioredis');
const redis = new Redis('redis://localhost:6379');

const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'mydb',
  config: { uri: 'mongodb://localhost:27017?replicaSet=rs0' },
  
  cache: {
    multiLevel: true,
    local: { maxEntries: 1000 },
    remote: MonSQLize.createRedisCacheAdapter(redis),
    
    // 分布式缓存失效
    distributed: {
      enabled: true,              // ✅ 必需：启用
      instanceId: 'instance-1'    // ❌ 可选：默认自动生成（建议手动设置）
      // redis                    // ❌ 可选：默认自动从 remote 复用（ES6 简写）
    },
    
  }
});

const businessLock = new MonSQLize.DistributedCacheLockManager({
  redis,
  lockKeyPrefix: 'myapp:business:lock:'
});

await businessLock.withLock(`payment:${paymentId}`, async () => {
  // 临界区保持幂等；涉及外部副作用时配合 fencing / outbox。
});
```

`transaction.distributedLock` 仅作为兼容配置占位保留，并未接入事务缓存锁。跨实例强一致需要禁用关键读路径缓存，或在业务/框架层显式协调。

---

### 5. 多实例 + 禁用缓存（🟡 适用：强一致性要求）

**特点**：
- ✅ 100% 数据一致性
- ✅ 无外部依赖
- ❌ 性能下降（所有请求查数据库）

**适用场景**：
- 小流量应用
- 强一致性要求
- 无法使用 Redis

**配置示例**：
```javascript
const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'mydb',
  config: { uri: 'mongodb://localhost:27017' },
  
  cache: {
    // 禁用缓存（所有查询直接访问数据库）
    enabled: false
  }
});
```

---

## 分布式环境下的风险

### 风险 1: 缓存失效不同步

**场景**：
```javascript
// 时间线
T1: 实例 A 查询用户 { id: 1, balance: 100 } → 写入本地缓存A
T2: 实例 B 查询用户 { id: 1, balance: 100 } → 写入本地缓存B
T3: 实例 A 更新余额为 150 → 失效本地缓存A ✓
T4: 实例 B 查询用户 → 命中本地缓存B → 返回旧数据 100 ❌
```

**影响**：
- 用户看到不一致的余额
- 业务逻辑可能出错

**解决方案**：启用**分布式缓存失效广播**

---

### 风险 2: 事务缓存锁不生效

**场景**：
```javascript
// 实例 A: 转账事务
await msq.withTransaction(async (tx) => {
  // T1: 扣款 Alice
  await accounts.updateOne(
    { userId: 'alice' },
    { $inc: { balance: -100 } },
    { session: tx.session }
  );
  
  // T2: 实例 B 查询 Alice → 读到中间状态 → 写入缓存 ❌
  
  // T3: 加款 Bob
  await accounts.updateOne(
    { userId: 'bob' },
    { $inc: { balance: 100 } },
    { session: tx.session }
  );
});
```

**影响**：
- 读到事务中间状态
- 缓存中可能有脏数据
- 事务隔离性失效

**解决方案**：对关键路径使用显式业务协调，并在需要严格新鲜度时绕过缓存

---

## 解决方案

### 方案 1: 分布式缓存失效广播（推荐）

**原理**：使用 Redis Pub/Sub 广播缓存失效消息

**工作流程**：
```text
1. 实例 A 更新数据
2. 实例 A 失效本地缓存 + Redis
3. 实例 A 广播失效消息（Redis Pub/Sub）
4. 实例 B 收到消息
5. 实例 B 失效本地缓存
```

**配置**：
```javascript
const Redis = require('ioredis');
const redis = new Redis('redis://localhost:6379');

cache: {
  multiLevel: true,
  local: { maxEntries: 1000 },
  remote: MonSQLize.createRedisCacheAdapter(redis),
  
  distributed: {
    enabled: true,                 // ✅ 必需：启用分布式失效
    instanceId: 'instance-A'       // ❌ 可选：实例标识，默认自动生成（建议手动设置）
    // redis                       // ❌ 可选：默认自动从 remote 复用（ES6 简写）
    // channel: 'myapp:cache:invalidate'  // ❌ 可选：默认 'monsqlize:cache:invalidate'
  }
}
```

**优点**：
- ✅ 实时广播，延迟低（毫秒级）
- ✅ 使用现有 Redis 基础设施
- ✅ 实现简单，易于维护

**缺点**：
- ⚠️ 依赖 Redis
- ⚠️ 极短时间窗口内可能不一致（网络延迟）

---

### 方案 2: 显式业务锁与缓存绕过

**原理**：缓存失效保持 best-effort，对关键业务副作用使用显式业务锁，并配合幂等 / fencing。

**工作流程**：
```text
1. 实例 A 获取业务锁，例如 payment:order-123
2. 实例 A 执行幂等事务，并把外部副作用写入 outbox / journal
3. 需要严格新鲜度的读路径绕过缓存，或使用应用层新鲜度校验
4. 实例 A 提交数据库事务
5. commit 后 best-effort 发布缓存失效
6. 实例 A 释放业务锁
```

**配置**：
```javascript
const Redis = require('ioredis');
const redis = new Redis('redis://localhost:6379');

const businessLock = new MonSQLize.DistributedCacheLockManager({
  redis,
  lockKeyPrefix: 'myapp:business:lock:',
  maxDuration: 300000
});

await businessLock.withLock(`order:${orderId}`, async () => {
  // 幂等事务 + fencing / outbox。
});
```

**优点**：
- ✅ 一致性边界明确落在业务层
- ✅ 可覆盖支付、库存、履约等外部副作用
- ✅ 适合金融/交易场景

**缺点**：
- ⚠️ 需要应用层幂等与恢复设计
- ⚠️ 不会让缓存失效与数据库事务变成原子提交
- ⚠️ 使用 Redis 锁时依赖 Redis 可用性

---

## 配置指南

### 完整配置示例

```javascript
import MonSQLize from 'monsqlize';
const Redis = require('ioredis');

// 创建 Redis 实例（复用于远端缓存与广播）
const redis = new Redis({
  host: 'localhost',
  port: 6379,
  db: 0,
  retryStrategy: (times) => {
    return Math.min(times * 50, 2000);
  }
});

const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'mydb',
  config: { 
    uri: 'mongodb://localhost:27017?replicaSet=rs0'
  },
  
  cache: {
    // 多层缓存
    multiLevel: true,
    
    // 本地缓存配置
    local: {
      maxEntries: 1000,    // 最多缓存 1000 条
      maxMemory: 0,        // 无内存限制
      enableStats: true    // 启用统计
    },
    
    // 远端 Redis 缓存（复用实例）
    remote: MonSQLize.createRedisCacheAdapter(redis),
    
    // 缓存策略
    policy: {
      writePolicy: 'both',            // 双写（both）或本地优先（local-first-async-remote）
      backfillLocalOnRemoteHit: true  // 远端命中时回填本地
    },
    
    // 分布式缓存失效
    distributed: {
      enabled: true,                           // ✅ 必需：启用
      instanceId: process.env.INSTANCE_ID,    // ❌ 可选：默认自动生成（建议使用环境变量）
      channel: 'myapp:cache:invalidate'       // ❌ 可选：自定义频道
      // redis                                // ❌ 可选：默认自动从 remote 复用（ES6 简写）
    },
    
  }
});

// 连接
await msq.connect();

// 使用
const { collection } = await msq.connect();
const users = await collection('users').find(
  { active: true },
  { cache: 60000 }  // 缓存 60 秒
);

// 关闭（清理资源）
await msq.close();
```

**💡 配置说明**：
- ✅ **必需项**：必须配置，否则功能不工作
- ❌ **可选项**：可以不配置，使用默认值
- **一个 Redis 实例**：用于远端缓存与广播；如需业务锁，请显式接入对应业务锁路径。

---

### 配置选项说明

#### distributed（分布式缓存失效）

| 选项 | 类型 | 必需 | 默认值 | 说明 |
|-----|------|------|--------|------|
| `enabled` | Boolean | ✅ | - | 是否启用分布式缓存失效 |
| `redis` | Object | `redis` / `redisUrl` 二选一 | - | 已有 Redis-like 实例，需要支持 `duplicate()`。 |
| `redisUrl` | String | ❌ | - | Redis 连接 URL（与 redis 二选一，不推荐） |
| `instanceId` | String | ❌ | `instance-${timestamp}-${random}` | 实例标识，默认自动生成（如 `instance-1732521234567-a2b3c4d5e`），**强烈建议手动设置** |
| `channel` | String | ❌ | `'monsqlize:cache:invalidate'` | Pub/Sub 频道名 |

**⚠️ 重要说明**：
- **`redis` 和 `redisUrl`**：分布式失效需要二选一
  - **推荐**：不配置 `redis`，自动从 `cache.remote` 复用 Redis 实例
  - 如需单独配置：使用 `redis` 参数（可复用实例）
  - 不推荐：使用 `redisUrl`（会创建新连接）
- **`instanceId`**：可选，但**强烈建议手动设置**
  - 默认值格式：`instance-${timestamp}-${random}`（如 `instance-1732521234567-a2b3c4d5e`）
  - **每个实例的 `instanceId` 必须不同**，否则会导致缓存失效广播失败
  - 推荐使用环境变量：`process.env.INSTANCE_ID` 或 `process.env.HOSTNAME`

#### transaction.distributedLock（兼容配置占位）

`transaction.distributedLock` 仅作为兼容配置占位保留，不会接入事务缓存锁。事务缓存锁仍是进程内语义。跨实例关键临界区请显式使用 `DistributedCacheLockManager` 等业务锁，并配合幂等 / fencing；严格新鲜度读路径请禁用或绕过缓存。

---

## 面向使用者的运行行为

### 分布式缓存失效流程

当启用 `cache.distributed` 且 Redis Pub/Sub 配置可用时，monSQLize 会在 `connect()` 阶段准备广播通道。对应用侧而言，契约是：

1. 写操作是否成功由 MongoDB 结果决定。
2. 如果本次写操作启用了缓存失效，monSQLize 会尝试失效本地缓存，并向其他实例发布失效消息。
3. 其他实例收到消息后，会按匹配的 namespace 或 pattern 失效本地缓存。
4. Redis publish/subscribe 失败会通过日志或统计暴露，但不会回滚已经完成的 MongoDB 写入。

### 运行注意事项

- 为每个运行实例设置唯一 `instanceId`，这样实例可以忽略自己发出的广播，并接收其他实例的广播。
- 对严格新鲜度读路径保持显式策略：需要时绕过或禁用缓存。
- 监控缓存失效 warning、Redis publish 错误和缓存统计。数据库写入可能已经提交，即使后续缓存失效步骤失败。
- 把分布式失效视为最终一致辅助能力。它能缩短 stale-cache 窗口，但不是两阶段提交协议，也不提供全局强一致。

---

## 最佳实践

### 1. 环境检测

自动检测是否在分布式环境：

```javascript
function isDistributedEnvironment() {
  return !!(
    process.env.INSTANCE_ID ||
    process.env.POD_NAME ||      // Kubernetes
    process.env.HOSTNAME         // Docker
  );
}

const cache = isDistributedEnvironment() ? {
  multiLevel: true,
  distributed: { enabled: true, ... }
} : {
  maxEntries: 1000
};
```

---

### 2. 根据业务选择方案

| 业务类型 | 推荐方案 | 配置 |
|---------|---------|------|
| **一般应用** | 分布式缓存失效 | `distributed.enabled = true` |
| **金融/支付** | 缓存失效 + 显式业务协调 | `distributed.enabled = true`<br>业务锁 + 幂等 / fencing |
| **强一致性** | 禁用缓存 | `cache.enabled = false` |
| **开发环境** | 本地缓存 | 默认配置 |

---

### 3. 监控和日志

启用日志查看分布式组件状态：

```javascript
const msq = new MonSQLize({
  // ...
  logger: {
    level: 'info',  // debug | info | warn | error
    // ...
  }
});

// 查看统计
const cache = msq.getCache();
console.log(cache.getStats());  // 缓存统计
```

---

### 4. 错误处理

分布式组件失败时的降级策略：

```javascript
// 如果 Redis 连接失败，仍然可以使用本地缓存
cache: {
  multiLevel: true,
  local: { maxEntries: 1000 },
  remote: MonSQLize.createRedisCacheAdapter('redis://...'),
  
  distributed: {
    enabled: true,
    redisUrl: 'redis://...'
    // 如果 Redis 不可用，会自动降级为仅本地缓存
  }
}
```

---

## 性能考虑

### 1. 分布式缓存失效性能

- **延迟**：~1-5ms（Redis Pub/Sub）
- **带宽**：每次失效 ~100 bytes
- **影响**：对总体性能影响可忽略

### 2. 显式业务锁性能

- **延迟**：~2-10ms（Redis SET/DEL）
- **吞吐量**：略有下降（~10-20%）
- **推荐**：仅包裹需要跨实例协调的业务临界区

### 3. 缓存策略对比

| 策略 | 延迟 | 一致性 | 适用场景 |
|-----|------|--------|---------|
| **仅本地** | 最低 | 低 | 单实例 |
| **本地 + Redis** | 低 | 中 | 多实例 |
| **本地 + Redis + 广播** | 低 | 失效后最终收敛 | 推荐 |
| **本地 + Redis + 广播 + 业务锁** | 中 | 显式业务边界 | 金融/交易 |
| **禁用缓存** | 高 | 最高 | 强一致性 |

---

## 故障排查

### 问题 1: 缓存失效广播不生效

**症状**：实例 A 更新后，实例 B 仍读到旧数据

**排查步骤**：
1. 检查 Redis 连接是否正常
   ```javascript
   await redis.ping();  // 应返回 'PONG'
   ```

2. 检查 Pub/Sub 订阅
   ```javascript
   await redis.subscribe('myapp:cache:invalidate');
   redis.on('message', (channel, message) => {
     console.log('收到消息:', channel, message);
   });
   ```

3. 查看日志
   ```javascript
   // 传入 LoggerLike 实现
   logger: console
   ```

4. 检查实例 ID
   ```javascript
   // 确保每个实例的 instanceId 不同（强烈建议手动设置）
   distributed: {
     instanceId: process.env.INSTANCE_ID  // 使用环境变量
   }
   ```

---

### 问题 2: `transaction.distributedLock` 不生效

**症状**：事务期间其他实例仍写入缓存

**排查步骤**：
1. 先确认运行时边界
   ```javascript
   // v2 兼容说明：
   // transaction.distributedLock 未接入事务缓存锁。
   ```

2. 关键临界区使用显式业务锁
   ```javascript
   const lock = new MonSQLize.DistributedCacheLockManager({
     redis,
     lockKeyPrefix: 'myapp:business:lock:'
   });

   await lock.withLock(`payment:${paymentId}`, async () => {
     // 幂等临界区。
   });
   ```

3. 严格新鲜度读路径禁用或绕过缓存。

---

### 问题 3: Redis 连接失败

**症状**：应用启动报错或缓存不工作

**解决方案**：
```javascript
const Redis = require('ioredis');
const redis = new Redis({
  host: 'localhost',
  port: 6379,
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  reconnectOnError: (err) => {
    console.error('Redis error:', err);
    return true;
  }
});

redis.on('error', (err) => {
  console.error('Redis 连接失败:', err.message);
});

redis.on('connect', () => {
  console.log('✅ Redis 连接成功');
});
```

---

## 总结

### 推荐配置

| 环境 | 推荐方案 |
|------|---------|
| **开发环境** | 本地缓存（默认） |
| **生产环境（单实例）** | 本地缓存 + Redis |
| **生产环境（多实例）** | 本地 + Redis + 分布式失效 |
| **金融/交易系统** | 本地 + Redis + 失效 + 显式业务协调 |

### 快速开始

**最简单的分布式配置**（推荐）：
```javascript
const Redis = require('ioredis');
const redis = new Redis('redis://localhost:6379');

const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'mydb',
  config: { uri: 'mongodb://...' },
  cache: {
    multiLevel: true,
    local: { maxEntries: 1000 },
    remote: MonSQLize.createRedisCacheAdapter(redis),
    distributed: {
      enabled: true,              // ✅ 必需：启用
      redis,
      instanceId: 'instance-1'    // 可选，建议设置，便于日志与排查
    }
  }
});
```

**⚠️ 重要**：
- `instanceId` 是可选的，默认自动生成（格式：`instance-${timestamp}-${random}`）
- 但**强烈建议手动设置**，便于调试和日志追踪
- 每个实例的 `instanceId` 必须不同
- 建议使用环境变量：`instanceId: process.env.INSTANCE_ID`
- 需要显式设置 `redis` 或 `redisUrl`；runtime 不会从 `cache.remote` 推导 Pub/Sub 配置。

---

## 相关文档

- [缓存策略文档](./cache.md)
- [缓存一致性说明](./cache.md)
- [事务功能文档](./transaction.md)
- [Redis 缓存适配器](https://github.com/devcodex-labs/monSQLize/blob/main/src/capabilities/cache/redis-cache-adapter.ts)

