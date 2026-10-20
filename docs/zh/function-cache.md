# 函数缓存 (Function Cache，Legacy 兼容)

兼容性 withCache 包装器提供同一底层包装器的 invalidate(...args) 和 invalidateAll()，保留 namespace、自定义 keyBuilder 与统计行为。

> **当前站点状态**: 已从导航隐藏
> **兼容状态**: 继续为既有消费方导出

`withCache()` 与 `FunctionCache` 仍保留 public API 兼容，但非数据库函数缓存不再作为 monSQLize 当前维护的能力方向。新的通用函数缓存建议直接使用 `cache-hub`，或放在应用自己的缓存层处理。当前 monSQLize 文档重点覆盖数据库查询缓存、Redis adapter、分布式失效与数据库 runtime 的缓存行为。

## 概述

函数缓存用于为**任意异步函数**添加缓存能力，不仅限于数据库查询。现在该页面只作为 legacy 兼容说明保留。

### 特性

这些能力仍可用于兼容既有消费方，但不再作为新的 monSQLize 缓存推荐入口。

- ✅ **零侵入**：通过装饰器模式，不修改原函数
- ✅ **自动序列化**：支持复杂参数（对象、数组、Date、ObjectId 等）
- ✅ **TTL 过期**：灵活的缓存时间控制
- ✅ **并发控制**：防止缓存击穿
- ✅ **条件缓存**：基于返回值决定是否缓存
- ✅ **命名空间隔离**：多模块缓存互不干扰
- ✅ **统计监控**：命中率、调用次数等
- ✅ **复用基础设施**：自动继承 monSQLize 的缓存配置（本地/Redis/双层）

---

## 兼容示例

### 安装

```bash
npm install monsqlize
```

### 方式 1：装饰器模式

```javascript
import MonSQLize from 'monsqlize';
import { withCache } from 'monsqlize';

const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'mydb',
    config: { uri: 'mongodb://localhost:27017' },
    cache: {
        multiLevel: true,
        local: { maxEntries: 10000 },
        remote: MonSQLize.createRedisCacheAdapter('redis://localhost:6379/0')
    }
});

await msq.connect();

// 业务函数（包含数据库查询）
async function getUserProfile(userId) {
    const user = await msq.collection('users').findOne({ _id: userId });
    const orders = await msq.collection('orders').find({ userId }).toArray();
    return { user, orders };
}

// 应用缓存
const cachedGetUserProfile = withCache(getUserProfile, {
    ttl: 300000,  // 5分钟
    cache: msq.getCache()  // 复用 monSQLize 缓存
});

// 使用
const profile = await cachedGetUserProfile('user123');  // 首次查询（~1.5ms）
const profile2 = await cachedGetUserProfile('user123'); // 命中缓存（~0.003ms，500x加速）⚡
```

⚠️ **重要提示**: 缓存适合**有明显开销**的函数（数据库查询、API调用等）。对于简单计算（如 `x => x * 2`），使用缓存会让性能**变差**。

### 方式 2：FunctionCache 类

```javascript
import { FunctionCache } from 'monsqlize';

const fnCache = new FunctionCache(msq, {
    namespace: 'myApp',
    ttl: 60000
});

// 注册函数
fnCache.register('getUserProfile', getUserProfileFn, { 
    ttl: 300000
});
fnCache.register('getOrderStats', getOrderStatsFn, { 
    ttl: 600000
});

// 执行
const profile = await fnCache.execute('getUserProfile', 'user123');
const stats = await fnCache.execute('getOrderStats', 'user123', 2024);

// ⚠️ 重要：数据更新后需要手动失效缓存
await msq.collection('users').updateOne({ _id: 'user123' }, { $set: { name: 'Alice' } });
await fnCache.invalidate('getUserProfile', 'user123'); // 手动失效缓存

// 查看统计
console.log(fnCache.getStats('getUserProfile'));
// { hits: 10, misses: 2, hitRate: 0.833, avgTime: 5.2 }
```

