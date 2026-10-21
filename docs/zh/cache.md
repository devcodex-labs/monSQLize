# 缓存 API

运行时远端缓存包装保留可选 TTL 能力，并透传 `set(key, value, ttl, { tags })` 的标签选项。TTL 查询与数据读写使用相同前缀，批量 TTL 结果按调用方原始 key 返回。TTL 方法缺失时沿用适配器回退行为，`undefined` 表示不回填，`null` 表示不过期；空的批量 TTL 结果不会被静默替换为逐 key 查询。

运行时关闭会撤销该包装的在途回填票据，并在清理自有资源前排空已经派发的回填。清理失败后，该包装继续绕过本地读取与回填，直到重试成功。注入缓存仍归调用方所有。公开 `MultiLevelCache.destroy()` 保持同步，无法等待已经开始的任意异步 setter。

`MultiLevelCache` 按键、批量、模式删除及接收远端 key/pattern 失效也会阻止旧远端读取在删除后重新回填 L1，并保留删除结果和无关本地条目。`clear()` 只清 L1 并撤销旧回填，保留 L2 供新读取使用。失败、重入和一致性边界见[缓存失效](./cache-invalidation.md)。

## BSON 查询身份与缓存迁移

稳定查询键编码升级为 `v3`：保留文档中显式的 `undefined` 成员，区分负零和正零，保留 Date、RegExp、Map 插入顺序及二进制子类型和内容，包括来自其他 JavaScript 执行环境的值。Buffer、Uint8Array 视图只使用可见字节；BSON Binary 使用有效 `position`。普通选项属性顺序继续归一化，BSON 文档字段顺序继续保留。

所有共享消费者使用同一代编码：find/findOne/count/distinct、aggregate、ID 查询、Model 查询变体、分页结果、totals 和书签。键按“操作选项、继承的驱动选项、默认 false”的顺序解析有效 `ignoreUndefined`，null/undefined 继续继承父值；count 也会将该选项传给驱动。

升级后这些缓存需要冷预热；书签可用 `prewarmBookmarks()` 重建。书签公开前缀仍是 `bm:v4`，内部哈希会改变。精确 descriptor 重建当前代键；现有按操作或集合的广泛失效仍覆盖新旧条目。混合版本部署时请使用广泛失效或隔离缓存。业务数据与同步检查点不迁移。本次不扩展自定义函数序列化或其他 BSON 解码选项的支持。

## 概述

可注入冻结的自有方法适配器；调用保留原适配器的 `this`，不会凭空增加可选 TTL 能力。Memory、Redis 与多层缓存的批量值读取支持 `__proto__`、`toString` 等合法 key，命中结果均为自有属性；Memory/Redis 的批量 TTL 也保留这些 key。只有 `undefined` 表示未命中，`null`、`false`、`0`、空字符串均保留。

monSQLize 提供面向集合读操作的数据库查询缓存、可选本地/远端缓存组合、手动失效和统计能力。缓存失效用于让常见应用读缓存足够及时，但它不是与 MongoDB 写入原子绑定的提交步骤。

本页只覆盖当前数据库运行时缓存路径：查询结果缓存、Bookmark 缓存、Redis 远端缓存、分布式失效与缓存统计。

## 核心特性

Redis 批次包含 `__proto__` 时，会额外读取该 key 的值或 TTL；普通 key 批次保持原有批量调用。适配器包装返回方法视图：可冻结原适配器，若需定义不可配置属性请在原适配器上操作；视图本身不接受冻结或新增不可配置属性。

- ✅ **TTL 过期**：自动淘汰过期数据
- ✅ **LRU 淘汰**：缓存满时淘汰最少使用的条目
- ✅ **多层缓存架构**：本地缓存 + 可选远端 `CacheLike`，常见实现是 Redis
- ✅ **双层缓存机制**：查询结果缓存 + Bookmark 分页缓存
- ✅ **手动失效**：通过 `invalidate()` 方法清理指定集合的缓存
- ✅ **统计监控**：命中率、淘汰统计、内存占用

---

## 缓存配置

### 全局缓存配置

在构造函数中配置全局缓存参数：

```javascript
import MonSQLize from 'monsqlize';

const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'shop',
  config: { uri: 'mongodb://localhost:27017' },
  
  // 全局缓存配置
  cache: {
    maxEntries: 100000,           // 最大缓存条目数（默认 100000）
    enableStats: true             // 启用统计（默认 true）
  }
});
```

### 查询级缓存配置

在具体查询中指定缓存 TTL（毫秒）：

```javascript
const { collection } = await msq.connect();
const products = collection('products');

// 缓存 5 秒（5000 毫秒）
const result1 = await products.find(
  { category: 'electronics' },
  { 
    cache: 5000,        // 缓存 5000ms
    maxTimeMS: 3000 
  }
);

// 不使用缓存（cache: 0）
const realtimeData = await collection('orders').find(
  { status: 'pending' },
  { 
    cache: 0,           // 禁用缓存
    maxTimeMS: 3000 
  }
);

// 长期缓存（1 小时 = 3600000 毫秒）
const staticConfig = await collection('config').findOne(
  { key: 'site_settings' },
  { 
    cache: 3600000,     // 缓存 1 小时
    maxTimeMS: 3000 
  }
);
```

**重要说明**:
- ✅ `cache` 参数的值是**毫秒数**（TTL）
- ✅ `cache: 0` 表示禁用缓存
- ✅ 默认值：未设置时不使用缓存
- ❌ **不支持** `cache: true` 和单独的 `ttl` 参数

---

## 缓存键生成

