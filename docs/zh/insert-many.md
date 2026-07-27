# insertMany() - 批量插入文档


`insertMany()` 方法一次向集合提交多个文档，通常可减少循环调用 `insertOne()` 产生的网络往返；实际收益取决于批量大小、文档、索引、写关注和网络，应以真实负载测量。

## 语法

```javascript
collection(name).insertMany(documents, options?)
```

## 参数

### documents（必需）

**类型**: `Array<Object>`

要插入的文档数组。如果文档没有 `_id` 字段，MongoDB 会自动生成。

```javascript
await collection("users").insertMany([
  { name: "Alice", email: "alice@example.com" },
  { name: "Bob", email: "bob@example.com" },
  { name: "Charlie", email: "charlie@example.com" }
]);
```

### options（可选）

**类型**: `Object`

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `ordered` | boolean | true | 是否有序插入（遇到错误是否继续） |
| `writeConcern` | Object | - | 写关注选项 |
| `bypassDocumentValidation` | boolean | false | 是否绕过文档验证 |
| `comment` | string | - | 操作注释，用于日志追踪 |

## 返回值

**类型**: `Promise<Object>`

返回一个包含插入结果的对象：

```javascript
{
  insertedIds: {
    0: ObjectId("507f1f77bcf86cd799439011"),
    1: ObjectId("507f1f77bcf86cd799439012"),
    2: ObjectId("507f1f77bcf86cd799439013")
  },
  insertedCount: 3,      // 成功插入的文档数量
  acknowledged: true     // 操作是否被确认
}
```

## 核心特性

### 高吞吐批量插入

相比在循环中逐次等待 `insertOne()`，`insertMany()` 可以减少应用到数据库的往返次数：

```javascript
// 每个文档一次带确认的数据库调用
for (const user of users) {
  await collection("users").insertOne(user);
}

// 数组形成一次批量请求，但仍受服务端和负载大小限制
await collection("users").insertMany(users);
```

**性能特征**：

| 路径 | 数据库往返次数 | 主要取舍 |
|---------|-----------------|------------|
| 逐次等待 `insertOne()` | 每个文档一次 | 逐文档控制简单，但重复承担网络和确认开销 |
| `insertMany()` | 符合部署限制时为一次批量请求 | 减少往返；需处理较大负载和部分失败 |

实际吞吐取决于文档大小、索引、写关注、ordered 模式、服务端拓扑与并发。请按[性能证据契约](./performance-evidence.md)测量部署工作负载。

### ✅ 有序 vs 无序插入

**有序插入（ordered: true，默认）**:
- 按数组顺序依次插入
- 遇到错误立即停止
- 前面的文档已插入，后面的不会插入

**无序插入（ordered: false）**:
- 并行插入，不保证顺序
- 遇到错误继续插入其他文档
- 尽可能插入更多文档

```javascript
// 有序插入（默认）
try {
  await collection("users").insertMany([
    { _id: 1, name: "Alice" },
    { _id: 1, name: "Bob" },    // ❌ 重复 _id，停止
    { _id: 2, name: "Charlie" } // 不会被插入
  ], { ordered: true });
} catch (error) {
  // 只插入了第一个文档
}

// 无序插入
try {
  await collection("users").insertMany([
    { _id: 1, name: "Alice" },
    { _id: 1, name: "Bob" },    // ❌ 重复 _id，但继续
    { _id: 2, name: "Charlie" } // ✅ 会被插入
  ], { ordered: false });
} catch (error) {
  // 插入了第一个和第三个文档
}
```

### ✅ 显式缓存失效

插入成功后，monSQLize 默认不清理查询缓存。需要清理时，使用 `cache.invalidate` 精准失效，或使用 `autoInvalidate: true` 做集合级 broad 失效。

```javascript
// 查询并缓存
const users = await collection("users").find({}, { cache: 5000 });
console.log(users.length); // 10

// 批量插入，并按需清理缓存
await collection("users").insertMany([
  { name: "Alice" },
  { name: "Bob" }
]);

// 再次查询（不会从缓存返回）
const updatedUsers = await collection("users").find({}, { cache: 5000 });
console.log(updatedUsers.length); // 12
```

