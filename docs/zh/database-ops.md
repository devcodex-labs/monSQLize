# 数据库操作 API

数据库级别的管理操作，包括列出数据库、删除数据库、列出集合等。

## listDatabases()

列出 MongoDB 服务器上的所有数据库。

### 语法

```javascript
const databases = await db.listDatabases(options);
```

### 参数

- **options** (Object, 可选):
  - `nameOnly` (boolean): 仅返回数据库名称，默认 `false`

### 返回值

- **不使用 nameOnly**: `Promise<Array<Object>>`
  - `name` (string): 数据库名称
  - `sizeOnDisk` (number): 磁盘占用（字节）
  - `empty` (boolean): 是否为空
- **使用 nameOnly**: `Promise<Array<string>>`

### 示例

```javascript
// 获取详细信息
const databases = await db.listDatabases();
console.log(databases);
// [
//   { name: 'admin', sizeOnDisk: 83886080, empty: false },
//   { name: 'mydb', sizeOnDisk: 167772160, empty: false }
// ]

// 仅获取名称
const dbNames = await db.listDatabases({ nameOnly: true });
console.log(dbNames); // ['admin', 'config', 'local', 'mydb']
```

---

## dropDatabase()

**⚠️ 危险操作**：删除整个数据库，无法恢复！

### 安全机制

1. **必须显式确认**: 必须传入 `{ confirm: true }`
2. **生产环境保护**: `NODE_ENV=production`、`prod` 或 `live` 默认禁止，需额外传入 `{ allowProduction: true }`
3. **审计日志**: 所有删除尝试都会记录

### 语法（dropDatabase()）

```javascript
const result = await db.db(databaseName).dropDatabase(options);
```

### 参数（dropDatabase()）

- **databaseName** (string, 必需): 数据库名称
- **options** (Object, 必需):
  - `confirm` (boolean, 必需): 必须为 `true`
  - `allowProduction` (boolean): 是否允许在生产环境执行，默认 `false`
  - `user` (string): 操作用户（用于审计）

### 返回值（dropDatabase()）

- **类型**: `Promise<Object>`
- **属性**:
  - `dropped` (boolean): 是否删除成功
  - `database` (string): 被删除的数据库名称
  - `timestamp` (Date): 删除时间

### 示例（dropDatabase()）

#### ❌ 错误：未提供确认

```javascript
try {
    await db.db('test_db').dropDatabase({ confirm: false });
} catch (error) {
    console.error(error.message);
    // "dropDatabase requires explicit confirmation..."
}
```

#### ✅ 正确：提供确认

```javascript
const result = await db.db('test_db').dropDatabase({
    confirm: true,
    user: 'admin@example.com'
});

console.log('Database dropped:', result.database);
console.log('Timestamp:', result.timestamp);
```

#### ⚠️ 生产环境：需要额外确认

```javascript
// 在生产类环境（NODE_ENV=production、prod 或 live）
const result = await db.db('prod_db').dropDatabase({
    confirm: true,
    allowProduction: true,
    user: 'admin@example.com'
});
```

### 错误处理

```javascript
try {
    await db.db('my_database').dropDatabase({
        confirm: true,
        user: 'admin@example.com'
    });
} catch (error) {
    if (error.code === 'CONFIRMATION_REQUIRED') {
        console.error('❌ 缺少确认参数');
    } else if (error.code === 'PRODUCTION_BLOCKED') {
        console.error('❌ 生产环境被阻止');
    } else {
        console.error('❌ 删除失败:', error.message);
    }
}
```

---

## listCollections()

列出当前数据库中的所有集合。

### 语法（listCollections()）

```javascript
const collections = await db.listCollections(filter, options);
```

### 参数（listCollections()）

- **filter** (Object, 可选): MongoDB 集合列表过滤条件
- **options** (Object, 可选): MongoDB listCollections 选项

### 返回值（listCollections()）

- `Promise<Array<Object>>`

### 示例（listCollections()）

```javascript
// 获取详细信息
const collections = await db.listCollections();
console.log(collections);
// [
//   { name: 'users', type: 'collection', options: {}, info: {...} },
//   { name: 'orders', type: 'collection', options: {}, info: {...} }
// ]

// 从公开返回值中提取名称
const names = collections.map((collection) => collection.name);
console.log(names); // ['users', 'orders', 'products']
```

---

## runCommand()

执行任意 MongoDB 命令。

### 语法（runCommand()）

```javascript
const result = await db.runCommand(command, options);
```

### 参数（runCommand()）

- **command** (Object, 必需): MongoDB 命令对象
- **options** (Object, 可选): 命令选项

### 示例（runCommand()）

```javascript
// 执行 ping 命令
const ping = await db.runCommand({ ping: 1 });
console.log(ping.ok); // 1

// 执行 dbStats 命令
const stats = await db.runCommand({ dbStats: 1, scale: 1024 });
console.log('Collections:', stats.collections);
console.log('Data size (KB):', stats.dataSize);

// 执行 collStats 命令
const collStats = await db.runCommand({
    collStats: 'users',
    scale: 1048576 // MB
});
console.log('Count:', collStats.count);
console.log('Size (MB):', collStats.size);
```

---

## 相关文档

- [运维监控](./admin.md) - ping, buildInfo, serverStatus, stats
- [集合管理](./collection-management.md) - 集合级别操作
- [集合管理示例](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/collection-management.ts)

