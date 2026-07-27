# Bookmark 维护 API 文档

## 概述

monSQLize 提供了三个 Bookmark 维护 API，用于管理 findPage 的 bookmark 缓存。这些 API 适用于运维调试和性能优化场景。

## 核心特性

- ✅ **智能 Hash 匹配**：自动应用 `ensureStableSort` 规范化，确保与 findPage 使用相同的缓存键
- ✅ **精确控制**：支持按 `keyDims` 管理特定查询的 bookmark
- ✅ **全局操作**：不传 `keyDims` 可操作所有 bookmark（适用于全局重置）
- ✅ **失败检测**：`prewarmBookmarks` 自动检测超出范围的页面
- ✅ **缓存可用性检查**：所有 API 在缓存不可用时抛出 `CACHE_UNAVAILABLE` 错误

## 使用场景

1. **系统启动预热** - 预热热点页面，减少首次查询延迟
2. **运维监控** - 查看已缓存的页面分布
3. **数据变更后清除缓存** - 确保查询最新数据
4. **内存管理** - 按需清理缓存释放资源

## API 说明

### 1. prewarmBookmarks(keyDims, pages)

预热指定页面的 bookmark 缓存。

#### 方法签名

```javascript
async prewarmBookmarks(keyDims, pages)
```

#### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `keyDims` | Object | 是 | 查询维度（query, sort, limit） |
| `pages` | Array<Number> | 是 | 要预热的页码数组 |

**keyDims 对象**：
```javascript
{
  query: { status: 'active' },      // 查询条件
  sort: { createdAt: -1 },          // 排序规则（会自动规范化）
  limit: 10                          // 每页数量
}
```

#### 返回值

```javascript
{
  warmed: 3,           // 成功预热的页数
  failed: 1,           // 失败的页数（超出范围等）
  keys: [              // 缓存的键列表
    'bm:iid123:mongodb:mydb:products:hash456:p1',
    'bm:iid123:mongodb:mydb:products:hash456:p2',
    'bm:iid123:mongodb:mydb:products:hash456:p3'
  ]
}
```

#### 使用示例

```javascript
import MonSQLize from 'monsqlize';
const { collection } = await new MonSQLize({
  type: 'mongodb',
  databaseName: 'shop',
  config: { uri: 'mongodb://localhost:27017' }
}).connect();

// 预热常用页面
const result = await collection('products').prewarmBookmarks(
  {
    query: { status: 'active' },
    sort: { createdAt: -1 },
    limit: 10
  },
  [1, 2, 3, 4, 5]  // 预热前 5 页
);

console.log('预热成功:', result.warmed);  // 5
console.log('预热失败:', result.failed);  // 0
console.log('缓存键数:', result.keys.length);  // 5
```

#### 错误处理

```javascript
try {
  const result = await collection('orders').prewarmBookmarks(
    { query: { status: 'paid' }, sort: { createdAt: -1 }, limit: 20 },
    [1, 2, 3, 1000]  // 第 1000 页可能超出范围
  );
  
  if (result.failed > 0) {
    console.warn(`有 ${result.failed} 页预热失败（可能超出数据范围）`);
  }
} catch (error) {
  if (error.code === 'CACHE_UNAVAILABLE') {
    console.error('缓存不可用，无法预热 bookmark');
  } else {
    console.error('预热失败:', error.message);
  }
}
```

---

### 2. listBookmarks(keyDims?)

列出已缓存的 bookmark（支持按查询过滤或查看全部）。

#### 方法签名（2. listBookmarks(keyDims?)）

```javascript
async listBookmarks(keyDims?)
```

#### 参数（2. listBookmarks(keyDims?)）

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `keyDims` | Object | 否 | 查询维度（不传则列出所有） |

#### 返回值（2. listBookmarks(keyDims?)）

