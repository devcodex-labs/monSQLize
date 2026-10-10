# 工具方法

## 概述

monSQLize 提供了一组实用的工具方法，用于访问内部状态、获取配置信息和命名空间信息。这些方法帮助开发者更好地理解和调试应用程序。

## 核心特性

- ✅ **缓存实例访问**：获取底层缓存实例进行高级操作
- ✅ **配置查询**：查看当前的默认配置和参数
- ✅ **命名空间信息**：获取集合的完整命名空间

---

## API 方法

### getCache()

获取底层缓存实例，支持直接操作缓存。

#### 方法签名

```javascript
const cache = msq.getCache()
```

#### 参数说明

无参数。

#### 返回值

```javascript
CacheLike  // MemoryCache、MultiLevelCache、Redis adapter 或自定义 CacheLike
```

#### 缓存实例方法

| 方法 | 说明 |
|------|------|
| `get(key)` | 获取缓存值 |
| `set(key, value, ttl)` | 设置缓存值 |
| `del(key)` | 删除缓存项 |
| `clear()` | 清空所有缓存 |
| `keys(pattern)` | 获取匹配模式的缓存键列表 |
| `getStats()` | 获取缓存统计信息 |

---

## 使用示例

### 基本用法

#### 1. 获取缓存实例

```javascript
import MonSQLize from 'monsqlize';

const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'shop',
  config: { uri: 'mongodb://localhost:27017' },
  cache: {
    maxEntries: 1000,
    defaultTtl: 60000
  }
});

await msq.connect();

const cache = msq.getCache();
console.log('缓存类型:', cache.constructor.name);
```

---

#### 2. 查看缓存统计

```javascript
const cache = msq.getCache();
const stats = cache.getStats();

console.log('缓存统计:', {
  命中次数: stats.hits,
  未命中次数: stats.misses,
  命中率: `${(stats.hits / (stats.hits + stats.misses) * 100).toFixed(2)}%`,
  缓存项数量: stats.size,
  内存使用: `${(stats.memoryUsage / 1024 / 1024).toFixed(2)} MB`
});
```

**输出示例**：
```javascript
{
  命中次数: 150,
  未命中次数: 50,
  命中率: '75.00%',
  缓存项数量: 85,
  内存使用: '2.34 MB'
}
```

---

#### 3. 手动操作缓存

```javascript
const { collection } = await msq.connect();
const cache = msq.getCache();

const cacheKey = 'custom:data:123';
await cache.set(cacheKey, { id: 123, name: 'Product A' }, 3600000); // 1小时

const cached = await cache.get(cacheKey);
console.log('缓存数据:', cached);

await cache.del(cacheKey);
console.log('✅ 缓存已删除');
```

---

#### 4. 清空所有缓存

```javascript
const cache = msq.getCache();

await cache.clear();
console.log('✅ 所有缓存已清空');

const stats = cache.getStats();
console.log('缓存项数量:', stats.size);  // 应该是 0
```

---

### getDefaults()

获取当前实例的默认配置参数。

#### 方法签名（getDefaults()）

```javascript
const defaults = msq.getDefaults()
```

#### 参数说明（getDefaults()）

无参数。

#### 返回值（getDefaults()）

```javascript
{
  type: 'mongodb',
  databaseName: string | undefined,
  maxTimeMS: number,
  findLimit: number,
  findMaxLimit: number,
  findMaxSkip: number,
  findPageMaxLimit: number,
  autoConvertObjectId: boolean | object,
  namespace: object,
  slowQueryLog: object | false
}
```

---

#### 5. 获取特定集合的缓存信息（推荐方法 ⭐）

**方法 1：使用 `getNamespace()` + `cache.keys()` 组合**（最方便）

