# findByIds Reference

Model `findByIds` 在同一次数据库查询中应用软删除可见性条件，使用最终 `before` hook 选项。包含、排除、计算投影与 `project` 别名保持原生语义，包括显式投影的删除标记。`onlyDeleted`、`withDeleted` 沿用原有优先级和校验。原始 Collection 查询不增加此过滤；`after` 替换的结果不会再次按删除标记过滤。

Model 过滤结果缓存按可见性条件隔离，并纳入精确 `findByIds` 写失效 descriptor。不支持 pattern 删除的缓存跳过这些过滤结果，带 session 的读取也绕过缓存。ID 校验、去重与 `preserveOrder` 行为不变。

## 方法概述

`findByIds(ids, options)` 是一个可选的多个 `_id` 查询 helper。它会归一化 ObjectId 形态的值、去重重复 id，并执行 `_id: { $in: ... }` 查询。

也可以直接使用标准 `find()` API。普通查询路径同样支持 ObjectId 自动转换：

```javascript
const users = await collection('users').find({
  _id: { $in: userIds }
});
```

当项目希望把“多个 id 查询”写成独立 helper，或需要 `preserveOrder` 保持输入顺序时，可以使用 `findByIds()`：

```javascript
const users = await collection('users').findByIds(userIds, {
  preserveOrder: true
});
```

### 行为摘要

| 行为 | 说明 |
|------|------|
| ObjectId 归一化 | 支持 ObjectId 形态字符串与 ObjectId 值混用 |
| 去重 | 重复 id 只查询一次 |
| 顺序 | 默认按 MongoDB 返回顺序；设置 `preserveOrder: true` 后按输入 id 顺序返回 |
| 缺失 id | 不存在的文档不会出现在返回数组中 |

---

## 方法签名
```typescript
async findByIds(
  ids: Array<string | ObjectId>,
  options?: {
    projection?: Object,
    sort?: Object,
    cache?: number,
    maxTimeMS?: number,
    comment?: string,
    preserveOrder?: boolean
  }
): Promise<Array<Document>>
```

### 参数说明

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `ids` | Array<string \| ObjectId> | 是 | _id 数组，支持字符串和 ObjectId 混合 |
| `options` | Object | 否 | 查询选项 |
| `options.projection` / `options.project` | Object | 否 | 字段投影。`project` 是 `projection` 的别名；两者同时存在时 `projection` 优先。 |
| `options.sort` | Object | 否 | 排序方式 |
| `options.cache` | number | 否 | 缓存 TTL（毫秒） |
| `options.maxTimeMS` | number | 否 | 查询超时（毫秒） |
| `options.comment` | string | 否 | 查询注释 |
| `options.preserveOrder` | boolean | 否 | 是否保持输入 ids 顺序；默认 `false` |

### 返回值说明

返回文档数组，不存在的 ID 不会返回结果。

---

## 基础示例

### 示例 1：批量查询文档（字符串 ID）

```javascript
const userIds = [
  '507f1f77bcf86cd799439011',
  '507f1f77bcf86cd799439012',
  '507f1f77bcf86cd799439013'
];

const users = await collection('users').findByIds(userIds);
console.log(`找到 ${users.length} 个用户`);
```

### 示例 2：批量查询文档（ObjectId）

```javascript
const { ObjectId } = require('mongodb');
const userIds = [
  new ObjectId('507f1f77bcf86cd799439011'),
  new ObjectId('507f1f77bcf86cd799439012')
];

const users = await collection('users').findByIds(userIds);
```

### 示例 3：混合类型（字符串 + ObjectId）

```javascript
const userIds = [
  '507f1f77bcf86cd799439011',  // 字符串
  new ObjectId('507f1f77bcf86cd799439012'),  // ObjectId
  '507f1f77bcf86cd799439013'   // 字符串
];

const users = await collection('users').findByIds(userIds);
```

### 示例 4：使用 projection（只返回特定字段）

```javascript
const users = await collection('users').findByIds(userIds, {
  projection: { name: 1, email: 1, role: 1 }
});

// 结果只包含 _id, name, email, role
```

