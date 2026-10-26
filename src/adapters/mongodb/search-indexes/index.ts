export {
    SEARCH_INDEX_MISSING_GRACE_MS,
    createSearchIndexOp,
    createSearchIndexesOp,
    dropSearchIndexOp,
    getSearchIndexOp,
    listSearchIndexesOp,
    updateSearchIndexOp,
    waitForSearchIndexOp,
} from './operations';
export { classifySearchIndexError, mapSearchIndexError } from './errors';
export { normalizeSearchIndexInfo, missingSearchIndexInfo } from './normalize';
export type { SearchIndexCollectionLike, SearchIndexContext } from './types';