```javascript
const { collection } = await msq.connect();
const cache = msq.getCache();

if (cache) {
  // 获取命名空间信息
  const ns = collection('products').getNamespace();
  console.log('命名空间:', ns);  // { iid: '...', type: 'mongodb', db: 'shop', collection: 'products' }
  
  // 使用命名空间构建模式（更精确）
  const pattern = `*"collection":"${ns.collection}"*"db":"${ns.db}"*`;
  const productsCacheKeys = await cache.keys(pattern);
  
  console.log('products 集合缓存信息:');
  console.log('  缓存键数量:', productsCacheKeys.length);
  
  // 查看每个缓存键的内容
  for (const key of productsCacheKeys.slice(0, 5)) {  // 只显示前 5 个
    const value = await cache.get(key);
    console.log('  键:', key);
    console.log('  值:', value ? `${value.length} 个文档` : 'null');
  }
}
```

**方法 2：直接使用集合名（简单但可能跨数据库匹配）**

```javascript
const cache = msq.getCache();

if (cache) {
  // 仅使用集合名（可能匹配其他数据库的同名集合）
  const productsCacheKeys = await cache.keys('*"collection":"products"*');
  
  console.log('products 集合缓存数量:', productsCacheKeys.length);
}
```

**输出示例**：
```javascript
products 集合缓存信息:
  缓存键数量: 12
  键: {"ns":{"p":"monSQLize","v":1,"iid":"...","type":"mongodb","db":"shop","collection":"products"},"op":"find","query":{"status":"active"}}
  值: 25 个文档
  键: {"ns":{"p":"monSQLize","v":1,"iid":"...","type":"mongodb","db":"shop","collection":"products"},"op":"count","query":{}}
  值: null
  ...
```

---

#### 6. 获取特定操作的缓存

```javascript
const cache = msq.getCache();

if (cache) {
  // 获取所有 find 操作的缓存键
  const findCacheKeys = await cache.keys('*"op":"find"*');
  console.log('find 操作缓存数量:', findCacheKeys.length);
  
  // 获取所有 count 操作的缓存键
  const countCacheKeys = await cache.keys('*"op":"count"*');
  console.log('count 操作缓存数量:', countCacheKeys.length);
  
  // 获取 products 集合的 find 操作缓存
  const productsFind = await cache.keys('*"collection":"products"*"op":"find"*');
  console.log('products find 缓存数量:', productsFind.length);
}
```

---

#### 7. 分析缓存使用情况（简化方法 ⭐）

```javascript
const { collection } = await msq.connect();
const cache = msq.getCache();

if (cache) {
  // 方法 1：使用 getNamespace() 获取精确的命名空间（推荐）
  async function getCacheInfoByCollection(collectionName) {
    const ns = collection(collectionName).getNamespace();
    const pattern = `*"collection":"${ns.collection}"*"db":"${ns.db}"*`;
    const allKeys = await cache.keys(pattern);
    
    const info = {
      collection: ns.collection,
      database: ns.db,
      total: allKeys.length,
      operations: {}
    };
    
    // 统计各操作类型
    for (const key of allKeys) {
      try {
        const keyObj = JSON.parse(key);
        const op = keyObj.op || 'unknown';
        info.operations[op] = (info.operations[op] || 0) + 1;
      } catch (e) {
        // 忽略无法解析的键
      }
    }
    
    return info;
  }
  
  // 获取 products 集合的缓存信息
  const productsInfo = await getCacheInfoByCollection('products');
  console.log('products 缓存信息:', productsInfo);
  
  // 批量获取多个集合
  const collections = ['products', 'users', 'orders'];
  const allInfo = {};
  for (const name of collections) {
    allInfo[name] = await getCacheInfoByCollection(name);
  }
  console.log('所有集合缓存:', allInfo);
}
```