### 示例 5：使用 sort（排序结果）

```javascript
const users = await collection('users').findByIds(userIds, {
  sort: { name: 1 }  // 按名称升序
});
```

### 示例 6：保持原始顺序

```javascript
const orderedIds = ['id3', 'id1', 'id2'];
const users = await collection('users').findByIds(orderedIds, {
  preserveOrder: true  // 结果顺序与 orderedIds 一致
});
```

---

## 真实场景示例

### 场景 1：批量查询用户资料（关联查询）

从评论列表中提取用户 ID，批量查询用户资料。

```javascript
// 评论列表
const comments = [
  { _id: 1, userId: '507f...011', content: 'Great!' },
  { _id: 2, userId: '507f...012', content: 'Nice!' },
  { _id: 3, userId: '507f...011', content: 'Thanks!' }  // 重复
];

// 提取唯一用户 ID
const userIds = [...new Set(comments.map(c => c.userId))];

// 批量查询用户
const users = await collection('users').findByIds(userIds, {
  projection: { name: 1, avatar: 1 }
});

// 构建用户映射
const userMap = new Map(users.map(u => [u._id.toString(), u]));

// 填充评论的用户信息
const commentsWithUser = comments.map(comment => ({
  ...comment,
  user: userMap.get(comment.userId)
}));

console.log(commentsWithUser);
```

### 场景 2：批量权限验证

检查多个用户是否有特定权限。

```javascript
async function checkUsersPermission(userIds, requiredPermission) {
  const users = await collection('users').findByIds(userIds, {
    projection: { permissions: 1, role: 1 }
  });

  const authorized = users.filter(user => 
    user.role === 'admin' || 
    user.permissions?.includes(requiredPermission)
  );

  return {
    total: userIds.length,
    authorized: authorized.length,
    authorizedIds: authorized.map(u => u._id.toString())
  };
}

// 使用
const result = await checkUsersPermission(
  ['user1', 'user2', 'user3'],
  'edit_content'
);
console.log(`${result.authorized}/${result.total} 用户有权限`);
```

### 场景 3：批量数据导出（保持顺序）

按指定顺序导出用户数据。

```javascript
async function exportUsers(orderedUserIds) {
  const users = await collection('users').findByIds(orderedUserIds, {
    projection: { password: 0, internalNotes: 0 },  // 排除敏感字段
    preserveOrder: true  // 保持导出顺序
  });

  // 转换为 CSV 格式
  const csv = users.map(user => 
    `${user._id},${user.name},${user.email},${user.role}`
  ).join('\n');

  return csv;
}

// 使用
const csvData = await exportUsers(['id1', 'id2', 'id3']);
```

### 场景 4：批量数据预加载（缓存）

预加载热门用户数据到缓存。

```javascript
async function preloadPopularUsers() {
  // 获取热门用户 ID
  const popularUserIds = await collection('stats')
    .aggregate([
      { $sort: { views: -1 } },
      { $limit: 100 },
      { $project: { userId: 1 } }
    ]);

  const ids = popularUserIds.map(s => s.userId);

  // 批量查询并缓存（1 小时）
  const users = await collection('users').findByIds(ids, {
    cache: 60 * 60 * 1000  // 1 小时
  });

  console.log(`预加载了 ${users.length} 个热门用户`);
  return users;
}
```

### 场景 5：批量好友信息查询

查询用户的所有好友信息。

```javascript
async function getUserFriends(userId) {
  // 获取用户的好友列表
  const user = await collection('users').findOne(
    { _id: new ObjectId(userId) },
    { projection: { friends: 1 } }
  );

  if (!user || !user.friends || user.friends.length === 0) {
    return [];
  }

  // 批量查询好友信息
  const friends = await collection('users').findByIds(user.friends, {
    projection: { name: 1, avatar: 1, status: 1 }
  });

  return friends;
}

// 使用
const friends = await getUserFriends('507f1f77bcf86cd799439011');
console.log(`该用户有 ${friends.length} 个好友`);
```

### 场景 6：批量通知发送

