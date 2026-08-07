# 错误码参考

## 概述

monSQLize 使用统一的错误码体系来标识不同类型的错误，帮助开发者准确识别和处理异常情况。所有错误对象都包含 `code` 属性，可以通过该属性判断错误类型并执行相应的处理逻辑。

配置、缓存、SSH、连接池、查询链、集合管理、事务和表达式编译等用户常见路径都会抛出带 `code` 的错误对象；错误 `message` 保留可读文案。

核心运行时使用 `MonSQLizeError` 与导出的 `ErrorCodes` 常量。Data Task 是独立的领域错误契约：它抛出 `DataTaskJobError`，通过可判别的 `code`、`phase` 和可选 `collection` 描述校验、审批、锁、应用、备份与恢复失败。不要用 `ErrorCodes` 比较 Data Task 错误码；应在边界显式处理两类错误。

### Data Task 错误契约

```javascript
import { DataTaskJobError } from 'monsqlize';

try {
  await dataTasks.apply(job, approval);
} catch (error) {
  if (error instanceof DataTaskJobError) {
    console.error(error.code, error.phase, error.collection);
  }
  throw error;
}
```

| 错误码 | 边界 |
|---|---|
| `INVALID_JOB` | 任务结构或策略校验 |
| `IDENTITY_CONFLICT` | 源/目标身份映射 |
| `INDEX_CONFLICT` | 索引计划冲突 |
| `APPROVAL_STALE` | 审批过期或不再匹配预览 |
| `BACKUP_FAILED` | 创建或持久化备份 |
| `LOCK_NOT_ACQUIRED` | 无法取得租约锁 |
| `LOCK_LOST` | 执行期间丢失租约所有权 |
| `APPLY_PARTIAL` | 只应用了计划范围的一部分 |
| `RESTORE_DRIFT` | 恢复预览或审批不再匹配当前状态 |
| `RESTORE_FAILED` | 恢复执行或回读验证 |

预览、审批、应用、备份与恢复流程参见 [Data Tasks](./data-tasks.md)。

### 核心运行时错误对象结构

```javascript
{
  message: '错误描述信息',
  code: 'ERROR_CODE',      // 错误码
  details: [...],          // 详细错误信息（可选）
  cause: Error             // 原始错误对象（可选）
}
```

### 错误处理最佳实践

#### 用户动作速查

| 错误码 | 常见来源 | 优先检查 |
|--------|----------|----------|
| `INVALID_CONFIG` | 构造配置、连接池配置、SSH 配置、Redis/分布式能力配置、Model `schemaDsl` runtime 配置 | 必填字段、字段类型、URI 前缀、认证字段、Redis/SSH 运行时配置、`schema-dsl/runtime` 解析与 API 形态 |
| `CONNECTION_FAILED` | MongoDB 连接或内存 MongoDB 启动失败 | MongoDB 地址、网络、认证、服务状态、`error.cause` |
| `NOT_CONNECTED` | `connect()` 前访问集合、Model、SSH tunnel address | 先 `await msq.connect()`，确认连接生命周期 |
| `CACHE_UNAVAILABLE` | 缓存实例无效、缺少可用缓存能力 | 传入的 cache 是否实现 `get`/`set`，Redis 配置是否可达 |
| `POOL_NOT_FOUND` | 指定连接池不存在或 health checker 找不到池 | 池名称是否注册、大小写是否一致、`pools` 是否传入 |
| `INVALID_OPERATION` | 查询重复执行、连接池全部不可用、事务状态不允许 | 是否重复 `toArray()`，池健康状态，事务生命周期 |
| `INVALID_ARGUMENT` | 查询链参数、集合管理参数、函数缓存参数 | 参数类型、取值范围、非空字符串/对象/数组 |
| `INVALID_VECTOR_SEARCH` | 本地 Vector Search 参数校验 | 向量索引/路径、有限 query vector、ANN/ENN 组合、filter/projection 形态 |
| `INVALID_RELATION_SELECT` | relation 默认或 populate 字段选择超出 P0 包含式语法 | 只使用非空顶层包含字段 |
| `RELATION_IN_USE` | 受保护 Model 删除发现已声明的入站引用 | 查看 `error.details[0].usages`，有意处理或保留引用 |
| `RELATION_USAGE_UNAVAILABLE` | 受保护删除未能完成已声明关系扫描 | 查看 coverage/skipped，不要降级为未检查删除 |
| `INVALID_EXPRESSION` | 表达式 DSL 或聚合表达式函数不合法 | 函数名、参数数量、lambda/object literal 格式 |
| `LOCK_ACQUIRE_FAILED` / `LOCK_TIMEOUT` | 业务锁或分布式锁获取失败 | 锁 TTL、重试次数、锁 key 粒度、Redis 状态 |

