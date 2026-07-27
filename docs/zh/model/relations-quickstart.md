# relations 快速上手指南（5 分钟）

**前置知识**: 了解 MongoDB 基础（集合、字段、外键）

---

## ⚡ 1 分钟理解 relations

**什么是 relations？**
- 定义集合之间的关联关系
- 使用 `populate()` 自动填充关联数据
- 避免手动写多次查询和拼接代码

**核心概念**（只有 3 个）:
1. **from**: 关联的集合名称（如 `'profiles'`）
2. **localField**: 本地外键字段（如 `'profileId'`）
3. **foreignField**: 外部主键字段（通常是 `'_id'`）

**与 MongoDB $lookup 的关系**:
- relations 配置 = MongoDB `$lookup` 的简化版
- 不需要学新概念，只需懂 MongoDB

---

## ⚡ 2 分钟完成第一个示例

### Step 1: 定义关系（30 秒）

```javascript
import { Model } from 'monsqlize';

// 定义 User Model
Model.define('User', {
  schema: (s) => s({
    username: 'string!',
    email: 'email!',
    profileId: 'objectId'    // 外键
  }),
  
  relations: {
    profile: {
      from: 'profiles',      // 关联 profiles 集合
      localField: 'profileId', // User.profileId
      foreignField: '_id',   // Profile._id
      single: true           // 返回单个文档（非数组）
    }
  }
});

// 定义 Profile Model（可选，即使不定义也能 populate）
Model.define('Profile', {
  schema: (s) => s({
    bio: 'string',
    avatar: 'url'
  })
});
```

### Step 2: 使用 populate（30 秒）

```javascript
const User = msq.model('User');

// 查询用户并自动填充 profile
const user = await User.findOne({ username: 'john' })
  .populate('profile');

console.log(user);
// {
//   _id: ObjectId('...'),
//   username: 'john',
//   email: 'john@example.com',
//   profileId: ObjectId('...'),
//   profile: {              // ← 自动填充
//     _id: ObjectId('...'),
//     bio: 'Software Engineer',
//     avatar: 'https://...'
//   }
// }
```

### Step 3: 完成！

就这么简单，不需要手动写：
```javascript
// ❌ 不需要手动这样写了
const user = await User.findOne({ username: 'john' });
const profile = await Profile.findOne({ _id: user.profileId });
user.profile = profile;
```

---

## ⚡ 2 分钟掌握常见场景

### 场景 1: one-to-one（一对一）

**示例**: 一个用户有一个资料

```javascript
// 配置
relations: {
  profile: {
    from: 'profiles',
    localField: 'profileId',
    foreignField: '_id',
    single: true           // ← 返回单个文档
  }
}

// 使用
const user = await User.findOne({ _id }).populate('profile');
console.log(user.profile); // { bio: '...', avatar: '...' }
```

### 场景 2: one-to-many（一对多 - 反向）

**示例**: 一个用户有多篇文章（通过反向查询）

```javascript
// 配置
relations: {
  posts: {
    from: 'posts',
    localField: '_id',         // User._id
    foreignField: 'authorId',  // Post.authorId 指向 User._id
    single: false              // ← 返回数组（默认值）
  }
}

// 使用
const user = await User.findOne({ _id }).populate('posts');
console.log(user.posts); // [{ title: 'Post 1' }, { title: 'Post 2' }]
```

### 场景 3: 多个关系

```javascript
// 配置多个关系
relations: {
  profile: {
    from: 'profiles',
    localField: 'profileId',
    foreignField: '_id',
    single: true
  },
  posts: {
    from: 'posts',
    localField: '_id',
    foreignField: 'authorId',
    single: false
  }
}

// 链式调用 populate
const user = await User.findOne({ _id })
  .populate('profile')
  .populate('posts');

console.log(user.profile); // 单个文档
console.log(user.posts);   // 数组
```

---

## 🎯 配置字段速查

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `from` | String | ✅ | - | 关联的集合名称（复数形式，如 `'users'`） |
| `localField` | String | ✅ | - | 本地字段名（外键，如 `'userId'`） |
| `foreignField` | String | ✅ | - | 外部字段名（通常是 `'_id'`） |
| `single` | Boolean | ❌ | `false` | `true`=返回单文档，`false`=返回数组 |

---

## 💡 快速决策

### Q: 我应该用 `single: true` 还是 `single: false`？

**决策树**:

```text
你的关系是什么？
├─ 一对一（一个用户一个资料）
│  → single: true
│
├─ 一对多（一个用户多篇文章）
│  → single: false
│
└─ 不确定？
   → 用 single: false（默认，返回数组）
```

### Q: `from` 应该写什么？

**规则**: 写集合名称（复数形式）

```javascript
// ✅ 正确
from: 'users'      // 集合名
from: 'profiles'
from: 'posts'

// ❌ 错误
from: 'User'       // Model 名（不是集合名）
from: 'Profile'
```

---

## ⚠️ 3 个常见错误

### 错误 1: 用 Model 名代替集合名