根据用户 ID 列表批量发送通知。

```javascript
async function sendBatchNotifications(userIds, notification) {
  // 批量查询用户（只需要通知设置和联系方式）
  const users = await collection('users').findByIds(userIds, {
    projection: { 
      email: 1, 
      phone: 1, 
      notificationSettings: 1 
    }
  });

  const results = {
    email: 0,
    sms: 0,
    skipped: 0
  };

  for (const user of users) {
    // 根据用户偏好发送通知
    if (user.notificationSettings?.email) {
      await sendEmail(user.email, notification);
      results.email++;
    }
    
    if (user.notificationSettings?.sms) {
      await sendSMS(user.phone, notification);
      results.sms++;
    }
    
    if (!user.notificationSettings?.email && !user.notificationSettings?.sms) {
      results.skipped++;
    }
  }

  return results;
}
```

---

## 选项参数详解

### projection - 字段投影

只返回需要的字段，减少数据传输量。

```javascript
// 只返回 name 和 email
const users = await collection('users').findByIds(userIds, {
  projection: { name: 1, email: 1 }
});

// 排除敏感字段
const users = await collection('users').findByIds(userIds, {
  projection: { password: 0, secretKey: 0 }
});
```

### sort - 排序

对结果进行排序。

```javascript
// 按名称升序
const users = await collection('users').findByIds(userIds, {
  sort: { name: 1 }
});

// 按创建时间降序
const users = await collection('users').findByIds(userIds, {
  sort: { createdAt: -1 }
});
```

### cache - 缓存

缓存查询结果，加速重复查询。

```javascript
// 缓存 5 分钟
const users = await collection('users').findByIds(userIds, {
  cache: 5 * 60 * 1000
});
```

### maxTimeMS - 查询超时

限制查询最大执行时间。

```javascript
const users = await collection('users').findByIds(userIds, {
  maxTimeMS: 5000  // 最多 5 秒
});
```

### comment - 查询注释

用于日志追踪和性能分析。

```javascript
const users = await collection('users').findByIds(userIds, {
  comment: 'CommentAPI:loadUsers:v1.2'
});
```

### preserveOrder - 保持顺序

结果顺序与输入 ids 数组一致。

```javascript
const orderedIds = ['id3', 'id1', 'id2'];
const users = await collection('users').findByIds(orderedIds, {
  preserveOrder: true
});

// users[0]._id === 'id3'
// users[1]._id === 'id1'
// users[2]._id === 'id2'
```

---

## 使用建议

`findByIds()` 会在规范化和去重输入 ID 后执行一次 `_id: { $in: ... }` 查询。实际耗时取决于 ID 数量、文档大小、projection、索引、网络、缓存配置和部署拓扑。

### 用 projection 减少返回字段

```javascript
const users = await collection('users').findByIds(ids, {
  projection: { name: 1, email: 1 }
});
```

### 对适合缓存的重复读取启用缓存

```javascript
const users = await collection('users').findByIds(hotUserIds, {
  cache: 60000  // 1 分钟
});
```

### 控制批量大小

不要把无限制的用户输入直接传进单次 `$in` 查询。应结合 payload 大小、延迟目标和 MongoDB 命令限制设置服务级批量大小。

```javascript
const batchSize = 100;
const results = [];

for (let i = 0; i < ids.length; i += batchSize) {
  const batch = await collection('users').findByIds(
    ids.slice(i, i + batchSize)
  );
  results.push(...batch);
}
```

---

## 错误处理

### 错误类型

| 错误类型 | 错误码 | 触发条件 |
|---------|--------|---------|
| **参数错误** | `INVALID_ARGUMENT` | ids 不是数组或包含无效 ID |
| **超时错误** | `QUERY_TIMEOUT` | 超过 maxTimeMS |

### 错误处理示例