---

## 核心 API

### withCache(fn, options)

装饰器函数，为异步函数添加缓存能力。

#### 参数

| 参数 | 类型 | 必需 | 默认值 | 说明 |
|------|------|------|-------|------|
| `fn` | `Function` | ✅ | - | 要缓存的异步函数 |
| `options` | `Object` | ❌ | `{}` | 缓存配置 |
| `options.ttl` | `number` | ❌ | `60000` | 缓存时间（毫秒） |
| `options.keyBuilder` | `Function` | ❌ | - | 自定义键生成函数 |
| `options.cache` | `Object` | ❌ | 内存缓存 | 缓存实例 |
| `options.namespace` | `string` | ❌ | `'fn'` | 命名空间 |
| `options.condition` | `Function` | ❌ | - | 条件缓存函数 |
| `options.enableStats` | `boolean` | ❌ | `true` | 启用统计 |

#### 返回值

返回包装后的函数，附带 `invalidate()` / `invalidateAll()` / `stats()` 方法。

#### 示例

```javascript
// 基础用法
const cached = withCache(originalFn, { ttl: 60000 });

// 自定义键生成
const cached = withCache(originalFn, {
    ttl: 300000,
    keyBuilder: (userId) => `user:${userId}`
});

// 条件缓存
const cached = withCache(originalFn, {
    ttl: 60000,
    condition: (result) => result && result.length > 0
});
```

---

### FunctionCache 类

#### 构造函数

```javascript
new FunctionCache(msq, options)
```

| 参数 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `msq` | `MonSQLize` | ❌ | MonSQLize 实例（可选） |
| `options` | `Object` | ❌ | 配置选项 |
| `options.namespace` | `string` | ❌ | 命名空间（默认 `'action'`） |
| `options.ttl` | `number` | ❌ | 默认 TTL（默认 `60000`） |

#### 方法

##### register(name, fn, options)

注册函数。

```javascript
fnCache.register('getUserProfile', getUserProfileFn, {
    ttl: 300000,
    keyBuilder: (userId) => `profile:${userId}`
});
```

##### execute(name, ...args)

执行函数。

```javascript
const result = await fnCache.execute('getUserProfile', 'user123');
```

##### invalidate(name, ...args)

失效缓存。

```javascript
await fnCache.invalidate('getUserProfile', 'user123');
```

##### invalidatePattern(pattern)

批量失效缓存。

```javascript
await fnCache.invalidatePattern('getUserProfile:*');
```

##### getStats(name?)

获取统计信息。

```javascript
// 单个函数
const stats = fnCache.getStats('getUserProfile');
// { hits: 10, misses: 2, errors: 0, hitRate: 0.833 }

// 所有函数
const allStats = fnCache.getStats();
```

##### list()

列出所有已注册的函数。

```javascript
const functions = fnCache.list();
// ['getUserProfile', 'getOrderStats', 'calculateScore']
```

##### resetStats(name?)

重置统计信息。

```javascript
fnCache.resetStats('getUserProfile');  // 重置单个
fnCache.resetStats();                   // 重置所有
```

##### clear()

清空所有已注册的函数。

```javascript
fnCache.clear();
```

---

## 使用场景

### 场景 1：复杂业务逻辑

```javascript
async function getUserDashboard(userId) {
    // 复杂的业务逻辑：查询多个集合 + 计算
    const user = await msq.collection('users').findOne({ _id: userId });
    const orders = await msq.collection('orders').find({ userId }).toArray();
    const reviews = await msq.collection('reviews').find({ userId }).toArray();
    
    const stats = calculateStats(orders, reviews);
    
    return { user, orders, reviews, stats };
}

// 应用缓存
const cached = withCache(getUserDashboard, {
    ttl: 300000,  // 5分钟
    cache: msq.getCache()
});
```

**性能提升：** 从 50ms → 0.001ms（50000x 加速）

