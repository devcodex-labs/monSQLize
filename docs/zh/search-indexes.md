# Search 索引生命周期

从 v3.4.0 起，集合访问器和 Model 可以创建、查看、更新、删除并等待 MongoDB Search 索引。**Search 索引**的类型为全文 `search` 或 `vectorSearch`。查询 `vectorSearch` 类型的 Search 索引请使用 [`vectorSearch()`](vector-search.md)。

## 环境要求

- MongoDB Atlas、带 `mongot` 的 MongoDB Community / Enterprise 8.2+，或本地镜像 `mongodb/mongodb-atlas-local`。
- 普通 `mongod`（包括 `mongodb-memory-server`）不支持 Search 索引命令，调用会以 `SEARCH_INDEX_UNSUPPORTED` 拒绝。
- 服务端异步构建索引。create、update、drop 在服务端接受命令后即返回，需要结果时调用 `waitForSearchIndex()`。

## API

```ts
collection.createSearchIndex(spec: SearchIndexSpec, options?: { ifExists?: 'error' | 'skip' | 'update' })
  : Promise<{ name: string; action: 'created' | 'skipped' | 'updated'; created: boolean }>;
collection.createSearchIndexes(specs: SearchIndexSpec[]): Promise<string[]>;
collection.listSearchIndexes(options?: { type?: 'search' | 'vectorSearch' }): Promise<SearchIndexInfo[]>;
collection.getSearchIndex(name: string): Promise<SearchIndexInfo>;
collection.updateSearchIndex(name: string, definition: Record<string, unknown>): Promise<void>;
collection.dropSearchIndex(name: string, options?: { ignoreMissing?: boolean }): Promise<void>;
collection.waitForSearchIndex(name: string, options?: {
  until?: 'queryable' | 'ready' | 'dropped'; // 默认 'queryable'
  timeoutMs?: number;                        // 默认 300000
  intervalMs?: number;                       // 默认 2000，最小 100
  signal?: AbortSignal;
}): Promise<SearchIndexInfo>;
```

Model 上有同样的 7 个方法。

```ts
interface SearchIndexSpec {
  name: string;
  type: 'search' | 'vectorSearch';
  definition: Record<string, unknown>;
}

interface SearchIndexInfo {
  name: string;
  status: 'PENDING' | 'BUILDING' | 'READY' | 'FAILED' | 'STALE' | 'DELETING' | 'DOES_NOT_EXIST';
  queryable: boolean;
  type?: 'search' | 'vectorSearch';
  typeSource: 'server' | 'inferred' | 'unknown';
  id?: string;
  latestDefinition?: Record<string, unknown>;
  latestDefinitionVersion?: { version: number; createdAt: Date };
  statusDetail?: Array<Record<string, unknown>>;
  raw: Record<string, unknown>;
}
```

## 行为

| 方法 | 行为 |
|------|------|
| `createSearchIndex` | 校验定义，再按 `ifExists` 处理。 |
| `createSearchIndexes` | 全部校验后一次提交。 |
| `listSearchIndexes` | 返回归一化条目。可用 `type` 过滤。 |
| `getSearchIndex` | 名称不存在时返回 `DOES_NOT_EXIST`。 |
| `updateSearchIndex` | 替换定义，由服务端重建。 |
| `dropSearchIndex` | 删除索引；`ignoreMissing` 时直接返回。 |
| `waitForSearchIndex` | 轮询到目标条件、超时或中止。 |

### createSearchIndex

调用先做本地校验，再查找同名索引。

- 默认 `ifExists: 'error'`：已存在时以 `SEARCH_INDEX_EXISTS` 拒绝。
- `'skip'`：不改动已有索引，返回 `action: 'skipped'`。
- `'update'`：替换定义，返回 `action: 'updated'`。
- 类型变化以 `INVALID_SEARCH_INDEX_DEFINITION` 拒绝。需要先删除再创建。

### createSearchIndexes

