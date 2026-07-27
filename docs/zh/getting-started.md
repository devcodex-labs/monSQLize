# 安装

## 本页内容

本页给出安装 monSQLize 并完成一次 MongoDB 最小连接验证的路径：

- 安装
- 初始化 `MonSQLize`
- `connect()`
- `collection()`
- 基础写入与查询
- 连接关闭
- 后续快速上手入口

## 安装

```bash
npm install monsqlize
```

### 运行前提

- Node.js 18 或更高版本。
- 一个 MongoDB 连接 URI，例如 `mongodb://localhost:27017`。
- Redis、SSH 隧道、缓存、Model、同步等能力只在你的应用启用对应配置时才需要关注。

## 最小连接示例

```typescript
import MonSQLize from 'monsqlize';

const msq = new MonSQLize({
    type: 'mongodb',
    databaseName: 'mydb',
    config: { uri: 'mongodb://localhost:27017' },
});

await msq.connect();

const users = msq.collection('users');
await users.insertOne({
    username: 'ada',
    email: 'ada@example.com',
    createdAt: new Date(),
});

const user = await users.findOne({ email: 'ada@example.com' });
console.log(user);

await msq.close();
```

## 仓库内可执行示例

若你在当前仓库中验证最小路径，可直接运行：

```bash
npm run build
npm run test:examples
```

当前官方示例文件是 [`examples/quick-start/basic-connect.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/quick-start/basic-connect.ts)，验证时会先编译再执行。该示例会：

1. 启动内存 MongoDB
2. 创建 `MonSQLize` 实例并连接
3. 写入一条用户数据
4. 读回该数据并打印结果
5. 关闭连接并清理临时数据库

## 下一步

- 继续快速上手常用 CRUD、分页、缓存和 Model 入口：[`basic-operations.md`](./basic-operations.md)。
- 查看构造函数完整参数：[`configuration.md`](./configuration.md)。
- 阅读查询细节：[`find.md`](./find.md)、[`findOne.md`](./findOne.md)、[`findPage.md`](./findPage.md)。
- 在 [`examples.md`](./examples.md) 查看文档主题与示例源码的对应关系。
- 直接打开 GitHub 示例源码：
  - [`examples/quick-start/basic-connect.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/quick-start/basic-connect.ts)
  - [`examples/quick-start/basic-operations.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/quick-start/basic-operations.ts)
  - [`examples/docs/find.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/find.ts)
  - [`examples/docs/find-one.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/find-one.ts)
  - [`examples/docs/find-page.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/find-page.ts)

## 常见注意事项

1. `connect()` 前直接访问 `collection()` 会触发 `NOT_CONNECTED`。
2. 缺少 `config.uri` 会触发 `INVALID_CONFIG`。
3. 应用代码从包根入口导入：`import MonSQLize from 'monsqlize'` 或 `const MonSQLize = require('monsqlize')`。

