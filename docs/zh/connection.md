# 连接管理文档

## 概述

monSQLize 提供 MongoDB 应用常用的连接管理能力，包括安全复用连接、参数校验、资源清理和跨库访问。本文档说明连接 API 与相关配置项。

## 核心特性

- **安全复用连接**：并发调用 `connect()` 会等待同一次连接尝试
- **参数验证**：集合名和数据库名会在使用前校验
- **资源清理**：`close()` 会释放客户端资源和运行时缓存
- **错误处理**：连接失败后可以安全重试
- **跨库访问**：一个实例可以访问其他数据库中的集合

---

## 连接管理 API

### connect()

建立数据库连接。支持并发调用，确保只建立一个连接。

#### 方法签名

```javascript
async connect()
```

#### 返回值

```javascript
{
  collection: Function,      // 集合访问函数（当前数据库）
  db: Function,              // 数据库级访问函数，db(name?) 返回 DbAccessor
  use: Function,             // 切换数据库并返回 { collection, model }
  instance: MonSQLize        // 当前 MonSQLize 实例
}
```

#### 使用示例

```javascript
import MonSQLize from 'monsqlize';

const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'shop',
  config: { uri: 'mongodb://localhost:27017' }
});

// 连接数据库
const { collection, use } = await msq.connect();

// 使用集合访问器
const users = collection('users');
const products = collection('products');

// 跨库访问
const analyticsEvents = use('analytics').collection('events');
```

---

### 并发调用 connect()

`connect()` 可以在并发启动任务或请求处理中安全调用。并发调用会等待同一次连接尝试，避免重复打开多个 MongoDB 客户端。

#### 预期行为

1. 首个调用方发起连接尝试。
2. 其他调用方等待这次尝试完成。
3. 连接成功后，所有调用方拿到已连接的 runtime 访问器。
4. 如果连接失败，等待中的调用方会收到同一个错误，下一次 `connect()` 调用可以重新尝试。

#### 高并发场景示例

```javascript
import MonSQLize from 'monsqlize';

const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'example',
  config: { uri: 'mongodb://localhost:27017' }
});

// 高并发场景：10 个并发请求
const promises = Array(10).fill(null).map(() => msq.connect());
const results = await Promise.all(promises);

// 所有请求返回同一个连接对象
console.log(results[0] === results[1]);  // true
console.log(results[0] === results[9]);  // true
console.log('✅ 只建立了一个连接');
```

#### 优势

- ✅ 避免连接池耗尽
- ✅ 减少连接开销
- ✅ 防止资源浪费
- ✅ 提高系统稳定性

---

### 可接受的集合名和数据库名

`collection()` 和 `db()` 会在集合名或数据库名缺失、格式不合法时尽早抛错。

#### collection() 验证

**验证规则**：
- 必须是非空字符串
- 不允许 `null`、`undefined`、空字符串、纯空格
- 不允许数字、对象等其他类型

```javascript
const { collection } = await msq.connect();

// ✅ 正常使用
const users = collection('users');
const orders = collection('my-orders');

// ❌ 无效参数（会抛出错误）
try {
  collection('');           // 错误：INVALID_COLLECTION_NAME - 空字符串
  collection('   ');        // 错误：INVALID_COLLECTION_NAME - 纯空格
  collection(null);         // 错误：INVALID_COLLECTION_NAME - null
  collection(undefined);    // 错误：INVALID_COLLECTION_NAME - undefined
  collection(123);          // 错误：INVALID_COLLECTION_NAME - 数字
  collection({ name: 'test' }); // 错误：INVALID_COLLECTION_NAME - 对象
} catch (err) {
  console.error(err.code, err.message);
  // 输出: INVALID_COLLECTION_NAME 集合名必须是非空字符串
}
```

#### db() 验证

**重要说明**：当传入 `name` 时，`db(name)` 会立即验证数据库名。省略参数或传入 `undefined` 会使用默认数据库；`null` 在 JavaScript 运行时会触发 `INVALID_DATABASE_NAME`。