```javascript
// ❌ 错误
relations: {
  profile: {
    from: 'Profile',  // Model 名
    // ...
  }
}

// ✅ 正确
relations: {
  profile: {
    from: 'profiles',  // 集合名（复数）
    // ...
  }
}
```

### 错误 2: 忘记创建索引

```javascript
// ⚠️ 性能问题：外键没有索引
relations: {
  profile: {
    from: 'profiles',
    localField: 'profileId',  // ← 这个字段需要索引！
    foreignField: '_id'
  }
}

// ✅ 解决：创建索引
Model.define('User', {
  schema: (s) => s({ profileId: 'objectId' }),
  indexes: [
    { key: { profileId: 1 } }  // ← 为外键创建索引
  ],
  relations: { /* ... */ }
});
```

### 错误 3: `single` 用反了

```javascript
// ❌ 期望返回单个文档，但用了 single: false
relations: {
  profile: {
    from: 'profiles',
    localField: 'profileId',
    foreignField: '_id',
    single: false  // ← 返回数组 [profile]，不是单文档！
  }
}

// ✅ 正确
single: true  // 返回单文档 { bio: '...' }
```

---

## 🚀 下一步

### 基础功能已掌握？查看进阶主题

- **选择字段**: `.populate('profile', { select: 'bio avatar' })`
- **排序和限制**: `.populate('posts', { sort: { createdAt: -1 }, limit: 10 })`
- **嵌套 populate**: 填充关联数据的关联数据
- **性能优化**: 启用 $lookup 聚合优化
- **缓存集成**: 关联数据也可以缓存

### 查看完整文档

- API 完整参考 - 所有配置项和选项
- 实施方案 - 技术细节（开发者）
- 最佳实践 - 性能优化建议

---

## 📚 示例代码库

### 完整示例：博客系统

```javascript
const msq = require('monsqlize');
const { Model } = msq;

// 1. Profile Model
Model.define('Profile', {
  schema: (s) => s({
    bio: 'string:0-500',
    avatar: 'url',
    location: 'string'
  })
});

// 2. Post Model
Model.define('Post', {
  schema: (s) => s({
    title: 'string:1-200!',
    content: 'string!',
    authorId: 'objectId!',
    status: 'string',
    createdAt: 'date'
  }),
  indexes: [
    { key: { authorId: 1 } }  // 外键索引
  ]
});

// 3. User Model（包含 relations）
Model.define('User', {
  schema: (s) => s({
    username: 'string:3-32!',
    email: 'email!',
    profileId: 'objectId'
  }),
  indexes: [
    { key: { profileId: 1 } }  // 外键索引
  ],
  relations: {
    // one-to-one
    profile: {
      from: 'profiles',
      localField: 'profileId',
      foreignField: '_id',
      single: true
    },
    // one-to-many（反向）
    posts: {
      from: 'posts',
      localField: '_id',
      foreignField: 'authorId',
      single: false
    }
  }
});

// 4. 使用示例
async function example() {
  const User = msq.model('User');
  
  // 查询用户 + profile + posts
  const user = await User.findOne({ username: 'john' })
    .populate('profile')
    .populate('posts');
  
  console.log(`用户: ${user.username}`);
  console.log(`简介: ${user.profile?.bio || '无'}`);
  console.log(`文章数: ${user.posts.length}`);
  
  // 输出：
  // 用户: john
  // 简介: Full-stack Developer
  // 文章数: 5
}

example();
```

**完整示例文件**: [Populate 关系可运行示例](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/populate-relations.ts)

---

## 💬 常见问题

### Q: populate 会影响性能吗？

**A**: 
- populate 会批量收集关联 id，避免常见 N+1 查询模式
- 需要完全自定义聚合管道时，直接使用 MongoDB `$lookup`
- 建议：为外键创建索引 + 启用缓存

### Q: 可以关联未定义 Model 的集合吗？

**A**: 
- 一级 populate 可以。`from` 可以直接指定 MongoDB 集合名，不强制依赖同名 Model。
- 如果还要对关联结果继续 nested populate，或需要关联集合自己的 schema、hooks、virtuals，请为该集合定义 Model。

### Q: 如何处理循环引用？

**A**: 
- 系统会自动检测循环引用并阻止无限递归
- nested populate 支持深度控制；复杂关系图建议保持浅层，并为深层分支设置明确限制。

### Q: 与 MongoDB $lookup 的区别？

**A**: 
- relations 是 $lookup 的简化版
- populate 可以批量收集关联 id，避免常见 N+1 查询模式
- 需要完全自定义聚合管道时，直接使用 MongoDB `$lookup`

---

## 下一步

你已经掌握了 relations 的核心路径：
- `from`、`localField`、`foreignField`、`single` 四个关键字段
- one-to-one 与 one-to-many 两类常见关系
- 集合名、索引和 `single` 配置的常见错误

接下来可以参考完整示例文件，把 relations 接入到自己的业务 Model。

**需要帮助？**
- 查看 API 完整参考
- 提交 Issue: https://github.com/devcodex-labs/monSQLize/issues
