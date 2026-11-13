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

## Quantization and BSON query vectors

BSON int8/int1 input is available starting with 3.6.0. For an earlier version whose `vectorSearch()` only accepts arrays, use `collection.aggregate()` with the native `$vectorSearch` stage for BSON vectors. Verify that the requested version exists in the registry before installing it.

Automatic quantization keeps your stored embeddings and query vectors as numeric arrays. Set `quantization: 'scalar'` or `'binary'` on the vector field in the Search index; continue passing the original finite `number[]` to `vectorSearch()`. The server quantizes it.

Pre-quantized vectors instead use MongoDB `Binary` **subtype 9**. Its internal dtype is int8 (`0x03`) or packed-bit int1 (`0x10`). This source accepts those two representations directly:

```ts
import { Binary } from 'mongodb';

const queryVector = Binary.fromInt8Array(Int8Array.of(-12, 7, 21, -8, 4, 16, -5, 9));
const hits = await runtime.collection('articles').vectorSearch({
  index: 'articles_int8_index', path: 'embeddingInt8', queryVector,
  limit: 5, numCandidates: 100,
});
```

The indexed data must use the matching representation and embedding model. Here the index has eight dimensions and cosine similarity; int8 needs no `quantization` setting. Factory methods pack values, rather than generating embeddings. Use a driver/BSON version compatible with monSQLize's driver.

For int1, create the query with `Binary.fromBits([1, 0, 1, 0, 1, 0, 1, 0])` or `Binary.fromPackedBits(...)`, use matching Binary data, and configure an index with euclidean similarity and dimensions that are a multiple of eight. Both ANN and ENN accept Binary input. Model uses the same input contract.

Do not decode int8/int1 into `number[]` to query a pre-quantized field: the measured 8.2.12 + mongot 0.69.1 combination returns `[]` without an error for that mismatch. Automatic binary quantization of float arrays is a separate case and continues to accept numeric arrays.

Only non-empty int8/int1 Binary vectors are accepted by this convenience method. Float32 Binary, other subtypes/dtypes, raw Buffer/TypedArray and JSON/EJSON objects are rejected locally. The method preserves effective `position` bytes and padding, copies the input before asynchronous execution, and does not modify the caller's vector. Local checks cover format; index dimensions and similarity remain server checks. `aggregate()` remains available for other native formats.

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
- `queryVector` must be a non-empty finite number array or a valid BSON subtype 9 int8/int1 vector. Sparse arrays, undefined and non-finite elements are invalid. Binary metadata, effective length and padding must be valid.
- `limit` must be a positive integer.
- ANN requires `numCandidates >= limit`; ENN rejects `numCandidates`.
- `filter`, `projection`, and `aggregateOptions` must have supported shapes.

Invalid vector options throw `INVALID_VECTOR_SEARCH`, with field/reason details. The Model-only `withDeleted` and `onlyDeleted` flags must be booleans. The call runs through monSQLize's existing aggregate execution path, but `aggregateOptions.meta`, `aggregateOptions.stream`, and `aggregateOptions.explain` are rejected because `vectorSearch()` always resolves to `VectorSearchHit[]`.

Deployment, index, and other MongoDB execution failures are rethrown with their original driver code and message. When the error object is writable, monSQLize adds `error.monsqlize.operation === 'vectorSearch'` and the target namespace for diagnosis.

Index management for a Search index (including type `vectorSearch`) is on the [Search index lifecycle](search-indexes.md) page: `createSearchIndex`, `updateSearchIndex`, `dropSearchIndex`, `listSearchIndexes`, and `waitForSearchIndex`.

## Operational notes

- A default local `mongodb-memory-server` instance does not provide Vector Search. End-to-end verification needs Atlas, `mongodb/mongodb-atlas-local`, or a compatible self-managed mongod/mongot pair. The runnable walkthrough is [`examples/docs/vector-search.ts`](../../examples/docs/vector-search.ts); it covers numeric arrays and BSON int8/int1. Set `MONSQLIZE_VECTOR_SEARCH_URI` or `MONSQLIZE_ATLAS_LOCAL_URI`. When neither is set, that example explicitly skips Search calls.
- Vector Search ranking is produced by MongoDB. monSQLize returns that score and does not re-rank results locally.
- Keep the embedding model, vector dimensions, and index configuration synchronized across writers and readers.

## Optional real-environment verification

After installing project development dependencies, run the source matrix only against an authorized disposable Search deployment:

```bash
MONSQLIZE_VECTOR_SEARCH_URI='mongodb://127.0.0.1:27017/?directConnection=true' \
MONSQLIZE_SEARCH_REAL_OUT='/absolute/outside-repo/search-results.json' \
npm run test:search:real
```

The runner creates a random `msq_search_real_*` database, writes seed data and Search indexes, then drops only that database and closes its clients. It compares the native driver with Collection/Model queries, automatic scalar/binary quantization, pre-quantized int8/int1, full-text scores, `$searchMeta` counts and same-collection `$rankFusion`/`$scoreFusion`. It preserves failures and reports cleanup failures with a nonzero exit.

`MONSQLIZE_VECTOR_SEARCH_URI` takes precedence over `MONSQLIZE_ATLAS_LOCAL_URI`. With no URI the runner reports `skipped` and exits zero; this is not a real-test pass. `MONSQLIZE_SEARCH_REAL_TIMEOUT_MS` is a positive safe integer in milliseconds (default 600000 per index wait). Invalid explicit configuration fails before connecting. Results go to stdout; `MONSQLIZE_SEARCH_REAL_OUT` optionally writes the same report, and a write failure fails the run. URI credentials are removed from report copies.

Record the actual mongot version or image digest alongside the report; a URI does not establish that provenance. MongoDB 8.2 is EOL. Use the [current self-managed compatibility table](https://www.mongodb.com/docs/search/self-managed/current/deployment/compatibility-requirements/) for new deployments; mongot 1.70.1+ does not pair with 8.2. Historical 8.2.12 + 0.69.1 verification does not establish support for arbitrary version pairs. Fusion results on 8.2 belong to that version's preview scope.
