# 数据任务 API 参考

`dataTasks` 用一份 `DataTaskJob` 配置完成发布范围内的索引确保、筛选数据同步、局部字段调整、预览审批、受影响范围备份和恢复。

如果你先要判断自己的场景是否适用，请先看[生产数据迁移同步](./production-data-migration.md)。生产发布的整体顺序见[生产发布与迁移](./production-rollout.md)。

## 入口与四个方法

ESM 使用命名导出：

```ts
import MonSQLize, { dataTasks, type DataTaskJob } from 'monsqlize';
```

CommonJS 从包对象读取同名导出：

```js
const { dataTasks } = require('monsqlize');
```

公开入口只有四个方法：

| 方法 | 是否写数据库 | 作用 |
|------|:------------:|------|
| `preview(job, options?)` | 否 | 读取索引和数据，生成差异、备份估算和短期 approval |
| `apply(job, { approval })` | 是 | 重新规划并校验 approval，备份后执行索引和数据写入 |
| `previewRestore(backup, options?)` | 否 | 校验 manifest、目标现状和可恢复动作，生成恢复 approval |
| `restore(backup, { approval, target? })` | 是 | 先创建恢复安全备份，再恢复文档和本任务创建的索引 |

dataTasks 不是实例方法，不需要创建任务 runner，也没有第二套步骤配置。

## 完整配置

```ts
const development = new MonSQLize({
  type: 'mongodb',
  databaseName: 'development',
  config: { uri: process.env.SOURCE_MONGODB_URI! }
});

const production = new MonSQLize({
  type: 'mongodb',
  databaseName: 'production',
  config: { uri: process.env.TARGET_MONGODB_URI! }
});

await Promise.all([development.connect(), production.connect()]);

const job = {
  name: 'release-2026-07-feature-modules',
  description: '同步本次发布需要的功能模块',
  source: development,
  target: production,
  targetEnvironment: 'production',
  collections: [{
    name: 'feature_modules',
    targetName: 'feature_modules',
    indexes: [
      { key: { code: 1 }, options: { unique: true } },
      { key: { release: 1, enabled: 1 } }
    ],
    data: {
      filter: { release: '2026-07' },
      projection: {
        _id: 1,
        code: 1,
        legacyName: 1,
        enabled: 1,
        developmentOnly: 1
      },
      identity: { mode: 'fields', fields: ['code'] },
      strategy: 'upsert',
      rename: { legacyName: 'name' },
      set: { schemaVersion: 2 },
      unset: ['developmentOnly'],
      batchSize: 500,
      maxDocuments: 10_000
    },
    verify: {
      mode: 'full',
      fields: ['code', 'name', 'enabled', 'schemaVersion']
    }
  }],
  backup: {
    dir: './.monsqlize/data-tasks',
    format: 'extended-jsonl',
    compression: 'gzip',
    retentionDays: 7,
    maxBytes: 256 * 1024 * 1024
  },
  lock: { ttlMs: 120_000, waitTimeoutMs: 0 }
} satisfies DataTaskJob;
```

SDK 的 `source`、`target` 可以是已连接的 monSQLize 实例，连接生命周期由调用方管理。CLI 配置必须使用两个 `MonSQLizeOptions`，dataTasks 会在完成或失败后关闭自己创建的连接。

SDK 进程结束前应在 `finally` 中关闭上面两个实例；可运行的完整生命周期见 [`examples/docs/data-tasks.ts`](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/data-tasks.ts)。

## Job 参数

| 路径 | 必填 | 默认值 | 说明 |
|------|:----:|--------|------|
| `name` | 是 | - | 稳定任务名，进入 job hash、approval 和 manifest |
| `description` | 否 | 无 | 人类可读说明，不改变执行语义 |
| `source` | 是 | - | 只读来源 runtime 或 MongoDB `MonSQLizeOptions` |
| `target` | 是 | - | 独立目标 runtime 或 MongoDB `MonSQLizeOptions` |
| `targetEnvironment` | 是 | - | `development/test/staging/production/prod/live`；生产别名启用持久备份要求 |
| `collections` | 是 | - | 非空数组；同一目标集合只能出现一次 |
| `backup` | 生产必填 | 非生产使用系统临时目录 | 本次受影响范围的回滚包设置 |
| `lock` | 否 | `false` | `true` 或租约参数；防止两个 dataTasks 同时写同一目标 |

每个 collection 至少配置非空 `indexes`、`data`，或两者都配置。

## Collection 与索引参数