---

### 场景 2：外部 API 调用

```javascript
const axios = require('axios');

async function fetchWeatherData(city) {
    const response = await axios.get(`https://api.weather.com/current?city=${city}`);
    return response.data;
}

// 应用缓存
const cached = withCache(fetchWeatherData, {
    ttl: 300000,  // 5分钟
    keyBuilder: (city) => `weather:${city}`,
    cache: msq.getCache()
});
```

**性能提升：** 从 200-500ms → 0.001ms（200000-500000x 加速）

---

### 场景 3：复杂计算

```javascript
async function calculateUserScore(userId) {
    const orders = await msq.collection('orders').find({ userId }).toArray();
    const reviews = await msq.collection('reviews').find({ userId }).toArray();
    
    // 复杂的算分逻辑（50ms）
    return expensiveCalculation(orders, reviews);
}

// 应用缓存
const cached = withCache(calculateUserScore, {
    ttl: 600000,  // 10分钟
    cache: msq.getCache()
});
```

**性能提升：** 从 100ms → 0.001ms（100000x 加速）

---

### 场景 4：条件缓存

```javascript
// 只缓存有效结果
const cached = withCache(searchProducts, {
    ttl: 60000,
    condition: (result) => result && result.length > 0,  // 只缓存非空结果
    cache: msq.getCache()
});
```

---

### 场景 5：命名空间隔离

```javascript
// 用户模块
const userCache = new FunctionCache(msq, { namespace: 'user' });
userCache.register('getProfile', getUserProfileFn);

// 订单模块
const orderCache = new FunctionCache(msq, { namespace: 'order' });
orderCache.register('getProfile', getOrderProfileFn);

// 缓存键：
// - user:getProfile:...
// - order:getProfile:...
```

---

## 最佳实践

### 1. 合理设置 TTL

| 数据类型 | 推荐 TTL | 理由 |
|---------|---------|------|
| **静态配置** | 1-24 小时 | 极少变化 |
| **用户资料** | 5-30 分钟 | 中等变化频率 |
| **外部 API** | 2-10 分钟 | 减少外部依赖 |
| **统计数据** | 30 秒 - 5 分钟 | 允许短暂延迟 |
| **实时数据** | 0（禁用缓存） | 需要实时性 |

---

### 2. 识别适合缓存的函数 ⚠️ 重要

**✅ 适合使用缓存**:
- 数据库查询（> 1ms）
- 外部 API 调用（> 50ms）
- 复杂计算（> 10ms）
- 文件 I/O 操作

**❌ 不适合使用缓存**:
- 简单计算（< 0.01ms）：如 `x => x * 2`
- 纯内存操作（< 0.01ms）：如数组简单遍历
- 已经很快的函数（< 0.01ms）

**性能测试建议**:
```javascript
// 添加缓存前，先测试函数执行时间
const start = process.hrtime.bigint();
await myFunction(args);
const time = Number(process.hrtime.bigint() - start) / 1000000;
console.log(`执行时间: ${time}ms`);

// 如果 time > 0.01ms，才考虑使用缓存
// 如果 time < 0.01ms，缓存可能会让性能变差
```

---

### 3. 使用命名空间隔离

```javascript
// ✅ 推荐：不同模块使用不同命名空间
const userCache = new FunctionCache(msq, { namespace: 'user' });
const productCache = new FunctionCache(msq, { namespace: 'product' });

// ❌ 不推荐：所有函数使用同一命名空间
const cache = new FunctionCache(msq);
```

---

### 4. 使用命名函数

```javascript
// ✅ 推荐：使用命名函数
async function getUserProfile(userId) { /*...*/ }
const cached = withCache(getUserProfile, { ttl: 60000 });

