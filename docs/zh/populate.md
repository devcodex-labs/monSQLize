# Populate API - 关联查询

传入非空 `sort` 时，关联记录按父文档逐个顺序查询，由 MongoDB 执行排序，遵从原生 null/missing、BSON、数组及关联集合的 collation 规则。`skip`、`limit` 应用于每个父文档的关联查询。这会比批读增加数据库查询次数。父查询的 collation 不会自动复制到关联读取。

无排序且无窗口时，ObjectId 等无歧义标量关联保持每批最多 200 个去重 key 的批读。字符串表示相同但 BSON 类型不同的 key（例如 `1` 和 `'1'`）及复杂对象 key，保留原始值交给 MongoDB 逐父匹配，仍遵从既有 ObjectId 转换配置；此路径可能增加到每父一条关联查询。

其他字符串 key 批次中，每次 populate 读取一次实际目标库/池中关联集合的默认 collation；确认二进制规则后批读，其他规则交给 MongoDB 逐父查询以保留等值语义。元数据无权限、不可用或未知时也逐父查询，不要求额外授权才能返回正确匹配，不长期缓存该信息。此路径会增加一次元数据请求及最多每父一条关联查询。

**功能**: Model层关联查询，支持6个方法（）

---

## 📖 概述

Populate 是 Model 层用于加载 `relations` 中声明的关联文档的能力。

本页 Model schema 示例使用 monSQLize 传入的 runtime 作用域 `s` 命名空间。应用代码不需要为了这些示例导入 root `schema-dsl` 入口。

### 核心特性

- ✅ **6个方法支持** - find/findOne/findByIds/findOneById/findAndCount/findPage（）
- ✅ **链式API** - 支持多个 populate 链式调用
- ✅ **智能缓存** - 关联查询结果可使用配置的缓存；效果取决于命中率、后端和负载
- ✅ **字段选择** - 只返回需要的字段，减少数据传输
- ✅ **排序限制** - 支持 sort 和 limit 控制关联数据
- ✅ **自动注入** - 结果自动注入到文档对象

---

## 🚀 快速开始

### 1. 定义关系

首先在 Model 定义中配置 relations：

```javascript
import { Model } from 'monsqlize';

// 定义 User Model
Model.define('users', {
    schema: (s) => s({
        username: 'string!',
        email: 'email!'
    }),
    relations: {
        // hasMany: 一对多
        posts: {
            from: 'posts',
            localField: '_id',
            foreignField: 'userId',
            single: false
        },
        // hasOne: 一对一
        profile: {
            from: 'profiles',
            localField: '_id',
            foreignField: 'userId',
            single: true
        }
    }
});

// 定义 Post Model
Model.define('posts', {
    schema: (s) => s({
        title: 'string!',
        content: 'string!'
    }),
    relations: {
        // belongsTo: 多对一
        author: {
            from: 'users',
            localField: 'userId',
            foreignField: '_id',
            single: true
        }
    }
});
```

### 2. 使用 populate

```javascript
const msq = new MonSQLize({ ... });
await msq.connect();

const User = msq.model('users');

// 基础 populate
const users = await User.find({ age: { $gte: 18 } })
    .populate('posts');

console.log(users[0].posts);  // [{ title: '...', content: '...' }, ...]
```

### 3. 多个 populate

```javascript
// 链式调用多个 populate
const users = await User.find()
    .populate('posts')
    .populate('profile');

// users[0].posts = [...]
// users[0].profile = { avatar: '...', bio: '...' }
```

### 4. 选项配置

```javascript
// 带选项的 populate
const users = await User.find()
    .populate('posts', {
        select: ['title', 'createdAt'],  // 只返回这些字段
        limit: 10,                        // 最多10条
        sort: { createdAt: -1 }          // 按创建时间倒序
    })
    .populate('profile', {
        select: ['avatar', 'bio']
    });
```

---

## 📚 支持的查询方法

monSQLize 支持 **6个查询方法** 的 populate，：

| 方法 | 返回类型 | Populate支持 | 说明 |
|------|---------|-------------|------|
| `find()` | Array | ✅ | 查询多个文档 |
| `findOne()` | Object/null | ✅ | 查询单个文档 |
| `findByIds()` | Array | ✅ | 批量ID查询 |
| `findOneById()` | Object/null | ✅ | ID查询单个 |
| `findAndCount()` | Object | ✅ | 查询+计数 |
| `findPage()` | Object | ✅ | 分页查询 |

### 示例