缓存键包含数据源/认证指纹、连接池标识、数据库与集合、可选实例标识、操作名、标准化后的查询或聚合 pipeline，以及影响结果的 driver options。分页/书签键还包含游标类型提示及自定义转换策略版本。原始键格式属于内部实现，建议使用失效描述符与集合 API。同源联动与升级后缓存冷启动见[缓存失效](./cache-invalidation.md)。

runtime 使用 BSON-aware 的稳定指纹生成缓存键：

- `ObjectId` 会表示为 `{ $oid }`。
- `Date` 会表示为 `{ $date }`。
- `RegExp` 会表示为 `{ $regex, $flags }`。
- `cache`、`meta`、`explain`、`stream` 这类控制选项不会单独生成一个数据缓存条目。

```javascript
// 概念形态，不是公开 API：
const key = `${operation}:${namespace}:${stableQueryFingerprint}:${stableOptionsFingerprint}`;
```

**相同查询的不同参数会生成不同的缓存键**：

```javascript
// 以下 3 个查询会生成 3 个不同的缓存键

// 查询 1
await collection('products').find(
  { category: 'electronics' },
  { limit: 10, cache: 5000 }
);

// 查询 2（不同的 limit）
await collection('products').find(
  { category: 'electronics' },
  { limit: 20, cache: 5000 }  // ← limit 不同
);

// 查询 3（不同的 sort）
await collection('products').find(
  { category: 'electronics' },
  { limit: 10, sort: { price: 1 }, cache: 5000 }  // ← 有 sort
);

await collection('products').find(
  { category: 'books' },  // 不同的 query
  { limit: 10, cache: 5000 }
);
```

---

## TTL（生存时间）过期

### 自动过期

缓存条目在 TTL 到期后自动失效：

```javascript
const { collection } = await msq.connect();

// 第一次查询：缓存 miss，从数据库读取
const products1 = await collection('products').find(
  { category: 'electronics' },
  {
    cache: 3000,           // 缓存 3 秒
    maxTimeMS: 3000
  }
);
console.log('第一次查询：从数据库读取');

// 2 秒后查询：缓存 hit，从缓存读取
await new Promise(r => setTimeout(r, 2000));
const products2 = await collection('products').find(
  { category: 'electronics' },
  {
    cache: 3000,
    maxTimeMS: 3000
  }
);
console.log('2秒后查询：从缓存读取（缓存 hit）');

// 再等 2 秒（总共 4 秒）：缓存过期，重新从数据库读取
await new Promise(r => setTimeout(r, 2000));
const products3 = await collection('products').find(
  { category: 'electronics' },
  {
    cache: 3000,
    maxTimeMS: 3000
  }
);
console.log('4秒后查询：缓存过期，重新从数据库读取');
```

### TTL 最佳实践

| 数据类型 | 推荐 TTL | 说明 |
|---------|---------|------|
| **静态配置** | 1-24 小时 | 极少变化的数据 |
| **用户信息** | 5-30 分钟 | 中等变化频率 |
| **商品列表** | 30 秒 - 5 分钟 | 频繁更新的数据 |
| **实时订单** | 0（禁用缓存） | 需要实时性的数据 |
| **统计数据** | 10-60 秒 | 允许短暂延迟 |

---

## LRU（最近最少使用）淘汰

### 淘汰机制

当缓存条目数达到 `maxEntries` 时，自动淘汰最久未访问的条目。

```javascript
import MonSQLize from 'monsqlize';

const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'shop',
  config: { uri: 'mongodb://localhost:27017' },
  
  cache: {
    maxEntries: 1000,       // 最多缓存 1000 条
    enableStats: true
  }
});

const { collection } = await msq.connect();

// 缓存 1001 条不同的查询
for (let i = 0; i < 1001; i++) {
  await collection('products').find(
    { id: i },
    {
      cache: 60000,           // 缓存 1 分钟
      maxTimeMS: 3000
    }
  );
}

// 查看淘汰统计
const stats = msq.getCache().getStats();
console.log('淘汰次数:', stats.evictions);
console.log('当前缓存条目数:', stats.entries);  // 应该是 1000（最大值）
```

### LRU 访问顺序

```javascript
// 场景：maxEntries = 3

// 1. 添加 3 条缓存
await collection('test').find({ a: 1 }, { cache: 60000 });  // 缓存 [a:1]
await collection('test').find({ b: 2 }, { cache: 60000 });  // 缓存 [a:1, b:2]
await collection('test').find({ c: 3 }, { cache: 60000 });  // 缓存 [a:1, b:2, c:3]

// 2. 访问第一条缓存（刷新 LRU 顺序）
await collection('test').find({ a: 1 }, { cache: 60000 });  // 缓存 [b:2, c:3, a:1]

// 3. 添加第 4 条缓存（淘汰最少使用的 b:2）
await collection('test').find({ d: 4 }, { cache: 60000 });  // 缓存 [c:3, a:1, d:4]
```

---

## 多层缓存

monSQLize 提供两种多层缓存机制：

### 1. 本地 + 远端缓存架构（MultiLevelCache）

支持本地内存缓存（LRU-Cache）+ 远端缓存（Redis/Memcached）的两层架构，实现更高的缓存命中率和更大的缓存容量。

#### CacheLike 接口规范

要作为 `remote` 使用，缓存实例必须实现以下 10 个方法（`CacheLike` 接口）：

