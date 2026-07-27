# Model API 文档

Model 层在 MongoDB runtime 之上提供 schema 校验、自定义方法、生命周期钩子、relations 和 Model 作用域写入能力。它不会隐藏 collection 访问，而是把重复的文档工作流收口到稳定的 Model 表面。

**特性**：Schema 验证 · 自定义方法 · 生命周期钩子 · 自动索引 · 数据源绑定

---

## 快速开始

```javascript
import MonSQLize from 'monsqlize';
const { Model } = MonSQLize;

// 1. 定义 Model
Model.define('users', {
    schema: (s) => s({
        username: 'string:3-32!',
        email: 'email!',
        password: 'string!',
        age: 'number:0-120'
    }),
    methods: (model) => ({
        instance: {
            checkPassword(password) {
                return this.password === password;
            }
        },
        static: {
            async findByUsername(username) {
                return await model.findOne({ username });
            }
        }
    })
});

// 2. 使用 Model
const msq = new MonSQLize({ ... });
await msq.connect();
const User = msq.model('users');

// 插入
await User.insertOne({
    username: 'test',
    email: 'test@example.com',
    password: 'secret123',
    age: 25
});

// 查询并使用方法
const user = await User.findByUsername('test');
if (user.checkPassword('secret123')) {
    console.log('登录成功');
}
```

---

## schema-dsl runtime

Model 的 `schema` 回调会收到当前 MonSQLize 实例隔离的 `schema-dsl/runtime` 的 `s` 命名空间。`Model.define()` 只保存定义；实际 schema 编译与验证发生在 `msq.model(name)` 创建绑定到运行时的 Model 实例时。

默认路径下，应用代码不需要直接导入 `schema-dsl`：

```javascript
Model.define('users', {
    schema: (s) => s({
        email: 'email!',
        name: s.string().min(1).max(64).require()
    })
});

const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'app',
    config: { uri: 'mongodb://127.0.0.1:27017' }
});
```

如果应用需要运行时本地的自定义类型、消息、locale，或要与 monSQLize 共享同一个 schema-dsl 状态，可以通过 `schemaDsl` 注入 `schema-dsl/runtime` 实例：

```javascript
import { createRuntime } from 'schema-dsl/runtime';

const schemaRuntime = createRuntime({
    types: {
        tenantId: { type: 'string', pattern: '^tenant_[a-z0-9]+$' }
    }
});

const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'app',
    config: { uri: 'mongodb://127.0.0.1:27017' },
    schemaDsl: { runtime: schemaRuntime }
});
```

当 monSQLize 持有 runtime 时，使用 `schemaDsl: { extensions }` 注册扩展定义。应用自己管理 schema-dsl 生命周期时，应直接配置该 runtime，包括调用 `runtime.registerExtensions([...])`，再通过 `schemaDsl: { runtime }` 注入。默认的 `schema-dsl/runtime` 入口无法解析，或没有暴露所需 runtime API 时，monSQLize 会抛出 `INVALID_CONFIG`；只有显式设置 `schemaDsl: false` 或 `schemaDsl: { enabled: false }` 才会关闭验证。

---

## API 参考

### Model.define(collectionName, definition)

注册 Model 定义。

**参数**：
- `collectionName` - 集合名称
- `definition` - Model 定义
  - `collection` - 实际 MongoDB 集合名；不填时依次回退到 `name` 与 `collectionName`
  - `name` - Model 自动加载文件中的兼容集合名；`collection` 优先级更高
  - `schema` (必需) - Schema 定义
  - `enums` - 枚举配置
  - `methods` - 自定义方法
  - `hooks` - 生命周期钩子
  - `indexes` - 索引定义
  - `connection` - 数据源绑定
    - `pool` - 连接池名称，须与构造函数 `pools[].name` 一致
    - `database` - 数据库名称，不填则使用实例 `databaseName`
  - `options.autoIndex` - 可选的 Model 级自动索引控制，会覆盖运行时 `autoIndex` 配置

```javascript
Model.define('users', {
    // 可选：把注册名与实际 MongoDB 集合名分开
    // collection: 'app_users',
    enums: {
        role: 'admin|user|guest'
    },
    schema: function(s) {
        return s({
            username: 'string:3-32!',
            email: 'email!',
            password: 'string!',
            role: this.enums.role.default('user')
        });
    },
    methods: (model) => ({
        instance: {
            checkPassword(password) {
                return this.password === password;
            }
        },
        static: {
            async findByUsername(username) {
                return await model.findOne({ username });
            }
        }
    }),
    hooks: (model) => ({
        insert: {
            before: async (ctx, docs) => {
                return { ...docs, createdAt: new Date() };
            }
        }
    }),
    indexes: [
        { key: { username: 1 }, unique: true }
    ]
});
```

---

### Model.get(collectionName)

获取已注册的 Model 定义。

**参数**：
- `collectionName` (string) - 集合名称

**返回**：`{ collectionName: string, definition: object } | undefined`

返回包含 `collectionName` 和 `definition` 的包装对象。如果指定的 Model 未注册，则返回 `undefined`。

```javascript
// 获取已注册的 Model 定义
const userModel = Model.get('users');

if (userModel) {
    console.log(userModel.collectionName); // 'users'
    console.log(userModel.definition);     // { schema: ..., methods: ..., ... }
}

// 未注册的 Model 返回 undefined
const notFound = Model.get('nonexistent');
console.log(notFound); // undefined
```

---

### Model.has(collectionName)

检查 Model 是否已注册。

**参数**：
- `collectionName` (string) - 集合名称

**返回**：`boolean`

```javascript
// 检查 Model 是否已注册
if (Model.has('users')) {
    console.log('users Model 已注册');
}

// 条件注册：避免重复定义
if (!Model.has('users')) {
    Model.define('users', {
        schema: (s) => s({ username: 'string!' })
    });
}
```

---

### Model.list()

获取所有已注册的 Model 名称。

**无参数**

**返回**：`string[]` - 所有已注册 Model 的集合名称数组

```javascript
// 获取所有已注册的 Model 名称
const models = Model.list();
console.log(models); // ['users', 'posts', 'comments']

// 遍历所有已注册的 Model
for (const name of Model.list()) {
    const model = Model.get(name);
    console.log(`${name}:`, model.definition);
}
```

---

### Model.redefine(collectionName, definition)

重新定义已注册的 Model。等效于 `undefine()` + `define()` 的组合操作。