```javascript
// find + populate
const users = await User.find().populate('posts');

// findOne + populate
const user = await User.findOne({ username: 'john' }).populate('profile');

// findByIds + populate
const users = await User.findByIds([id1, id2, id3]).populate('posts');

// findOneById + populate
const user = await User.findOneById(userId).populate('posts');

// findAndCount + populate
const result = await User.findAndCount({ age: { $gte: 18 } }).populate('posts');
// result.data[0].posts = [...]

// findPage + populate
const result = await User.findPage({ limit: 10 }).populate('posts');
// result.items[0].posts = [...]
```

---

## 🎯 API 参考

### .populate(path, options?)

添加关联查询到查询链。

**参数**:
- `path` (String) - 关系路径，必须在 Model 的 relations 中定义
- `options` (Object, 可选) - Populate 选项

**返回**: PopulateProxy 对象（支持链式调用和 Promise）

**选项**:

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `select` | String[] | 全部字段 | 选择返回的字段 |
| `limit` | Number | 无限制 | 限制返回的数量（hasMany） |
| `sort` | Object | 无排序 | 排序规则 |
| `cache` | Number | 继承主查询 | 缓存时间（毫秒） |

**示例**:

```javascript
// 完整选项
const users = await User.find()
    .populate('posts', {
        select: ['title', 'createdAt'],
        limit: 5,
        sort: { createdAt: -1 },
        cache: 60000
    });
```

---

## 💡 使用场景

### 场景1: 用户-文章 (hasMany)

```javascript
// 定义
Model.define('users', {
    schema: (s) => s({ username: 'string!' }),
    relations: {
        posts: {
            from: 'posts',
            localField: '_id',
            foreignField: 'userId',
            single: false  // hasMany
        }
    }
});

// 使用
const users = await User.find()
    .populate('posts', { limit: 10 });

users.forEach(user => {
    console.log(`${user.username} 有 ${user.posts.length} 篇文章`);
});
```

### 场景2: 文章-作者 (belongsTo)

```javascript
// 定义
Model.define('posts', {
    schema: (s) => s({ title: 'string!' }),
    relations: {
        author: {
            from: 'users',
            localField: 'userId',
            foreignField: '_id',
            single: true  // belongsTo (hasOne)
        }
    }
});

// 使用
const posts = await Post.find()
    .populate('author', { select: ['username', 'avatar'] });

posts.forEach(post => {
    console.log(`${post.title} 作者: ${post.author.username}`);
});
```

### 场景3: 用户-资料 (hasOne)

```javascript
// 定义
Model.define('users', {
    schema: (s) => s({ username: 'string!' }),
    relations: {
        profile: {
            from: 'profiles',
            localField: '_id',
            foreignField: 'userId',
            single: true  // hasOne
        }
    }
});

// 使用
const user = await User.findOne({ username: 'john' })
    .populate('profile');

console.log(user.profile.bio);
```

### 场景4: 多对多（通过中间表）

```javascript
// 定义学生
Model.define('students', {
    schema: (s) => s({ name: 'string!' }),
    relations: {
        enrollments: {
            from: 'student_course',
            localField: '_id',
            foreignField: 'studentId',
            single: false
        }
    }
});

// 定义中间表
Model.define('student_course', {
    schema: (s) => s({
        studentId: 'objectId!',
        courseId: 'objectId!'
    }),
    relations: {
        course: {
            from: 'courses',
            localField: 'courseId',
            foreignField: '_id',
            single: true
        }
    }
});

// 使用（需要两次 populate）
const students = await Student.find()
    .populate('enrollments');

// 更深层路径请使用 nested populate 配置。
for (const student of students) {
    const courseIds = student.enrollments.map(e => e.courseId);
    const courses = await Course.findByIds(courseIds);
    student.courses = courses;
}
```

---

## ⚡ 性能优化

### N+1 问题解决

**❌ 传统方式（N+1问题）**:

```javascript
// 查询用户：1次
const users = await User.find();

// 为每个用户查询文章：N次
for (const user of users) {
    user.posts = await Post.find({ userId: user._id });
}

// 总查询次数：1 + N次（100个用户 = 101次查询）
```

**✅ monSQLize Populate（批量查询）**:

以下两次查询示例假定非字符串关联 key、无排序/窗口、去重 key 不超过 200；字符串关联可能另读元数据或逐父查询，见页首。

```javascript
// 只需要2次查询
const users = await User.find().populate('posts');

// 第1次：查询用户
// 第2次：批量查询所有用户的文章（WHERE userId IN [...]）
// 对此单层关系总计 2 次查询，而不是每个用户再查询一次关联数据。
```

### 智能缓存

**Populate + 缓存**：

```javascript
// 第一次查询
const users = await User.find({}, { cache: 60000 }).populate('posts');
// 2次数据库查询（用户+文章）

// 后续查询（60秒内）
const users2 = await User.find({}, { cache: 60000 }).populate('posts');
// 所需条目全部有效命中缓存时，不再查询数据库。
```