```javascript
try {
  const users = await collection('users').findByIds(userIds);
  
  // 检查缺失的用户
  const foundIds = new Set(users.map(u => u._id.toString()));
  const missingIds = userIds.filter(id => !foundIds.has(id));
  
  if (missingIds.length > 0) {
    console.warn(`未找到 ${missingIds.length} 个用户:`, missingIds);
  }
} catch (error) {
  if (error.code === 'INVALID_ARGUMENT') {
    console.error('参数错误:', error.message);
  } else if (error.code === 'QUERY_TIMEOUT') {
    console.error('查询超时');
  } else {
    console.error('未知错误:', error);
  }
}
```

---

## 使用模式

### 一次查询关联文档

```javascript
const userIds = [...new Set(comments.map(c => c.userId))];
const users = await collection('users').findByIds(userIds);
```

### 交给辅助方法处理重复 ID

```javascript
const users = await collection('users').findByIds(userIds);
```

### 对完整性敏感时检查缺失文档

```javascript
const users = await collection('users').findByIds(userIds);

if (users.length < userIds.length) {
  console.warn('部分用户不存在');
}
```

---

## 与其他方法对比

### vs findOneById

| 维度 | findByIds | findOneById |
|------|-----------|-------------|
| **范围** | 多个 ID | 一个 ID |
| **查询形态** | `_id: { $in: ids }` | `_id: id` |
| **辅助行为** | 去重输入，可按输入顺序返回 | 单文档便利封装 |
| **适用场景** | 批量关联记录 | 一个已知文档 |

### vs find({ _id: { $in }})

| 维度 | findByIds | find({ _id: { $in }}) |
|------|-----------|-----------------------|
| **ObjectId 转换** | 支持 | 支持 |
| **去重** | 内置 | 需要时在调用前处理 |
| **按输入顺序返回** | `preserveOrder: true` | 需要时在查询后处理 |
| **适用场景** | 仅按 ID 批量读取的辅助方法 | 通用查询路径 |

---

## 常见问题

### Q1: findByIds 和 find 有什么区别？

**A**: `findByIds()` 是仅按 ID 批量读取时可选的便利封装。`find({ _id: { $in: ids } })` 仍是标准查询路径，并且同样支持 ObjectId 自动转换。需要内置去重和可选按输入顺序返回时，可以使用 `findByIds()`。

### Q2: 如何处理不存在的 ID？

**A**: `findByIds` 只返回存在的文档，不存在的 ID 不会返回结果。

```javascript
const users = await collection('users').findByIds([
  'existingId1',
  'nonExistentId',  // 不存在
  'existingId2'
]);
// users.length === 2（只返回存在的）
```

### Q3: 支持多少个 ID？

**A**: monSQLize 没有额外设置固定上限，但查询仍受 MongoDB 命令大小、BSON 限制和你的服务延迟目标约束。对于很大或来自用户输入的数组，应设置应用级批量大小并分批处理。

### Q4: preserveOrder 选项有性能影响吗？

**A**: 有轻微影响（需要重新排序），但通常可以忽略：
- 无 preserveOrder: O(n)
- 有 preserveOrder: O(n log n)

### Q5: 会自动去重吗？

**A**: 是。重复 ID 会在查询前去重。

```javascript
const users = await collection('users').findByIds([
  'id1', 'id1', 'id2', 'id2', 'id2'  // 重复
]);
// 实际只查询 ['id1', 'id2']（自动去重）
```

### Q6: 支持缓存吗？

**A**: 支持。结果适合缓存时可以使用 `cache` 选项。

```javascript
const users = await collection('users').findByIds(ids, {
  cache: 60000  // 缓存 1 分钟
});
```

### Q7: 性能如何？

**A**: 需要在你的环境中测量。MongoDB 默认会为 `_id` 字段创建索引，但延迟仍受 ID 数量、projection、文档大小、网络、缓存和部署拓扑影响。生产调优建议使用 MongoDB profiler、APM 或服务指标。

---

## 另请参阅

- [findOneById()](./find-one-by-id.md) - 通过 _id 查询单个文档
- [find()](./find.md) - 基础查询方法
- [findOne()](./findOne.md) - 查询单个文档
- [MongoDB 官方文档：$in 操作符](https://www.mongodb.com/docs/manual/reference/operator/query/in/)

