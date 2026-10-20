import { createHash } from 'node:crypto';
import type { Document, Sort } from 'mongodb';

import { buildResultCacheKeyOptions, normalizeFindProjectionOptions, normalizeSortShape, resolveProjectionOption, stableCacheKeyString } from './query-helpers';
import { createError, ErrorCodes } from '../../../core/errors';
import type { QueryCacheLike } from '../../../types/internal/query';

export const DEFAULT_FIND_PAGE_LIMIT = 20;

export function hashPayload(payload: unknown): string {
    return createHash('sha256').update(stableCacheKeyString(payload)).digest('hex');
}

type BookmarkKeyDimsPayload = {
    options?: unknown;
    hint?: unknown;
    collation?: unknown;
    readConcern?: unknown;
    readPreference?: unknown;
    allowDiskUse?: unknown;
    let?: unknown;
    projection?: unknown;
    project?: unknown;
    cursorTypes?: Record<string, unknown>;
    cursorValueNormalizerVersion?: string;
    sort?: Sort;
    limit?: number;
    query?: Document;
    pipeline?: Document[];
};

type BookmarkCacheEntry = {
    page?: number;
    pageInfo?: {
        endCursor?: string | null;
    };
};

export type BookmarkResumePoint = {
    page: number;
    endCursor: string;
};

export function buildBookmarkBaseKey(namespace: string, keyDims: BookmarkKeyDimsPayload): string {
    const effectiveOptions = { ...(keyDims.options as Record<string, unknown> ?? {}) };
    for (const key of ['hint', 'collation', 'readConcern', 'readPreference', 'allowDiskUse', 'let'] as const) {
        if (keyDims[key] !== undefined) effectiveOptions[key] = keyDims[key];
    }
    const projection = resolveProjectionOption(keyDims);
    if (projection !== undefined) effectiveOptions.projection = projection;
    return `${namespace}:bm:v4:${hashPayload(stableCacheKeyString({
        sort: normalizeSortShape(keyDims.sort),
        limit: keyDims.limit ?? DEFAULT_FIND_PAGE_LIMIT,
        query: keyDims.query ?? {},
        pipeline: keyDims.pipeline,
        options: buildResultCacheKeyOptions(normalizeFindProjectionOptions(effectiveOptions)),
        cursorTypes: keyDims.cursorTypes,
        cursorValueNormalizerVersion: keyDims.cursorValueNormalizerVersion,
    }))}`;
}

export function buildBookmarkPattern(namespace: string, keyDims: BookmarkKeyDimsPayload): string {
    return `${buildBookmarkBaseKey(namespace, keyDims)}:*`;
}

function extractBookmarkPage(key: string): number | null {
    const match = key.match(/:(\d+)$/);
    return match ? Number.parseInt(match[1], 10) : null;
}

export async function readNearestBookmark(
    cache: QueryCacheLike | null | undefined,
    namespace: string,
    keyDims: BookmarkKeyDimsPayload,
    targetPage: number,
): Promise<BookmarkResumePoint | null> {
    if (!cache?.keys || targetPage <= 2) return null;
    const keys = await Promise.resolve(cache.keys(buildBookmarkPattern(namespace, keyDims)));
    if (!Array.isArray(keys) || keys.length === 0) return null;

    let best: BookmarkResumePoint | null = null;
    for (const key of keys) {
        const page = extractBookmarkPage(key);
        if (!page || page >= targetPage) continue;
        const cached = await Promise.resolve(cache.get(key)) as BookmarkCacheEntry | undefined;
        const endCursor = cached?.pageInfo?.endCursor;
        if (typeof endCursor !== 'string' || endCursor.length === 0) continue;
        if (!best || page > best.page) {
            best = { page, endCursor };
        }
    }
    return best;
}
