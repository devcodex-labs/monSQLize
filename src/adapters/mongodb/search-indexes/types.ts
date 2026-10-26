/**
 * Internal types for the Search index lifecycle helpers.
 * Public shapes live in types/search-index.d.ts.
 */
import type { Document } from 'mongodb';

export type {
    CreateSearchIndexOptions,
    CreateSearchIndexResult,
    DropSearchIndexOptions,
    ListSearchIndexesOptions,
    SearchIndexInfo,
    SearchIndexManagement,
    SearchIndexSpec,
    SearchIndexStatus,
    SearchIndexType,
    SearchIndexTypeSource,
    WaitForSearchIndexOptions,
} from '../../../../types/search-index';

/** Minimal driver collection surface used by the helpers (eases mocking). */
export interface SearchIndexCollectionLike {
    listSearchIndexes(name: string, options?: Record<string, unknown>): { toArray(): Promise<Document[]>; };
    listSearchIndexes(options?: Record<string, unknown>): { toArray(): Promise<Document[]>; };
    createSearchIndex(description: { name: string; type: string; definition: Document; }): Promise<string>;
    createSearchIndexes(descriptions: Array<{ name: string; type: string; definition: Document; }>): Promise<string[]>;
    updateSearchIndex(name: string, definition: Document): Promise<void>;
    dropSearchIndex(name: string): Promise<void>;
}

/** Context passed to every helper. */
export interface SearchIndexContext {
    collection: SearchIndexCollectionLike;
    namespace: object;
}