**输出示例**：
```javascript
products 缓存信息: {
  collection: 'products',
  database: 'shop',
  total: 15,
  operations: { find: 8, count: 4, findOne: 3 }
}

所有集合缓存: {
  products: { collection: 'products', database: 'shop', total: 15, operations: { find: 8, count: 4, findOne: 3 } },
  users: { collection: 'users', database: 'shop', total: 8, operations: { find: 5, findOne: 3 } },
  orders: { collection: 'orders', database: 'shop', total: 6, operations: { find: 4, count: 2 } }
}
```

---

#### 8. 完整的缓存管理工具函数

```javascript
const { collection } = await msq.connect();
const cache = msq.getCache();

// 封装成工具类
class CacheManager {
  constructor(msq) {
    this.msq = msq;
    this.cache = msq.getCache();
  }
  
  // 获取集合缓存信息
  async getCollectionCacheInfo(collectionName) {
    if (!this.cache) return null;
    
    const ns = this.msq.collection(collectionName).getNamespace();
    const pattern = `*"collection":"${ns.collection}"*"db":"${ns.db}"*`;
    const keys = await this.cache.keys(pattern);
    
    return {
      collection: ns.collection,
      database: ns.db,
      namespace: `${ns.db}.${ns.collection}`,
      totalKeys: keys.length,
      operations: this._groupByOperation(keys),
      keys: keys
    };
  }
  
  // 按操作类型分组
  _groupByOperation(keys) {
    const ops = {};
    for (const key of keys) {
      try {
        const keyObj = JSON.parse(key);
        const op = keyObj.op || 'unknown';
        if (!ops[op]) ops[op] = [];
        ops[op].push(key);
      } catch (e) {
        // 忽略
      }
    }
    return ops;
  }
  
  // 获取全局缓存统计
  getGlobalStats() {
    if (!this.cache) return null;
    return this.cache.getStats();
  }
  
  // 获取所有集合的缓存分布
  async getAllCollectionsCacheInfo() {
    if (!this.cache) return null;
    
    const allKeys = await this.cache.keys('*');
    const collectionsMap = {};
    
    for (const key of allKeys) {
      try {
        const keyObj = JSON.parse(key);
        const ns = keyObj.ns;
        if (!ns || !ns.collection) continue;
        
        const collKey = `${ns.db}.${ns.collection}`;
        if (!collectionsMap[collKey]) {
          collectionsMap[collKey] = {
            database: ns.db,
            collection: ns.collection,
            totalKeys: 0,
            operations: {}
          };
        }
        
        collectionsMap[collKey].totalKeys++;
        const op = keyObj.op || 'unknown';
        collectionsMap[collKey].operations[op] = 
          (collectionsMap[collKey].operations[op] || 0) + 1;
      } catch (e) {
        // 忽略
      }
    }
    
    return collectionsMap;
  }
}

// 使用示例
const cacheManager = new CacheManager(msq);

// 获取 products 缓存信息
const productsCache = await cacheManager.getCollectionCacheInfo('products');
console.log('products 缓存:', productsCache);

// 获取全局统计
const globalStats = cacheManager.getGlobalStats();
console.log('全局缓存统计:', globalStats);

// 获取所有集合的缓存分布
const allCollections = await cacheManager.getAllCollectionsCacheInfo();
console.log('所有集合缓存:', allCollections);
```

---

## getDefaults() 示例

### 1. 查看默认配置

```javascript
import MonSQLize from 'monsqlize';

const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'shop',
  config: { uri: 'mongodb://localhost:27017' },
  maxTimeMS: 5000,
  findLimit: 50,
  findPageMaxLimit: 200,
  cache: {
    maxEntries: 1000,
    defaultTtl: 10000
  }
});

await msq.connect();

// 获取默认配置
const defaults = msq.getDefaults();
console.log('默认配置:', defaults);
```

**输出示例**：
```javascript
{
  maxTimeMS: 5000,
  findLimit: 50,
  findPageMaxLimit: 200,
  namespace: { scope: 'database' }
}
```

---

### 2. 验证配置生效