**性能特征**：

| 方式 | 单个单层关系的查询形态 | 主要变量 |
|------|-------|---------|
| N+1 查询 | 一次主查询，加上每个父文档一次关联查询 | 父文档数量、网络延迟、连接池竞争 |
| Populate | 二进制匹配且无排序/窗口时批读；字符串非二进制或元数据未知时逐父查询 | collation、关系基数、`$in` 大小、索引、选择字段 |
| Populate 有效缓存命中 | 缓存读取可替代部分或全部数据库查询 | 缓存层级、序列化、负载大小、命中率、失效策略 |

查询次数减少是结构特征，延迟仍取决于工作负载。请按[性能证据契约](./performance-evidence.md)测量。

### 缓存策略

```javascript
// 主查询和 populate 使用相同缓存时间
const users = await User.find({}, { cache: 60000 }).populate('posts');

// 主查询和 populate 使用不同缓存时间
const users = await User.find({}, { cache: 60000 })
    .populate('posts', { cache: 300000 });  // 文章缓存5分钟

// 只缓存 populate，不缓存主查询
const users = await User.find()
    .populate('posts', { cache: 60000 });
```

---

## 🆚 与 Mongoose 对比

### 支持方法数对比

| 特性 | monSQLize | Mongoose | 优势 |
|------|-----------|----------|------|
| **支持方法** | **6个** | 仅 find | ✅ **** |
| findOne populate | ✅ | ❌ 需手动 | ✅ 开箱即用 |
| findPage populate | ✅ | ❌ | ✅ 独家功能 |
| findByIds populate | ✅ | ❌ | ✅ 批量查询 |
| 链式API | ✅ | ✅ | 同等 |
| 字段选择 | ✅ | ✅ | 同等 |
| **智能缓存** | **✅ 内置** | **❌ 需自己实现** | 取决于负载；需测量命中率与时延 |

### 性能测量示例

```javascript
// Mongoose
const users = await User.find().populate('posts');
const users2 = await User.find().populate('posts'); // 应用未添加缓存时再次查询。

// monSQLize
const users = await User.find({}, { cache: 60000 }).populate('posts');  // 此 key 的冷路径。
const users2 = await User.find({}, { cache: 60000 }).populate('posts'); // 可能的热缓存路径。
```

应对相同数据集记录冷、热路径分布，不能从此控制流示例推导固定倍率；参见[性能证据](./performance-evidence.md)。

### API 对比

```javascript
// Mongoose
User.find()
    .populate('posts')
    .populate({ path: 'profile', select: 'avatar bio' });

// monSQLize（更简洁）
User.find()
    .populate('posts')
    .populate('profile', { select: ['avatar', 'bio'] });
```

---

## ❓ 常见问题

### Q1: populate 后能不能缓存？

**A**: ✅ 可以！这是 monSQLize 的独家优势。

```javascript
// populate 结果会被缓存
const users = await User.find({}, { cache: 60000 }).populate('posts');

// 后续查询直接从缓存读取，包括 populate 的数据
const users2 = await User.find({}, { cache: 60000 }).populate('posts');
// 非字符串 key 完整有效命中时可不查数据库；字符串 key 仍读取元数据。
```

### Q2: 如何避免 N+1 问题？

**A**: 二进制批读关系避免逐父查询；排序、窗口及字符串非二进制/未知规则按页首说明使用原生查询路径。

无排序/窗口且使用 ObjectId 等非字符串 key 的 populate 使用批量查询；字符串规则与回退查询次数见页首：
```javascript
// 自动转换为 WHERE userId IN [id1, id2, id3, ...]
const users = await User.find().populate('posts');
// 只需要2次查询（用户 + 批量查询文章）
```

### Q3: 能不能嵌套 populate？

**A**: 当前版本已支持嵌套 populate，可直接在 populate 配置中声明下一层关系。

```javascript
const students = await Student.find()
    .populate({ path: 'enrollments', populate: 'course' });
```

### Q4: populate 会影响性能吗？

**A**: 不会，反而性能更好。

- ✅ 批量查询（避免 N+1）
- ✅ 智能缓存（对目标负载测量命中率、后端时延和失效成本）
- ✅ 字段选择（减少数据传输）

### Q5: 关系定义后必须 populate 吗？

**A**: 不是，populate 是可选的。

```javascript
// 不 populate，只查询用户
const users = await User.find();
// users[0].posts = undefined

// populate 后才有关联数据
const users = await User.find().populate('posts');
// users[0].posts = [...]
```

### Q6: populate 支持条件过滤吗？

**A**: 支持。使用 `match`、`limit` 等选项即可约束被填充的数据。

