# insertOne() - 插入单个文档


`insertOne()` 方法向集合中插入单个文档。

## 语法

```javascript
collection(name).insertOne(document, options?)
```

## 参数

### document（必需）

**类型**: `Object`

要插入的文档对象。如果文档没有 `_id` 字段，MongoDB 会自动生成一个。

```javascript
// 自动生成 _id
await collection("users").insertOne({
  name: "Alice",
  email: "alice@example.com",
  age: 30
});

// 手动指定 _id
await collection("users").insertOne({
  _id: "custom-id-123",
  name: "Bob",
  email: "bob@example.com"
});
```

### options（可选）

**类型**: `Object`

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `writeConcern` | Object | - | 写关注选项 |
| `bypassDocumentValidation` | boolean | false | 是否绕过文档验证 |
| `comment` | string | - | 操作注释，用于日志追踪 |

## 返回值

**类型**: `Promise<Object>`

返回一个包含插入结果的对象：

```javascript
{
  insertedId: ObjectId("507f1f77bcf86cd799439011"),  // 插入文档的 _id
  acknowledged: true                                  // 操作是否被确认
}
```

## 核心特性

### ✅ 自动生成 _id

如果文档没有 `_id` 字段，MongoDB 会自动生成一个唯一的 ObjectId。

```javascript
const result = await collection("users").insertOne({
  name: "Alice",
  email: "alice@example.com"
});

console.log(result.insertedId); // ObjectId("507f1f77bcf86cd799439011")
```

### ✅ 显式缓存失效

插入成功后，monSQLize 默认不清理查询缓存。需要清理时，使用 `cache.invalidate` 精准失效，或使用 `autoInvalidate: true` 做集合级 broad 失效。

```javascript
// 查询并缓存
const users = await collection("users").find({}, { cache: 5000 });
console.log(users.length); // 10

// 插入新用户，并按需清理缓存
await collection("users").insertOne({ name: "Alice" });

// 再次查询（不会从缓存返回，会查询数据库）
const updatedUsers = await collection("users").find({}, { cache: 5000 });
console.log(updatedUsers.length); // 11
```

### ✅ 慢查询监控

超过阈值（默认 1000ms）的插入操作会自动记录警告日志。

```javascript
// 配置慢查询阈值
const monsqlize = new MonSQLize({
  slowQueryMs: 500  // 超过 500ms 记录警告
});

// 慢插入操作会被记录
await collection("large_docs").insertOne({
  data: { /* 大量数据 */ }
});
// 日志: [WARN] [insertOne] 慢操作警告 { duration: 650ms, ... }
```

## 常见场景

### 场景 1: 创建新用户

```javascript
const result = await collection("users").insertOne({
  userId: "user123",
  name: "Alice",
  email: "alice@example.com",
  status: "active",
  createdAt: new Date()
});

console.log("用户创建成功，ID:", result.insertedId);
```

### 场景 2: 插入嵌套文档

```javascript
const result = await collection("orders").insertOne({
  orderId: "order123",
  customerId: "cust456",
  items: [
    { productId: "prod1", quantity: 2, price: 29.99 },
    { productId: "prod2", quantity: 1, price: 49.99 }
  ],
  shippingAddress: {
    street: "123 Main St",
    city: "New York",
    zip: "10001"
  },
  total: 109.97,
  createdAt: new Date()
});

console.log("订单创建成功:", result.insertedId);
```

### 场景 3: 使用自定义 _id

```javascript
// 使用业务 ID 作为 _id
const result = await collection("products").insertOne({
  _id: "SKU-12345",
  name: "Laptop",
  price: 999.99,
  category: "electronics"
});

console.log("产品 ID:", result.insertedId); // "SKU-12345"
```

### 场景 4: 插入带时间戳的文档

```javascript
const result = await collection("logs").insertOne({
  level: "info",
  message: "User logged in",
  userId: "user123",
  timestamp: new Date(),
  metadata: {
    ip: "192.168.1.1",
    userAgent: "Mozilla/5.0..."
  }
});
```

### 场景 5: 插入并返回完整文档

```javascript
// 插入文档
const result = await collection("users").insertOne({
  name: "Alice",
  email: "alice@example.com"
});

// 查询刚插入的文档（包含自动生成的 _id）
const newUser = await collection("users").findOne({
  _id: result.insertedId
});

console.log(newUser);
// {
//   _id: ObjectId("..."),
//   name: "Alice",
//   email: "alice@example.com"
// }
```