当不确定从哪里开始排查时，先打印 `error.code`、`error.message`、`error.details` 和 `error.cause`。

#### 1. 捕获特定错误

```javascript
import { ErrorCodes } from 'monsqlize';

try {
  await collection('users').insertOne({});
} catch (error) {
  if (error.code === ErrorCodes.DOCUMENT_REQUIRED) {
    console.error('文档参数缺失，请提供有效的文档对象');
  } else if (error.code === ErrorCodes.DUPLICATE_KEY) {
    console.error('文档已存在，请检查唯一索引字段');
  } else {
    console.error('其他错误:', error.message);
  }
}
```

#### 2. 统一错误处理

```javascript
function handleDatabaseError(error) {
  switch (error.code) {
    case ErrorCodes.CONNECTION_FAILED:
      // 重新连接
      return reconnect();
    case ErrorCodes.QUERY_TIMEOUT:
      // 记录慢查询日志
      return logSlowQuery(error);
    case ErrorCodes.WRITE_CONFLICT:
      // 重试写操作
      return retryWrite();
    default:
      // 记录未知错误
      logger.error('Unknown error:', error);
      throw error;
  }
}
```

#### 3. 详细错误信息

```javascript
try {
  await collection('users').insertOne({ name: 'Alice' });
} catch (error) {
  console.log('错误码:', error.code);
  console.log('错误消息:', error.message);
  
  // 部分错误包含详细信息
  if (error.details) {
    console.log('详细信息:', error.details);
  }
  
  // 部分错误包含原始错误
  if (error.cause) {
    console.log('原始错误:', error.cause);
  }
}
```

---

## 错误码列表

### 验证相关错误 (Validation)

#### VALIDATION_ERROR

**说明**: 参数校验失败

**触发场景**:
- 提供的参数不符合要求
- 缺少必需参数
- 参数类型错误

**示例**:
```javascript
try {
  await collection('users').find({ age: 'invalid' });
} catch (error) {
  console.log(error.code); // 'VALIDATION_ERROR'
  console.log(error.details); // 详细的校验错误信息
}
```

**处理建议**:
- 检查 `error.details` 获取详细的校验错误
- 验证输入参数是否符合 API 要求
- 参考 API 文档确认正确的参数格式

---

#### INVALID_ARGUMENT

**说明**: 参数无效

**触发场景**:
- 参数值超出允许范围
- 参数组合不合法
- 参数格式不正确

**示例**:
```javascript
try {
  await collection('users').find({}).limit(-10); // 负数限制
} catch (error) {
  console.log(error.code); // 'INVALID_ARGUMENT'
}
```

**处理建议**:
- 检查参数的类型和取值范围
- 确认参数组合是否合法
- 参考 API 文档了解参数约束

---

#### INVALID_VECTOR_SEARCH

**说明**: MongoDB 调用前，`vectorSearch()` 的本地参数不合法。

