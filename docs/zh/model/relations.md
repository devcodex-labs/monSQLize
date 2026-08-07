# Relations 和 Populate API 文档

Model 层提供 relations 和 populate 功能，让你轻松处理集合之间的关联关系。

本页 Model schema 示例使用 monSQLize 传入的 runtime 作用域 `s` 命名空间。应用代码不需要为了这些示例导入 root `schema-dsl` 入口。

---

## 快速开始

### 1分钟上手

```javascript
// 1. 定义关系
Model.define('users', {
    schema: (s) => s({
        username: 'string!',
        profileId: 'objectId'
    }),
    relations: {
        profile: {
            from: 'profiles',         // 集合名
            localField: 'profileId',  // 本地字段
            foreignField: '_id',      // 外部字段
            single: true              // 返回类型
        }
    }
});

// 2. 使用 populate
const user = await User.findOne({ username: 'john' }).populate('profile');

// 3. 结果
{
    _id: '...',
    username: 'john',
    profileId: '...',
    profile: {              // ← 自动填充
        _id: '...',
        bio: 'Software Engineer',
        avatar: 'https://example.com/avatar.jpg'
    }
}
```

---

## 核心特性

- ✅ **极简配置** - 只需 4 个字段定义关系
- ✅ **接近 MongoDB 原生** - 直接对应 `$lookup` 操作
- ✅ **链式调用** - 支持 `.populate().populate()` 链式语法
- ✅ **批量优化** - 使用 `$in` 避免 N+1 查询问题
- ✅ **丰富选项** - 支持 select/sort/limit/skip/match

---

## 关系类型

### one-to-one（一对一）

**场景**: 用户 → 个人资料

```javascript
Model.define('users', {
    schema: (s) => s({
        username: 'string!',
        profileId: 'objectId'
    }),
    relations: {
        profile: {
            from: 'profiles',
            localField: 'profileId',  // users.profileId
            foreignField: '_id',       // profiles._id
            single: true               // 返回单个文档或 null
        }
    }
});

// 使用
const user = await User.findOne({ _id }).populate('profile');

// 结果
{
    _id: '...',
    username: 'john',
    profileId: 'p1',
    profile: {              // 单个对象或 null
        _id: 'p1',
        bio: 'Software Engineer',
        avatar: 'https://...'
    }
}
```

### one-to-many（一对多）

**场景**: 用户 → 文章列表

```javascript
Model.define('users', {
    schema: (s) => s({
        username: 'string!'
    }),
    relations: {
        posts: {
            from: 'posts',
            localField: '_id',         // users._id
            foreignField: 'authorId',  // posts.authorId
            single: false              // 返回数组
        }
    }
});

// 使用
const user = await User.findOne({ _id }).populate('posts');

// 结果
{
    _id: '...',
    username: 'john',
    posts: [                // 数组或 []
        { _id: 'post1', title: 'Post 1', authorId: '...' },
        { _id: 'post2', title: 'Post 2', authorId: '...' }
    ]
}
```

### many-to-one（多对一）

**场景**: 文章 → 作者

```javascript
Model.define('posts', {
    schema: (s) => s({
        title: 'string!',
        authorId: 'objectId'
    }),
    relations: {
        author: {
            from: 'users',
            localField: 'authorId',
            foreignField: '_id',
            single: true
        }
    }
});

// 使用
const post = await Post.findOne({ _id }).populate('author');

// 结果
{
    _id: '...',
    title: 'My Post',
    authorId: 'u1',
    author: {               // 单个对象或 null
        _id: 'u1',
        username: 'john',
        email: 'john@example.com'
    }
}
```

---

## Populate 选项

### select - 选择字段

```javascript
// 只返回指定字段（_id 总是包含）
await User.find().populate('profile', { select: 'bio avatar' });

// 结果
user.profile = {
    _id: '...',      // 自动包含
    bio: '...',      // 选择的字段
    avatar: '...'    // 选择的字段
    // location 不返回
};
```

关系定义也可以提供默认字段选择：

```ts
relations: {
  profile: {
    from: 'profiles',
    localField: 'profileId',
    foreignField: '_id',
    single: true,
    select: 'bio avatar',
  },
}
```

调用级 `select` 会覆盖关系默认值。P0 的字段选择只接受非空的顶层包含字段（`'bio avatar'` 或 `['bio', 'avatar']`）；排除式字段、`+`/`-` 前缀和点路径会抛出 `INVALID_RELATION_SELECT`。`_id` 仍会保留。关联查询会把投影下推到 MongoDB；为匹配或嵌套 populate 临时保留的 join key，除非被显式选择，否则会在填充结果返回前移除。