全部 spec 校验通过后一次提交。不支持 `ifExists`。名称重复时以 `SEARCH_INDEX_EXISTS` 拒绝。

### listSearchIndexes 与 getSearchIndex

`listSearchIndexes` 返回归一化后的条目。`type` 按解析出的类型过滤。`typeSource: 'unknown'` 的条目不会命中该过滤。

`getSearchIndex` 在索引不存在时返回 `status: 'DOES_NOT_EXIST'`，不抛错。

### updateSearchIndex

调用替换定义。服务端异步重建索引。重建期间，上一版可以继续提供查询。

各部署上报的 `queryable` 并不相同。Community 8.2.12 保持 `true`。atlas-local 8.3.13 在 `search` 类型重建期间上报 `false`，但 `$search` 仍返回结果。两者均为实测。索引不存在时以 `SEARCH_INDEX_NOT_FOUND` 拒绝。

对 `vectorSearch` 类型的 Search 索引执行原地 `updateSearchIndex`，取决于部署环境：

| 部署 | 原地更新 |
|------|----------|
| MongoDB Atlas | 文档写明支持。monSQLize 未实测。 |
| atlas-local 8.3.13 | 拒绝。服务端 `BadValue`（2）。已实测。 |
| Community 8.2.12 + community-search | 接受。重建期间查询继续返回。已实测。 |

MongoDB Atlas 文档说明重建期间旧索引继续提供查询。monSQLize 没有实测这条路径。

`mongodb/mongodb-atlas-local`（mongod 8.3.13）以 `BadValue`（2）拒绝更新，消息为 `"mappings" is required`。

Community 8.2.12 配合 `mongodb/mongodb-community-search` 会接受更新。20,000 篇文档、64 维的一次实测重建约 30 秒，期间 `$vectorSearch` 持续返回结果。

在所有实测环境中，服务端都不接受 `updateSearchIndex` 命令带 `type` 字段（`IDLUnknownField`）。带上该字段也没有用。服务端拒绝时，monSQLize 原样透出为 `MONGODB_ERROR`（带 `serverCode`），不会自动降级。

不能原地更新时，用换名切换避免中断：用新名字创建索引，调用 `waitForSearchIndex(newName, { until: 'queryable' })`，把查询切到新名字，再删除旧索引。期间两个索引同时存在，会额外占用资源，并计入索引数量上限（Atlas Free 档 3 个 Search 索引，Flex 档 10 个）。

如果能接受短暂中断，可以先删除索引、等待 `dropped`、再重新创建。在它重新可查询之前，检索会失败。中断时长随数据量增长。atlas-local 上 50,000 篇文档、64 维约 1–2 秒。

`status` 原样透传服务端的值。判断能否检索看 `queryable`，展示进度看 `status`。

### dropSearchIndex

索引不存在时以 `SEARCH_INDEX_NOT_FOUND` 拒绝，除非 `ignoreMissing: true`。

### 索引类型