**处理建议**: 查看 `error.details` 中的字段与原因，提供非空 index/path、有限向量、正确的 ANN 或 ENN 组合以及受支持的 filter/projection 形态。服务端的 Vector Search 或索引错误不会被改写为该错误码。

---

#### INVALID_RELATION_SELECT

**说明**: relation 默认或 populate 的 `select` 超出了 P0 支持的包含式形式。

**处理建议**: 使用 `'title createdAt'` 或 `['title', 'createdAt']` 这样的非空顶层字段。这里不支持排除式字段、前缀和点路径。

---

#### RELATION_IN_USE

**说明**: 受保护的 Model 删除发现至少一个已注册、已声明的入站引用。

**处理建议**: 查看 `error.details[0].usages`，处理引用或保留目标。此错误不会发出删除写入。

---

#### RELATION_USAGE_UNAVAILABLE

**说明**: 关系占用扫描不可用、超出目标上限，或 coverage 不完整。

**处理建议**: 查看 `error.details[0].coverage` 与 `skipped`，恢复所需 Model/来源访问或提高显式上限后重试受保护操作。不要改用未检查的删除。

---

#### INVALID_COLLECTION_NAME

**说明**: 集合名称无效

**触发场景**:
- 集合名称为空
- 集合名称包含非法字符
- 集合名称不符合 MongoDB 命名规范

**示例**:
```javascript
try {
  await collection('$invalid.collection'); // 包含非法字符
} catch (error) {
  console.log(error.code); // 'INVALID_COLLECTION_NAME'
}
```

**处理建议**:
- 使用合法的集合名称（字母、数字、下划线）
- 避免使用保留字符（$、.）
- 参考 MongoDB 集合命名规范

---

#### INVALID_DATABASE_NAME

**说明**: 数据库名称无效

**触发场景**:
- 数据库名称为空
- 数据库名称包含非法字符
- 数据库名称不符合 MongoDB 命名规范

**示例**:
```javascript
try {
  await msq.db('invalid/database'); // 包含非法字符
} catch (error) {
  console.log(error.code); // 'INVALID_DATABASE_NAME'
}
```

**处理建议**:
- 使用合法的数据库名称
- 避免使用特殊字符
- 参考 MongoDB 数据库命名规范

---

### 游标相关错误 (Cursor)

#### INVALID_CURSOR

**说明**: 游标无效

**触发场景**:
- 游标已过期或关闭
- 游标配置错误
- 游标状态不一致

**示例**:
```javascript
try {
  const cursor = await collection('users').find({}).cursor();
  await cursor.next();
  // ... 游标过期
  await cursor.next(); // 可能抛出此错误
} catch (error) {
  console.log(error.code); // 'INVALID_CURSOR'
}
```

**处理建议**:
- 确保游标未关闭或过期
- 检查游标的生命周期
- 考虑使用 `toArray()` 或流式处理

---

#### CURSOR_SORT_MISMATCH

**说明**: 游标排序不匹配

**触发场景**:
- 游标分页时排序字段不一致
- 跳页时使用了不同的排序条件

**示例**:
```javascript
try {
  // 第一页使用 price 排序
  const page1 = await collection('products')
    .find({})
    .sort({ price: 1 })
    .cursor({ pageSize: 10 });
  
  // 第二页改用 name 排序 - 错误！
  await page1.next({ sort: { name: 1 } });
} catch (error) {
  console.log(error.code); // 'CURSOR_SORT_MISMATCH'
}
```

**处理建议**:
- 确保分页时排序条件一致
- 使用相同的 `sort` 参数
- 考虑在应用层维护排序状态

---

### 分页相关错误 (Pagination)

#### JUMP_TOO_FAR

**说明**: 跳页距离过远

**触发场景**:
- 尝试跳转到超出合理范围的页面
- 一次性跳过太多页

**示例**:
```javascript
try {
  const cursor = await collection('users').findPage({}, { pageSize: 10 });
  await cursor.jump(10000); // 跳转过远
} catch (error) {
  console.log(error.code); // 'JUMP_TOO_FAR'
}
```