**参数**：
- `collectionName` (string) - 集合名称
- `definition` (object) - 新的 Model 定义

**返回**：void

如果 Model 不存在，行为等同于 `define()`。

> ⚠️ **注意**：如果新定义校验失败，旧定义会被移除（不会回滚）。主要用于开发模式下的 Model 热重载。

**可抛出**：`Error`（与 `define()` 相同的校验逻辑）

```javascript
// 重新定义已注册的 Model
Model.redefine('users', {
    schema: (s) => s({
        username: 'string:3-32!',
        email: 'email!',
        avatar: 'string'   // 新增字段
    })
});

// 开发模式下的热重载示例
if (process.env.NODE_ENV === 'development') {
    Model.redefine('users', updatedDefinition);
}
```

---

### Model.undefine(collectionName)

注销已注册的 Model 定义。幂等操作，对不存在的 Model 不抛错。

**参数**：
- `collectionName` (string) - 要注销的集合名称

**返回**：`boolean` - 成功移除返回 `true`，不存在返回 `false`

已实例化的 ModelInstance 不受影响。主要用于开发模式下的 Model 热重载。

```javascript
// 注销已注册的 Model
const removed = Model.undefine('users');
console.log(removed); // true

// 对不存在的 Model 不抛错
const notFound = Model.undefine('nonexistent');
console.log(notFound); // false

// 注销后可重新定义
Model.undefine('users');
Model.define('users', newDefinition);
```

---

### msq.model(collectionName)

获取 Model 实例。

> **缓存行为**：同一 runtime / pool / database / 注册名 / 实际集合名 / 定义版本下，多次调用 `msq.model()` 返回同一 `ModelInstance` 实例。
> - Model 自动索引默认启用，首次创建实例时会调度；任务会先调用 `listIndexes()`，跳过已匹配的 existing 索引，只创建 missing 索引，同一进程内 pending / fulfilled 的任务会去重
> - 可通过 `new MonSQLize({ autoIndex: false })` 全局关闭，也可通过 `options: { autoIndex: false }` 在单个 Model 上关闭
> - `connect()` 只加载与注册 Model 定义，不会单独创建 `ModelInstance`，也不会单独触发索引创建
> - 进程重启后内存任务表清空，首次使用对应 Model 时会再次执行索引预检，并创建仍然缺失的索引
> - 自动索引不会 drop、rename 或 rebuild 冲突索引；冲突和创建失败会记录日志，创建失败任务允许后续重试，支持事件的 runtime 会额外触发 `model-index-error`
> - 生产发布建议使用 `autoIndex: false`，再通过 `ensureIndexes({ dryRun: true })` 或 `msq.ensureModelIndexes({ dryRun: true })` 做显式预检
> - `Model.redefine()` 或 `Model.undefine()` 后，下次调用 `msq.model()` 自动获取新定义的实例
> - `Model.redefine()` 或 `Model.undefine()` 后，已缓存实例会自动失效，下次调用 `msq.model()` 时重建
> - `msq.close()` 后全部缓存清空

```javascript
const User = msq.model('users');

// 继承所有 collection 方法
const users = await User.find({ status: 'active' });
const user = await User.findOne({ username: 'test' });

// 使用自定义静态方法
const admin = await User.findByUsername('admin');
```

---

### validate(data, options)

验证数据。

```javascript
const result = User.validate({
    username: 'test',
    email: 'test@example.com'
});

if (!result.valid) {
    console.error('验证失败:', result.errors);
}
```

---

## 注册名与实际集合名

`Model.define(collectionName, definition)` 的第一个参数是注册名，也是调用 `msq.model(collectionName)` 时使用的名称。运行时访问 MongoDB 时会按以下顺序解析实际集合名：

1. `definition.collection`
2. `definition.name`
3. `Model.define()` 的 `collectionName`

```javascript
Model.define('UserModel', {
    collection: 'users',
    schema: (s) => s({
        username: 'string!'
    })
});

const User = msq.model('UserModel'); // 使用注册名获取 Model
await User.insertOne({ username: 'alice' }); // 实际写入 MongoDB users 集合
```

`definition.name` 主要兼容自动加载文件格式；在手动注册时优先使用 `collection` 表达实际集合名。Model 实例缓存键同时包含 pool、database、注册名和实际集合名，避免不同路由或不同实际集合复用同一个实例。

Model 注册是进程级的，行为类似 Mongoose 的 model 注册。`Model.define('users', ...)` 在同一进程内同名只能定义一次；再次定义相同注册名会抛出 `MODEL_ALREADY_EXISTS`。如果多租户或多数据库应用需要“同一个 MongoDB 集合名、不同 schema”，请使用不同注册名并通过 `definition.collection` 指向实际集合，或仅在测试/开发流程中显式使用 `Model.redefine()` / `Model.undefine()`。

如果 `relations.from` 指向一个已注册 Model，populate 会使用该 Model 的实际集合名；如果没有同名 Model，则把 `from` 当作原始集合名使用。这样既兼容 v1 常见的“按 Model 名引用关系”，也保留直接写 MongoDB 集合名的方式。

---

## 数据源绑定

通过 `Model.define()` 的 `connection` 字段，将 Model 绑定到指定连接池和/或数据库，实现多数据源路由。

### 四种路由组合

| `pool` | `database` | 路由目标 |
|:------:|:----------:|---------|
| —      | —          | 默认连接池 + 实例 `databaseName` |
| —      | ✅          | 默认连接池 + 指定数据库 |
| ✅      | —          | 指定连接池 + 实例 `databaseName` |
| ✅      | ✅          | 指定连接池 + 指定数据库 |

### 使用示例