```javascript
const { collection } = await msq.connect();

// 获取默认配置
const defaults = msq.getDefaults();

// 查询时未指定参数，使用默认值
const products = await collection('products').find(
  { status: 'active' }
);

console.log(`查询结果: ${products.length} 个文档`);
console.log(`应用的默认限制: ${defaults.findLimit}`);
```

---

### 3. 调试配置问题

```javascript
const defaults = msq.getDefaults();

// 检查查询超时
if (defaults.maxTimeMS < 3000) {
  console.warn(`⚠️ 查询超时较短: ${defaults.maxTimeMS}ms`);
}

// 检查分页限制
if (defaults.findLimit > 100) {
  console.warn(`⚠️ 默认分页限制较大: ${defaults.findLimit}`);
}
```

---

### 4. 运行时配置对比

```javascript
// 创建多个实例，对比配置
const msq1 = new MonSQLize({
  type: 'mongodb',
  databaseName: 'shop',
  config: { uri: 'mongodb://localhost:27017' },
  findLimit: 20,
  maxTimeMS: 3000
});

const msq2 = new MonSQLize({
  type: 'mongodb',
  databaseName: 'analytics',
  config: { uri: 'mongodb://localhost:27017' },
  findLimit: 100,
  cache: { enabled: false }
});

await msq1.connect();
await msq2.connect();

console.log('实例 1 配置:', msq1.getDefaults());
console.log('实例 2 配置:', msq2.getDefaults());

// 输出:
// 实例 1 配置包含 { findLimit: 20, maxTimeMS: 3000 }
// 实例 2 配置包含 { findLimit: 100 }
```

---

### getNamespace()

获取集合的完整命名空间（格式：`databaseName.collectionName`）。

#### 方法签名（getNamespace()）

```javascript
const namespace = collection('collectionName').getNamespace()
```

#### 参数说明（getNamespace()）

无参数。返回当前绑定集合的命名空间。

#### 返回值（getNamespace()）

```javascript
string  // 格式: "databaseName.collectionName"
```

---

## getNamespace() 示例

### 1. 获取命名空间

```javascript
import MonSQLize from 'monsqlize';

const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'shop',
  config: { uri: 'mongodb://localhost:27017' }
});

const { collection } = await msq.connect();

// 获取命名空间
const namespace = collection('products').getNamespace();
console.log('命名空间:', namespace);  // 输出: "shop.products"
```

---

### 2. 多集合命名空间

```javascript
const { collection } = await msq.connect();

// 获取多个集合的命名空间
const collections = ['users', 'orders', 'products', 'logs'];

collections.forEach(name => {
  const namespace = collection(name).getNamespace();
  console.log(`${name} 的命名空间: ${namespace}`);
});

// 输出:
// users 的命名空间: shop.users
// orders 的命名空间: shop.orders
// products 的命名空间: shop.products
// logs 的命名空间: shop.logs
```

---

### 3. 命名空间在日志中的应用

```javascript
const { collection } = await msq.connect();

// 查询前记录命名空间
const namespace = collection('products').getNamespace();
console.log(`[${new Date().toISOString()}] 查询集合: ${namespace}`);

const result = await collection('products').find(
  { status: 'active' },
  { limit: 10 }
);

console.log(`[${new Date().toISOString()}] 查询完成: ${namespace}, 结果: ${result.length} 个文档`);

// 输出:
// [2025-11-06T10:30:00.000Z] 查询集合: shop.products
// [2025-11-06T10:30:00.123Z] 查询完成: shop.products, 结果: 10 个文档
```

---

### 4. 命名空间验证

```javascript
const { collection } = await msq.connect();

// 验证命名空间格式
function validateNamespace(collectionName) {
  const namespace = collection(collectionName).getNamespace();
  const [dbName, colName] = namespace.split('.');
  
  console.log(`数据库名: ${dbName}`);
  console.log(`集合名: ${colName}`);
  console.log(`完整命名空间: ${namespace}`);
  
  return { dbName, colName, namespace };
}

validateNamespace('products');

// 输出:
// 数据库名: shop
// 集合名: products
// 完整命名空间: shop.products
```