**处理建议**:
- 减小跳页距离
- 使用渐进式跳页
- 考虑使用普通查询代替游标

---

#### STREAM_NO_JUMP

**说明**: 流模式不支持跳页

**触发场景**:
- 在流模式下尝试跳页

**示例**:
```javascript
try {
  const stream = collection('users').find({}).stream();
  await stream.jump(5); // 流模式不支持跳页
} catch (error) {
  console.log(error.code); // 'STREAM_NO_JUMP'
}
```

**处理建议**:
- 流模式下只能顺序读取
- 如需跳页，使用游标模式

---

#### STREAM_NO_TOTALS

**说明**: 流模式不支持获取总数

**触发场景**:
- 在流模式下尝试获取总记录数

**示例**:
```javascript
try {
  const stream = collection('users').find({}).stream();
  await stream.totalCount(); // 流模式不支持
} catch (error) {
  console.log(error.code); // 'STREAM_NO_TOTALS'
}
```

**处理建议**:
- 如需总数，使用 `findAndCount()` 或 `count()`
- 流模式只用于数据处理，不计算总数

---

#### STREAM_NO_EXPLAIN

**说明**: 流模式不支持查询计划

**触发场景**:
- 在流模式下尝试获取执行计划

**示例**:
```javascript
try {
  const stream = collection('users').find({}).stream();
  await stream.explain(); // 流模式不支持
} catch (error) {
  console.log(error.code); // 'STREAM_NO_EXPLAIN'
}
```

**处理建议**:
- 使用链式 API 的 `.explain()` 方法
- 在创建流之前获取执行计划

---

### 连接相关错误 (Connection)

#### CONNECTION_TIMEOUT

**说明**: 连接超时

**触发场景**:
- 数据库服务器响应超时
- 网络延迟过高
- 连接池等待超时

**示例**:
```javascript
try {
  const msq = new MonSQLize({
    type: 'mongodb',
    config: { 
      uri: 'mongodb://slow-server:27017',
      serverSelectionTimeoutMS: 5000
    }
  });
  await msq.connect();
} catch (error) {
  console.log(error.code); // 'CONNECTION_TIMEOUT'
}
```

**处理建议**:
- 检查网络连接
- 增加超时时间配置
- 检查数据库服务器状态
- 检查连接池配置

---

#### CONNECTION_FAILED

**说明**: 数据库连接失败

**触发场景**:
- 数据库服务器不可达
- 连接字符串错误
- 认证失败
- 网络错误

**示例**:
```javascript
try {
  const msq = new MonSQLize({
    type: 'mongodb',
    config: { uri: 'mongodb://invalid-host:27017' }
  });
  await msq.connect();
} catch (error) {
  console.log(error.code); // 'CONNECTION_FAILED'
  console.log(error.cause); // 原始 MongoDB 错误
}
```

**处理建议**:
- 验证连接字符串格式
- 检查数据库服务器状态
- 检查网络连接
- 验证用户名和密码
- 查看 `error.cause` 获取详细错误

---

#### NOT_CONNECTED

**说明**: 数据库未连接（v1.3.0+）

**触发场景**:
- 在调用 `connect()` 之前使用 `pool()` / `use()` / `scopedCollection()` / `scopedModel()`

**示例**:
```javascript
const msq = new MonSQLize({ uri: '...' });
// 未调用 await msq.connect()
try {
  msq.use('billing').collection('invoices'); // 抛出
} catch (error) {
  console.log(error.code); // 'NOT_CONNECTED'
}
```

**处理建议**:
- 确保在使用任何数据访问方法前先调用 `await msq.connect()`

---

#### NO_POOL_MANAGER

**说明**: 未配置多连接池管理器（v1.3.0+）

**触发场景**:
- 调用 `pool()` 时，MonSQLize 构造函数未传入 `pools` 配置