| 方法 | 签名 | 说明 | 必需 |
|------|------|------|------|
| **get** | `async get(key: string): any` | 获取单个缓存值 | ✅ |
| **set** | `async set(key: string, val: any, ttl?: number): void` | 设置单个缓存值（ttl 单位：毫秒） | ✅ |
| **del** | `async del(key: string): boolean` | 删除单个缓存项 | ✅ |
| **exists** | `async exists(key: string): boolean` | 检查键是否存在 | ✅ |
| **getMany** | `async getMany(keys: string[]): Object` | 批量获取（返回 `{key: value}`） | ✅ |
| **setMany** | `async setMany(obj: Object, ttl?: number): boolean` | 批量设置 | ✅ |
| **delMany** | `async delMany(keys: string[]): number` | 批量删除（返回删除数量） | ✅ |
| **delPattern** | `async delPattern(pattern: string): number` | 按模式删除（支持通配符 `*`） | ✅ |
| **clear** | `async clear(): void` | 清空所有缓存 | ✅ |
| **keys** | `async keys(pattern?: string): string[]` | 获取所有键（可选模式匹配） | ✅ |

**验证建议**：

- 优先直接使用 `MonSQLize.createRedisCacheAdapter()`，避免手写 `CacheLike` 适配器
- 若必须自定义 remote cache，请逐项确保实现了上表列出的 10 个方法
- 当前不再提供旧包装层里的 `MemoryCache.isValidCache()` 校验工具

#### 缓存策略

**读操作**：
1. 优先从本地缓存读取（内存，速度快）
2. 本地未命中则查询远端缓存（网络，速度较慢）
3. 远端命中则异步回填到本地缓存（可配置）
4. 远端失败则优雅降级（返回 undefined）

**写操作**：
- `both`（默认）：本地 + 远端双写，保持两级缓存同步；数据库提交与缓存失效不是原子步骤
- `local-first-async-remote`：本地优先，远端异步写入，提升性能

**删除操作**：
- 删除本地缓存（立即生效）
- 删除远端缓存（尽力而为）
- `delPattern` 支持可选的集群广播机制

#### 配置示例

建议在应用启动时创建一次 Redis 适配器，并在下面的示例中复用同一个适配器。如果项目已经通过 `cache.redis.url`、`cache.redis.client` 或其他共享配置集中管理 Redis，请让这份共享配置指向 Redis，不要在每个示例里重复写 URL。

```javascript
import MonSQLize from 'monsqlize';

const redisCache = MonSQLize.createRedisCacheAdapter(
  process.env.REDIS_URL ?? 'redis://localhost:6379/0'
);
```

##### 方式 1：只使用远程 Redis 缓存（无本地缓存）

如果不需要本地内存缓存，可以直接传入 Redis 适配器作为缓存实例：

```javascript
import MonSQLize from 'monsqlize';

// ✅ 只使用 Redis 缓存（不使用 multiLevel）
const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'shop',
  config: { uri: 'mongodb://localhost:27017' },
  
  // 复用共享 Redis 适配器（不需要 multiLevel: true）
  cache: redisCache
});

const { collection } = await msq.connect();

// 所有查询缓存直接存储在 Redis
const products = await collection('products').find(
  { category: 'electronics' },
  {
    cache: 10000,                           // 缓存 10 秒
    maxTimeMS: 3000
  }
);
```

**适用场景**：
- 多实例部署，需要共享缓存
- 服务器内存受限，不适合本地缓存
- 缓存数据量较大（百万级）
- 需要持久化缓存（Redis 持久化）

**性能特点**：
- 读取延迟：1-2ms（网络 + Redis 查询）
- 缓存容量：取决于 Redis 内存（可达 GB 级）
- 缓存一致性：跨实例共享；写后失效是显式 best-effort 流程，分布式广播最终收敛，不与数据库提交原子绑定

---

##### 方式 2：本地 + 远程双层缓存（推荐高性能场景）

使用 `multiLevel: true` 启用本地内存 + Redis 双层架构：

```javascript
import MonSQLize from 'monsqlize';

// ✅ 本地 + 远程双层缓存
const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'shop',
  config: { uri: 'mongodb://localhost:27017' },
  
  cache: {
    multiLevel: true,                     // 启用双层缓存
    
    // 本地缓存配置
    local: {
      maxEntries: 10000,                  // 本地缓存 1 万条
      enableStats: true
    },
    
    // 远端 Redis 缓存（复用共享适配器）
    remote: redisCache,
    
    // 缓存策略
    policy: {
      writePolicy: 'both',                // 'both' | 'local-first-async-remote'
      backfillLocalOnRemoteHit: true      // 远端命中时回填本地（默认 true）
    }
  }
});

const { collection } = await msq.connect();

// 命中流程：
// 1. 查本地缓存 → 命中则返回（0.001ms）
// 2. 本地未命中 → 查 Redis → 命中则返回（1-2ms）+ 回填本地
// 3. Redis 未命中 → 查询 MongoDB → 存入本地 + Redis
const products = await collection('products').find(
  { category: 'electronics' },
  {
    cache: 10000,
    maxTimeMS: 3000
  }
);
```

**适用场景**：
- 高并发读取场景
- 热点数据频繁访问
- 希望热点读优先走本地内存的低延迟路径
- 多实例部署并共享缓存；写后失效仍是 best-effort、最终收敛

**性能特点**：
- 本地缓存命中：0.001ms（内存读取）
- Redis 缓存命中：1-2ms（网络 + Redis）
- 数据库查询：10ms+

---

##### 方式 3：使用已创建的 Redis 实例

```javascript
import MonSQLize from 'monsqlize';
const Redis = require('ioredis');

// 创建 Redis 实例（自定义配置）
const redis = new Redis({
  host: 'localhost',
  port: 6379,
  db: 0,
  retryStrategy: (times) => Math.min(times * 50, 2000)
});

// 只使用 Redis 缓存（无本地缓存）
const msq1 = new MonSQLize({
  type: 'mongodb',
  databaseName: 'shop',
  config: { uri: 'mongodb://localhost:27017' },
  cache: MonSQLize.createRedisCacheAdapter(redis)  // 直接传入实例
});

// 或使用双层缓存
const msq2 = new MonSQLize({
  type: 'mongodb',
  databaseName: 'shop',
  config: { uri: 'mongodb://localhost:27017' },
  
  cache: {
    multiLevel: true,
    local: { maxEntries: 10000 },
    remote: MonSQLize.createRedisCacheAdapter(redis),  // 传入实例
    policy: { writePolicy: 'both' }
  }
});
```