类型优先取服务端返回的顶层 `type` 字段（`typeSource: 'server'`）。自建 `mongot` 不返回该字段（见 [MongoDB 限制说明](https://www.mongodb.com/docs/search/self-managed/current/limitations/)）。此时根据 `latestDefinition` 推断（`typeSource: 'inferred'`）：`fields` 数组中有 `type: 'vector'` 的项即为 `vectorSearch`，有 `mappings` 键即为 `search`。两者都没有时不返回 `type`，`typeSource` 为 `'unknown'`。

### waitForSearchIndex

| `until` | 何时返回 | 遇到 `FAILED` | 索引不存在 |
|---------|----------|---------------|------------|
| `queryable` | `queryable` 为 true | 不可查询时拒绝 | 宽限 30 秒后未找到 |
| `ready` | `status` 为 `READY` | 拒绝 | 同样宽限 30 秒 |
| `dropped` | `status` 为 `DOES_NOT_EXIST` | 继续等待 | 直接返回 |

`until: 'queryable'` 时，仅在索引不可查询的情况下，`FAILED` 以 `SEARCH_INDEX_BUILD_FAILED` 拒绝。`until: 'ready'` 时，`FAILED` 以 `SEARCH_INDEX_BUILD_FAILED` 拒绝。`until: 'dropped'` 时，`FAILED` 继续等待。

`queryable` 或 `ready` 下索引不存在时，最多再等 30 秒，之后以 `SEARCH_INDEX_NOT_FOUND` 拒绝。`dropped` 下索引不存在时直接返回。

方法每隔 `intervalMs` 查询一次。超时以 `SEARCH_INDEX_WAIT_TIMEOUT` 拒绝，`details[0].last` 是最后一次观察到的状态。`signal` 中止时原样以 `signal.reason` 拒绝。

## writePathPolicy

`createSearchIndex`、`createSearchIndexes`、`updateSearchIndex`、`dropSearchIndex` 与 `createIndex()` 一样属于 `management` 操作。在 `model-only` 且 `management: 'inherit'` 时，Model 调用放行，直接调用集合会以 `INVALID_OPERATION` 拒绝。读方法（`listSearchIndexes`、`getSearchIndex`、`waitForSearchIndex`）不受限制。

## 错误码

| 码 | 何时出现 |
|----|----------|
| `INVALID_SEARCH_INDEX_DEFINITION` | 本地校验失败，或 `update` 改变了类型 |
| `SEARCH_INDEX_EXISTS` | 同名已存在，或批量创建里名称重复 |
| `SEARCH_INDEX_NOT_FOUND` | 更新、删除或等待的目标不存在 |
| `SEARCH_INDEX_UNSUPPORTED` | 部署不支持 Search 索引命令 |
| `SEARCH_INDEX_BUILD_FAILED` | `waitForSearchIndex` 观察到 `FAILED` |
| `SEARCH_INDEX_WAIT_TIMEOUT` | `waitForSearchIndex` 超过 `timeoutMs` |

本地校验覆盖名称、类型、定义和选项。`ifExists: 'update'` 也会拒绝类型变化。`SEARCH_INDEX_NOT_FOUND` 包括 `waitForSearchIndex` 在宽限期后仍未看到索引。

由服务端返回的错误都把驱动原错误放在 `cause`。没有专用码的服务端错误以 `MONGODB_ERROR` 拒绝，`details[0]` 带 `serverCode`、`serverCodeName`、`serverMessage`，并附加 `error.monsqlize = { operation, namespace, indexName }`。详见[错误码参考](error-codes.md)。

## 示例

```ts
const docs = msq.collection('docs');

await docs.createSearchIndex({
  name: 'embedding_idx',
  type: 'vectorSearch',
  definition: {
    fields: [
      { type: 'vector', path: 'embedding', numDimensions: 1536, similarity: 'cosine' },
      { type: 'filter', path: 'tenantId' },
    ],
  },
}, { ifExists: 'skip' });
await docs.waitForSearchIndex('embedding_idx', { until: 'queryable', timeoutMs: 600_000 });

await docs.createSearchIndex({ name: 'text_idx', type: 'search', definition: { mappings: { dynamic: true } } });
const info = await docs.getSearchIndex('text_idx');
console.log(info.status, info.queryable);

await docs.dropSearchIndex('text_idx', { ignoreMissing: true });
await docs.waitForSearchIndex('text_idx', { until: 'dropped' });
```

用 [`vectorSearch()`](vector-search.md) 查询 `vectorSearch` 类型的 Search 索引。可运行的创建、等待和查询示例是 [`examples/docs/vector-search.ts`](../../examples/docs/vector-search.ts)。它需要 MongoDB Atlas、`mongodb/mongodb-atlas-local`，或带 `mongot` 的 Community / Enterprise 8.2+，并通过 `MONSQLIZE_VECTOR_SEARCH_URI` 或 `MONSQLIZE_ATLAS_LOCAL_URI` 连接。