### ✅ 慢查询监控

超过阈值（默认 1000ms）的插入操作会自动记录警告日志。

```javascript
// 大量插入可能触发慢查询警告
await collection("products").insertMany(largeProductArray);
// 日志: [WARN] [insertMany] 慢操作警告 { duration: 1500ms, insertedCount: 10000 }
```

## 常见场景

### 场景 1: 批量创建用户

```javascript
const newUsers = [
  { userId: "user1", name: "Alice", email: "alice@example.com" },
  { userId: "user2", name: "Bob", email: "bob@example.com" },
  { userId: "user3", name: "Charlie", email: "charlie@example.com" }
];

const result = await collection("users").insertMany(newUsers);
console.log(`成功创建 ${result.insertedCount} 个用户`);
console.log("用户 IDs:", result.insertedIds);
```

### 场景 2: 导入 CSV/JSON 数据

```javascript
const fs = require("fs");

// 读取 JSON 文件
const data = JSON.parse(fs.readFileSync("products.json", "utf8"));

// 批量插入
const result = await collection("products").insertMany(data);
console.log(`导入了 ${result.insertedCount} 个产品`);
```

### 场景 3: 批量插入日志

```javascript
const logs = [
  { level: "info", message: "Server started", timestamp: new Date() },
  { level: "warn", message: "High memory usage", timestamp: new Date() },
  { level: "error", message: "Database connection failed", timestamp: new Date() }
];

await collection("logs").insertMany(logs);
```

### 场景 4: 无序插入（最大容错）

```javascript
// 即使有部分失败，也尽可能插入更多文档
try {
  const result = await collection("products").insertMany(
    products,
    { ordered: false }  // 无序插入，遇到错误继续
  );
  console.log(`成功插入 ${result.insertedCount} 个产品`);
} catch (error) {
  // 检查哪些文档插入失败
  if (error.writeErrors) {
    console.error(`${error.writeErrors.length} 个文档插入失败`);
    error.writeErrors.forEach(err => {
      console.error(`文档索引 ${err.index}: ${err.errmsg}`);
    });
  }
  // 部分文档仍然成功插入
  console.log(`实际插入 ${error.result.insertedCount} 个文档`);
}
```

### 场景 5: 大量数据分批插入

```javascript
// 超大数据集应该分批插入
const BATCH_SIZE = 1000;

async function insertLargeDataset(collectionName, documents) {
  let inserted = 0;

  for (let i = 0; i < documents.length; i += BATCH_SIZE) {
    const batch = documents.slice(i, i + BATCH_SIZE);
    const result = await collection(collectionName).insertMany(batch);
    inserted += result.insertedCount;

    console.log(`进度: ${inserted}/${documents.length}`);
  }

  return inserted;
}

// 使用示例
const totalInserted = await insertLargeDataset("products", allProducts);
console.log(`总共插入 ${totalInserted} 个文档`);
```

## 错误处理

### 重复键错误（有序插入）

```javascript
try {
  await collection("users").insertMany([
    { _id: "user1", name: "Alice" },
    { _id: "user1", name: "Bob" },    // ❌ 重复 _id
    { _id: "user2", name: "Charlie" } // 不会被插入
  ], { ordered: true });  // 有序插入，遇到错误停止
} catch (error) {
  if (error.code === ErrorCodes.DUPLICATE_KEY) {
    console.error("存在重复的 _id");
    console.log(`已插入 ${error.result.insertedCount} 个文档`);
  }
}
```

### 重复键错误（无序插入）

```javascript
try {
  await collection("users").insertMany([
    { _id: "user1", name: "Alice" },
    { _id: "user1", name: "Bob" },    // ❌ 重复 _id
    { _id: "user2", name: "Charlie" } // ✅ 仍会插入
  ], { ordered: false });  // 无序插入，遇到错误继续
} catch (error) {
  console.log(`成功插入 ${error.result.insertedCount} 个文档`); // 2
  console.log(`失败 ${error.writeErrors.length} 个文档`); // 1

  // 查看具体失败的文档
  error.writeErrors.forEach(err => {
    console.error(`索引 ${err.index} 失败: ${err.errmsg}`);
  });
}
```

