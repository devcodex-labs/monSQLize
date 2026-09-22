# 写路径策略

`writePathPolicy` 用于控制运行时写操作入口：允许 `collection()` 和 `model()` 两种入口同时写入，或要求指定命名空间必须经过 Model 层写入。

策略查找只使用配置对象自身显式声明的规则，不会把原型继承属性当作规则；显式配置的 `toString`、`constructor` 等命名空间键仍有效。

默认行为是宽松的：不配置 `writePathPolicy` 时，collection API 和 Model API 都可以写入。只有当业务希望强制写入经过 schema defaults、hooks、timestamps、乐观锁、soft delete 等 Model mutation 规则时，才需要启用该策略。

## 配置

```ts
import MonSQLize from 'monsqlize';

const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'app',
  config: { uri: 'mongodb://localhost:27017' },
  writePathPolicy: {
    default: 'model-only',
    namespaces: {
      'app.audit_logs': 'allow-both',
      'analytics:app.reports': {
        mode: 'allow-both',
        raw: 'block',
        management: 'allow'
      }
    }
  }
});
```

## 规则结构

```ts
type WritePathPolicyMode = 'allow-both' | 'model-only';

type WritePathPolicyRule = {
  mode?: WritePathPolicyMode;
  raw?: 'inherit' | 'allow' | 'block';
  management?: 'inherit' | 'allow' | 'block';
  onViolation?: 'throw' | 'warn';
};

type WritePathPolicyOptions = {
  default?: WritePathPolicyMode | WritePathPolicyRule;
  namespaces?: Record<string, WritePathPolicyMode | WritePathPolicyRule>;
};
```

| 字段 | 默认值 | 含义 |
|------|--------|------|
| `mode` | `allow-both` | `allow-both` 允许 collection 与 Model 写入。`model-only` 会阻断直接 collection、db、legacy 写入，除非命名空间规则覆盖。 |
| `raw` | `inherit` | 控制 `collection.raw()`、`db.raw()` 与 db command 入口。`model-only` 下继承为 `block`，`allow-both` 下继承为 `allow`。 |
| `management` | `inherit` | 控制索引、集合、validator 等管理操作。`model-only` 下 Model 管理方法允许，直接 collection 管理方法阻断。 |
| `onViolation` | `throw` | `throw` 会拒绝操作；`warn` 只记录告警并放行。 |

## 命名空间匹配

命名空间规则按从具体到宽泛的顺序匹配：

1. 内部实例命名空间（存在时）。
2. 池级命名空间：`poolName:dbName.collectionName`。
3. 数据库命名空间：`dbName.collectionName`。
4. 仅集合名。
5. `default`。

用户配置中建议优先使用 `poolName:dbName.collectionName` 或 `dbName.collectionName`，它们不依赖运行时实例 ID。

在 `namespaces` 内，`default` 是 fallback 匹配器保留 key，构造期会被拒绝；全局默认规则应使用顶层 `writePathPolicy.default`。如果真实集合名就是 `default`，请使用 `dbName.default` 或 `poolName:dbName.default` 这类限定 key。命名空间 key 不能包含首尾空白。

## 生效范围

`writePathPolicy` 作用于具备写副作用的入口：

- Collection 写操作：`insertOne`、`insertMany`、`updateOne`、`updateMany`、`replaceOne`、`findOneAndUpdate`、`findOneAndReplace`、`findOneAndDelete`、`upsertOne`、`deleteOne`、`deleteMany`。
- 批量 helper：`insertBatch`、`updateBatch`、`deleteBatch`、`incrementOne`。
- Collection 管理操作：索引创建/删除、集合创建/删除、validator、`renameCollection`、`collMod`、capped 转换。
- Raw/db/legacy 写入口：`collection.raw()`、`db.raw()`、`db.runCommand()`、`dropDatabase()`、legacy adapter 写操作。
- 最后阶段包含 `$out` 或 `$merge` 的聚合管道；策略按实际写入目标 namespace 判断。

只读查询不受该策略约束。

## model-only 示例

```ts
const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'app',
  config: { uri: 'mongodb://localhost:27017' },
  writePathPolicy: { default: 'model-only' }
});

MonSQLize.Model.define('users', {
  schema: {},
  options: {
    timestamps: true,
    version: true,
    softDelete: true
  }
});

await msq.connect();

await msq.model('users').insertOne({ name: 'Ada' }); // 允许
await msq.collection('users').insertOne({ name: 'Ada' }); // 抛错
```

对确实需要保留原生写入口的运维集合，可以使用命名空间覆盖：

```ts
const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'app',
  config: { uri: 'mongodb://localhost:27017' },
  writePathPolicy: {
    default: 'model-only',
    namespaces: {
      'app.audit_logs': 'allow-both'
    }
  }
});
```

## 边界

该策略只约束“通过哪个 API 入口发起写操作”。它不会让缓存失效变成数据库事务的原子步骤，也不会让 Change Stream 同步变成 exactly-once，更不能替代业务幂等或权限控制。