// ❌ 不推荐：匿名函数
const cached = withCache(async (userId) => { /*...*/ }, { ttl: 60000 });
```

---

### 5. 监控缓存命中率

```javascript
// 定期检查缓存命中率
setInterval(() => {
    const stats = fnCache.getStats();
    console.log('缓存统计:', stats);
    
    // 如果命中率低于 80%，考虑调整 TTL
    if (stats.hitRate < 0.8) {
        console.warn('⚠️  缓存命中率偏低，建议调整 TTL');
    }
}, 60000);
```

---

### 5. 及时失效缓存

```javascript
// 数据更新后立即失效相关缓存
async function updateUserProfile(userId, data) {
    await msq.collection('users').updateOne({ _id: userId }, { $set: data });
    
    // 失效相关缓存
    await fnCache.invalidate('getUserProfile', userId);
    await fnCache.invalidate('getUserDashboard', userId);
}
```

---
## Legacy 性能说明

`withCache()` 和 `FunctionCache` 保留给既有消费方使用；新的通用函数级缓存建议直接使用 `cache-hub`，或放在应用自己的缓存层处理。

既有代码保留 wrapper 前应按真实工作负载评估：

- 只缓存有明显 I/O 或计算成本的函数。
- 不要包装非常轻量的同步计算。
- TTL 与失效策略应由数据归属方控制。
- monSQLize 查询结果优先使用数据库查询缓存。
## 常见问题

### Q1: 如何选择缓存类型？

**A:** 根据应用场景选择：

- **单实例应用** → 仅本地缓存
- **多实例应用** → 本地 + Redis 双层缓存
- **微服务架构** → Redis 缓存（共享）

---

### Q2: 匿名函数会导致键冲突吗？

**A:** 会。建议：

```javascript
// ❌ 危险：匿名函数可能冲突
const cached1 = withCache(async (x) => { /*...*/ }, { ttl: 60000 });
const cached2 = withCache(async (x) => { /*...*/ }, { ttl: 60000 });

// ✅ 安全：使用命名函数
async function fn1(x) { /*...*/ }
async function fn2(x) { /*...*/ }
const cached1 = withCache(fn1, { ttl: 60000 });
const cached2 = withCache(fn2, { ttl: 60000 });

// ✅ 安全：使用不同命名空间
const cached1 = withCache(async (x) => { /*...*/ }, {
    namespace: 'fn1',
    ttl: 60000
});
```

---

### Q3: 如何复用 monSQLize 的缓存配置？

**A:** 使用 `msq.getCache()`:

```javascript
const cached = withCache(fn, {
    ttl: 60000,
    cache: msq.getCache()  // 自动继承 Redis/多层缓存配置
});
```

---

### Q4: 支持哪些参数类型？

**A:** 支持所有可序列化类型：

- ✅ 基础类型（string、number、boolean）
- ✅ 对象、数组
- ✅ Date、RegExp
- ✅ MongoDB 类型（ObjectId、Decimal128 等）
- ❌ 函数、Symbol

---

### Q5: 如何处理缓存穿透？

**A:** 使用条件缓存：

```javascript
const cached = withCache(fn, {
    ttl: 60000,
    condition: (result) => result !== null  // 不缓存 null 值
});
```

---

## TypeScript 支持

```typescript
import { withCache, FunctionCache, WithCacheOptions } from 'monsqlize';

// withCache 自动推导类型
async function getUserProfile(userId: string) {
    return { userId, name: 'User' };
}

const cached = withCache(getUserProfile, {
    ttl: 60000
});

// 类型安全
const profile = await cached('user123');  // profile: { userId: string; name: string; }

// FunctionCache
const fnCache = new FunctionCache(msq);
fnCache.register('getUserProfile', getUserProfile);
const result = await fnCache.execute<{ userId: string; name: string }>('getUserProfile', 'user123');
```

---

## 相关文档

- [缓存策略文档](./cache.md)
- [多层缓存配置](./cache.md#多层缓存)
- [使用已创建的 Redis 实例](./cache.md#方式-3使用已创建的-redis-实例)
- [函数缓存键生成机制](./function-cache.md)

---

**文档结束**