**示例**:
```javascript
const msq = new MonSQLize({ uri: 'mongodb://localhost:27017' }); // 无 pools
await msq.connect();
try {
  msq.pool('cn'); // 抛出
} catch (error) {
  console.log(error.code); // 'NO_POOL_MANAGER'
}
```

**处理建议**:
- 在构造函数中配置 `pools` 选项，或改用 `use()` 切换数据库（单池多库场景）

---

#### POOL_NOT_FOUND

**说明**: 指定连接池不存在（v1.3.0+）

**触发场景**:
- `pool(poolName)` 的 `poolName` 未在 `ConnectionPoolManager` 中注册

**示例**:
```javascript
try {
  msq.pool('missing-pool'); // 抛出
} catch (error) {
  console.log(error.code);      // 'POOL_NOT_FOUND'
  console.log(error.available); // ['cn', 'eu'] — 当前可用连接池列表
}
```

**处理建议**:
- 检查 `error.available` 字段确认可用的连接池名称
- 确认 `poolName` 与初始化时的名称完全一致（区分大小写）

---

#### MODEL_NOT_DEFINED

**说明**: 指定 Model 未注册（v1.3.0+）

**触发场景**:
- `pool().model(key)` 或 `scopedModel(key)` 的 `key` 未注册到 Model 注册表

**示例**:
```javascript
try {
  msq.pool('cn').model('NonExistentModel'); // 抛出
} catch (error) {
  console.log(error.code); // 'MODEL_NOT_DEFINED'
}
```

**处理建议**:
- 确认 Model 文件已被正确加载（检查 `models.path` 配置）
- 确认 key 字符串与 Model 定义中的 `key`（或 `name`）一致

---

#### CONNECTION_CLOSED

**说明**: 连接已关闭

**触发场景**:
- 在已关闭的连接上执行操作
- 连接池已关闭
- 服务器主动关闭连接

**示例**:
```javascript
try {
  await msq.close();
  await collection('users').find({}); // 连接已关闭
} catch (error) {
  console.log(error.code); // 'CONNECTION_CLOSED'
}
```

**处理建议**:
- 检查连接状态
- 重新建立连接
- 避免在关闭后执行操作

---

### 数据库操作错误 (Database)

#### DATABASE_ERROR

**说明**: 通用数据库错误

**触发场景**:
- MongoDB 驱动返回的未分类错误
- 数据库内部错误
- 其他数据库相关问题

**示例**:
```javascript
try {
  await collection('users').find({ $invalidOp: true });
} catch (error) {
  console.log(error.code); // 'DATABASE_ERROR'
  console.log(error.cause); // 原始 MongoDB 错误
}
```

**处理建议**:
- 查看 `error.cause` 获取原始错误
- 检查查询语法
- 查阅 MongoDB 文档

---

#### QUERY_TIMEOUT

**说明**: 查询超时

**触发场景**:
- 查询执行时间超过 `maxTimeMS` 配置
- 慢查询导致超时

**示例**:
```javascript
try {
  await collection('users').find(
    { age: { $gt: 18 } },
    { maxTimeMS: 1000 } // 1秒超时
  );
} catch (error) {
  console.log(error.code); // 'QUERY_TIMEOUT'
}
```

**处理建议**:
- 优化查询条件
- 创建合适的索引
- 增加 `maxTimeMS` 值
- 使用查询计划分析性能

---

### 缓存相关错误 (Cache)

#### CACHE_ERROR

**说明**: 缓存操作错误

**触发场景**:
- 缓存读写失败
- 缓存序列化/反序列化错误
- 缓存配置错误

**示例**:
```javascript
try {
  await collection('users').find({}).cache(60000);
  // 缓存系统故障
} catch (error) {
  console.log(error.code); // 'CACHE_ERROR'
}
```

**处理建议**:
- 检查缓存配置
- 查看缓存服务状态（如 Redis）
- 考虑降级为不使用缓存
- 检查数据是否可序列化