```javascript
const users = await User.find()
    .populate('posts', {
        match: { status: 'published' },  // 只 populate 已发布的文章
        limit: 10
    });
```

---

## 📝 完整示例

### 博客系统示例

```javascript
import MonSQLize from 'monsqlize';
const { Model } = MonSQLize;

// 1. 定义 Models
Model.define('users', {
    schema: (s) => s({
        username: 'string:3-32!',
        email: 'email!',
        avatar: 'url'
    }),
    relations: {
        posts: {
            from: 'posts',
            localField: '_id',
            foreignField: 'authorId',
            single: false
        },
        profile: {
            from: 'profiles',
            localField: '_id',
            foreignField: 'userId',
            single: true
        }
    }
});

Model.define('posts', {
    schema: (s) => s({
        title: 'string!',
        content: 'string!',
        status: 'string'
    }),
    relations: {
        author: {
            from: 'users',
            localField: 'authorId',
            foreignField: '_id',
            single: true
        },
        comments: {
            from: 'comments',
            localField: '_id',
            foreignField: 'postId',
            single: false
        }
    }
});

Model.define('comments', {
    schema: (s) => s({
        content: 'string!',
        postId: 'objectId!',
        userId: 'objectId!'
    }),
    relations: {
        user: {
            from: 'users',
            localField: 'userId',
            foreignField: '_id',
            single: true
        }
    }
});

Model.define('profiles', {
    schema: (s) => s({
        bio: 'string',
        website: 'url',
        userId: 'objectId!'
    })
});

// 2. 连接数据库
const msq = new MonSQLize({
    type: 'mongodb',
    config: { uri: 'mongodb://localhost:27017/blog' },
    cache: { ttl: 60000, max: 1000 }  // 启用缓存
});

await msq.connect();

const User = msq.model('users');
const Post = msq.model('posts');
const Comment = msq.model('comments');

// 3. 使用场景

// 场景A: 获取用户及其文章
const users = await User.find({}, { cache: 60000 })
    .populate('posts', {
        select: ['title', 'createdAt', 'status'],
        limit: 5,
        sort: { createdAt: -1 }
    })
    .populate('profile');

console.log('用户列表:');
users.forEach(user => {
    console.log(`- ${user.username}`);
    console.log(`  简介: ${user.profile?.bio || '无'}`);
    console.log(`  文章数: ${user.posts.length}`);
    user.posts.forEach(post => {
        console.log(`    - ${post.title}`);
    });
});

// 场景B: 获取文章及作者和评论
const posts = await Post.find(
    { status: 'published' },
    { cache: 60000 }
).populate('author', {
    select: ['username', 'avatar']
}).populate('comments', {
    limit: 10
});

console.log('\n文章列表:');
posts.forEach(post => {
    console.log(`- ${post.title}`);
    console.log(`  作者: ${post.author.username}`);
    console.log(`  评论数: ${post.comments.length}`);
});

// 场景C: 分页查询用户
const result = await User.findPage({
    limit: 10,
    page: 1
}).populate('posts', { limit: 3 });

console.log(`\n总用户数: ${result.pageInfo.totalCount}`);
console.log(`当前页: ${result.pageInfo.currentPage}/${result.pageInfo.totalPages}`);
result.items.forEach(user => {
    console.log(`- ${user.username}: ${user.posts.length} 篇最新文章`);
});
```

---

## 🔗 相关文档

- [Relations API](./relations.md) - 关系定义详解
- [Model API](./model.md) - Model 层完整文档
- [Cache API](./cache.md) - 缓存配置
- [FindPage API](./findPage.md) - 分页查询

---

## 📌 最佳实践

### 1. 合理使用字段选择

```javascript
// ❌ 不好：返回所有字段（浪费带宽）
const users = await User.find().populate('posts');

// ✅ 好：只返回需要的字段
const users = await User.find().populate('posts', {
    select: ['title', 'createdAt']
});
```

### 2. 限制关联数据数量

```javascript
// ❌ 不好：可能返回数千条评论
const posts = await Post.find().populate('comments');

// ✅ 好：限制数量
const posts = await Post.find().populate('comments', {
    limit: 10,
    sort: { createdAt: -1 }
});
```

### 3. 启用智能缓存

```javascript
// ❌ 不好：每次都查询数据库
const users = await User.find().populate('posts');

// ✅ 好：启用缓存（适合读多写少的数据）
const users = await User.find({}, { cache: 60000 }).populate('posts');
```

### 4. 按需 populate

```javascript
// ❌ 不好：总是 populate（即使不需要）
const users = await User.find()
    .populate('posts')
    .populate('profile')
    .populate('comments');

// ✅ 好：只 populate 需要的关系
const users = await User.find()
    .populate('profile');  // 只需要资料
```