---

##### 方式 4：手动封装 Redis（适用于自定义需求）

```javascript
import MonSQLize from 'monsqlize';
const { MemoryCache } = MonSQLize;  // 公开缓存工具类
const Redis = require('ioredis');

// 创建 Redis 客户端（远端缓存）
const redis = new Redis({
  host: 'localhost',
  port: 6379,
  db: 0
});

// 封装 Redis 为 CacheLike 接口（必须实现以下 10 个方法）
const remoteCache = {
  async get(key) {
    const val = await redis.get(key);
    return val ? JSON.parse(val) : undefined;
  },
  async set(key, val, ttl = 0) {
    const str = JSON.stringify(val);
    if (ttl > 0) {
      await redis.setex(key, Math.ceil(ttl / 1000), str);
    } else {
      await redis.set(key, str);
    }
  },
  async del(key) {
    return await redis.del(key) > 0;
  },
  async exists(key) {
    return await redis.exists(key) > 0;
  },
  async getMany(keys) {
    const values = await redis.mget(keys);
    const result = {};
    keys.forEach((key, i) => {
      if (values[i]) result[key] = JSON.parse(values[i]);
    });
    return result;
  },
  async setMany(obj, ttl = 0) {
    const pipeline = redis.pipeline();
    for (const [key, val] of Object.entries(obj)) {
      const str = JSON.stringify(val);
      if (ttl > 0) {
        pipeline.setex(key, Math.ceil(ttl / 1000), str);
      } else {
        pipeline.set(key, str);
      }
    }
    await pipeline.exec();
    return true;
  },
  async delMany(keys) {
    return await redis.del(...keys);
  },
  async delPattern(pattern) {
    const keys = [];
    let cursor = '0';
    do {
      const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
      cursor = nextCursor;
      keys.push(...batch);
    } while (cursor !== '0');
    if (keys.length > 0) {
      return await redis.del(...keys);
    }
    return 0;
  },
  async clear() {
    await redis.flushdb();
  },
  async keys(pattern = '*') {
    const keys = [];
    let cursor = '0';
    do {
      const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
      cursor = nextCursor;
      keys.push(...batch);
    } while (cursor !== '0');
    return keys;
  }
};

// ✅ 建议先自行做最小契约检查
const hasRequiredMethods = ['get', 'set', 'del', 'exists', 'getMany', 'setMany', 'delMany', 'delPattern', 'clear', 'keys']
  .every((name) => typeof remoteCache[name] === 'function');

console.log('remoteCache 是否符合 CacheLike 接口:', hasRequiredMethods);

// 配置本地 + 远端缓存（monSQLize 内置了 MultiLevelCache）
const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'shop',
  config: { uri: 'mongodb://localhost:27017' },
  
  cache: {
    multiLevel: true,     // ⚠️ 启用多层缓存（必须配置 remote 才有意义）
    
    // 本地缓存配置
    local: {
      maxEntries: 10000,  // 本地缓存 1 万条
      enableStats: true
    },
    
    // 远端缓存配置（必须配置，否则等同于只用本地缓存）
    
    // 方式 1：传入实现了 CacheLike 接口的 Redis 实例（✅ 推荐生产环境）
    remote: remoteCache,  // 上面封装的 Redis 缓存实例
    
    // 方式 2：传入配置对象（❌ 不推荐：会创建内存缓存占位，失去分布式缓存意义）
    // remote: {
    //   maxEntries: 50000, // 创建的是内存缓存，不是真正的 Redis
    //   timeoutMs: 50     // 远端操作超时时间（默认 50ms）
    // },
    
    // ⚠️ 如果不配置 remote，MultiLevelCache 会退化为只用本地缓存
    
    // 缓存策略配置
    policy: {
      writePolicy: 'both',                    // 'both' | 'local-first-async-remote'
      backfillLocalOnRemoteHit: true          // 远端命中时回填本地（默认 true）
    }
  }
});

const { collection } = await msq.connect();

// 使用缓存查询（自动使用本地 + 远端两层）
const products = await collection('products').find(
  { category: 'electronics' },
  {
    cache: 5000,           // 缓存 5 秒
    maxTimeMS: 3000
  }
);

// 命中流程：
// 1. 查本地缓存 → 命中则返回（最快）
// 2. 本地未命中 → 查远端缓存 → 命中则返回 + 回填本地
// 3. 远端未命中 → 查询 MongoDB → 存入本地 + 远端
```

#### 策略配置

```javascript
const msq = new MonSQLize({
  // ...
  cache: {
    maxEntries: 10000,
    remote: remoteCache,
    
    // 写策略配置
    policy: {
      writePolicy: 'both',                      // 'both' | 'local-first-async-remote'
      backfillLocalOnRemoteHit: true            // 远端命中时回填本地（默认 true）
    }
  }
});
```

#### 性能对比

**三种缓存策略对比**：

