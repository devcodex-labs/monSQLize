# 向量查询

`collection.vectorSearch()` 会执行 MongoDB `$vectorSearch` 查询，并为每条命中记录返回稳定的分数信封。

## 前置条件

该 API 需要支持 Vector Search 的 MongoDB 部署，以及一个已经创建好的 Vector Search 索引。本版本 monSQLize 不创建、更新或删除 Vector Search 索引。请保证索引配置中的向量维度、数值表示和索引字段路径与传入 API 的 embedding 一致。部署和索引要求请参考 [MongoDB `$vectorSearch` 文档](https://www.mongodb.com/docs/vector-search/query/aggregation-stages/vector-search-stage/)。

`$vectorSearch` 必须是聚合管道的第一个阶段；它也不能放在 `$lookup` 子管道或 `$facet` 中。因此应以集合级 API 作为检索入口，如需补充关联信息，再对命中文档做后续处理。

## API

```ts
collection.vectorSearch<TDocument = TSchema>(options: VectorSearchOptions)
  : Promise<Array<VectorSearchHit<TDocument>>>;

model.vectorSearch(options: ModelVectorSearchOptions)
  : Promise<Array<VectorSearchHit<ModelDocument<TDocument>>>>;
```

```ts
interface VectorSearchOptions {
  index: string;
  path: string;
  queryVector: number[];
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

`filter` 是 Vector Search 的预过滤条件，不是后置 `$match`。依赖该条件前，需要先在 Vector Search 索引中配置相应的过滤字段。

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
- `queryVector` 必须是非空且每项为有限数字的数组。
- `limit` 必须为正整数。
- ANN 要求 `numCandidates >= limit`；ENN 不允许 `numCandidates`。
- `filter`、`projection` 和 `aggregateOptions` 必须使用受支持的数据形状。

不合法的向量参数会抛出 `INVALID_VECTOR_SEARCH`，并携带字段与原因详情。Model 专用的 `withDeleted` 与 `onlyDeleted` 必须为布尔值。调用会复用 monSQLize 既有的聚合执行链，但为了保证始终返回 `VectorSearchHit[]`，会拒绝 `aggregateOptions.meta`、`aggregateOptions.stream` 和 `aggregateOptions.explain`。

部署、索引或其他 MongoDB 执行失败会保留原始 driver 的 code 和 message 后重新抛出。错误对象可写时，monSQLize 会附加 `error.monsqlize.operation === 'vectorSearch'` 和目标 namespace，便于诊断。

本版本同时在 `Collection` 和 `Model` 上提供向量查询；不会提供向量索引生命周期 API。

## 运行注意事项

- 默认本地 `mongodb-memory-server` 不支持 Vector Search。单元测试覆盖管道构造和参数校验；端到端验证需要外部准备的兼容部署和索引。
- 向量排序分数由 MongoDB 生成，monSQLize 只返回该分数，不会在本地二次排序。
- 请让写入端和查询端使用一致的 embedding 模型、向量维度和索引配置。