```javascript
import MonSQLize from 'monsqlize';
const { Model } = MonSQLize;

// 1. 先配置 MonSQLize 实例（声明连接池）
const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'main_db',
    config: { uri: 'mongodb://localhost:27017' },
    pools: [
        {
            name: 'analytics',
            uri: 'mongodb://analytics-host:27017'
        }
    ]
});

// 2. 定义 Model，在 connection 中引用上面声明的池名
// 场景 1：仅切换数据库（默认连接池）
Model.define('AuditLog', {
    schema: (s) => s({ action: 'string!', userId: 'objectId' }),
    connection: { database: 'audit_db' }
});

// 场景 2：仅切换连接池（使用实例默认数据库 main_db）
Model.define('AnalyticsEvent', {
    schema: (s) => s({ event: 'string!', ts: 'date' }),
    connection: { pool: 'analytics' }
});

// 场景 3：同时切换连接池 + 数据库
Model.define('AnalyticsReport', {
    schema: (s) => s({ reportId: 'string!', data: 'object' }),
    connection: { pool: 'analytics', database: 'reports_db' }
});

// 普通 Model（无 connection，走默认逻辑）
Model.define('User', {
    schema: (s) => s({ name: 'string!', email: 'email!' })
});

// 3. 连接
await msq.connect();

// 4. 路由自动处理，调用方式不变
const AuditLogModel       = msq.model('AuditLog');        // → audit_db（默认池）
const AnalyticsEventModel = msq.model('AnalyticsEvent');  // → main_db（analytics 池）
const ReportModel         = msq.model('AnalyticsReport'); // → reports_db（analytics 池）
const UserModel           = msq.model('User');            // → main_db（默认池，原逻辑）
```

### 错误码

| 错误码 | 触发条件 |
|--------|---------|
| `NO_POOL_MANAGER` | Model 配置了 `pool`，但构造函数未配置 `pools` |
| `POOL_NOT_FOUND` | `pool` 指定的名称不存在于已注册的连接池 |
| `INVALID_MODEL_DEFINITION` | `pool` 或 `database` 为空字符串 |

---

## Model 自动加载

### 功能说明

monSQLize 支持自动扫描指定目录，加载所有 Model 定义文件，无需手动调用 `Model.define()`。

### 使用方式

#### 简化配置

```javascript
const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'mydb',
    config: { uri: '...' },
    models: './models'  // ← 自动加载
});

await msq.connect();  // 自动扫描 models/*.model.{js,mjs,cjs}

// 直接使用（无需 Model.define）
const User = msq.model('users');
```

> ⚠️ **路径解析规则**：相对路径以 **`process.cwd()`**（Node.js 进程启动目录）为基准，不是以 `new MonSQLize()` 所在文件的目录为基准。通常在项目根目录启动服务时，`'./models'` 等价于 `<项目根>/models/`。如需避免歧义，建议使用绝对路径：
> ```javascript
> models: path.join(__dirname, 'models')
> ```

#### 完整配置

```javascript
const msq = new MonSQLize({
    models: {
        path: path.join(__dirname, 'models'), // 推荐：绝对路径，基于当前文件目录
        pattern: '*.model.js',               // 文件名模式
        recursive: true                      // 递归扫描子目录
    }
});
```

### Model 文件格式

```javascript
// models/user.model.js
module.exports = {
    name: 'users',  // 集合名称（必需）
    
    schema: (s) => s({
        username: 'string:3-32!',
        email: 'email!'
    }),
    
    methods: (model) => ({
        instance: {
            checkPassword(password) {
                return this.password === password;
            }
        },
        static: {
            async findByUsername(username) {
                return await model.findOne({ username });
            }
        }
    }),
    
    hooks: (model) => ({
        insert: {
            before: async (ctx, doc) => {
                doc.createdAt = new Date();
                return doc;
            }
        }
    }),
    
    indexes: [
        { key: { username: 1 }, unique: true }
    ]
};
```

### 目录结构

```text
models/
├── user.model.js
├── post.model.js
├── comment.model.js
└── admin/
    ├── role.model.js
    └── permission.model.js
```

### 支持的文件格式

- ✅ `.js` - CommonJS
- ✅ `.mjs` - ES Module
- ✅ `.cjs` - CommonJS（显式）
- ⚠️ `.ts` - TypeScript 源文件需要先编译，或由应用自行注册运行时 loader；默认自动加载器不会直接 require `.ts` 文件。

### 配置选项

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `path` | string | - | Model 文件目录（必需） |
| `pattern` | string | `*.model.{js,mjs,cjs}` | 文件名模式（支持 glob） |
| `recursive` | boolean | `false` | 是否递归扫描子目录 |

### 错误处理

#### 目录不存在
```text
[Model] Models directory not found: /path/to/models
```

#### 文件格式错误
```text
[Model] ❌ Failed to load models/invalid.model.js: export is null
[Model] ❌ Failed to load models/no-name.model.js: missing 'name' property
```

#### 重复注册
```text
[Model] Model 'users' already registered, skipping models/user2.model.js
```

### 最佳实践

1. **统一命名规范**: 使用 `{name}.model.js` 格式
2. **按功能分组**: 使用子目录组织（如 `admin/`、`public/`）
3. **导出格式**: 始终使用 `module.exports = { name, ... }`
4. **测试环境**: 可以禁用自动加载，手动注册测试 Model

### 注意事项

- ⚠️ 文件必须包含 `name` 属性
- ⚠️ 重复的 Model 名称只会注册第一个
- ⚠️ 文件语法错误会导致加载失败（记录日志，不中断）
- ⚠️ TypeScript 文件需要运行时支持（ts-node 或编译后）

### 与手动注册对比

| 方式 | 优点 | 缺点 |
|------|------|------|
| 手动注册 | 精确控制、显式依赖 | 重复代码、维护成本高 |
| 自动加载 | 自动发现、代码简洁 | 隐式依赖、加载顺序不确定 |

**推荐**: 生产环境使用自动加载，测试环境可选择手动注册。

---

## Schema 验证

### 运行时行为

monSQLize 使用 `schema-dsl` 作为 Model 文档的 schema 校验引擎。每个已连接的 `MonSQLize` 运行时都会创建或接收一个隔离的 `schema-dsl/runtime` 实例，可通过 `schemaDsl` 选项配置，因此业务代码可以使用运行时作用域的 `s` helper，而不需要导入全局 DSL 入口。

`Model.define()` 只把定义保存到进程级 registry。schema 回调会在 `msq.model(name)` 把定义绑定到具体运行时时编译。验证会在定义了 schema 的完整文档写入路径执行：`insertOne()`、`insertMany()`、`insertBatch()`、`replaceOne()`、`findOneAndReplace()` 和 hydrated document `save()`。只有 Model 设置 `options.validate: false`、支持验证的单次写操作传入 `skipValidation: true`，或运行时通过 `schemaDsl: false` / `{ enabled: false }` 显式关闭 schema DSL 时，验证才会跳过。