### 本地 ID 数组

`localField` 可以保存 ID 数组，例如 `tagIds: ['tag-b', 'tag-a', 'tag-b']`。Populate 会在一次查询中读取去重后的非空 ID，并返回 `['tag-b', 'tag-a']` 对应的目标；未知 ID 会被忽略。没有 `sort` 时保留本地 ID 顺序；设置 `sort` 后，匹配到的关联文档按指定排序返回。

### sort - 排序

```javascript
// 按 createdAt 倒序排序
await User.find().populate('posts', { sort: { createdAt: -1 } });

// 多字段排序
await User.find().populate('posts', { 
    sort: { category: 1, createdAt: -1 } 
});
```

### limit - 限制数量

```javascript
// 只返回最新的 5 篇文章
await User.find().populate('posts', { 
    limit: 5,
    sort: { createdAt: -1 }
});
```

### skip - 跳过

```javascript
// 分页：跳过前 10 个，返回接下来的 10 个
await User.find().populate('posts', { 
    skip: 10,
    limit: 10,
    sort: { createdAt: -1 }
});
```

### match - 额外查询条件

```javascript
// 只返回已发布的文章
await User.find().populate('posts', { 
    match: { status: 'published' },
    sort: { createdAt: -1 }
});
```

### 组合使用

```javascript
await User.find().populate('posts', {
    select: 'title content status',
    match: { status: 'published' },
    sort: { createdAt: -1 },
    limit: 10
});
```

---

## 高级用法

### 链式 populate

```javascript
// 一次填充多个关系
const user = await User.findOne({ _id })
    .populate('profile')
    .populate('posts')
    .populate('comments');

// 结果
{
    _id: '...',
    username: 'john',
    profile: { bio: '...', avatar: '...' },
    posts: [{ title: '...', content: '...' }, ...],
    comments: [{ text: '...', postId: '...' }, ...]
}
```

### 批量查询 + populate

```javascript
// find 返回数组，每个文档都会填充关系
const users = await User.find({ active: true })
    .populate('profile')
    .populate('posts', { limit: 5 });

// 结果
[
    {
        _id: '...',
        username: 'john',
        profile: {...},
        posts: [...]
    },
    {
        _id: '...',
        username: 'jane',
        profile: {...},
        posts: [...]
    }
]
```

### 动态关系（数组形式）

```javascript
// 根据条件选择要填充的关系
const relations = ['profile'];
if (includePosts) relations.push('posts');

const user = await User.findOne({ _id }).populate(relations);
```

### 对象形式（完整配置）

```javascript
await User.find().populate({
    path: 'posts',
    select: 'title content',
    match: { status: 'published' },
    sort: { createdAt: -1 },
    limit: 10,
    skip: 0
});
```

---

## 性能优化

### 自动批量查询

```javascript
// monSQLize 自动使用 $in 批量查询，避免 N+1 问题

// 查询 100 个用户并填充 profile
const users = await User.find({ active: true }).populate('profile');

// 实际执行的查询（自动优化）：
// 1. 查询 100 个用户: db.users.find({ active: true })
// 2. 收集所有 profileId: [id1, id2, id3, ...]
// 3. 批量查询 profiles: db.profiles.find({ _id: { $in: [id1, id2, ...] } })
// 4. 填充到每个用户
// 总查询次数：2 次（而不是 101 次）
```

### 索引建议

```javascript
// 为外键字段创建索引，提升 populate 性能

Model.define('users', {
    schema: (s) => s({
        username: 'string!',
        profileId: 'objectId'
    }),
    indexes: [
        { key: { profileId: 1 } }  // ← 外键索引
    ],
    relations: {
        profile: {
            from: 'profiles',
            localField: 'profileId',
            foreignField: '_id',
            single: true
        }
    }
});

// profiles 集合的 _id 字段默认有索引
```

### 性能对比

| 场景 | 查询次数 | 性能 |
|------|---------|------|
| 不使用 populate | 1 次 | 最快 |
| populate（N 个文档） | 2 次 | 快（使用 $in） |
| 循环查询（N 次） | N+1 次 | 慢（N+1 问题） |

---

## 边缘情况处理

### 外键为 null

```javascript
// 用户没有 profileId
const user = await User.findOne({ _id }).populate('profile');

// single: true - 返回 null
user.profile === null

// single: false - 返回空数组
user.posts === []
```