## 错误处理

### 重复的 _id

```javascript
try {
  await collection("users").insertOne({
    _id: "user123",
    name: "Alice"
  });

  // 再次插入相同的 _id 会失败
  await collection("users").insertOne({
    _id: "user123",  // 重复的 _id
    name: "Bob"
  });
} catch (error) {
  if (error.code === ErrorCodes.DUPLICATE_KEY) {
    console.error("文档已存在");
  }
}
```

### 无效的文档

```javascript
try {
  // 错误：document 必须是对象
  await collection("users").insertOne("not an object");
} catch (error) {
  console.error(error.code); // INVALID_ARGUMENT
  console.error(error.message); // "document 必须是对象类型"
}
```

### 唯一索引冲突

```javascript
// 假设 email 字段有唯一索引
try {
  await collection("users").insertOne({
    name: "Alice",
    email: "alice@example.com"
  });

  // 插入相同 email 会失败
  await collection("users").insertOne({
    name: "Bob",
    email: "alice@example.com"  // 重复的 email
  });
} catch (error) {
  if (error.code === ErrorCodes.DUPLICATE_KEY) {
    console.error("Email 已被使用");
  }
}
```

### 文档验证失败

```javascript
// 假设集合有验证规则
try {
  await collection("users").insertOne({
    name: "Alice"
    // 缺少必需的 email 字段
  });
} catch (error) {
  if (error.code === ErrorCodes.WRITE_ERROR) {
    console.error("文档验证失败:", error.message);
  }
}
```

## 与其他方法的区别

### vs insertMany

| 特性 | insertOne | insertMany |
|------|-----------|------------|
| **插入数量** | 一次插入 1 个文档 | 一次插入多个文档 |
| **返回值** | `insertedId` (单个) | `insertedIds` (数组) |
| **性能** | 低（每次单独插入） | 高（批量插入） |
| **原子性** | 是（单个文档插入） | 否（可部分成功） |
| **使用场景** | 单个文档创建 | 批量导入数据 |

```javascript
// insertOne - 单个插入
const result1 = await collection("users").insertOne({ name: "Alice" });
console.log(result1.insertedId); // ObjectId

// insertMany - 批量插入
const result2 = await collection("users").insertMany([
  { name: "Bob" },
  { name: "Charlie" }
]);
console.log(result2.insertedIds); // { 0: ObjectId, 1: ObjectId }
```

### vs updateOne with upsert

| 特性 | insertOne | updateOne (upsert: true) |
|------|-----------|--------------------------|
| **行为** | 只插入，已存在则失败 | 不存在则插入，存在则更新 |
| **重复处理** | 抛出错误 | 更新现有文档 |
| **使用场景** | 确定是新文档 | 不确定文档是否存在 |

```javascript
// insertOne - 重复时失败
try {
  await collection("users").insertOne({ _id: "user123", name: "Alice" });
  await collection("users").insertOne({ _id: "user123", name: "Bob" }); // ❌ 失败
} catch (error) {
  console.error("文档已存在");
}

// updateOne with upsert - 重复时更新
await collection("users").updateOne(
  { _id: "user123" },
  { $set: { name: "Alice" } },
  { upsert: true }  // 不存在则插入，存在则更新
);

await collection("users").updateOne(
  { _id: "user123" },
  { $set: { name: "Bob" } },
  { upsert: true }  // ✅ 更新成功
);
```

## 性能优化建议

### 1. 批量插入时使用 insertMany

```javascript
// 不好：循环调用 insertOne
for (const user of users) {
  await collection("users").insertOne(user);  // 慢，每次一个网络往返
}

// 好：使用 insertMany
await collection("users").insertMany(users);  // 快，一次网络往返
```

### 2. 避免在循环中插入

```javascript
// 不好：在循环中插入
const results = [];
for (let i = 0; i < 1000; i++) {
  const result = await collection("items").insertOne({ index: i });
  results.push(result);
}

// 好：先准备数据，然后批量插入
const items = Array.from({ length: 1000 }, (_, i) => ({ index: i }));
const result = await collection("items").insertMany(items);
```

### 3. 使用适当的 _id 类型

```javascript
// ObjectId（默认）- 12 字节，包含时间戳
await collection("users").insertOne({ name: "Alice" });

// 字符串 - 如果有业务 ID，可以使用
await collection("products").insertOne({
  _id: "SKU-12345",  // 业务 ID
  name: "Laptop"
});

// 数字 - 如果有序列号
await collection("orders").insertOne({
  _id: 100001,  // 订单号
  customerId: "cust123"
});
```