验证成功后，这六条写路径会继续使用 schema-dsl 返回的 normalized `data`，因此类型转换、schema default 和允许的字段移除都会真正进入 MongoDB。固定顺序为 model defaults、before hook、schema normalize、timestamps、version、driver write；replace 或 hydrated `save()` 不适用的阶段仍保持不存在。验证失败，或成功结果返回的 normalized data 不是对象时，会在 driver write 之前终止。`Model.validate()` 会暴露 normalized `data`，但不会写库。

`updateOne()`、`updateMany()`、`findOneAndUpdate()`、`upsertOne()`、`incrementOne()` 和 `updateBatch()` 这类 patch 写入接收的是 MongoDB update operators 或 aggregation pipeline，而不是最终完整文档。monSQLize 不会对这些 patch 写入执行完整文档 schema 验证；如果业务要求 patch 也符合完整领域对象，请在 hooks、`Model.validate()` 或应用层校验中处理。

### 基本使用

```javascript
import { Model } from 'monsqlize';

Model.define('users', {
    schema: (s) => s({
        username: 'string:3-32!',      // 必需，3-32 字符
        email: 'email!',               // 必需，邮箱格式
        password: 'string:6-!',        // 必需，至少 6 字符
        age: 'number:0-120',           // 可选，0-120 范围
        role: 'string?'                // 可选字符串
    })
});

const User = msq.model('users');

// 绑定到运行时且定义了 schema 的完整文档写入会自动执行验证。
await User.insertOne({
    username: 'john',
    email: 'john@example.com',
    password: 'secret123',
    age: 25
});

// ❌ 验证失败
try {
    await User.insertOne({
        username: 'ab',        // 太短
        email: 'invalid',      // 邮箱格式错误
        password: '123'        // 太短
    });
} catch (err) {
    console.error(err.code);    // 'VALIDATION_ERROR'
    console.error(err.message); // 'Schema validation failed: ...'
    console.error(err.errors);  // 详细错误数组
}
```

### Schema 语法

| 类型 | 语法 | 示例 |
|------|------|------|
| 字符串 | `string` | `'string!'` 必需字符串 |
| 字符串范围 | `string:min-max` | `'string:3-32!'` 3-32 字符 |
| 数字 | `number` | `'number!'` 必需数字 |
| 数字范围 | `number:min-max` | `'number:0-120'` 0-120 范围 |
| 邮箱 | `email` | `'email!'` 邮箱格式 |
| URL | `url` | `'url!'` URL 格式 |
| 数组 | `array` | `'array!'` 必需数组 |
| 对象 | `object` | `'object!'` 必需对象 |
| 布尔 | `boolean` | `'boolean!'` 必需布尔值 |
| 日期 | `date` | `'date!'` Date 对象 |
| 可选 | `type?` | `'string?'` 可选字符串 |
| 必需 | `type!` | `'string!'` 必需字符串 |