### 找不到关联数据

```javascript
// profileId 存在，但 profiles 集合中没有对应文档
const user = await User.findOne({ _id }).populate('profile');

// single: true - 返回 null
user.profile === null

// single: false - 返回空数组
user.posts === []
```

### 外键数组

```javascript
// 如果需要外键数组，使用反向关系（one-to-many）
// 不推荐：user.tagIds = [id1, id2, id3]
// 推荐：tags.userId = userId（在 tags 中存储 userId）

relations: {
    tags: {
        from: 'tags',
        localField: '_id',
        foreignField: 'userId',  // tags 中存储 userId
        single: false
    }
}
```

---

## 与 Mongoose 的对比

| 特性 | Mongoose | monSQLize |
|------|----------|-----------|
| **配置方式** | `ref: 'ModelName'` | `from: 'collectionName'` |
| **学习成本** | 需要学习 Schema/Model 概念 | 只需懂 MongoDB $lookup |
| **灵活性** | 必须定义 Model | 可关联任何集合 |
| **性能** | 抽象层开销 | 可直接优化为 $lookup |
| **使用方式** | `.populate('path')` | `.populate('path')` |

**为什么选择 `from` 而不是 `ref`？**

1. **接近 MongoDB 原生** - `from` 是 `$lookup` 的原生字段
2. **更灵活** - 不依赖 Model 是否定义，可关联任何集合
3. **更直观** - `from: 'profiles'` 清楚知道查询 profiles 集合

---

## 完整示例

```javascript
import MonSQLize from 'monsqlize';
const { Model } = MonSQLize;

// 定义 User Model
Model.define('users', {
    schema: (s) => s({
        username: 'string:3-32!',
        email: 'email!',
        profileId: 'objectId',
        createdAt: 'date'
    }),
    indexes: [
        { key: { username: 1 }, unique: true },
        { key: { profileId: 1 } }
    ],
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
});

// 定义 Post Model
Model.define('posts', {
    schema: (s) => s({
        title: 'string!',
        content: 'string!',
        authorId: 'objectId!',
        status: ['draft', 'published'],
        createdAt: 'date'
    }),
    indexes: [
        { key: { authorId: 1 } },
        { key: { status: 1, createdAt: -1 } }
    ],
    relations: {
        author: {
            from: 'users',
            localField: 'authorId',
            foreignField: '_id',
            single: true
        }
    }
});

// 使用
const msq = new MonSQLize({
    type: 'mongodb',
    config: { url: 'mongodb://localhost:27017/mydb' }
});
await msq.connect();

const User = msq.model('users');
const Post = msq.model('posts');

// 查询用户并填充关系
const user = await User.findOne({ username: 'john' })
    .populate('profile')
    .populate('posts', {
        select: 'title status createdAt',
        match: { status: 'published' },
        sort: { createdAt: -1 },
        limit: 10
    });

console.log(user);
// {
//     _id: '...',
//     username: 'john',
//     email: 'john@example.com',
//     profileId: '...',
//     profile: {
//         _id: '...',
//         bio: 'Software Engineer',
//         avatar: 'https://...'
//     },
//     posts: [
//         { _id: '...', title: 'Post 1', status: 'published', createdAt: ... },
//         { _id: '...', title: 'Post 2', status: 'published', createdAt: ... }
//     ]
// }

// 查询文章并填充作者
const post = await Post.findOne({ _id: postId }).populate('author', {
    select: 'username email'
});

console.log(post);
// {
//     _id: '...',
//     title: 'My Post',
//     content: '...',
//     authorId: '...',
//     author: {
//         _id: '...',
//         username: 'john',
//         email: 'john@example.com'
//     }
// }
```

---

## 常见问题

**Q: populate 会执行多少次查询？**  
A: 对于 N 个文档 + 1 个关系，执行 2 次查询：
1. 查询主文档（N 个）
2. 批量查询关联文档（使用 `$in`，1 次）

**Q: 如何实现嵌套 populate？**  
A: 当前版本已支持嵌套 populate，推荐使用对象配置来表达下一层关系：

```javascript
const user = await User.findOne({ username: 'john' })
    .populate({ path: 'posts', populate: 'comments' });
```

**Q: populate 会影响性能吗？**  
A: 使用 `$in` 批量查询，性能影响较小。建议：
1. 为外键字段创建索引
2. 使用 `select` 只返回需要的字段
3. 使用 `limit` 限制关联数据数量