| 路径 | 必填 | 默认值 | 说明 |
|------|:----:|--------|------|
| `collections[].name` | 是 | - | 来源集合名 |
| `collections[].targetName` | 否 | 与 `name` 相同 | 目标集合名 |
| `collections[].indexes` | 条件 | `[]` | 本次需要确保存在的索引数组，不复制来源全部索引 |
| `indexes[].key` | 是 | - | 保持字段顺序的 MongoDB 索引 key |
| `indexes[].name` | 否 | 由 MongoDB 生成 | 可读性需要时显式填写；恢复始终使用数据库实际返回的名称 |
| `indexes[].options` | 否 | `{}` | driver 索引选项；不要把 `name` 放进 `options` |

preview 对每个目标集合先调用 `listIndexes()`，再把声明索引分成 `existing`、`missing`、`conflict`。apply 只创建 `missing`，不会自动 drop、rename 或 rebuild 冲突索引。

`identity.mode: 'fields'` 要求目标现有索引或本 collection 的声明索引中存在完全覆盖 identity 字段的非 partial unique index。缺失 unique index 需要验证目标最终镜像；安全扫描超过 10,000 个目标文档或遇到无法严格证明的特殊索引形态时会阻断。

## 数据参数

| 路径 | 必填 | 默认值 | 说明 |
|------|:----:|--------|------|
| `data.filter` / `data.all` | 二选一 | - | 非空筛选条件，或显式 `all: true`；空 filter 会被拒绝 |
| `data.identity` | 是 | - | 目标匹配规则，见下一节 |
| `data.strategy` | 否 | `upsert` | `upsert` 更新或插入；`insert` 遇到已有 identity 即失败 |
| `data.projection` | 否 | 全字段 | 来源投影；必须保留 identity、`conflictBy` 和 rename 来源字段 |
| `data.rename` | 否 | `{}` | 只重命名列出的字段，格式 `{ oldPath: 'newPath' }` |
| `data.set` | 否 | `{}` | 只设置列出的 BSON 字面量，支持点路径 |
| `data.unset` | 否 | `[]` | 只移除列出的字段路径 |
| `data.batchSize` | 否 | `500` | write-ahead checkpoint 批次，范围 `1..10000` |
| `data.maxDocuments` | 否 | `10000` | 本 collection 允许规划的最大来源文档数 |

dataTasks 的来源读取使用内部有界 stream，不继承普通查询的 `findLimit` 默认值。规划最多读取 `maxDocuments + 1` 条来源文档，因此并发增长会明确阻断，不会静默截断或无界加载。

字段调整顺序固定为 `filter -> projection -> rename -> set -> unset -> diff`。它只适合本次发布中少数字段的确定性调整：

- 路径不能是 `_id`、identity 字段，也不能互相重叠。
- 禁止 `__proto__`、`prototype`、`constructor` 等危险路径。
- rename 目标已存在且值不同时，preview 阻断，不会覆盖。
- 点路径穿过非对象值时，preview 阻断。
- `set` 只接受 BSON 可序列化字面量，不接受函数、随机值或数据库更新表达式。

## Identity 与 `_id`

业务键模式：

```ts
identity: { mode: 'fields', fields: ['tenantId', 'code'] }
```

它用稳定业务字段匹配。更新保留目标原有 `_id`；插入由目标 MongoDB 生成 `_id`。这适用于两套环境独立生成 `_id` 的普通发布数据。

来源 ID 模式：

```ts
identity: { mode: 'source-id', conflictBy: ['tenantId', 'code'] }
```

它要求两端 `_id` 完全一致。插入保留来源 `_id`；已有目标只有 `_id` 相同时才更新。`conflictBy` 用来发现业务键相同但 `_id` 不同的逻辑重复，发现后 preview 阻断。

## Verify、备份与锁

| 路径 | 默认值 | 说明 |
|------|--------|------|
| `verify.mode` | `sample` | `sample` 或 `full`，只控制字段内容比较强度 |
| `verify.fields` | 计划写入字段 | apply 后比较的字段路径 |
| `verify.sampleSize` | `20` | 稳定样本数量，范围 `1..1000` |
| `backup.format` | `extended-jsonl` | 保留 BSON 类型；当前只有这一种格式 |
| `backup.compression` | `gzip` | `gzip` 或 `none` |
| `backup.retentionDays` | `7` | 保留策略元数据；不会自动删除文件 |
| `backup.maxBytes` | 256 MiB | 未压缩回滚数据上限 |
| `lock.ttlMs` | `120000` | 目标数据库租约时长，运行中续租 |
| `lock.waitTimeoutMs` | `0` | 已有任务持锁时最多等待多久 |