| 维度 | 无缓存 | 本地缓存（MemoryCache） | 远程缓存（Redis） | 双层缓存（MultiLevel） |
|------|-------|----------------------|------------------|---------------------|
| **响应时间** | 取决于负载和网络 | 取决于进程与负载 | 取决于网络和后端 | 取决于命中层级和回填 |
| **缓存容量** | - | 1-10万条 | GB级别（百万条+） | 本地条目 + Redis 容量 |
| **集群一致性** | ❌ 每次查库 | ❌ 各节点独立 | 共享 Redis 状态；失效最终收敛 | 共享 Redis 状态；失效最终收敛 |
| **内存占用** | - | 高（本地） | 低（远程） | 中（本地）+ 低（远程） |
| **可靠性** | ✅ 直接查库 | ⚠️ 重启丢失 | ✅ 持久化 | ✅ 持久化 |
| **单点故障影响** | 仅DB | 单机重启丢失 | Redis故障降级查库 | Redis故障降级本地 |
| **适用场景** | 低QPS | 单机应用 | 多实例集群 | 高QPS集群 |

**场景选择建议**：

| 场景 | 推荐策略 | 原因 |
|------|---------|------|
| 单机应用，低QPS | 本地缓存（MemoryCache） | 简单高效，无需 Redis 服务 |
| 多实例部署，需共享缓存 | 远程缓存（Redis） | 跨节点共享，写入后 best-effort 失效 |
| 高QPS，热点数据集中 | 双层缓存（MultiLevel） | 热点优先走本地命中路径，远端命中用于共享缓存回退 |
| 内存受限服务器 | 远程缓存（Redis） | 节省本地内存，大容量 |
| 数据持久化需求 | 远程或双层 | Redis支持RDB/AOF持久化 |

**性能影响示例**：

| 场景 | 仅本地缓存 | 本地 + 远端缓存 | 提升 |
|------|-----------|----------------|------|
| 热点数据 | 0.1ms | 0.1ms | 无差异 |
| 冷数据（本地未命中）| 查询 MongoDB | 远端缓存命中时查询 Redis | 命中 Redis 时延迟更低，取决于实际负载 |
| 缓存容量 | 受单进程内存限制 | Redis-backed 远端缓存 | 扩展到单进程以外的容量 |
| 集群一致性 | 每个节点独立 | 共享 Redis，失效后最终收敛 | ✅ |

#### 最佳实践

1. **本地缓存配置**
   - 设置合理的 `maxEntries`（推荐 1-10 万条）
   - 热点数据优先存入本地

2. **远端缓存配置**
   - Redis 连接池配置（避免连接耗尽）
   - 设置合理的超时时间（推荐 50-100ms）
   - 监控 Redis 内存使用

3. **写策略选择**
   - 需要两级缓存同步：使用 `both`（默认）；强一致读路径应绕过缓存或使用事务/业务侧协调
   - 高并发写入：使用 `local-first-async-remote`

4. **故障降级**
   - 远端缓存故障自动降级到本地缓存
   - 不影响业务正常运行

---

### 2. 查询结果 + Bookmark 双层缓存

```javascript
const { collection } = await msq.connect();

// find 查询缓存
const products = await collection('products').find(
  { category: 'electronics' },
  {
    cache: 5000,           // 缓存 5 秒
    maxTimeMS: 3000
  }
);

// findOne 查询缓存
const user = await collection('users').findOne(
  { email: 'user@example.com' },
  {
    cache: 30000,          // 缓存 30 秒
    maxTimeMS: 3000
  }
);

// aggregate 查询缓存
const stats = await collection('orders').aggregate({
  pipeline: [
    { $match: { status: 'completed' } },
    { $group: { _id: '$category', total: { $sum: '$amount' } } }
  ],
  cache: 60000,          // 缓存 1 分钟
  maxTimeMS: 3000
});

// distinct 查询缓存
const categories = await collection('products').distinct(
  'category',
  { inStock: true },
  {
    cache: 10000,          // 缓存 10 秒
    maxTimeMS: 3000
  }
);
```

### Bookmark 分页缓存

```javascript
// findPage 使用 Bookmark 缓存分页游标
const page1 = await collection('products').findPage({
  query: { category: 'electronics' },
  limit: 20,
  bookmarks: {
    step: 10,            // 每 10 页缓存一个书签
    maxHops: 20,         // 最多跳跃 20 次
    ttlMs: 3600000,      // 书签缓存 1 小时
    maxPages: 10000      // 最多缓存 10000 页
  },
  maxTimeMS: 3000
});

// 跳到第 100 页（使用书签缓存加速）
const page100 = await collection('products').findPage({
  query: { category: 'electronics' },
  limit: 20,
  page: 100,             // 跳到第 100 页
  bookmarks: {
    step: 10,
    maxHops: 20,
    ttlMs: 3600000,
    maxPages: 10000
  },
  maxTimeMS: 3000
});
```

---

## 缓存失效行为

写操作默认不失效读缓存。需要写入后清理缓存时，可以在单次写入上使用 `cache.invalidate` 精准指定缓存，也可以使用 `autoInvalidate: true` 触发集合级 broad 失效。完整说明见 [缓存失效](./cache-invalidation.md)。

这是 best-effort 的缓存一致性模型：

- 数据库写入成功后，如果后续缓存失效或分布式广播失败，不会回滚 MongoDB 写入。
- 事务内写入会先记录待失效 intent，成功 commit 后执行；commit 结果未知时也会保守清理。结果已知的事务 abort 会丢弃这些意图。
- 跨实例缓存失效需要配置 `cache.distributed` 与 Redis Pub/Sub，并且仍是最终收敛，不是与数据库 commit 原子绑定。
- `cache.invalidate: false` 或 `cache.invalidate: []` 会覆盖全局 `cache.autoInvalidate: true`，表示本次写入不清理缓存。
- `invalidate()` 仍适用于外部工具改数据、应用侧额外缓存或需要手动刷新缓存的场景。

### 写入失效示例