---

### 5. 跨数据库操作时的命名空间

```javascript
// 创建两个不同数据库的实例
const shopDB = new MonSQLize({
  type: 'mongodb',
  databaseName: 'shop',
  config: { uri: 'mongodb://localhost:27017' }
});

const analyticsDB = new MonSQLize({
  type: 'mongodb',
  databaseName: 'analytics',
  config: { uri: 'mongodb://localhost:27017' }
});

await shopDB.connect();
await analyticsDB.connect();

// 对比命名空间
const shopCollection = shopDB.collection('products');
const analyticsCollection = analyticsDB.collection('products');

console.log('Shop 命名空间:', shopCollection.getNamespace());        // shop.products
console.log('Analytics 命名空间:', analyticsCollection.getNamespace()); // analytics.products
```

---

## 最佳实践

### 1. 缓存监控

定期监控缓存统计，优化缓存策略：

```javascript
const cache = msq.getCache();

if (cache) {
  // 定时输出缓存统计
  setInterval(async () => {
    const stats = cache.getStats();
    const hitRate = (stats.hits / (stats.hits + stats.misses) * 100).toFixed(2);
    
    console.log('缓存统计:', {
      命中率: `${hitRate}%`,
      缓存项: stats.size,
      内存: `${(stats.memoryUsage / 1024 / 1024).toFixed(2)} MB`
    });
    
    // 如果命中率低于 50%，考虑调整缓存策略
    if (parseFloat(hitRate) < 50) {
      console.warn('⚠️ 缓存命中率过低，建议优化缓存策略');
    }
  }, 60000); // 每分钟检查一次
}
```

---

### 1.1 监控特定集合的缓存（使用 getNamespace ⭐）

```javascript
const { collection } = await msq.connect();
const cache = msq.getCache();

if (cache) {
  // 推荐：使用 getNamespace() 获取精确的命名空间
  setInterval(async () => {
    const ns = collection('products').getNamespace();
    const pattern = `*"collection":"${ns.collection}"*"db":"${ns.db}"*`;
    const productsKeys = await cache.keys(pattern);
    
    // 按操作类型统计
    const findKeys = await cache.keys(`${pattern}*"op":"find"*`);
    const countKeys = await cache.keys(`${pattern}*"op":"count"*`);
    const findOneKeys = await cache.keys(`${pattern}*"op":"findOne"*`);
    
    console.log('products 集合缓存:', {
      命名空间: `${ns.db}.${ns.collection}`,
      总缓存键数: productsKeys.length,
      find操作: findKeys.length,
      count操作: countKeys.length,
      findOne操作: findOneKeys.length
    });
    
    // 如果缓存键过多，可能需要调整 TTL 或清理策略
    if (productsKeys.length > 100) {
      console.warn('⚠️ products 集合缓存键过多，建议缩短 TTL');
    }
  }, 60000);
}
```

---

### 2. 配置验证

在启动时验证配置的合理性：

```javascript
const defaults = msq.getDefaults();

// 验证配置合理性
function validateConfig(defaults) {
  const warnings = [];
  
  if (defaults.findLimit > 100) {
    warnings.push(`findLimit 较大 (${defaults.findLimit})，可能影响宽查询`);
  }
  
  if (defaults.maxTimeMS < 1000) {
    warnings.push(`maxTimeMS 过小 (${defaults.maxTimeMS})，可能导致查询超时`);
  }
  
  if (defaults.findPageMaxLimit > defaults.findMaxLimit) {
    warnings.push('findPageMaxLimit 不应超过 findMaxLimit');
  }
  
  if (warnings.length > 0) {
    console.warn('⚠️ 配置警告:');
    warnings.forEach(w => console.warn(`  - ${w}`));
  } else {
    console.log('✅ 配置验证通过');
  }
}

validateConfig(defaults);
```