**按查询过滤**：
```javascript
{
  pages: [1, 2, 3, 5, 10],  // 已缓存的页码列表
  count: 5,                  // 缓存数量
  keyPrefix: 'bm:iid123:mongodb:mydb:products:hash456'
}
```

**查看全部**：
```javascript
{
  keys: [                    // 所有 bookmark 键
    'bm:iid123:mongodb:mydb:products:hash456:p1',
    'bm:iid123:mongodb:mydb:orders:hash789:p2',
    // ...
  ],
  count: 15                  // 总缓存数
}
```

#### 使用示例（2. listBookmarks(keyDims?)）

```javascript
// 列出特定查询的 bookmark
const list = await collection('orders').listBookmarks({
  query: { status: 'pending' },
  sort: { createdAt: -1 },
  limit: 50
});

console.log('已缓存页面:', list.pages);  // [1, 2, 3, 5, 10, 20]
console.log('缓存数量:', list.count);     // 6

// 列出所有 bookmark（不传 keyDims）
const allList = await collection('orders').listBookmarks();
console.log('总缓存数:', allList.count);  // 25
console.log('所有缓存键:', allList.keys);
```

#### 运维监控场景

```javascript
// 定期检查 bookmark 使用情况
async function monitorBookmarks() {
  const all = await collection('products').listBookmarks();
  console.log(`📊 Bookmark 统计: ${all.count} 个缓存`);
  
  // 检查特定查询的缓存分布
  const hotQuery = await collection('products').listBookmarks({
    query: { featured: true },
    sort: { sales: -1 },
    limit: 20
  });
  
  console.log(`热门商品查询: 已缓存 ${hotQuery.pages.length} 页`);
  console.log(`页码分布: ${hotQuery.pages.join(', ')}`);
}
```

---

### 3. clearBookmarks(keyDims?)

清除指定查询或全部 bookmark 缓存。

#### 方法签名（3. clearBookmarks(keyDims?)）

```javascript
async clearBookmarks(keyDims?)
```

#### 参数（3. clearBookmarks(keyDims?)）

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `keyDims` | Object | 否 | 查询维度（不传则清除所有） |

#### 返回值（3. clearBookmarks(keyDims?)）

```javascript
{
  cleared: 5,  // 已清除的缓存数量
  keyPrefix: 'bm:iid123:mongodb:mydb:products:hash456'  // 清除的键前缀（可选）
}
```

#### 使用示例（3. clearBookmarks(keyDims?)）

```javascript
// 清除特定查询的 bookmark
const clearResult = await collection('products').clearBookmarks({
  query: { category: 'books' },
  sort: { title: 1 },
  limit: 10
});

console.log('已清除:', clearResult.cleared, '个 bookmark');

// 清除所有 bookmark（不传 keyDims）
const clearAllResult = await collection('products').clearBookmarks();
console.log('已清空所有 bookmark:', clearAllResult.cleared, '个');
```

#### 数据更新场景

```javascript
// 批量更新商品后清除相关缓存
async function updateProducts(updates) {
  // 1. 执行批量更新
  await collection('products').updateMany(
    { category: 'electronics' },
    { $set: updates }
  );
  
  // 2. 清除相关查询的 bookmark
  await collection('products').clearBookmarks({
    query: { category: 'electronics' },
    sort: { price: 1 },
    limit: 50
  });
  
  // 3. 可选：清除所有相关缓存
  await collection('products').invalidate('findPage');
  
  console.log('✅ 商品更新完成，缓存已清除');
}
```

---

## 完整工作流示例

### 场景 1: 系统启动预热