---

#### CACHE_TIMEOUT

**说明**: 缓存操作超时

**触发场景**:
- 缓存读取超时
- 缓存写入超时
- 缓存服务响应慢

**示例**:
```javascript
try {
  await collection('users').find({}).cache(60000);
  // Redis 响应超时
} catch (error) {
  console.log(error.code); // 'CACHE_TIMEOUT'
}
```

**处理建议**:
- 检查缓存服务状态
- 增加超时配置
- 考虑降级为不使用缓存

---

### 配置相关错误 (Configuration)

#### INVALID_CONFIG

**说明**: 配置无效

**触发场景**:
- 配置参数错误
- 缺少必需的配置项
- 配置格式不正确
- Model `schemaDsl` runtime 无法解析 `schema-dsl/runtime`、暴露的 API 形态不匹配，或 runtime options 无效

**示例**:
```javascript
try {
  const msq = new MonSQLize({
    type: 'mongodb',
    config: { /* 缺少 uri */ }
  });
} catch (error) {
  console.log(error.code); // 'INVALID_CONFIG'
}
```

**处理建议**:
- 检查配置参数
- 参考文档确认必需配置
- 验证配置格式
- 如果是 Model schema 验证，检查随包依赖安装完整性、包管理器裁剪、运行时模块解析路径，以及 `schemaDsl` runtime/options/extensions 配置

---

#### UNSUPPORTED_DATABASE

**说明**: 不支持的数据库类型

**触发场景**:
- 指定了不支持的数据库类型
- 数据库版本不兼容

**示例**:
```javascript
try {
  const msq = new MonSQLize({
    type: 'mysql', // 不支持
    config: { /* ... */ }
  });
} catch (error) {
  console.log(error.code); // 'UNSUPPORTED_DATABASE'
}
```

**处理建议**:
- 使用支持的数据库类型（目前仅 MongoDB）
- 检查数据库版本兼容性

---

### 写操作错误 (Write Operations)

#### WRITE_ERROR

**说明**: 通用写操作错误

**触发场景**:
- 写操作执行失败
- 服务器拒绝写入
- 其他写入相关错误

**示例**:
```javascript
try {
  await collection('users').insertOne({ _id: 'duplicate' });
  await collection('users').insertOne({ _id: 'duplicate' });
} catch (error) {
  console.log(error.code); // 可能是 'WRITE_ERROR'
  console.log(error.cause); // 原始 MongoDB 错误
}
```

**处理建议**:
- 查看 `error.cause` 获取详细错误
- 检查写入权限
- 验证数据格式

---

#### DOCUMENT_REQUIRED

**说明**: 缺少文档参数

**触发场景**:
- `insertOne` 未提供文档
- 提供的文档为 `null` 或 `undefined`

**示例**:
```javascript
try {
  await collection('users').insertOne(); // 缺少文档
} catch (error) {
  console.log(error.code); // 'DOCUMENT_REQUIRED'
}
```

**处理建议**:
- 提供有效的文档对象
- 检查文档参数是否为 `null` 或 `undefined`

---

#### DOCUMENTS_REQUIRED

**说明**: 缺少文档数组参数

**触发场景**:
- `insertMany` 未提供文档数组
- 提供的文档数组为空

**示例**:
```javascript
try {
  await collection('users').insertMany([]); // 空数组
} catch (error) {
  console.log(error.code); // 'DOCUMENTS_REQUIRED'
}
```

**处理建议**:
- 提供至少一个文档
- 验证文档数组不为空

---

#### DUPLICATE_KEY

**说明**: 唯一键冲突

**触发场景**:
- 插入重复的 `_id`
- 违反唯一索引约束

