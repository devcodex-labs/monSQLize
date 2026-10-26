import { expectAssignable, expectError, expectType } from 'tsd';
import MonSQLize, {
    ErrorCodes,
    type CreateSearchIndexResult,
    type SearchIndexInfo,
    type SearchIndexSpec,
    type SearchIndexTypeSource,
} from 'monsqlize';

const runtime = new MonSQLize({ type: 'mongodb', databaseName: 'app', config: { uri: 'mongodb://localhost:27017' } });
const docs = runtime.collection('docs');

const spec: SearchIndexSpec = {
    name: 'emb_idx',
    type: 'vectorSearch',
    definition: { fields: [{ type: 'vector', path: 'embedding', numDimensions: 3, similarity: 'cosine' }] },
};

expectType<Promise<CreateSearchIndexResult>>(docs.createSearchIndex(spec, { ifExists: 'skip' }));
expectType<Promise<string[]>>(docs.createSearchIndexes([spec]));
expectType<Promise<SearchIndexInfo[]>>(docs.listSearchIndexes({ type: 'search' }));
expectType<Promise<SearchIndexInfo>>(docs.getSearchIndex('emb_idx'));
expectType<Promise<void>>(docs.updateSearchIndex('emb_idx', {}));
expectType<Promise<void>>(docs.dropSearchIndex('emb_idx', { ignoreMissing: true }));
expectType<Promise<SearchIndexInfo>>(docs.waitForSearchIndex('emb_idx', { until: 'dropped', timeoutMs: 1000, intervalMs: 100, signal: new AbortController().signal }));

declare const result: CreateSearchIndexResult;
expectAssignable<'created' | 'skipped' | 'updated'>(result.action);
declare const info: SearchIndexInfo;
expectType<SearchIndexTypeSource>(info.typeSource);
expectAssignable<'search' | 'vectorSearch' | undefined>(info.type);

expectError(docs.createSearchIndex({ name: 'x', definition: {} }));
expectError(docs.createSearchIndex(spec, { ifExists: 'replace' }));
expectError(docs.waitForSearchIndex('x', { until: 'built' }));

expectType<ErrorCodes.SEARCH_INDEX_EXISTS>(ErrorCodes.SEARCH_INDEX_EXISTS);