```javascript
const { collection } = await msq.connect();

// 1. 查询并缓存数据
await collection('products').find(
  { category: 'electronics' },
  { cache: 60000 }
);

await collection('products').find(
  { category: 'books' },
  { cache: 60000 }
);

// 2. 精准失效受影响的 find 缓存
await collection('products').insertOne(
  {
    name: 'New Phone',
    category: 'electronics',
    price: 999
  },
  {
    cache: {
      invalidate: [{
        operation: 'find',
        query: { category: 'electronics' },
        options: { cache: 60000 }
      }]
    }
  }
);

// 3. 下一次缓存读会从 MongoDB 重新填充
await collection('products').find(
  { category: 'electronics' },
  { cache: 60000 }
);
```


### 手动清理

使用 `clearBookmarks()` 手动清理 Bookmark 缓存：

```javascript
const { collection } = await msq.connect();

// 清理特定集合的所有书签
await collection('products').clearBookmarks();
console.log('✅ products 集合的书签已清理');

// 清理特定查询的书签
await collection('products').clearBookmarks({
  query: { category: 'electronics' },
  sort: { createdAt: -1 }
});
console.log('✅ 特定查询的书签已清理');
```

---

## 统计监控

### 获取缓存统计

```javascript
const { collection } = await msq.connect();

// 执行一些查询
await collection('products').find({}, { cache: 5000, maxTimeMS: 3000 });
await collection('products').find({}, { cache: 5000, maxTimeMS: 3000 });  // 缓存 hit
await collection('users').find({}, { cache: 5000, maxTimeMS: 3000 });

// 获取统计
const stats = msq.getCache().getStats();

console.log('缓存统计:', {
  entries: stats.entries,     // 当前缓存条目数
  hits: stats.hits,           // 缓存命中次数
  misses: stats.misses,       // 缓存未命中次数
  sets: stats.sets,           // 缓存设置次数
  deletes: stats.deletes,     // 缓存删除次数
  evictions: stats.evictions, // LRU 淘汰次数
  hitRate: stats.hitRate      // 命中率（0~1）
});

// 输出示例:
// {
//   entries: 2,
//   hits: 1,
//   misses: 2,
//   sets: 2,
//   deletes: 0,
//   evictions: 0,
//   hitRate: 0.3333
// }
```

### 统计指标说明

| 指标 | 说明 | 优化目标 |
|------|------|---------|
| **entries** | 当前缓存条目数 | 接近 maxEntries 表示利用率高 |
| **hits** | 缓存命中次数 | 越高越好 |
| **misses** | 缓存未命中次数 | 越低越好 |
| **sets** | 缓存设置次数 | 正常波动 |
| **deletes** | 缓存删除次数（写操作触发） | 正常波动 |
| **evictions** | LRU 淘汰次数 | 频繁淘汰说明 maxEntries 太小 |
| **hitRate** | 命中率（hits / (hits + misses)，0~1） | 目标 > 0.8 |

### 监控与告警

```javascript
const cache = msq.getCache();
const CACHE_MAX_ENTRIES = 100000;

// 定期监控缓存性能
setInterval(() => {
  const stats = cache.getStats();
  
  // 命中率过低告警
  if (stats.hitRate < 0.5) {
    console.warn('⚠️ 缓存命中率过低:', stats.hitRate);
    console.warn('建议：增加 TTL 或 maxEntries');
  }
  
  // 频繁淘汰告警
  if (stats.evictions > 1000) {
    console.warn('⚠️ 缓存频繁淘汰:', stats.evictions);
    console.warn('建议：增加 maxEntries');
  }
  
  // 缓存利用率低告警
  if (stats.entries < CACHE_MAX_ENTRIES * 0.1) {
    console.warn('⚠️ 缓存利用率过低:', `${stats.entries}/${CACHE_MAX_ENTRIES}`);
    console.warn('建议：减少 maxEntries 或增加缓存使用');
  }
}, 60000);  // 每分钟检查一次
```

---

## 性能测量

缓存命中会避开部分或全部数据库工作，但不代表固定时延或加速倍率。应在相同查询、负载、并发、序列化路径、MongoDB 拓扑与缓存后端下，比较 `find`、`findPage` 和 `distinct` 的冷、热路径分布。保存带 commit 与环境信息的原始样本，再为具体工作负载定义回归预算。

负载、环境、数据集、命令、产物与预算字段要求参见[性能证据](./performance-evidence.md)。

---

## 最佳实践（缓存策略文档）

### 1. 根据数据特征选择 TTL

```javascript
const { collection } = await msq.connect();

// 静态配置：长期缓存
const siteConfig = await collection('config').findOne(
  { key: 'site_settings' },
  {
    cache: 3600000,        // 1 小时
    maxTimeMS: 3000
  }
);

// 用户信息：中等缓存
const user = await collection('users').findOne(
  { id: userId },
  {
    cache: 300000,         // 5 分钟
    maxTimeMS: 3000
  }
);

// 商品列表：短期缓存
const products = await collection('products').find(
  { category: 'electronics' },
  {
    cache: 60000,          // 1 分钟
    maxTimeMS: 3000
  }
);

// 实时订单：禁用缓存
const orders = await collection('orders').find(
  { status: 'pending' },
  {
    cache: 0,              // 不缓存
    maxTimeMS: 3000
  }
);
```

### 2. 合理设置 maxEntries