---

### 3. 命名空间追踪

在日志中使用命名空间，方便追踪：

```javascript
const { collection } = await msq.connect();

// 封装带命名空间的日志函数
function logWithNamespace(collectionName, level, message, data) {
  const namespace = collection(collectionName).getNamespace();
  const timestamp = new Date().toISOString();
  
  console.log(`[${timestamp}] [${level}] [${namespace}] ${message}`, data || '');
}

// 使用示例
logWithNamespace('products', 'INFO', '开始查询', { query: { status: 'active' } });

const result = await collection('products').find(
  { status: 'active' },
  { limit: 10 }
);

logWithNamespace('products', 'INFO', '查询完成', { count: result.length });

// 输出:
// [2025-11-06T10:30:00.000Z] [INFO] [shop.products] 开始查询 { query: { status: 'active' } }
// [2025-11-06T10:30:00.123Z] [INFO] [shop.products] 查询完成 { count: 10 }
```

---

### 4. 缓存预热

使用 `getCache()` 实现缓存预热：

```javascript
const { collection } = await msq.connect();
const cache = msq.getCache();

async function prewarmCache() {
  console.log('开始缓存预热...');
    
  // 预热热门产品
  const hotProducts = await collection('products').find(
    { featured: true },
    {
      limit: 100,
      cache: 3600000  // 1小时
    }
  );
    
  console.log(`✅ 已预热 ${hotProducts.length} 个热门产品`);
    
  // 预热用户配置
  const userConfigs = await collection('configs').find(
    { type: 'user' },
    {
      limit: 50,
      cache: 7200000  // 2小时
    }
  );

  console.log(`✅ 已预热 ${userConfigs.length} 个用户配置`);

  // 显示缓存统计
  const stats = cache.getStats();
  console.log('缓存预热完成:', {
    缓存项: stats.size,
    内存使用: `${(stats.memoryUsage / 1024 / 1024).toFixed(2)} MB`
  });
}

await prewarmCache();
```

---

## 常见问题

### Q1: 如何禁用运行时缓存？

**A**: `getCache()` 返回当前活动的 `CacheLike` 实例。需要禁用缓存存储时，请使用 `cache.enabled: false`，同时保留稳定的运行时 API：

```javascript
const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'shop',
  config: { uri: 'mongodb://localhost:27017' },
  cache: { enabled: false }
});

const cache = msq.getCache();
console.log(cache.constructor.name);
```

---

### Q2: 如何查看某个查询的缓存键？

**A**: 键由操作名、包含数据源/认证/连接池的缓存命名空间及影响结果的查询选项生成。不同操作的格式不同，属于内部实现。支持时可查看 `meta.keyHash` 或使用缓存诊断；建议使用[失效描述符](./cache-invalidation.md)，不要根据 `getNamespace()` 拼接键。

```javascript
const { collection } = await msq.connect();

// 查询会自动生成缓存键
const result = await collection('products').find(
  { status: 'active' },
  {
    limit: 10,
    cache: 5000
  }
);

// 缓存键示例: "shop.products:hash({"status":"active"},10,{})"
// 包含: 命名空间 + 查询参数哈希
```

---

### Q3: 如何清除特定集合的缓存？

**A**: 可以使用 `invalidate()` 方法：

```javascript
const { collection } = await msq.connect();

// 清除 products 集合的所有缓存
await collection('products').invalidate();

console.log('✅ products 集合缓存已清除');

// 或者手动清除所有缓存
const cache = msq.getCache();
await cache.clear();
console.log('✅ 所有缓存已清除');
```

详见：[缓存策略文档](./cache.md)

---

### Q4: `getDefaults()` 的配置可以修改吗？

**A**: 不能直接修改，但可以在查询时覆盖：