```javascript
import MonSQLize from 'monsqlize';

async function prewarmOnStartup() {
  const { collection } = await new MonSQLize({
    type: 'mongodb',
    databaseName: 'shop',
    config: { uri: 'mongodb://localhost:27017' }
  }).connect();
  
  console.log('🚀 系统启动，开始预热 bookmark...');
  
  // 预热热门商品查询（前 10 页）
  const hotProducts = await collection('products').prewarmBookmarks(
    {
      query: { featured: true, inStock: true },
      sort: { sales: -1 },
      limit: 20
    },
    Array.from({ length: 10 }, (_, i) => i + 1)  // [1, 2, ..., 10]
  );
  
  console.log(`✅ 热门商品: 预热 ${hotProducts.warmed} 页`);
  
  // 预热最近订单查询（前 5 页）
  const recentOrders = await collection('orders').prewarmBookmarks(
    {
      query: { status: 'pending' },
      sort: { createdAt: -1 },
      limit: 50
    },
    [1, 2, 3, 4, 5]
  );
  
  console.log(`✅ 待处理订单: 预热 ${recentOrders.warmed} 页`);
  console.log('🎉 预热完成！');
}

prewarmOnStartup();
```

### 场景 2: 定期清理过期缓存

```javascript
async function cleanupExpiredBookmarks() {
  const { collection } = await new MonSQLize({
    type: 'mongodb',
    databaseName: 'shop',
    config: { uri: 'mongodb://localhost:27017' }
  }).connect();
  
  console.log('🧹 开始清理过期 bookmark...');
  
  // 查看当前缓存状态
  const before = await collection('products').listBookmarks();
  console.log(`清理前: ${before.count} 个 bookmark`);
  
  // 清理特定查询的 bookmark
  const cleared1 = await collection('products').clearBookmarks({
    query: { category: 'discontinued' },
    sort: { name: 1 },
    limit: 20
  });
  
  console.log(`已清理停产商品查询: ${cleared1.cleared} 个`);
  
  // 查看清理后状态
  const after = await collection('products').listBookmarks();
  console.log(`清理后: ${after.count} 个 bookmark`);
  console.log(`✅ 释放了 ${before.count - after.count} 个缓存`);
}

// 每小时执行一次清理
setInterval(cleanupExpiredBookmarks, 60 * 60 * 1000);
```

### 场景 3: 数据更新后刷新缓存

```javascript
async function refreshCacheAfterUpdate(category, updates) {
  const { collection } = await new MonSQLize({
    type: 'mongodb',
    databaseName: 'shop',
    config: { uri: 'mongodb://localhost:27017' }
  }).connect();
  
  console.log(`🔄 更新 ${category} 类商品...`);
  
  // 1. 清除旧缓存
  const oldBookmarks = await collection('products').clearBookmarks({
    query: { category },
    sort: { price: 1 },
    limit: 20
  });
  
  console.log(`已清除旧 bookmark: ${oldBookmarks.cleared} 个`);
  
  // 2. 执行更新
  const updateResult = await collection('products').updateMany(
    { category },
    { $set: updates }
  );
  
  console.log(`已更新 ${updateResult.modifiedCount} 个商品`);
  
  // 3. 预热新缓存（前 5 页）
  const newBookmarks = await collection('products').prewarmBookmarks(
    {
      query: { category },
      sort: { price: 1 },
      limit: 20
    },
    [1, 2, 3, 4, 5]
  );
  
  console.log(`✅ 已预热新 bookmark: ${newBookmarks.warmed} 页`);
}

// 使用示例
refreshCacheAfterUpdate('electronics', { discount: 0.1 });
```

### 场景 4: 监控与统计