**验证规则**：
- 如果提供了 `databaseName`，必须是非空字符串
- 省略参数或传入 `undefined` 会使用默认数据库
- **不允许** `null`、空字符串或纯空格字符串

```javascript
const { db } = await msq.connect();

// ✅ 正常使用
const shopDb = db('shop');
const analyticsDb = db('analytics');

// ✅ 使用默认数据库（合法）
const defaultDb1 = db();               // 合法：使用默认数据库
const defaultDb2 = db(undefined);      // 合法：使用默认数据库

// 验证可以正常获取集合
const shopOrders = shopDb.collection('orders');
const analyticsEvents = analyticsDb.collection('events');

// ❌ 无效参数（会抛出错误）
// 注意：db() 会立即验证数据库名
try {
  db(null);                         // 错误：INVALID_DATABASE_NAME - null
  db('');                           // 错误：INVALID_DATABASE_NAME - 空字符串
  db('   ');                        // 错误：INVALID_DATABASE_NAME - 纯空格
} catch (err) {
  console.error(err.code, err.message);
  // 输出: INVALID_DATABASE_NAME Database name must be a non-empty string.
}

// ✅ 省略参数和 undefined 是合法的
const users1 = db().collection('users');
const users2 = db(undefined).collection('users');
console.log('✅ 使用默认数据库成功');
```

#### 错误信息

| 错误码 | 说明 | 示例 |
|--------|------|------|
| `INVALID_COLLECTION_NAME` | 集合名无效 | `collection('')` |
| `INVALID_DATABASE_NAME` | 数据库名无效（`null`、空字符串或纯空格） | `db('')` |

**注意**：
- `db()` 和 `db(undefined)` 会使用创建 MonSQLize 实例时指定的默认数据库名
- `db(null)` 在 JavaScript 运行时会抛出 `INVALID_DATABASE_NAME`；TypeScript 调用方应直接省略参数
- 空字符串 `''` 和纯空格字符串 `'   '` 也会触发验证错误

---

### close()

关闭数据库连接，正确清理所有资源。

#### 方法签名（close()）

```javascript
async close()
```

#### close() 释放的资源

- ✅ 关闭 MongoDB 客户端连接
- 释放当前连接尝试状态
- 清理当前 MonSQLize 实例缓存的 Model 实例
- 释放关闭后不应继续保留的 runtime 引用

#### 使用示例（close()）

```javascript
import MonSQLize from 'monsqlize';

const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'example',
  config: { uri: 'mongodb://localhost:27017' }
});

// 连接
const { collection } = await msq.connect();

// 使用连接...
await collection('test').find({});

// 关闭连接
await msq.close();
console.log('✅ 连接已关闭，资源已清理');
```

#### 多次连接-关闭循环

```javascript
// 多次连接-关闭循环（安全）
for (let i = 0; i < 5; i++) {
  const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'example',
    config: { uri: 'mongodb://localhost:27017' }
  });
  
  await msq.connect();
  const { collection } = await msq.connect();
  
  // 使用连接...
  await collection('test').find({});
  
  // 关闭连接
  await msq.close();
  console.log(`第 ${i + 1} 次循环完成`);
}
console.log('✅ 所有循环完成，内存已正确清理');
```

#### 注意事项

- 多次调用 `close()` 是安全的，不会抛出错误
- 关闭后再调用 `connect()` 会重新建立连接
- 建议在应用关闭时调用 `close()` 释放资源
- 单元测试中应在 `afterEach` 或 `after` 钩子中关闭连接

---

## 跨库访问

monSQLize 支持访问不同数据库的集合，无需创建多个实例。

### 访问其他数据库