更多语法见 [schema-dsl 文档](https://github.com/devcodex-labs/schema-dsl)。

### 验证错误详情

```javascript
try {
    await User.insertOne({ username: 'ab', email: 'invalid' });
} catch (err) {
    console.log(err.code);     // 'VALIDATION_ERROR'
    console.log(err.message);  // 'Schema validation failed: ...'
    console.log(err.errors);   // 详细错误数组
    /*
    [
        {
            field: 'username',
            message: 'username must be 3-32 characters'
        },
        {
            field: 'email',
            message: 'email must be a valid email address'
        }
    ]
    */
}
```

monSQLize 的公开错误边界是 `{ field, message }`。`field` 由 schema-dsl canonical `path` 映射；上游 deprecated 的 `field`、`type`、`expected` 别名不属于 monSQLize 契约。

### 禁用验证

#### 全局禁用（不推荐）

```javascript
Model.define('users', {
    schema: (s) => s({ ... }),
    options: { validate: false }  // 全局禁用验证
});
```

#### 单次操作跳过

```javascript
// 跳过验证（特殊场景，如数据迁移）
await User.insertOne(doc, { skipValidation: true });
```

### 性能影响

- **验证开销**: 在典型 schema 较重的完整文档写入路径中，耗时约增加 5-10%
- **缓存优化**: schema 会在 Model 绑定到运行时时编译，之后复用
- **跳过选项**: 可在受控迁移或修复任务中通过 `skipValidation` 跳过验证

### 最佳实践

1. **始终定义 Schema**: 保证数据质量
2. **合理使用可选字段**: 避免过度严格
3. **自定义验证**: 使用 hooks 添加复杂验证逻辑
4. **错误处理**: 捕获 `VALIDATION_ERROR` 返回友好错误

### 常见问题

**Q: 如何验证嵌套对象？**

A: 使用 schema-dsl 的嵌套语法：

```javascript
schema: (s) => s({
    profile: s({
        name: 'string!',
        age: 'number!'
    })
})
```

**Q: 如何自定义验证逻辑？**

A: 使用 hooks 添加复杂验证：

```javascript
hooks: (model) => ({
    insert: {
        before: async (ctx, doc) => {
            if (doc.age < 18) {
                throw new Error('Must be 18+');
            }
            return doc;
        }
    }
})
```

**Q: 性能敏感场景如何优化？**

A: 批量插入时可选择跳过验证（风险自负）：

```javascript
await User.insertMany(docs, { skipValidation: true });
```

---

## 配置说明

### 1. schema - 数据验证

定义字段验证规则。

```javascript
// 推荐：使用 function 可引用 enums
schema: function(s) {
    return s({
        username: 'string:3-32!',
        email: 'email!',
        age: 'number:0-120',
        role: this.enums.role.default('user')  // 引用 enums
    });
}

// 或直接使用 object
schema: (s) => s({
    username: 'string:3-32!',
    email: 'email!'
})
```

**常用规则**：
- `string!` - 必填字符串
- `string:3-32` - 长度 3-32
- `number:0-120` - 数字范围
- `email!` - 邮箱格式
- `.default('value')` - 默认值
- `.pattern(/regex/)` - 正则验证

---

### 2. methods - 自定义方法

#### instance 方法

注入到查询返回的文档对象。

```javascript
methods: (model) => ({
    instance: {
        checkPassword(password) {
            return this.password === password;  // this = 文档对象
        },
        isAdmin() {
            return this.role === 'admin';
        }
    }
})

// 使用
const user = await User.findOne({ username: 'test' });
user.checkPassword('secret123');  // ✅
user.isAdmin();                   // ✅
```

**注意**：
- ⚠️ 必须使用普通函数，不能用箭头函数
- ⚠️ 方法名避免与字段名冲突，使用动词前缀：`is*`, `check*`, `get*`
- ⚠️ 修改 `this` 不会自动保存到数据库

#### static 方法

挂载到 Model 实例。

```javascript
methods: (model) => ({
    static: {
        async findByUsername(username) {
            return await model.findOne({ username });
        },
        async findAdmins() {
            return await model.find({ role: 'admin' });
        }
    }
})

// 使用
const User = msq.model('users');
const user = await User.findByUsername('test');  // ✅
const admins = await User.findAdmins();          // ✅
```

---

### 3. hooks - 生命周期钩子

在操作前后执行自定义逻辑。

```javascript
hooks: (model) => ({
    insert: {
        before: async (ctx, docs) => {
            // 自动添加时间戳
            return { ...docs, createdAt: new Date() };
        },
        after: async (ctx, result) => {
            console.log('插入完成');
        }
    },
    update: {
        before: async (ctx, filter, update) => {
            if (!update.$set) update.$set = {};
            update.$set.updatedAt = new Date();
            return [filter, update];
        }
    }
})
```

**支持的操作**：`find`, `insert`, `update`, `delete`

**ctx 上下文**：用于在 before 和 after 之间传递数据

```javascript
before: async (ctx, docs) => {
    ctx.timestamp = Date.now();
},
after: async (ctx, result) => {
    console.log('耗时:', Date.now() - ctx.timestamp);
}
```

---

### 4. indexes - 自动创建索引

```javascript
indexes: [
    { key: { username: 1 }, unique: true },      // 唯一索引
    { key: { status: 1, createdAt: -1 } },       // 复合索引
    { key: { expireAt: 1 }, expireAfterSeconds: 0 }  // TTL 索引
]
```

自动索引只在 `ModelInstance` 创建时调度，不会在每次查询或每次请求时重复创建。同一进程内，monSQLize 会按 runtime / pool / database / collection / 声明索引集合指纹记录索引 ensure 任务：任务处于 pending 或 fulfilled 状态时会跳过重复调度；创建失败任务允许下次重新调度。

为了保持向后兼容，自动索引默认启用。生产服务可以在运行时或单个 Model 上关闭：

```javascript
const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'app',
    autoIndex: false
});

Model.define('users', {
    schema: (s) => s({ email: 'email!' }),
    options: { autoIndex: false },
    indexes: [
        { key: { email: 1 }, unique: true, name: 'users_email_unique' }
    ]
});
```

发布前使用显式 ensure API 做预检和受控执行：

```javascript
const User = msq.model('users');

const plan = await User.ensureIndexes({ dryRun: true });
console.log(plan.missing, plan.conflicts);

if (plan.conflicts.length === 0) {
    await User.ensureIndexes({ throwOnError: true });
}

const summary = await msq.ensureModelIndexes({
    models: ['users'],
    dryRun: true
});
console.log(summary.totals);
```

`ensureIndexes()` 与 `ensureModelIndexes()` 会先调用 `listIndexes()`，并把声明索引分类为 `existing`、`missing`、`conflicts`。dry-run 模式不会调用 `createIndex()`。执行模式只创建 `missing` 索引，不会 drop、rename 或 rebuild 冲突索引。设置 `throwOnError: true` 后，显式 ensure 遇到冲突或创建失败会抛出 MonSQLize `MONGODB_ERROR`。

自动索引也会先使用相同的预检分类：跳过 `existing`，创建 `missing`，并通过 warning 日志和 `model-index-error` 事件报告 `conflicts`，不会自动修改冲突索引。

---

### 5. enums - 枚举配置

```javascript
enums: {
    role: 'admin|user|guest',
    status: 'active|inactive'
}

// schema 中引用
schema: function(s) {
    return s({
        role: this.enums.role.default('user')
    });
}
```

---

## 完整示例

```javascript
import MonSQLize from 'monsqlize';
const { Model } = MonSQLize;

// 定义 User Model
Model.define('users', {
    enums: {
        role: 'admin|user|guest',
        status: 'active|inactive|banned'
    },
    schema: function(s) {
        return s({
            username: 'string:3-32!',
            email: 'email!',
            password: 'string!'.pattern(/^[a-zA-Z0-9]{6,30}$/),
            role: this.enums.role.default('user'),
            status: this.enums.status.default('active'),
            loginCount: 'number'.default(0),
            lastLoginAt: 'date',
            createdAt: 'date!',
            updatedAt: 'date!'
        });
    },
    methods: (model) => ({
        instance: {
            checkPassword(password) {
                return this.password === password;
            },
            isAdmin() {
                return this.role === 'admin';
            },
            async incrementLogin() {
                return await model.updateOne(
                    { _id: this._id },
                    { 
                        $inc: { loginCount: 1 },
                        $set: { lastLoginAt: new Date() }
                    }
                );
            }
        },
        static: {
            async findByUsername(username) {
                return await model.findOne({ username });
            },
            async findActive() {
                return await model.find({ status: 'active' });
            },
            async countAdmins() {
                return await model.count({ role: 'admin' });
            }
        }
    }),
    hooks: (model) => ({
        insert: {
            before: async (ctx, docs) => {
                const now = new Date();
                return {
                    ...docs,
                    createdAt: now,
                    updatedAt: now
                };
            }
        },
        update: {
            before: async (ctx, filter, update) => {
                if (!update.$set) update.$set = {};
                update.$set.updatedAt = new Date();
                return [filter, update];
            }
        }
    }),
    indexes: [
        { key: { username: 1 }, unique: true },
        { key: { email: 1 }, unique: true },
        { key: { status: 1, createdAt: -1 } }
    ]
});

// 使用
const msq = new MonSQLize({
    type: 'mongodb',
    config: { uri: 'mongodb://localhost:27017/mydb' }
});
await msq.connect();

const User = msq.model('users');

// 创建用户
const result = User.validate({
    username: 'admin',
    email: 'admin@example.com',
    password: 'secret123',
    role: 'admin'
});

if (result.valid) {
    await User.insertOne(result.data);
}

// 登录验证
const user = await User.findByUsername('admin');
if (user && user.checkPassword('secret123')) {
    if (user.isAdmin()) {
        console.log('管理员登录');
    }
    await user.incrementLogin();
}

// 查询活跃用户
const activeUsers = await User.findActive();

// 统计管理员数量
const adminCount = await User.countAdmins();
```

---

## 注意事项（Model API 文档）

### ⚠️ 方法命名避免冲突

方法名不要与字段名相同，使用动词前缀。

```javascript
// ❌ 错误
methods: { instance: { status() {} } }

// ✅ 正确
methods: { 
    instance: { 
        isActive() {},      // is* 判断
        checkStatus() {},   // check* 验证
        getFullName() {}    // get* 获取
    } 
}
```

### ⚠️ 必须使用普通函数

不能使用箭头函数，否则 `this` 指向错误。

```javascript
// ❌ 错误
checkPassword: (password) => this.password === password

// ✅ 正确
checkPassword(password) { return this.password === password; }
```

### ⚠️ 修改不会自动保存

方法内修改 `this` 只改内存，不会保存到数据库。

```javascript
// ❌ 错误：只改内存
updatePassword(pwd) { this.password = pwd; }

// ✅ 正确：调用更新方法
async changePassword(pwd) {
    return await model.updateOne(
        { _id: this._id },
        { $set: { password: pwd } }
    );
}
```

---

## 自动时间戳

自动管理 `createdAt` 和 `updatedAt` 字段。

### 基本用法

```javascript
Model.define('users', {
    schema: (s) => s({ username: 'string!' }),
    options: {
        timestamps: true  // 启用自动时间戳
    }
});

// 插入时自动添加
await User.insertOne({ username: 'john' });
// => { _id, username: 'john', createdAt: Date, updatedAt: Date }

// 更新时自动更新 updatedAt
await User.updateOne({ username: 'john' }, { $set: { status: 'active' } });
// => updatedAt 自动更新为当前时间
```

### 自定义字段名

```javascript
Model.define('users', {
    options: {
        timestamps: {
            createdAt: 'created_time',  // 自定义创建时间字段名
            updatedAt: 'updated_time'   // 自定义更新时间字段名
        }
    }
});
```

### 部分启用

```javascript
// 只启用 createdAt
Model.define('users', {
    options: {
        timestamps: {
            createdAt: true,
            updatedAt: false
        }
    }
});

// 只启用 updatedAt
Model.define('users', {
    options: {
        timestamps: {
            createdAt: false,
            updatedAt: true
        }
    }
});
```

### 支持的操作

| 操作 | createdAt | updatedAt | 说明 |
|------|-----------|-----------|------|
| insertOne | ✅ | ✅ | 同时添加两个字段 |
| insertMany | ✅ | ✅ | 每个文档都添加 |
| updateOne | ❌ | ✅ | 只更新 updatedAt |
| updateMany | ❌ | ✅ | 所有匹配文档更新 |
| replaceOne | ❌ | ✅ | 替换时更新 |
| upsertOne | ✅/❌ | ✅ | 插入时添加 createdAt，更新时不添加 |
| findOneAndUpdate | ❌ | ✅ | 只更新 updatedAt |
| findOneAndReplace | ❌ | ✅ | 替换时更新 |
| incrementOne | ❌ | ❌ | ⚠️ 暂不支持 |

### 注意事项（自动时间戳）

#### ⚠️ 用户手动设置会被覆盖

```javascript
await User.insertOne({
    username: 'john',
    createdAt: new Date('2020-01-01')  // 会被覆盖
});
// => createdAt 会是当前时间，不是 2020-01-01
```

如需保留用户设置的值，请暂时禁用 timestamps 或在 before hook 中处理。

#### ⚠️ incrementOne 暂不支持

```javascript
// incrementOne 不会自动更新 updatedAt
await User.incrementOne({ _id }, { score: 10 });
```

**临时方案**：手动添加 updatedAt

```javascript
await User.updateOne(
    { _id },
    { 
        $inc: { score: 10 },
        $set: { updatedAt: new Date() }
    }
);
```

#### ✅ 与 schema 验证配合

timestamps 自动添加的字段会通过 schema 验证（如果 schema 中有定义）。

```javascript
Model.define('users', {
    schema: (s) => s({
        username: 'string!',
        createdAt: 'date',    // 可选：定义验证规则
        updatedAt: 'date'
    }),
    options: {
        timestamps: true       // 自动添加的值会通过验证
    }
});
```

#### ✅ 与 hooks 配合

timestamps 在用户 hooks 之后执行，不会影响用户的 before hook。

```javascript
Model.define('users', {
    options: { timestamps: true },
    hooks: (model) => ({
        insert: {
            before: (ctx, docs) => {
                // 用户 hook 先执行
                return { ...docs, customField: 'value' };
            }
        }
    })
});

// 执行顺序：用户 before hook → timestamps → 数据库操作 → 用户 after hook
```

---

## 软删除（softDelete）


软删除标记文档为已删除，而非物理删除，支持数据恢复和审计。

### 启用软删除

```javascript
// 简单模式
Model.define('users', {
    schema: (s) => s({ username: 'string!' }),
    options: {
        softDelete: true  // 使用默认配置
    }
});

// 完整配置
Model.define('posts', {
    schema: (s) => s({ title: 'string!' }),
    options: {
        softDelete: {
            enabled: true,           // 启用软删除
            field: 'deletedAt',      // 字段名（可自定义）
            type: 'timestamp',       // 'timestamp' | 'boolean'
            ttl: 86400 * 30          // TTL 索引（30天后自动清理）
        }
    }
});
```

### 配置项

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | boolean | true | 启用软删除 |
| `field` | string | 'deletedAt' | 删除标记字段名 |
| `type` | string | 'timestamp' | 删除标记类型（'timestamp' 或 'boolean'） |
| `ttl` | number | null | TTL 索引（秒），自动清理已删除数据 |

### 软删除操作

启用软删除后，`deleteOne` 和 `deleteMany` 会自动转换为更新操作：

```javascript
const User = msq.model('users');

// 软删除（标记为已删除）
await User.deleteOne({ _id });
// 实际执行：updateOne({ _id }, { $set: { deletedAt: new Date() } })

// 批量软删除
await User.deleteMany({ status: 'inactive' });
// 实际执行：updateMany({ status: 'inactive' }, { $set: { deletedAt: new Date() } })
```

### 查询自动过滤

启用软删除后，查询操作自动过滤已删除的文档：

```javascript
// 默认查询不返回已删除数据
const users = await User.find({});
// 实际执行：find({ deletedAt: null })

const user = await User.findOne({ username: 'john' });
// 实际执行：findOne({ username: 'john', deletedAt: null })

const count = await User.count({ status: 'active' });
// 实际执行：count({ status: 'active', deletedAt: null })
```

### 查询已删除数据

使用专门的方法查询包含或只查询已删除的数据：

```javascript
// 查询包含已删除的所有数据
const allUsers = await User.findWithDeleted({});
const john = await User.findOneWithDeleted({ username: 'john' });
const totalCount = await User.countWithDeleted({});

// 只查询已删除的数据
const deletedUsers = await User.findOnlyDeleted({});
const deletedJohn = await User.findOneOnlyDeleted({ username: 'john' });
const deletedCount = await User.countOnlyDeleted({});
```

### 新增方法

| 方法 | 说明 |
|------|------|
| `findWithDeleted(filter, options)` | 查询包含已删除的文档 |
| `findOneWithDeleted(filter, options)` | 查询单个文档（包含已删除） |
| `countWithDeleted(filter, options)` | 统计文档数（包含已删除） |
| `findOnlyDeleted(filter, options)` | 只查询已删除的文档 |
| `findOneOnlyDeleted(filter, options)` | 查询单个已删除文档 |
| `countOnlyDeleted(filter, options)` | 统计已删除的文档数 |
| `restore(filter, options)` | 恢复已删除的文档 |
| `restoreMany(filter, options)` | 批量恢复已删除的文档 |
| `forceDelete(filter, options)` | 强制物理删除（不可恢复） |
| `forceDeleteMany(filter, options)` | 批量强制物理删除 |

### 恢复已删除数据

```javascript
// 恢复单个文档
const result = await User.restore({ _id });
// 实际执行：updateOne({ _id, deletedAt: { $ne: null } }, { $unset: { deletedAt: 1 } })

// 批量恢复
const result = await User.restoreMany({ status: 'active' });
// 实际执行：updateMany({ status: 'active', deletedAt: { $ne: null } }, { $unset: { deletedAt: 1 } })
```

### 强制物理删除

绕过软删除机制，执行真正的物理删除（不可恢复）：

```javascript
// 强制物理删除单个文档
await User.forceDelete({ _id });
// 实际执行：真正的 deleteOne（数据永久删除）

// 批量强制删除
await User.forceDeleteMany({ deletedAt: { $lt: thirtyDaysAgo } });
// 实际执行：真正的 deleteMany（批量永久删除）
```

### 删除类型

#### timestamp 类型（默认）

```javascript
Model.define('users', {
    options: {
        softDelete: { type: 'timestamp' }  // 默认
    }
});

// 删除时记录删除时间
{ _id, username: 'john', deletedAt: new Date('2026-01-05T10:30:00Z') }

// 优点：记录删除时间，支持审计
// 缺点：占用存储空间
```

#### boolean 类型

```javascript
Model.define('posts', {
    options: {
        softDelete: { type: 'boolean' }
    }
});

// 删除时标记为 true
{ _id, title: 'Hello', deletedAt: true }

// 优点：节省存储空间
// 缺点：不记录删除时间
```

### 自定义字段名（软删除（softDelete））

```javascript
Model.define('comments', {
    options: {
        softDelete: {
            enabled: true,
            field: 'removed_at'  // 自定义字段名
        }
    }
});

// 删除时使用 removed_at 字段
await Comment.deleteOne({ _id });
// { _id, content: 'Nice!', removed_at: new Date() }
```

### TTL 索引自动清理

配置 TTL 索引，MongoDB 会自动删除过期的已删除数据：

```javascript
Model.define('logs', {
    options: {
        softDelete: {
            enabled: true,
            ttl: 86400 * 30  // 30天后自动清理
        }
    }
});

// 自动创建索引：
// db.logs.createIndex({ deletedAt: 1 }, { expireAfterSeconds: 2592000 })

// MongoDB 会自动删除 deletedAt 超过 30 天的文档
```

生产环境中，如果已有大量文档已过期，创建 TTL 索引后可能触发集中清理。建议使用 `autoIndex: false`，先运行 `ensureIndexes({ dryRun: true })`，必要时分批清理旧数据，再在低峰窗口创建 TTL 索引并开启数据库监控。

### 与 timestamps 协同

软删除和时间戳可以同时启用：

```javascript
Model.define('products', {
    schema: (s) => s({ name: 'string!' }),
    options: {
        timestamps: true,   // 自动管理 createdAt/updatedAt
        softDelete: true    // 软删除
    }
});

// 插入时自动添加时间戳
await Product.insertOne({ name: 'iPhone' });
// { _id, name: 'iPhone', createdAt: Date, updatedAt: Date }

// 软删除时自动更新 updatedAt
await Product.deleteOne({ _id });
// { _id, name: 'iPhone', createdAt: Date, updatedAt: Date(更新), deletedAt: Date }
```

### 唯一索引处理

⚠️ **注意**：软删除后，唯一索引可能失效。

```javascript
// 问题：用户 john 被软删除后
{ username: 'john', deletedAt: new Date() }

// 创建新用户 john 会失败（唯一索引冲突）
await User.insertOne({ username: 'john' });  // ❌ 冲突
```

**解决方案**：使用复合唯一索引

```javascript
Model.define('users', {
    schema: (s) => s({ username: 'string!' }),
    options: {
        softDelete: true
    },
    indexes: [
        {
            key: { username: 1, deletedAt: 1 },  // 复合索引
            unique: true
        }
    ]
});

// 现在可以创建同名用户（因为 deletedAt 不同）
```

---

## 乐观锁版本控制（Version）

### 什么是乐观锁？

乐观锁是一种并发控制机制，通过版本号检测数据冲突：
- 每次更新时自动递增版本号
- 更新时验证版本号是否匹配
- 版本号不匹配说明数据已被其他请求修改（并发冲突）

**使用场景**：
- 多用户同时编辑同一数据
- 防止脏写（Lost Update）
- 需要并发安全保证的场景

### 基础配置

```javascript
Model.define('users', {
    schema: (s) => s({
        username: 'string!',
        email: 'string!',
        status: 'string'
    }),
    options: {
        version: true  // 启用版本控制（默认字段名 version）
    }
});
```

### 完整配置（乐观锁版本控制（Version））

```javascript
Model.define('users', {
    schema: (s) => s({
        username: 'string!',
        email: 'string!'
    }),
    options: {
        version: {
            enabled: true,      // 是否启用
            field: '__v',       // 自定义字段名（默认 'version'）
            updateMany: 'counter' // counter | strict | off
        }
    }
});
```

### 插入时自动初始化

```javascript
// 插入文档
const result = await User.insertOne({
    username: 'john',
    email: 'john@example.com'
});

// 查询文档
const user = await User.findOne({ _id: result.insertedId });
console.log(user);
// { _id: '...', username: 'john', email: 'john@example.com', version: 0 }
```

### 更新时自动处理版本

```javascript
// 第一次更新
await User.updateOne({ _id }, { $set: { status: 'active' } });
// 实际执行会先读取当前 version，再写入 { _id, version: 0 } + { $inc: { version: 1 } }

const user = await User.findOne({ _id });
console.log(user.version);  // 1

// 第二次更新
await User.updateOne({ _id }, { $set: { status: 'inactive' } });
const updatedAgain = await User.findOne({ _id });
console.log(updatedAgain.version);  // 2
```

启用 version 后，`save`、`updateOne`、`replaceOne`、`findOneAndUpdate`、`findOneAndReplace` 使用真正的乐观锁。filter 中有直接 `_id` 时，monSQLize 会自动读取当前 version；显式传入 `expectedVersion`、`version` 或 filter 中的 version 字段时，显式值优先。

`updateMany` 和 `updateBatch` 通过 `versionMode` 控制批量版本行为：

```javascript
await User.updateMany(
    { status: 'pending' },
    { $set: { status: 'active' } },
    { versionMode: 'strict' } // counter | strict | off
);
```

- `counter`（默认）：原生批量更新并递增 version，只是版本计数器，不是乐观锁。
- `strict`：先读取匹配文档的 `_id` 和 version，再逐条按 `{ _id, version }` 条件更新，并在结果中返回 `conflictCount` / `conflictedIds`。
- `off`：本次批量更新跳过 version 处理。

### 并发冲突检测

```javascript
// 用户 A 读取数据
const userA = await User.findOne({ _id });
console.log(userA.version);  // 0

// 用户 B 读取数据
const userB = await User.findOne({ _id });
console.log(userB.version);  // 0

// 用户 A 先更新成功
const resultA = await User.updateOne(
    { _id },
    { $set: { status: 'active' } }
);
console.log(resultA.modifiedCount);  // 1

// 用户 B 更新失败
try {
    await User.updateOne(
        { _id, version: userB.version },  // 版本号已过期
        { $set: { status: 'inactive' } }
    );
} catch (error) {
    console.log(error.code);  // WRITE_CONFLICT
}
```

### 与其他功能协同

```javascript
Model.define('users', {
    options: {
        timestamps: true,  // 自动时间戳
        softDelete: true,  // 软删除
        version: true      // 版本控制
    }
});

// 所有功能协同工作
await User.insertOne({ username: 'john' });
// { _id, username, version: 0, createdAt, updatedAt }

await User.deleteOne({ _id, version: 0 });
// 软删除时版本号递增
```

### 最佳实践（乐观锁版本控制（Version））

```javascript
// 并发更新场景
async function updateUserStatus(userId, newStatus) {
    let maxRetries = 3;
    
    for (let i = 0; i < maxRetries; i++) {
        const user = await User.findOne({ _id: userId });
        if (!user) throw new Error('User not found');

        try {
            await User.updateOne(
                { _id: userId },
                { $set: { status: newStatus } },
                { expectedVersion: user.version }
            );
            return { success: true };
        } catch (error) {
            if (error.code !== 'WRITE_CONFLICT') throw error;
            console.log(`Retry ${i + 1}/${maxRetries} (version conflict)`);
        }
    }
    
    throw new Error('Update failed due to concurrent modification');
}
```

---

### 完整示例（乐观锁版本控制（Version））

```javascript
import MonSQLize from 'monsqlize';
const { Model } = MonSQLize;

// 定义 Model（启用软删除和时间戳）
Model.define('articles', {
    schema: (s) => s({
        title: 'string!',
        content: 'string!',
        author: 'string!'
    }),
    options: {
        timestamps: true,
        softDelete: {
            enabled: true,
            type: 'timestamp',
            ttl: 86400 * 30  // 30天后自动清理
        }
    },
    indexes: [
        { key: { author: 1 } },
        { key: { title: 1, deletedAt: 1 }, unique: true }  // 复合唯一索引
    ]
});

async function example() {
    const msq = new MonSQLize({ type: 'mongodb', databaseName: 'blog' });
    await msq.connect();
    
    const Article = msq.model('articles');
    
    // 1. 插入文章
    const article = await Article.insertOne({
        title: 'Hello World',
        content: 'This is my first post',
        author: 'john'
    });
    console.log('Created:', article);
    // { _id, title, content, author, createdAt, updatedAt }
    
    // 2. 软删除文章
    await Article.deleteOne({ _id: article._id });
    console.log('Article soft deleted');
    
    // 3. 查询（自动过滤已删除）
    const articles = await Article.find({ author: 'john' });
    console.log('Active articles:', articles.length);  // 0
    
    // 4. 查询包含已删除
    const allArticles = await Article.findWithDeleted({ author: 'john' });
    console.log('All articles:', allArticles.length);  // 1
    
    // 5. 恢复文章
    await Article.restore({ _id: article._id });
    console.log('Article restored');
    
    // 6. 查询（恢复后可以查到）
    const restoredArticle = await Article.findOne({ _id: article._id });
    console.log('恢复后:', restoredArticle.title);  // 'Hello World'
    
    // 7. 强制物理删除
    await Article.forceDelete({ _id: article._id });
    console.log('Article permanently deleted');
    
    await msq.close();
}

example().catch(console.error);
```

---

## 常见问题（Model API 文档）

**Q: `this.password` 从哪来？**  
A: 来自数据库查询结果，不是 schema。schema 只定义验证规则。

**Q: 如何引用 enums？**  
A: 使用 function 定义 schema：`schema: function(s) { return s({ role: this.enums.role }) }`

**Q: instance 和 static 的区别？**  
A: instance 注入到文档对象，static 挂载到 Model 实例。

---

## 更多示例

查看当前 TypeScript 示例：
- [Model 基础可运行示例](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/model.ts) - Model 基础使用
- [Relations 与 populate 可运行示例](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/populate-relations.ts) - Relations 与 populate 示例