索引、identity、数量、manifest 和实际写入始终全量验证；`verify.mode` 只影响用户指定字段的内容校验。

## Preview 与 Apply 流程

```ts
const preview = await dataTasks.preview(job, {
  sampleSize: 10,
  approvalTtlMs: 15 * 60 * 1000
});

if (!preview.passed || !preview.approval) {
  throw new Error(preview.errors.join('; '));
}

const result = await dataTasks.apply(job, { approval: preview.approval });
```

preview 零写入，返回每个 collection 的索引状态、`source/insert/update/unchanged/conflict`、变更样本、备份文档数和预估字节数。approval 绑定 job、转换后的来源数据、目标前像、目标索引和过期时间。

apply 的实际顺序：

1. 获取可选目标数据库租约。
2. 重新执行完整计划；任一 hash 漂移都会拒绝旧 approval。
3. 写入并回读校验受影响范围备份。
4. 再次读取索引，只创建审核过的 missing 索引。
5. 每批先记录 pending 操作，再按顺序执行数据写入。
6. 用目标前像 CAS 过滤器防止覆盖并发修改。
7. 回读完整预期后像，验证字段、identity、索引和 manifest。
8. 标记结果并释放租约。

索引和跨集合写入不是一个 MongoDB 事务。中途失败返回 `failed` 或 `partial`，保留 manifest，不自动恢复。

## 恢复

```ts
const restorePreview = await dataTasks.previewRestore(result.backup);
if (!restorePreview.passed || !restorePreview.approval) {
  throw new Error(restorePreview.errors.join('; '));
}

const restored = await dataTasks.restore(result.backup, {
  approval: restorePreview.approval
});
```

恢复前会核对目标是否仍等于 apply 后像，并识别数据库写入后、manifest checkpoint 前中断的 pending 操作。无法严格判断或目标后来又被修改时，以 `RESTORE_DRIFT` 阻断。

restore 写入前还会创建 recovery safety backup。恢复文档使用精确当前镜像过滤器；索引只处理本任务实际创建且定义未变化的索引。safety backup 也可以再次 previewRestore/restore，用于撤销一次恢复。

## CLI

任务文件必须直接导出 `DataTaskJob`，不要再包一层对象：

```js
module.exports = {
  name: 'release-settings',
  source: { type: 'mongodb', databaseName: 'development', config: { uri: process.env.SOURCE_URI } },
  target: { type: 'mongodb', databaseName: 'production', config: { uri: process.env.TARGET_URI } },
  targetEnvironment: 'production',
  collections: [{
    name: 'settings',
    data: { all: true, identity: { mode: 'source-id', conflictBy: ['code'] } }
  }],
  backup: { dir: './.monsqlize/data-tasks' }
};
```

```bash
monsqlize data-task preview --task ./tasks/release.cjs --out preview.json --json
monsqlize data-task apply --task ./tasks/release.cjs --approval preview.json --out result.json --json
monsqlize data-task preview-restore --task ./tasks/release.cjs --backup ./path/manifest.json --out restore-preview.json --json
monsqlize data-task restore --task ./tasks/release.cjs --backup ./path/manifest.json --approval restore-preview.json --json
```

配置错误、approval 过期或漂移、锁冲突、partial/failed、checksum 错误和恢复漂移都以退出码 `1` 结束。

## 错误码与能力边界

`DataTaskJobError` 提供 `code`、`phase` 和可选 `collection`。稳定错误码包括 `INVALID_JOB`、`IDENTITY_CONFLICT`、`INDEX_CONFLICT`、`APPROVAL_STALE`、`BACKUP_FAILED`、`LOCK_NOT_ACQUIRED`、`LOCK_LOST`、`APPLY_PARTIAL`、`RESTORE_DRIFT`、`RESTORE_FAILED`。

- backup 是本任务受影响范围的回滚包，不是全库备份或时间点恢复点。
- dataTasks 不同步 Model Schema，不复制来源全部索引，不维护版本目录，也不执行持续 CDC。
- 全库复制和灾难恢复使用 MongoDB 原生工具或托管备份。
- 首次回填后的持续变更使用 Change Stream sync。

## 相关文档

- [生产数据迁移同步](./production-data-migration.md)
- [生产发布与迁移](./production-rollout.md)
- [批量创建索引](./create-indexes.md)
- [Change Stream 同步](./sync-backup.md)