```javascript
import MonSQLize from 'monsqlize';

const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'shop',  // 默认数据库
  config: { uri: 'mongodb://localhost:27017' }
});

const { collection, use } = await msq.connect();

// 1. 访问默认数据库的集合
const products = await collection('products').find({});
console.log('shop.products ->', products);

// 2. 访问其他数据库的集合
const analyticsEvents = await use('analytics').collection('events').findOne(
  { type: 'click' },
  {
    cache: 3000,
    maxTimeMS: 1500
  }
);
console.log('analytics.events ->', analyticsEvents);

// 3. 多次跨库查询
const [user1, user2] = await Promise.all([
  db('users_db').collection('users').findOne({ name: 'Alice' }, { cache: 2000 }),
  db('users_db').collection('users').findOne({ name: 'Bob' })
]);
console.log(user1, user2);
```

### 跨库访问注意事项

- 所有跨库访问共享同一个 MongoDB 客户端连接
- 缓存键包含数据库名，不同数据库的相同集合有独立缓存
- 跨库查询的配置（maxTimeMS、cache 等）与主数据库配置独立
- 支持在跨库查询中使用所有 monSQLize 功能（缓存、慢查询日志等）

---

## 错误处理

### 连接失败

```javascript
import MonSQLize from 'monsqlize';

try {
  const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'example',
    config: { uri: 'mongodb://invalid-host:27017' }
  });
  
  await msq.connect();
} catch (err) {
  // 连接失败错误
  console.error('连接失败:', err.message);
  
  // 失败的连接尝试不会让实例卡住，可以安全重试
  console.log('可以重新尝试连接');
}
```

### 参数验证失败

```javascript
const { collection, db } = await msq.connect();

try {
  // 无效的集合名
  const users = collection('');
} catch (err) {
  if (err.code === 'INVALID_COLLECTION_NAME') {
    console.error('集合名无效:', err.message);
    console.log('请提供有效的集合名');
  }
}

try {
  // 无效的数据库名（空字符串）
  // 注意：db() 会立即验证数据库名
  db('');
} catch (err) {
  if (err.code === 'INVALID_DATABASE_NAME') {
    console.error('数据库名无效:', err.message);
    console.log('请提供有效的数据库名，或省略参数使用默认数据库');
  }
}

// ✅ 正确用法：省略参数或使用 undefined 表示默认数据库
const defaultDb = db().collection('users');
const defaultDb2 = db(undefined).collection('users');
```

---

## 最佳实践

### 1. 单例模式

```javascript
// db-connection.js
import MonSQLize from 'monsqlize';

let msqInstance = null;

async function getConnection() {
  if (!msqInstance) {
    msqInstance = new MonSQLize({
      type: 'mongodb',
      databaseName: process.env.DB_NAME || 'shop',
      config: { uri: process.env.MONGODB_URI }
    });
  }
  
  return await msqInstance.connect();
}

async function closeConnection() {
  if (msqInstance) {
    await msqInstance.close();
    msqInstance = null;
  }
}

module.exports = { getConnection, closeConnection };
```

```javascript
// 使用单例
const { getConnection } = require('./db-connection');

async function queryUsers() {
  const { collection } = await getConnection();
  return await collection('users').find({});
}
```

### 2. 应用生命周期管理

```javascript
import MonSQLize from 'monsqlize';

class Application {
  constructor() {
    this.msq = new MonSQLize({
      type: 'mongodb',
      databaseName: 'shop',
      config: { uri: process.env.MONGODB_URI }
    });
  }
  
  async start() {
    console.log('🚀 启动应用...');
    
    // 建立连接
    const { collection } = await this.msq.connect();
    this.collection = collection;
    
    console.log('✅ 数据库连接成功');
  }
  
  async stop() {
    console.log('🛑 停止应用...');
    
    // 关闭连接
    await this.msq.close();
    
    console.log('✅ 数据库连接已关闭');
  }
}

// 使用
const app = new Application();

async function main() {
  await app.start();
  
  // 应用运行...
  
  // 优雅关闭
  process.on('SIGINT', async () => {
    await app.stop();
    process.exit(0);
  });
}

main();
```

