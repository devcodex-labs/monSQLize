# Vector search

`collection.vectorSearch()` executes a MongoDB `$vectorSearch` query and returns a stable score envelope for every match.

## Prerequisites

This API requires a MongoDB deployment that supports Vector Search and a Search index of type `vectorSearch` that already exists. A **Search index** is a MongoDB Search index whose type is full-text `search` or `vectorSearch`. Since v3.4.0 you can manage that index with the [Search index lifecycle API](search-indexes.md). Configure the index and make its vector dimensions, numeric representation, and indexed path match the embeddings you send to the API. See the [MongoDB `$vectorSearch` reference](https://www.mongodb.com/docs/vector-search/query/aggregation-stages/vector-search-stage/) for deployment and index requirements.

`$vectorSearch` must be the first stage of any pipeline it appears in. Current MongoDB documentation still does not allow it inside a `$lookup` sub-pipeline or a `$facet` stage ([manual](https://www.mongodb.com/docs/manual/reference/operator/aggregation/vectorsearch/), [Vector Search stage](https://www.mongodb.com/docs/vector-search/query/aggregation-stages/vector-search-stage/)). Use `vectorSearch()` as the search entry point and enrich the resulting documents afterwards when needed.

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

`filter` is a Vector Search pre-filter, not a later `$match` stage. Create the relevant filter fields on the Search index (`vectorSearch` type) before relying on them.

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

Index management for a Search index (including type `vectorSearch`) is on the [Search index lifecycle](search-indexes.md) page: `createSearchIndex`, `updateSearchIndex`, `dropSearchIndex`, `listSearchIndexes`, and `waitForSearchIndex`.

## Operational notes

- A default local `mongodb-memory-server` instance does not provide Vector Search. Unit coverage verifies pipeline construction and validation. End-to-end verification needs Atlas, `mongodb/mongodb-atlas-local`, or Community/Enterprise 8.2+ with `mongot`. The runnable walkthrough is [`examples/docs/vector-search.ts`](../../examples/docs/vector-search.ts). Set `MONSQLIZE_VECTOR_SEARCH_URI` or `MONSQLIZE_ATLAS_LOCAL_URI`. When neither is set, that example exits without calling Search so `npm run test:examples` can still invoke it.
- Vector Search ranking is produced by MongoDB. monSQLize returns that score and does not re-rank results locally.
- Keep the embedding model, vector dimensions, and index configuration synchronized across writers and readers.