**示例**:
```javascript
try {
  await collection('users').insertOne({ _id: 1, name: 'Alice' });
  await collection('users').insertOne({ _id: 1, name: 'Bob' }); // 重复
} catch (error) {
  console.log(error.code); // 'DUPLICATE_KEY'
  console.log(error.details); // 包含重复的键信息
}
```

**处理建议**:
- 检查唯一索引字段
- 使用 `updateOne` 的 `upsert` 选项
- 捕获并处理重复错误

---

#### WRITE_CONFLICT

**说明**: 写入冲突

**触发场景**:
- 并发写入冲突
- 事务冲突
- 乐观锁冲突

**示例**:
```javascript
try {
  // 两个并发事务修改同一文档
  await msq.withTransaction(async (session) => {
    await collection('users').updateOne(
      { _id: 1 },
      { $inc: { balance: 100 } },
      { session }
    );
  });
} catch (error) {
  console.log(error.code); // 'WRITE_CONFLICT'
}
```

**处理建议**:
- 重试写入操作
- 使用事务隔离级别
- 实现乐观锁机制

---

### 锁相关错误 (Locking) 🆕 v1.4.0

#### LOCK_ACQUIRE_FAILED

**说明**: 锁获取失败

**触发场景**:
- 分布式锁已被其他进程持有
- 锁服务不可用
- 锁配置错误

**示例**:
```javascript
try {
  const lock = await msq.acquireLock('user:123', { timeout: 5000 });
} catch (error) {
  console.log(error.code); // 'LOCK_ACQUIRE_FAILED'
}
```

**处理建议**:
- 等待锁释放后重试
- 检查锁服务状态（如 Redis）
- 实现锁超时和重试机制
- 考虑使用更短的锁超时时间

---

#### LOCK_TIMEOUT

**说明**: 锁等待超时

**触发场景**:
- 等待锁的时间超过配置的超时时间
- 其他进程长时间持有锁

**示例**:
```javascript
try {
  const lock = await msq.acquireLock('resource:1', { 
    timeout: 3000,
    waitTimeout: 10000 
  });
} catch (error) {
  console.log(error.code); // 'LOCK_TIMEOUT'
}
```

**处理建议**:
- 增加等待超时时间
- 检查锁持有者状态
- 实现锁的强制释放机制
- 优化业务逻辑减少锁持有时间

---

## 错误码快速索引