### 无效的文档数组

```javascript
try {
  // 错误：documents 必须是数组
  await collection("users").insertMany({ name: "Alice" });
} catch (error) {
  console.error(error.code); // INVALID_ARGUMENT
  console.error(error.message); // "documents 必须是数组类型"
}
```

### 空数组

```javascript
try {
  // 错误：数组不能为空
  await collection("users").insertMany([]);
} catch (error) {
  console.error(error.message); // "documents 数组不能为空"
}
```

## 与其他方法的区别

### vs insertOne

| 特性 | insertOne | insertMany |
|------|-----------|------------|
| **插入数量** | 一次插入 1 个 | 一次插入多个 |
| **性能** | 网络往返更多 | 通常网络往返更少；需按实际负载测量 |
| **返回值** | `insertedId` (单个) | `insertedIds` (对象) |
| **错误处理** | 简单（成功或失败） | 复杂（可能部分成功） |
| **使用场景** | 单个文档创建 | 批量导入数据 |

```javascript
// insertOne - 逐个插入（慢）
const ids = [];
for (const user of users) {
  const result = await collection("users").insertOne(user);
  ids.push(result.insertedId);
}

// insertMany - 批量插入（快）
const result = await collection("users").insertMany(users);
const ids = Object.values(result.insertedIds);
```

### vs insertBatch

| 特性 | insertMany | insertBatch |
|------|-----------|-------------|
| **最大数量** | 无限制（手动分批） | 自动分批（默认 1000/批） |
| **性能** | 好 | 更好（自动优化） |
| **内存使用** | 高（一次性加载） | 低（分批处理） |
| **使用场景** | 中小量数据 | 超大量数据（百万级） |

```javascript
// insertMany - 适合中小量数据（<10万）
await collection("users").insertMany(users);

// insertBatch - 适合超大量数据（>10万）
await collection("users").insertBatch(users, {
  batchSize: 1000  // 每批 1000 个
});
```

## 性能优化建议

### 1. 选择合适的批量大小

```javascript
// 太小：性能提升不明显
await collection("users").insertMany(users.slice(0, 10));

// 太大：可能超时或内存不足
await collection("users").insertMany(millionUsers);

// 合适：1000-10000 之间
const BATCH_SIZE = 5000;
for (let i = 0; i < users.length; i += BATCH_SIZE) {
  const batch = users.slice(i, i + BATCH_SIZE);
  await collection("users").insertMany(batch);
}
```

### 2. 使用无序插入提高容错性

```javascript
// 数据质量不确定时，使用无序插入
await collection("products").insertMany(products, {
  ordered: false  // 尽可能插入更多数据
});
```

### 3. 避免过大的文档

```javascript
// 不好：每个文档都很大
const largeDocuments = users.map(user => ({
  ...user,
  largeField: Buffer.alloc(1024 * 1024)  // 1MB
}));

// 好：保持文档精简
const compactDocuments = users.map(user => ({
  userId: user.id,
  name: user.name,
  email: user.email
}));
```

### 4. 使用索引后再插入大量数据

```javascript
// 策略 1：先插入数据，后创建索引（更快）
await collection("users").insertMany(millionUsers);
await collection("users").createIndex({ email: 1 });

// 策略 2：先创建索引，后插入数据（插入时维护索引，较慢）
await collection("users").createIndex({ email: 1 });
await collection("users").insertMany(millionUsers);

// 推荐：大量数据时使用策略 1
```

## 实用工具函数

### 分批插入函数