```javascript
const defaults = msq.getDefaults();
console.log('默认 limit:', defaults.findLimit);  // 20

// ❌ 不能修改默认配置
// defaults.findLimit = 50;  // 无效

// ✅ 在查询时覆盖默认值
const result = await collection('products').find(
  {},
  { limit: 50 }  // 覆盖默认的 20
);
```

如果需要修改全局默认值，应该重新创建 MonSQLize 实例。

---

### Q5: `getNamespace()` 有什么实际用途？

**A**: 主要用于日志记录、调试和跨数据库操作时的标识：

```javascript
const { collection } = await msq.connect();

// 用途 1: 日志记录
function logQuery(collectionName, query) {
  const namespace = collection(collectionName).getNamespace();
  console.log(`[${namespace}] 查询:`, query);
}

// 用途 2: 缓存键前缀
function getCacheKey(collectionName, query) {
  const namespace = collection(collectionName).getNamespace();
  return `${namespace}:${JSON.stringify(query)}`;
}

// 用途 3: 调试多数据库环境
const shopProducts = collection('products').getNamespace();    // shop.products
const testProducts = collection('products').getNamespace();    // test.products

if (shopProducts !== testProducts) {
  console.log('⚠️ 正在操作不同的数据库');
}
```

---

### Q6: 如何查看特定集合有多少缓存？（推荐方法 ⭐）

**A**: 最方便的方法是使用 `getNamespace()` + `cache.keys()`：

```javascript
const { collection } = await msq.connect();
const cache = msq.getCache();

if (cache) {
  // 方法 1：使用 getNamespace()（推荐，更精确）
  const ns = collection('products').getNamespace();
  const pattern = `*"collection":"${ns.collection}"*"db":"${ns.db}"*`;
  const productsKeys = await cache.keys(pattern);
  
  console.log(`products 集合缓存数量: ${productsKeys.length}`);
  console.log(`命名空间: ${ns.db}.${ns.collection}`);
  
  // 方法 2：仅使用集合名（简单但可能跨数据库匹配）
  const simpleKeys = await cache.keys('*"collection":"products"*');
  console.log(`简单匹配: ${simpleKeys.length}`);
  
  // 按操作类型统计（使用 getNamespace 的模式）
  const findKeys = await cache.keys(`${pattern}*"op":"find"*`);
  const countKeys = await cache.keys(`${pattern}*"op":"count"*`);
  const findOneKeys = await cache.keys(`${pattern}*"op":"findOne"*`);
  
  console.log('缓存详情:', {
    总数: productsKeys.length,
    find: findKeys.length,
    count: countKeys.length,
    findOne: findOneKeys.length
  });
}
```

**为什么推荐使用 `getNamespace()`？**
- ✅ 更精确：同时匹配数据库名和集合名
- ✅ 避免跨数据库匹配：不会匹配其他数据库的同名集合
- ✅ 类型安全：返回结构化的命名空间对象
- ✅ 易于扩展：可以直接获取 `iid`、`type` 等信息

**模式说明**：
- `*"collection":"products"*"db":"shop"*` - 精确匹配（推荐）
- `*"collection":"products"*` - 简单匹配（可能跨数据库）
- `*"op":"find"*` - 匹配特定操作类型

---

### Q7: 如何清除特定集合的某个操作的缓存？

**A**: 使用 `invalidate(op)` 方法指定操作类型：

```javascript
const { collection } = await msq.connect();

// 只清除 products 的 find 操作缓存
await collection('products').invalidate('find');

console.log('✅ products 的 find 缓存已清除');

// count 和 findOne 缓存仍然有效
```

详见：[缓存策略文档](./cache.md)

---

## 参考资料

- [缓存策略](./cache.md) - 详细的缓存配置和 invalidate() 方法
- [连接管理](./connection.md) - 实例初始化和 defaults 配置
- [查询方法](./find.md) - 查询参数和默认值的使用
- [最佳实践](./getting-started.md) - 配置优化建议