**Q: 如何实现 many-to-many？**  
A: 需要额外字段或多对多归属时，使用中间集合建模：
```javascript
// users ←→ user_roles ←→ roles
Model.define('users', {
    relations: {
        userRoles: {
            from: 'user_roles',
            localField: '_id',
            foreignField: 'userId',
            single: false,
        },
    },
});
Model.define('user_roles', {
    relations: {
        role: { from: 'roles', localField: 'roleId', foreignField: '_id', single: true },
    },
});

const user = await User.findOne({ _id }).populate({ path: 'userRoles', populate: 'role' });
// user.userRoles 保留中间表字段，user.userRoles[n].role 为关联角色
```

**Q: populate 支持哪些选项？**  
A: 支持以下选项：
- `select` - 字段选择
- `sort` - 排序
- `limit` - 限制数量
- `skip` - 跳过
- `match` - 额外查询条件

**Q: 为什么我的 populate 返回 null？**  
A: 可能的原因：
1. 外键字段值为 null/undefined
2. 关联集合中没有匹配的文档
3. `foreignField` 字段值不匹配

**Q: 如何调试 populate？**  
A: 
```javascript
// 1. 检查关系定义
console.log(User.getRelations().profile);

// 2. 检查外键值
const user = await User.findOne({ _id });
console.log('profileId:', user.profileId);

// 3. 手动查询关联文档
const profile = await msq.collection('profiles').findOne({ _id: user.profileId });
console.log('profile:', profile);
```

---

## 支持 populate 的查询方法

monSQLize 的 6 个查询方法都支持 populate：

### 1. find() + populate

批量查询，返回文档数组。

```javascript
const users = await User.find({ active: true }).populate('profile');

// 结果: [{ _id, username, profile: {...} }, ...]
```

### 2. findOne() + populate

单文档查询，返回单个文档或 null。

```javascript
const user = await User.findOne({ username: 'john' }).populate('profile');

// 结果: { _id, username, profile: {...} } 或 null
```

### 3. findByIds() + populate

批量 ID 查询，返回文档数组。

```javascript
const users = await User.findByIds([id1, id2, id3]).populate('profile');

// 结果: [{ _id, username, profile: {...} }, ...]
```

### 4. findOneById() + populate

单 ID 查询，返回单个文档或 null。

```javascript
const user = await User.findOneById(id).populate('profile');

// 结果: { _id, username, profile: {...} } 或 null
```

### 5. findAndCount() + populate

带计数的查询，返回 `{ data, total }` 结构。

```javascript
const result = await User.findAndCount({ 
  filter: { active: true },
  limit: 10
}).populate('profile');

// 结果: { data: [...], total: 100 }
// data 中的每个文档都会被 populate
```

### 6. findPage() + populate

分页查询，返回完整的分页结构。

```javascript
const page = await User.findPage({ 
  page: 1, 
  pageSize: 10 
}).populate('profile');

// 结果: { 
//   data: [...],           // 填充后的文档
//   page: 1, 
//   pageSize: 10, 
//   total: 100, 
//   hasNext: true 
// }
```

**特殊说明**:
- `findAndCount` 和 `findPage` 只对 `data` 部分进行 populate
- 其他字段（`total`, `page`, `pageSize`, `hasNext`）保持不变
- 所有方法都支持链式 populate

---

## API 参考

### Model.define() relations 配置

```typescript
relations: {
    [relationName: string]: {
        from: string;           // 关联的集合名（必需）
        localField: string;     // 本地字段名（必需）
        foreignField: string;   // 外部字段名（必需）
        single?: boolean;       // 是否返回单个文档，默认 false
    }
}
```

### .populate() 方法

```typescript
// 字符串形式
.populate(path: string)
.populate(path: string, options: PopulateOptions)

// 数组形式
.populate(paths: string[])

// 对象形式
.populate(config: {
    path: string;
    select?: string;
    sort?: object;
    limit?: number;
    skip?: number;
    match?: object;
})
```

### PopulateOptions

```typescript
interface PopulateOptions {
    select?: string;    // 字段选择，空格分隔
    sort?: object;      // 排序规则
    limit?: number;     // 限制数量
    skip?: number;      // 跳过数量
    match?: object;     // 额外查询条件
}
```

---

## 更多资源

- [Model API 文档](../model.md)
- [示例代码](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/populate-relations.ts)
- [GitHub Issues](https://github.com/devcodex-labs/monSQLize/issues)