```javascript
// 低流量场景：较小的 maxEntries
const msqLow = new MonSQLize({
  type: 'mongodb',
  databaseName: 'shop',
  config: { uri: 'mongodb://localhost:27017' },
  cache: { maxEntries: 1000 }    // 1000 条足够
});

// 中等流量场景：标准 maxEntries
const msqMedium = new MonSQLize({
  type: 'mongodb',
  databaseName: 'shop',
  config: { uri: 'mongodb://localhost:27017' },
  cache: { maxEntries: 100000 }  // 默认 10 万条
});

// 高流量场景：较大的 maxEntries
const msqHigh = new MonSQLize({
  type: 'mongodb',
  databaseName: 'shop',
  config: { uri: 'mongodb://localhost:27017' },
  cache: { maxEntries: 500000 }  // 50 万条
});
```

### 3. 监控缓存健康度

```javascript
// 健康检查函数
function checkCacheHealth(msq) {
  const stats = msq.getCache().getStats();
  const hitRate = stats.hitRate;
  const evictionRate = stats.evictions / (stats.sets || 1);
  
  return {
    healthy: hitRate > 0.7 && evictionRate < 0.1,
    hitRate,
    evictionRate,
    recommendations: [
      hitRate < 0.7 && '命中率过低，建议增加 TTL',
      evictionRate > 0.1 && '淘汰频繁，建议增加 maxEntries',
      stats.entries < 100000 * 0.1 && '利用率低，建议减少 maxEntries'
    ].filter(Boolean)
  };
}

// 使用
const health = checkCacheHealth(msq);
if (!health.healthy) {
  console.warn('⚠️ 缓存健康度异常');
  health.recommendations.forEach(r => console.warn('  -', r));
}
```

### 4. 批量预热缓存

```javascript
async function prewarmCache(collection, queries) {
  console.log('开始缓存预热...');
  
  for (const [index, query] of queries.entries()) {
    await collection('products').find(
      query,
      {
        cache: 300000,     // 缓存 5 分钟
        maxTimeMS: 3000
      }
    );
    
    if ((index + 1) % 10 === 0) {
      console.log(`预热进度: ${index + 1}/${queries.length}`);
    }
  }
  
  const stats = msq.getCache().getStats();
  console.log(`✅ 预热完成，已缓存 ${stats.entries} 条查询`);
}

// 使用
const hotQueries = [
  { category: 'electronics' },
  { category: 'books' },
  { inStock: true },
  { price: { $lt: 100 } }
];

await prewarmCache(collection, hotQueries);
```

### 5. 缓存穿透保护

```javascript
// 对于可能返回空结果的查询，也应该缓存
const product = await collection('products').findOne(
  { id: 'non-existent' },
  {
    cache: 60000,          // 缓存空结果 1 分钟
    maxTimeMS: 3000
  }
);

// 第二次查询相同的 id，从缓存返回 null，避免重复查询数据库
const product2 = await collection('products').findOne(
  { id: 'non-existent' },
  {
    cache: 60000,
    maxTimeMS: 3000
  }
);
```

---

## 常见问题

### Q: 缓存会占用多少内存？

**A**: 每个缓存条目包含查询键（约 100-200 字节）和查询结果（取决于数据大小）。

估算公式：
```text
内存占用 ≈ 缓存条目数 × 平均结果大小

示例:
- 10000 条缓存
- 每条结果平均 1KB
- 总内存占用 ≈ 10000 × 1KB = 10MB
```

### Q: 如何选择合适的 maxEntries？

**A**: 根据服务器内存和查询热点数据量选择：

```javascript
// 公式
// maxEntries = 可用内存 / 平均结果大小

// 示例 1：服务器有 1GB 可用内存，平均结果 1KB
// maxEntries ≈ 1GB / 1KB = 1000000 条

// 示例 2：服务器有 100MB 可用内存，平均结果 500 字节
// maxEntries ≈ 100MB / 500B = 200000 条
```

**建议**：
- 从默认值 100000 开始
- 监控淘汰率（evictionRate）
- 如果 evictionRate > 10%，增加 maxEntries

### Q: 如何手动清理缓存？

**A**: monSQLize 已支持写操作；但在以下场景里仍然建议手动清理缓存：

```javascript
const { collection } = await msq.connect();

// 场景 1：外部工具修改了数据（如 MongoDB Shell）
// 需要手动清除缓存
await collection('products').invalidate();
console.log('✅ products 集合缓存已清除');

// 场景 2：定时刷新缓存
setInterval(async () => {
  await collection('products').invalidate();
  console.log('✅ 缓存已刷新');
}, 5 * 60 * 1000);  // 每 5 分钟刷新一次

// 场景 3：批量清除多个集合
const collections = ['products', 'users', 'orders'];
for (const name of collections) {
  await collection(name).invalidate();
  console.log(`✅ ${name} 缓存已清除`);
}
```

**注意**：
- 当使用外部工具修改数据后，仍需手动调用 `invalidate()` 清理缓存
- 通过 monSQLize 发起的写操作只有在 `cache.invalidate`、`autoInvalidate` 或全局 `cache.autoInvalidate` 配置后才会清理读缓存
- 若你的缓存策略跨进程/跨节点，建议同时结合分布式失效广播

### Q: 如何禁用缓存？

**A**: 有三种方式：

```javascript
// 方式 1：全局禁用（构造时不传 cache 配置）
const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'shop',
  config: { uri: 'mongodb://localhost:27017' }
  // 不传 cache 配置
});

// 方式 2：查询级禁用
await collection('orders').find(
  {},
  {
    cache: 0,              // cache: 0 表示不缓存
    maxTimeMS: 3000
  }
);

// 方式 3：不传 cache 参数
await collection('orders').find(
  {},
  {
    maxTimeMS: 3000        // 不传 cache 参数
  }
);
```

### Q: 缓存和 Bookmark 有什么区别？

**A**: 
- **缓存（find/findOne/aggregate/distinct）**：缓存查询结果（完整的文档列表）
- **Bookmark（findPage）**：缓存分页游标（仅存储每 N 页的起始位置）