| 错误码 | 分类 | 说明 |
|--------|------|------|
| `VALIDATION_ERROR` | 验证 | 参数校验失败 |
| `INVALID_ARGUMENT` | 验证 | 参数无效 |
| `INVALID_VECTOR_SEARCH` | 向量查询 | 本地 Vector Search 参数无效 |
| `INVALID_RELATION_SELECT` | 关系 | 不支持的 relation 包含式字段选择 |
| `RELATION_IN_USE` | 关系 | 受保护删除发现已声明引用 |
| `RELATION_USAGE_UNAVAILABLE` | 关系 | 受保护删除扫描 coverage 不完整或不可用 |
| `INVALID_COLLECTION_NAME` | 验证 | 集合名称无效 |
| `INVALID_DATABASE_NAME` | 验证 | 数据库名称无效 |
| `INVALID_EXPRESSION` | 表达式 | 表达式 DSL 无效 |
| `INVALID_OPERATION` | 操作状态 | 当前状态不允许执行该操作 |
| `INVALID_CURSOR` | 游标 | 游标无效 |
| `INVALID_PAGINATION` | 分页 | 分页参数或 cursor 无效 |
| `CURSOR_SORT_MISMATCH` | 游标 | 游标排序不匹配 |
| `JUMP_TOO_FAR` | 分页 | 跳页距离过远 |
| `STREAM_NO_JUMP` | 分页 | 流模式不支持跳页 |
| `STREAM_NO_TOTALS` | 分页 | 流模式不支持获取总数 |
| `STREAM_NO_EXPLAIN` | 分页 | 流模式不支持查询计划 |
| `CONNECTION_TIMEOUT` | 连接 | 连接超时 |
| `CONNECTION_FAILED` | 连接 | 连接失败 |
| `NOT_CONNECTED` | 连接 | 尚未连接 |
| `CONNECTION_CLOSED` | 连接 | 连接已关闭 |
| `NO_POOL_MANAGER` | 连接池 | 未配置连接池管理器 |
| `POOL_NOT_FOUND` | 连接池 | 指定连接池不存在 |
| `DATABASE_ERROR` | 数据库 | 通用数据库错误 |
| `QUERY_TIMEOUT` | 数据库 | 查询超时 |
| `MANAGEMENT_OPERATION_FAILED` | 管理操作 | 索引、书签或集合管理操作失败 |
| `CACHE_ERROR` | 缓存 | 缓存操作错误 |
| `CACHE_TIMEOUT` | 缓存 | 缓存操作超时 |
| `CACHE_UNAVAILABLE` | 缓存 | 缓存能力不可用 |
| `INVALID_CONFIG` | 配置 | 配置无效 |
| `UNSUPPORTED_DATABASE` | 配置 | 不支持的数据库类型 |
| `WRITE_ERROR` | 写操作 | 通用写操作错误 |
| `DOCUMENT_REQUIRED` | 写操作 | 缺少文档参数 |
| `DOCUMENTS_REQUIRED` | 写操作 | 缺少文档数组参数 |
| `DUPLICATE_KEY` | 写操作 | 唯一键冲突 |
| `WRITE_CONFLICT` | 写操作 | 写入冲突 |
| `LOCK_ACQUIRE_FAILED` | 锁 | 锁获取失败 🆕 v1.4.0 |
| `LOCK_TIMEOUT` | 锁 | 锁等待超时 🆕 v1.4.0 |

---

## 常见问题

### 如何捕获所有数据库相关错误？

```javascript
import { ErrorCodes } from 'monsqlize';

const DATABASE_ERRORS = [
  ErrorCodes.DATABASE_ERROR,
  ErrorCodes.QUERY_TIMEOUT,
  ErrorCodes.CONNECTION_FAILED,
  ErrorCodes.CONNECTION_TIMEOUT,
  ErrorCodes.CONNECTION_CLOSED
];

try {
  await collection('users').find({});
} catch (error) {
  if (DATABASE_ERRORS.includes(error.code)) {
    console.error('数据库错误:', error.message);
  }
}
```

### 如何实现错误重试机制？

```javascript
async function retryOnError(fn, retries = 3) {
  const RETRYABLE_ERRORS = [
    ErrorCodes.CONNECTION_TIMEOUT,
    ErrorCodes.QUERY_TIMEOUT,
    ErrorCodes.WRITE_CONFLICT
  ];

  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (RETRYABLE_ERRORS.includes(error.code) && i < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
        continue;
      }
      throw error;
    }
  }
}

// 使用示例
await retryOnError(async () => {
  await collection('users').insertOne({ name: 'Alice' });
});
```

### 错误日志记录最佳实践

```javascript
function logError(error, context = {}) {
  const logData = {
    code: error.code,
    message: error.message,
    timestamp: new Date().toISOString(),
    ...context
  };

  if (error.details) {
    logData.details = error.details;
  }

  if (error.cause) {
    logData.cause = {
      name: error.cause.name,
      message: error.cause.message,
      stack: error.cause.stack
    };
  }

  // 根据错误类型选择日志级别
  if (error.code === ErrorCodes.VALIDATION_ERROR) {
    logger.warn(logData);
  } else if (error.code === ErrorCodes.CONNECTION_FAILED) {
    logger.error(logData);
  } else {
    logger.info(logData);
  }
}
```

---

## 参考资料

- [API 参考](./api-index.md)
- [事务管理](./transaction.md)
- [连接池配置](./multi-pool.md)
- [链式池/库访问 API](./pool-chain-api.md)
- [连接配置](./connection.md)
