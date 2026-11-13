# 向量查询

`collection.vectorSearch()` 会执行 MongoDB `$vectorSearch` 查询，并为每条命中记录返回稳定的分数信封。

## 前置条件

该 API 需要支持 Vector Search 的 MongoDB 部署，以及一个已经创建好的 Search 索引（`vectorSearch` 类型）。**Search 索引**指 MongoDB Search 索引，类型为全文 `search` 或 `vectorSearch`。从 v3.4.0 起可以使用 [Search 索引生命周期 API](search-indexes.md) 管理该索引。请保证索引配置中的向量维度、数值表示和索引字段路径与传入 API 的 embedding 一致。部署和索引要求请参考 [MongoDB `$vectorSearch` 文档](https://www.mongodb.com/docs/vector-search/query/aggregation-stages/vector-search-stage/)。

`$vectorSearch` 必须是它所在管道的第一个阶段。当前 MongoDB 文档仍然不允许把它放进 `$lookup` 子管道或 `$facet` 阶段（[手册](https://www.mongodb.com/docs/manual/reference/operator/aggregation/vectorsearch/)、[Vector Search 阶段](https://www.mongodb.com/docs/vector-search/query/aggregation-stages/vector-search-stage/)）。请用 `vectorSearch()` 作为检索入口，需要补充关联信息时再处理命中文档。

## API

```ts
collection.vectorSearch<TDocument = TSchema>(options: VectorSearchOptions)
  : Promise<Array<VectorSearchHit<TDocument>>>;

model.vectorSearch(options: ModelVectorSearchOptions)
  : Promise<Array<VectorSearchHit<ModelDocument<TDocument>>>>;
```

```ts
import type { Binary } from 'mongodb';

interface VectorSearchOptions {
  index: string;
  path: string;
  queryVector: number[] | Binary;
  limit: number;
  numCandidates?: number;
  exact?: boolean;
  filter?: Record<string, unknown>;
  projection?: Record<string, unknown> | string[];
  aggregateOptions?: VectorSearchAggregateOptions;
}

interface VectorSearchHit<TDocument> {
  document: TDocument;
  score: number;
}

interface ModelVectorSearchOptions extends VectorSearchOptions {
  withDeleted?: boolean;
  onlyDeleted?: boolean;
}
```

`document` 是返回的源文档，`score` 单独放在结果信封中，因此不会覆盖业务文档中的同名字段。

## 近似最近邻查询（ANN）

默认 ANN 模式下，`numCandidates` 必填，且必须是大于等于 `limit` 的正整数。

```ts
type Article = {
  _id: string;
  title: string;
  summary: string;
  status: 'draft' | 'published';
};

const articles = runtime.collection<Article>('articles');
const queryEmbedding = [0.12, -0.08, 0.44];

const hits = await articles.vectorSearch({
  index: 'articles_embedding_index',
  path: 'embedding',
  queryVector: queryEmbedding,
  limit: 5,
  numCandidates: 100,
  filter: { status: 'published' },
  projection: ['title', 'summary', 'status'],
  aggregateOptions: {
    maxTimeMS: 5_000,
    comment: 'related-articles',
  },
});

for (const { document, score } of hits) {
  console.log(score, document.title);
}
```

`filter` 是 Vector Search 的预过滤条件，不是后置 `$match`。依赖该条件前，需要先在 Search 索引（`vectorSearch` 类型）中配置相应的过滤字段。

## 精确最近邻查询（ENN）

设置 `exact: true` 可启用精确最近邻查询，同时必须省略 `numCandidates`。

```ts
const hits = await runtime.collection('articles').vectorSearch({
  index: 'articles_embedding_index',
  path: 'embedding',
  queryVector: queryEmbedding,
  limit: 5,
  exact: true,
});
```

## 量化与 BSON 查询向量

BSON int8/int1 输入从 3.6.0 开始提供。对仅接收数组的较早版本，可通过 `collection.aggregate()` 中的原生 `$vectorSearch` 阶段执行 BSON 查询；安装前请核实目标版本已在 registry 发布。

自动量化保留存储的数值数组和查询数组：在 Search 索引的向量字段设置 `quantization: 'scalar'` 或 `'binary'`，调用 `vectorSearch()` 时继续传原始有限 `number[]`，由服务端量化。

预量化向量则使用 MongoDB `Binary` 的 **subtype 9**，其内部 dtype 为 int8（`0x03`）或 packed-bit int1（`0x10`）。本源码增量直接接收这两种表示：

```ts
import { Binary } from 'mongodb';

const queryVector = Binary.fromInt8Array(Int8Array.of(-12, 7, 21, -8, 4, 16, -5, 9));
const hits = await runtime.collection('articles').vectorSearch({
  index: 'articles_int8_index', path: 'embeddingInt8', queryVector,
  limit: 5, numCandidates: 100,
});
```

存储数据、查询表示和 embedding 模型必须匹配。上例对应八维、cosine 索引，int8 不需要额外的 `quantization` 设置。工厂方法负责封装数值，不负责生成 embedding。请使用与 monSQLize 驱动可序列化兼容的 mongodb/BSON 版本。

int1 可使用 `Binary.fromBits([1, 0, 1, 0, 1, 0, 1, 0])` 或 `Binary.fromPackedBits(...)` 构造查询；存储表示保持一致，索引使用 euclidean，相应维度为八的倍数。ANN、ENN 和 Model 均使用相同 BSON 输入契约。

不要将 int8/int1 解码成 `number[]` 后查询预量化字段：实测 8.2.12 + mongot 0.69.1 会返回 `[]`，没有错误。对浮点数组使用自动 binary 量化是另一种场景，仍接受数值查询数组。

便利接口只接收非空 int8/int1 Binary 向量；float32 Binary、其他 subtype/dtype、裸 Buffer/TypedArray 及 JSON/EJSON 对象均在本地拒绝。它保留有效 `position` 字节和 padding，在异步执行前复制输入，不修改调用方对象。本地检查格式，维度和相似度匹配由服务端判定。其他原生格式可使用 `aggregate()`。

## Model 层向量查询

`model.vectorSearch()` 与 Collection 方法使用相同的索引、ANN/ENN 校验和结果信封；它额外负责 Model 可见性与文档 hydrate：

- 开启软删除的 Model 会把默认可见性条件合并到 `$vectorSearch.filter`，不会在前面插入 `$match`。
- `withDeleted: true` 保留调用方 filter；`onlyDeleted: true` 仅搜索软删除文档（同时设置 `withDeleted` 时仍以 `withDeleted` 为准）。
- 命中文档是 hydrate 后的 Model 文档，因此可以继续调用 `hit.document.populate('author')`；服务端返回的 score 与命中顺序保持不变。

```ts
const hits = await runtime.model<Article>('articles').vectorSearch({
  index: 'articles_embedding_index',
  path: 'embedding',
  queryVector: queryEmbedding,
  limit: 5,
  numCandidates: 100,
  filter: { tenantId: 'tenant-a' },
});

await hits[0]?.document.populate('author');
```

## 校验与执行行为

方法在访问 MongoDB 前会先做本地校验：

- `index` 和 `path` 必须为非空字符串。
- `queryVector` 必须是非空有限数字数组，或合法的 BSON subtype 9 int8/int1 向量；稀疏数组、undefined、非有限数字均无效。二进制元数据、有效长度和 padding 必须合法。
- `limit` 必须为正整数。
- ANN 要求 `numCandidates >= limit`；ENN 不允许 `numCandidates`。
- `filter`、`projection` 和 `aggregateOptions` 必须使用受支持的数据形状。

不合法的向量参数会抛出 `INVALID_VECTOR_SEARCH`，并携带字段与原因详情。Model 专用的 `withDeleted` 与 `onlyDeleted` 必须为布尔值。调用会复用 monSQLize 既有的聚合执行链，但为了保证始终返回 `VectorSearchHit[]`，会拒绝 `aggregateOptions.meta`、`aggregateOptions.stream` 和 `aggregateOptions.explain`。

部署、索引或其他 MongoDB 执行失败会保留原始 driver 的 code 和 message 后重新抛出。错误对象可写时，monSQLize 会附加 `error.monsqlize.operation === 'vectorSearch'` 和目标 namespace，便于诊断。

Search 索引（含 `vectorSearch` 类型）的管理见 [Search 索引生命周期](search-indexes.md)：`createSearchIndex`、`updateSearchIndex`、`dropSearchIndex`、`listSearchIndexes`、`waitForSearchIndex`。

## 运行注意事项

- 默认本地 `mongodb-memory-server` 不支持 Vector Search。端到端验证需要 Atlas、`mongodb/mongodb-atlas-local` 或兼容的自建 mongod/mongot 配对。可运行示例是 [`examples/docs/vector-search.ts`](../../examples/docs/vector-search.ts)，覆盖数字数组和 BSON int8/int1。请设置 `MONSQLIZE_VECTOR_SEARCH_URI` 或 `MONSQLIZE_ATLAS_LOCAL_URI`；均未设置时明确跳过 Search 调用。
- 向量排序分数由 MongoDB 生成，monSQLize 只返回该分数，不会在本地二次排序。
- 请让写入端和查询端使用一致的 embedding 模型、向量维度和索引配置。

## 可选真实环境验证

安装项目开发依赖后，仅对已授权、可丢弃的 Search 环境执行源码矩阵：

```bash
MONSQLIZE_VECTOR_SEARCH_URI='mongodb://127.0.0.1:27017/?directConnection=true' \
MONSQLIZE_SEARCH_REAL_OUT='/absolute/outside-repo/search-results.json' \
npm run test:search:real
```

验证器创建随机 `msq_search_real_*` 数据库，写入种子及 Search 索引，最后只删除该库并关闭本次连接。它对照原生驱动与 Collection/Model，覆盖自动 scalar/binary、预量化 int8/int1、全文分数、`$searchMeta` 计数及同集合 `$rankFusion`/`$scoreFusion`。失败和清理错误保留，失败退出码非零。

`MONSQLIZE_VECTOR_SEARCH_URI` 优先于 `MONSQLIZE_ATLAS_LOCAL_URI`。均缺失时报告 `skipped` 并以零退出，不能当作真实验证通过。`MONSQLIZE_SEARCH_REAL_TIMEOUT_MS` 是正安全整数毫秒，默认每个索引等待 600000；显式无效配置在连接前失败。结果默认写 stdout，`MONSQLIZE_SEARCH_REAL_OUT` 可选写同一结果文件，写入失败也使整次运行失败。输出副本会屏蔽 URI 凭据。

请将真实 mongot 版本或镜像摘要与报告一并保存，不能由 URI 推断该信息。MongoDB 8.2 已 EOL；新部署使用[现行自建配对表](https://www.mongodb.com/docs/search/self-managed/current/deployment/compatibility-requirements/)，mongot 1.70.1+ 不与 8.2 配对。历史 8.2.12 + 0.69.1 实测不代表任意组合可用；8.2 上的融合结果属于该版本预览范围。