```javascript
// 缓存查询结果（存储完整数据）
const products = await collection('products').find(
  {},
  {
    cache: 60000           // 缓存完整的 products 列表
  }
);

// Bookmark 分页（仅存储游标位置）
const page1 = await collection('products').findPage({
  query: {},
  limit: 20,
  bookmarks: {
    step: 10,            // 每 10 页存储一个游标
    ttlMs: 3600000       // 游标缓存 1 小时
  }
});
```

---

## 缓存失效 API

### invalidate()

手动清除指定集合的所有缓存。适用于需要立即刷新缓存的场景。

#### 方法签名

```javascript
await collection('collectionName').invalidate()
```

#### 参数说明

无参数。清除当前绑定集合的所有查询缓存。

#### 返回值

返回 `Promise<void>`。

---

### 使用场景

#### 1. 外部工具修改数据后刷新缓存

```javascript
const { collection } = await msq.connect();

// 场景：使用 MongoDB Shell、Compass 或其他工具修改了数据
// 需要手动清除 monSQLize 的缓存

// 清除 products 集合的缓存
await collection('products').invalidate();

console.log('✅ 缓存已清除，下次查询将获取最新数据');
```

---

#### 2. 定时刷新缓存

```javascript
const { collection } = await msq.connect();

// 每 5 分钟刷新一次 products 缓存
setInterval(async () => {
  await collection('products').invalidate();
  console.log('✅ products 缓存已刷新');
}, 5 * 60 * 1000);
```

---

#### 3. 多集合缓存清除

```javascript
const { collection } = await msq.connect();

// 清除多个集合的缓存
async function clearAllCache() {
  const collections = ['products', 'users', 'orders', 'configs'];
  
  for (const name of collections) {
    await collection(name).invalidate();
    console.log(`✅ ${name} 缓存已清除`);
  }
}

await clearAllCache();
```

---

### 使用说明

**重要提示**：monSQLize 当前版本已经支持 `insertOne` / `updateOne` / `deleteOne` 等写操作；通过 monSQLize 写入时，只有显式配置了失效策略才会清理相关缓存。`invalidate()` 仍然用于以下场景：

1. **外部写入后的显式清理**：
   - 使用 MongoDB Shell、Compass 或其他应用直接修改数据后
   - 旁路批量导入、迁移脚本或手工修复数据后
2. **主动刷新策略**：
   - 定时刷新热点集合缓存
   - 临时强制清理某个集合的查询缓存
3. **自定义缓存边界**：
   - 使用自定义 cache adapter 或业务侧额外缓存时，需要自行决定清理范围

**当前最佳实践**：
- 业务写入优先通过 monSQLize 执行，避免绕过缓存失效链路
- 外部工具或旁路脚本修改数据后，立即调用 `invalidate()`
- 定期监控缓存命中率，决定是否需要定时刷新
- 避免过度使用，仅在必要时清除缓存

---

### 最佳实践（缓存失效 API）

#### 1. 避免过度使用

```javascript
// ❌ 不推荐：每次查询前都清除缓存
await collection('products').invalidate();
const products = await collection('products').find(
  {},
  { cache: 60000 }
);

// ✅ 推荐：只在必要时清除缓存
// 只有在外部修改数据或特殊需求时才手动清除
```

---

#### 2. 结合缓存监控

```javascript
const cache = msq.getCache();

// 清除缓存前记录统计
const beforeStats = cache.getStats();
console.log('清除前缓存项:', beforeStats.size);

// 清除缓存
await collection('products').invalidate();

// 清除后记录统计
const afterStats = cache.getStats();
console.log('清除后缓存项:', afterStats.size);
console.log('清除数量:', beforeStats.size - afterStats.size);
```

---

#### 3. 批量清除时使用并行

```javascript
// ✅ 并行清除（更快）
const collections = ['products', 'users', 'orders'];

await Promise.all(
  collections.map(name => collection(name).invalidate())
);

console.log('✅ 所有缓存已清除');
```

---

#### 4. 定时刷新的错误处理

```javascript
// 定时刷新缓存，带错误处理
setInterval(async () => {
  try {
    await collection('products').invalidate();
    console.log('✅ products 缓存已刷新');
  } catch (error) {
    console.error('❌ 缓存刷新失败:', error.message);
  }
}, 5 * 60 * 1000);
```

---

### 注意事项

1. **清除范围**：`invalidate()` 只清除指定集合的查询缓存，不影响其他集合
2. **性能影响**：清除缓存后，下次查询需要访问数据库，会有性能损耗
3. **不清除 Bookmarks**：`invalidate()` 不清除 findPage 的 Bookmark 缓存，需要使用 `clearBookmarks()`
4. **旁路写入限制**：通过外部工具或其他服务绕过 monSQLize 写入时，必须手动调用 `invalidate()` 或执行等效的业务清理动作

---

### 相关方法

- **`clearBookmarks(collectionName?)`** - 清除 findPage 的 Bookmark 缓存（参见 [Bookmarks 文档](./bookmarks.md)）
- **`getCache()`** - 获取缓存实例，可调用 `clear()` 清除所有缓存（参见 [工具方法文档](./utilities.md)）

---

## 参考资料

- [LRU 缓存算法](https://en.wikipedia.org/wiki/Cache_replacement_policies#Least_recently_used_(LRU))
- [Redis 缓存策略](https://redis.io/topics/lru-cache)
- [HTTP 缓存控制](https://developer.mozilla.org/en-US/docs/Web/HTTP/Caching)
- [monSQLize README](../../README.md)
- [findPage 文档](./findPage.md)
- [Bookmarks 文档](./bookmarks.md)
- [工具方法文档](./utilities.md)