```javascript
async function monitorBookmarkUsage() {
  const { collection } = await new MonSQLize({
    type: 'mongodb',
    databaseName: 'shop',
    config: { uri: 'mongodb://localhost:27017' }
  }).connect();
  
  // 获取所有 bookmark
  const all = await collection('products').listBookmarks();
  console.log(`\n📊 Bookmark 使用统计:`);
  console.log(`  总缓存数: ${all.count}`);
  
  // 检查热门查询的缓存分布
  const queries = [
    { query: { featured: true }, sort: { sales: -1 }, limit: 20 },
    { query: { category: 'electronics' }, sort: { price: 1 }, limit: 50 },
    { query: { inStock: true }, sort: { updatedAt: -1 }, limit: 30 }
  ];
  
  for (const q of queries) {
    const list = await collection('products').listBookmarks(q);
    console.log(`\n  查询: ${JSON.stringify(q.query)}`);
    console.log(`    缓存页数: ${list.pages?.length || 0}`);
    console.log(`    页码分布: ${list.pages?.join(', ') || '无'}`);
  }
}

// 每分钟监控一次
setInterval(monitorBookmarkUsage, 60 * 1000);
```

---

## 最佳实践

### 1. 预热策略

```javascript
// ✅ 好：预热常用页面
await collection('products').prewarmBookmarks(
  { query: { featured: true }, sort: { sales: -1 }, limit: 20 },
  [1, 2, 3, 4, 5]  // 前 5 页通常是最常访问的
);

// ❌ 不好：预热过多页面
await collection('products').prewarmBookmarks(
  { query: { featured: true }, sort: { sales: -1 }, limit: 20 },
  Array.from({ length: 1000 }, (_, i) => i + 1)  // 占用过多内存
);
```

### 2. 清理时机

```javascript
// ✅ 好：数据更新后清理
async function updateProductPrice(productId, newPrice) {
  await collection('products').updateOne(
    { _id: productId },
    { $set: { price: newPrice } }
  );
  
  // 清理相关查询的 bookmark
  await collection('products').clearBookmarks({
    query: { category: 'electronics' },
    sort: { price: 1 },
    limit: 20
  });
}

// ❌ 不好：频繁清理所有缓存
setInterval(async () => {
  await collection('products').clearBookmarks();  // 过于频繁
}, 1000);
```

### 3. 监控与告警

```javascript
// ✅ 好：定期检查缓存健康度
async function checkCacheHealth() {
  const all = await collection('products').listBookmarks();
  
  if (all.count > 10000) {
    console.warn('⚠️ Bookmark 缓存过多，建议清理');
  }
  
  if (all.count === 0) {
    console.info('ℹ️ 无 bookmark 缓存，考虑预热热门查询');
  }
}
```

---

## 注意事项

1. **缓存键匹配**：`keyDims` 的 `sort` 会自动应用 `ensureStableSort` 规范化，确保与 findPage 使用相同的缓存键
2. **缓存可用性**：所有 API 在缓存不可用时抛出 `CACHE_UNAVAILABLE` 错误，使用前需确保缓存已配置
3. **内存管理**：预热过多页面会占用大量内存，建议只预热常用的前几页
4. **失败页面**：`prewarmBookmarks` 自动检测超出范围的页面，失败页面不会影响成功页面的预热
5. **读路径使用**：匹配的 bookmark 会被 `findPage()` 页码导航读取，用于从最近的预热页继续跳转。
6. **全局清理**：`clearBookmarks()` 不传参数会清除集合的所有 bookmark，使用时需谨慎

---

## 错误处理（第2处）

```javascript
try {
  // 尝试预热 bookmark
  const result = await collection('orders').prewarmBookmarks(
    { query: { status: 'paid' }, sort: { createdAt: -1 }, limit: 20 },
    [1, 2, 3, 1000]
  );
  
  if (result.failed > 0) {
    console.warn(`有 ${result.failed} 页预热失败`);
  }
} catch (error) {
  if (error.code === 'CACHE_UNAVAILABLE') {
    console.error('缓存不可用，请检查缓存配置');
  } else if (error.code === 'VALIDATION_ERROR') {
    console.error('参数验证失败:', error.details);
  } else {
    console.error('操作失败:', error.message);
  }
}
```

---

## 参考资料

- [findPage 方法文档](./findPage.md)
- [缓存策略文档](./cache.md)
- [bookmarks 示例代码](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/bookmarks.ts)
- 性能优化指南
