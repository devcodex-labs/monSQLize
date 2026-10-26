# Search 索引生命周期

从 v3.4.0 起，集合访问器和 Model 可以创建、查看、更新、删除并等待 MongoDB Search 索引。同一套接口同时支持全文 `search` 索引和 `vectorSearch` 索引；查询向量索引请使用 [`vectorSearch()`](vector-search.md)。

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
| `createSearchIndex` | 先做本地校验，再检查是否已有同名索引。默认 `ifExists: 'error'` 时以 `SEARCH_INDEX_EXISTS` 拒绝；`'skip'` 不做改动（`action: 'skipped'`）；`'update'` 替换定义（`action: 'updated'`），但类型不同时以 `INVALID_SEARCH_INDEX_DEFINITION` 拒绝，需要先删除再创建。 |
| `createSearchIndexes` | 全部校验通过后一次提交；不支持 `ifExists`，名称重复时以 `SEARCH_INDEX_EXISTS` 拒绝。 |
| `listSearchIndexes` | 返回归一化后的条目；`type` 按解析出的类型过滤。 |
| `getSearchIndex` | 索引不存在时返回 `status: 'DOES_NOT_EXIST'`，不抛错。 |
| `updateSearchIndex` | 替换定义，服务端随后重建；重建期间旧版本可以继续提供查询（`queryable` 保持 `true`）。索引不存在时以 `SEARCH_INDEX_NOT_FOUND` 拒绝。 |
| `dropSearchIndex` | 索引不存在时以 `SEARCH_INDEX_NOT_FOUND` 拒绝；传 `ignoreMissing: true` 则直接返回。 |
| `waitForSearchIndex` | 每隔 `intervalMs` 查询一次，规则见下表。 |

`status` 原样透传服务端的值。判断能否检索看 `queryable`，展示进度看 `status`。

### 索引类型

类型优先取服务端返回的顶层 `type` 字段（`typeSource: 'server'`）。自建 `mongot` 不返回该字段（见 [MongoDB 限制说明](https://www.mongodb.com/docs/search/self-managed/current/limitations/)），此时根据 `latestDefinition` 推断（`typeSource: 'inferred'`）：`fields` 数组中有 `type: 'vector'` 的项即为 `vectorSearch`，有 `mappings` 键即为 `search`。两者都没有时不返回 `type`，`typeSource` 为 `'unknown'`，这类条目不会被 `listSearchIndexes({ type })` 匹配。

### waitForSearchIndex

| `until` | 何时返回 | 遇到 `FAILED` | 索引不存在 |
|---------|----------|---------------|------------|
| `queryable` | `queryable === true` | 仅在不可查询时以 `SEARCH_INDEX_BUILD_FAILED` 拒绝 | 最多再等 30 秒，之后以 `SEARCH_INDEX_NOT_FOUND` 拒绝 |
| `ready` | `status === 'READY'` | 以 `SEARCH_INDEX_BUILD_FAILED` 拒绝 | 同上 |
| `dropped` | `status === 'DOES_NOT_EXIST'` | 继续等待 | 直接返回 |

超时以 `SEARCH_INDEX_WAIT_TIMEOUT` 拒绝，`details[0].last` 是最后一次观察到的状态。`signal` 中止时原样以 `signal.reason` 拒绝。

## writePathPolicy

`createSearchIndex`、`createSearchIndexes`、`updateSearchIndex`、`dropSearchIndex` 与 `createIndex()` 一样属于 `management` 操作。在 `model-only` 且 `management: 'inherit'` 时，Model 调用放行，直接调用集合会以 `INVALID_OPERATION` 拒绝。读方法（`listSearchIndexes`、`getSearchIndex`、`waitForSearchIndex`）不受限制。

## 错误码

| 码 | 何时出现 |
|----|----------|
| `INVALID_SEARCH_INDEX_DEFINITION` | 本地校验失败（名称、类型、定义、选项），或 `ifExists: 'update'` 的目标是另一种类型的索引 |
| `SEARCH_INDEX_EXISTS` | 已有同名索引且 `ifExists: 'error'`，或 `createSearchIndexes` 中名称重复 |
| `SEARCH_INDEX_NOT_FOUND` | `updateSearchIndex` / `dropSearchIndex` 的目标不存在；`waitForSearchIndex` 在宽限期后仍未看到索引 |
| `SEARCH_INDEX_UNSUPPORTED` | 部署不支持 Search 索引命令 |
| `SEARCH_INDEX_BUILD_FAILED` | `waitForSearchIndex` 观察到 `FAILED` |
| `SEARCH_INDEX_WAIT_TIMEOUT` | `waitForSearchIndex` 超过 `timeoutMs` |

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