## 最佳实践

### ✅ 包含创建时间戳

```javascript
await collection("users").insertOne({
  name: "Alice",
  email: "alice@example.com",
  createdAt: new Date(),  // 创建时间
  updatedAt: new Date()   // 更新时间
});
```

### ✅ 使用验证确保数据质量

```javascript
// 在插入前验证数据
function validateUser(user) {
  if (!user.name || typeof user.name !== "string") {
    throw new Error("name 是必需的字符串");
  }
  if (!user.email || !user.email.includes("@")) {
    throw new Error("email 格式无效");
  }
  return true;
}

// 使用验证
const newUser = { name: "Alice", email: "alice@example.com" };
if (validateUser(newUser)) {
  await collection("users").insertOne(newUser);
}
```

### ✅ 处理重复键错误

```javascript
async function createUser(userData) {
  try {
    const result = await collection("users").insertOne(userData);
    return { success: true, id: result.insertedId };
  } catch (error) {
    if (error.code === ErrorCodes.DUPLICATE_KEY) {
      return { success: false, error: "用户已存在" };
    }
    throw error;
  }
}
```

### ✅ 使用事务（多文档插入）

```javascript
// 如果需要原子性地插入到多个集合
const session = client.startSession();
try {
  await session.withTransaction(async () => {
    // 插入用户
    const userResult = await collection("users").insertOne(
      { userId: "user123", name: "Alice" },
      { session }
    );

    // 插入用户配置
    await collection("user_settings").insertOne(
      { userId: "user123", theme: "dark" },
      { session }
    );
  });
} finally {
  await session.endSession();
}
```

## 注意事项

### ⚠️ _id 是不可变的

一旦插入，`_id` 字段不能被修改：

```javascript
const result = await collection("users").insertOne({
  _id: "user123",
  name: "Alice"
});

// 无法修改 _id
await collection("users").updateOne(
  { _id: "user123" },
  { $set: { _id: "user456" } }  // ❌ 错误：不能修改 _id
);
```

### ⚠️ 大文档的性能影响

MongoDB 文档大小限制为 16MB，但大文档会影响性能：

```javascript
// 避免插入过大的文档
await collection("files").insertOne({
  name: "large-file.pdf",
  content: Buffer.alloc(15 * 1024 * 1024)  // 15MB，接近限制
});

// 考虑使用 GridFS 存储大文件
```

### ⚠️ 缓存失效的范围

插入会清理整个集合的缓存：

```javascript
// 查询并缓存
await collection("users").find({ status: "active" }, { cache: 5000 });

// 插入新用户（清理所有 users 集合的缓存）
await collection("users").insertOne({ name: "Alice" });

// 上面的缓存被清理，即使新用户的 status 不是 "active"
```

## 实用工具函数

### 安全的插入函数（带重试）

```javascript
/**
 * 安全地插入文档（自动重试）
 */
async function safeInsertOne(collectionName, document, options = {}) {
  const { maxRetries = 3, retryDelay = 100 } = options;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await collection(collectionName).insertOne(document);
      return { success: true, insertedId: result.insertedId };
    } catch (error) {
      if (error.code === ErrorCodes.DUPLICATE_KEY) {
        // 重复键不重试
        return { success: false, error: "文档已存在", code: error.code };
      }

      if (attempt < maxRetries) {
        console.warn(`插入失败 (尝试 ${attempt}/${maxRetries})，${retryDelay}ms 后重试...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      } else {
        return { success: false, error: error.message, code: error.code };
      }
    }
  }
}

// 使用示例
const result = await safeInsertOne("users", { name: "Alice" });
if (result.success) {
  console.log("插入成功:", result.insertedId);
} else {
  console.error("插入失败:", result.error);
}
```

## 相关方法

- [insertMany()](./insert-many.md) - 批量插入多个文档
- [insertBatch()](./insertBatch.md) - 高性能批量插入（分批处理）
- [updateOne()](./update-one.md) - 更新文档（配合 upsert 可实现插入或更新）

## 示例代码

完整的示例代码请参考：
- [insert 可运行示例](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/insert.ts)
- [写入操作指南](./write-operations.md)

## MongoDB 文档

- [MongoDB insertOne 文档](https://www.mongodb.com/docs/manual/reference/method/db.collection.insertOne/)