```javascript
/**
 * 智能分批插入（自动重试、进度报告）
 */
async function batchInsert(collectionName, documents, options = {}) {
  const {
    batchSize = 5000,
    ordered = false,
    maxRetries = 3,
    onProgress = null
  } = options;

  let inserted = 0;
  let failed = 0;

  for (let i = 0; i < documents.length; i += batchSize) {
    const batch = documents.slice(i, i + batchSize);
    let attempt = 0;
    let success = false;

    while (attempt < maxRetries && !success) {
      try {
        const result = await collection(collectionName).insertMany(batch, { ordered });
        inserted += result.insertedCount;
        success = true;

        // 进度回调
        if (onProgress) {
          onProgress({
            inserted,
            total: documents.length,
            percentage: ((inserted / documents.length) * 100).toFixed(2)
          });
        }
      } catch (error) {
        attempt++;

        if (error.result) {
          // 部分成功（无序插入）
          inserted += error.result.insertedCount || 0;
          failed += error.writeErrors?.length || 0;
          success = true;
        } else if (attempt < maxRetries) {
          console.warn(`批次 ${i} 插入失败，重试 (${attempt}/${maxRetries})...`);
          await new Promise(resolve => setTimeout(resolve, 1000));
        } else {
          throw error;
        }
      }
    }
  }

  return { inserted, failed, total: documents.length };
}

// 使用示例
const result = await batchInsert("products", allProducts, {
  batchSize: 5000,
  ordered: false,
  maxRetries: 3,
  onProgress: (progress) => {
    console.log(`进度: ${progress.percentage}% (${progress.inserted}/${progress.total})`);
  }
});

console.log(`插入完成: 成功 ${result.inserted}, 失败 ${result.failed}`);
```

### CSV 导入函数

```javascript
const fs = require("fs");
const { parse } = require("csv-parse/sync");

/**
 * 从 CSV 文件批量导入数据
 */
async function importFromCSV(collectionName, csvFilePath, options = {}) {
  // 读取 CSV 文件
  const fileContent = fs.readFileSync(csvFilePath, "utf8");
  const records = parse(fileContent, {
    columns: true,  // 使用第一行作为字段名
    skip_empty_lines: true,
    ...options.parseOptions
  });

  // 数据转换
  const documents = records.map(record => {
    // 可以在这里进行数据转换
    return {
      ...record,
      importedAt: new Date()
    };
  });

  // 批量插入
  const result = await batchInsert(collectionName, documents, options.insertOptions);

  return result;
}

// 使用示例
const result = await importFromCSV("users", "./data/users.csv", {
  insertOptions: {
    batchSize: 5000,
    ordered: false
  }
});
```

## 注意事项

### ⚠️ 内存限制

大数组会占用大量内存：

```javascript
// 危险：一次性加载百万级文档到内存
const millionUsers = []; // 占用大量内存
await collection("users").insertMany(millionUsers);

// 安全：分批处理
await batchInsert("users", millionUsers, { batchSize: 5000 });
```

### ⚠️ 有序 vs 无序的选择

```javascript
// 使用有序插入：数据质量高，需要完整性
await collection("critical_data").insertMany(data, {
  ordered: true  // 遇到错误停止
});

// 使用无序插入：数据质量不确定，最大容错
await collection("import_logs").insertMany(logs, {
  ordered: false  // 尽可能插入更多
});
```

### ⚠️ 批量操作的事务性

`insertMany` 本身不是事务，可能部分成功：

```javascript
// 如果需要完全的原子性，使用事务
const session = client.startSession();
try {
  await session.withTransaction(async () => {
    await collection("users").insertMany(users, { session });
  });
} finally {
  await session.endSession();
}
```

## 相关方法

- [insertOne()](./insert-one.md) - 插入单个文档
- [insertBatch()](./insertBatch.md) - 高性能批量插入（自动分批，适合百万级数据）
- [updateMany()](./update-many.md) - 批量更新文档

## 示例代码

完整的示例代码请参考：
- [insertMany 可运行示例](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/insert-many.ts)
- [写入操作指南](./write-operations.md)

## MongoDB 文档

- [MongoDB insertMany 文档](https://www.mongodb.com/docs/manual/reference/method/db.collection.insertMany/)
- [MongoDB Bulk Write Operations](https://www.mongodb.com/docs/manual/core/bulk-write-operations/)
