# Vector search

`collection.vectorSearch()` executes a MongoDB `$vectorSearch` query and returns a stable score envelope for every match.

## Prerequisites

This API requires a MongoDB deployment that supports Vector Search and a Vector Search index that already exists. monSQLize does not create, update, or delete Vector Search indexes in this release. Configure the index and make its vector dimensions, numeric representation, and indexed path match the embeddings you send to the API. See the [MongoDB `$vectorSearch` reference](https://www.mongodb.com/docs/vector-search/query/aggregation-stages/vector-search-stage/) for deployment and index requirements.

`$vectorSearch` must be the first aggregation stage. It is also not supported inside a `$lookup` sub-pipeline or `$facet`, so use this collection-level API as the search entry point and enrich the resulting documents afterwards when needed.

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

`document` contains the returned source document. `score` is kept in a separate envelope, so it cannot overwrite an application document field.

## Approximate nearest-neighbor search (ANN)

For the default ANN mode, `numCandidates` is required and must be a positive integer greater than or equal to `limit`.

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

`filter` is a Vector Search pre-filter, not a later `$match` stage. Create the relevant filter fields in the Vector Search index before relying on them.

## Exact nearest-neighbor search (ENN)

Set `exact: true` for exact nearest-neighbor search and omit `numCandidates`.

```ts
const hits = await runtime.collection('articles').vectorSearch({
  index: 'articles_embedding_index',
  path: 'embedding',
  queryVector: queryEmbedding,
  limit: 5,
  exact: true,
});
```

## Model vector search

`model.vectorSearch()` uses the same index, ANN/ENN validation, and result envelope as the Collection method. Its only extra responsibilities are Model visibility and hydration:

- A soft-deleted Model merges its default visibility predicate into `$vectorSearch.filter`; it does not insert a preceding `$match`.
- `withDeleted: true` keeps the caller filter unchanged. `onlyDeleted: true` searches only soft-deleted documents unless `withDeleted` is also set.
- Hit documents are hydrated Model documents. For example, `hit.document.populate('author')` is available after the search. The server-provided score and hit order are preserved.

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

## Validation and execution behavior

The method validates options locally before it contacts MongoDB:

- `index` and `path` must be non-empty strings.
- `queryVector` must be a non-empty array of finite numbers.
- `limit` must be a positive integer.
- ANN requires `numCandidates >= limit`; ENN rejects `numCandidates`.
- `filter`, `projection`, and `aggregateOptions` must have supported shapes.

Invalid vector options throw `INVALID_VECTOR_SEARCH`, with field/reason details. The Model-only `withDeleted` and `onlyDeleted` flags must be booleans. The call runs through monSQLize's existing aggregate execution path, but `aggregateOptions.meta`, `aggregateOptions.stream`, and `aggregateOptions.explain` are rejected because `vectorSearch()` always resolves to `VectorSearchHit[]`.

Deployment, index, and other MongoDB execution failures are rethrown with their original driver code and message. When the error object is writable, monSQLize adds `error.monsqlize.operation === 'vectorSearch'` and the target namespace for diagnosis.

This release exposes vector search on both `Collection` and `Model`; it does not add a vector-index lifecycle API.

## Operational notes

- A default local `mongodb-memory-server` instance does not provide Vector Search. Unit coverage verifies pipeline construction and validation; end-to-end verification needs a compatible externally provisioned deployment and index.
- Vector Search ranking is produced by MongoDB. monSQLize returns that score and does not re-rank results locally.
- Keep the embedding model, vector dimensions, and index configuration synchronized across writers and readers.