### 3. 错误重试

```javascript
async function connectWithRetry(maxRetries = 3, delay = 1000) {
  const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'shop',
    config: { uri: process.env.MONGODB_URI }
  });
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      await msq.connect();
      console.log('✅ 连接成功');
      return msq;
    } catch (err) {
      console.error(`连接失败 (${i + 1}/${maxRetries}):`, err.message);
      
      if (i < maxRetries - 1) {
        console.log(`等待 ${delay}ms 后重试...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw new Error('连接失败，已达到最大重试次数');
      }
    }
  }
}
```

### 4. 单元测试中的连接管理

```javascript
const { describe, it, before, after } = require('mocha');
import MonSQLize from 'monsqlize';

describe('用户服务测试', () => {
  let msq;
  let collection;
  
  before(async () => {
    // 测试前建立连接
    msq = new MonSQLize({
      type: 'mongodb',
      databaseName: 'test',
      config: { useMemoryServer: true }
    });
    
    const conn = await msq.connect();
    collection = conn.collection;
  });
  
  after(async () => {
    // 测试后关闭连接
    await msq.close();
  });
  
  it('应该查询用户', async () => {
    const users = await collection('users').find({});
    console.log('找到用户:', users.length);
  });
});
```

`useMemoryServer` 默认会复用项目内 `.cache/mongodb-memory-server/binaries` 二进制缓存，并把自动创建的临时数据目录放到 `.cache/mongodb-memory-server/db` 后在关闭时清理。如需固定目录，可传入 `memoryServerOptions.instance.dbPath` 或设置 `MONSQLIZE_MEMORY_SERVER_DB_DIR`。

---

## 构造配置

连接生命周期与构造函数配置分开维护。本页只说明 `connect()`、`collection()`、`db()`、`use()` 与 `close()`。完整 `new MonSQLize(options)` 配置请看 [完整配置参考](./configuration.md)，其中覆盖 MongoDB 连接、缓存、Redis、分布式失效、Model、schema-dsl、连接池、同步、慢查询日志、ObjectId 转换与写路径策略。

---

## 常见问题

### Q: 如何确保只建立一个连接？

**A**: `connect()` 方法内置并发锁机制，无论调用多少次，都只建立一个连接。

```javascript
const msq = new MonSQLize({ /* ... */ });

// 并发调用，但只建立一个连接
const [conn1, conn2, conn3] = await Promise.all([
  msq.connect(),
  msq.connect(),
  msq.connect()
]);

console.log(conn1 === conn2);  // true
```

### Q: 什么时候需要调用 close()？

**A**: 以下场景建议调用 `close()`：
- 应用关闭时
- 单元测试后清理
- 长时间不使用连接时
- 多次连接-关闭循环测试

### Q: 跨库访问会建立多个连接吗？

**A**: 不会。所有跨库访问共享同一个 MongoDB 客户端连接，只是访问不同的数据库。

```javascript
const { use } = await msq.connect();

// 这三个操作共享同一个连接
await use('shop').collection('products').find({});
await use('analytics').collection('events').find({});
await use('logs').collection('errors').find({});
```

### Q: 连接失败后如何重试？

**A**: 连接失败后，下一次 `connect()` 可以重新发起连接：

```javascript
async function connectWithRetry() {
  const msq = new MonSQLize({ /* ... */ });
  
  while (true) {
    try {
      await msq.connect();
      return msq;
    } catch (err) {
      console.error('连接失败，3秒后重试...');
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}
```

---

## 参考资料

- [MongoDB Node.js 驱动文档](https://docs.mongodb.com/drivers/node/)
- [连接字符串格式](https://docs.mongodb.com/manual/reference/connection-string/)
- [连接池配置](https://docs.mongodb.com/manual/reference/connection-string/#connection-pool-options)
- [monSQLize README](https://github.com/devcodex-labs/monSQLize/blob/main/README.md)


