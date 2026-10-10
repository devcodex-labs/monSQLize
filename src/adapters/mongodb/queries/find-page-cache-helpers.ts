import { createHash } from 'node:crypto';
import type { Document } from 'mongodb';

import { createError, ErrorCodes } from '../../../core/errors';
import type { QueryCacheLike, SortShape } from '../../../types/internal/query';

export const DEFAULT_FIND_PAGE_LIMIT = 20;

function stableStringify(value: unknown): string {
    return stableStringifyValue(value, new WeakSet<object>());
}

function stableStringifyValue(value: unknown, seen: WeakSet<object>): string {
    if (value === undefined) {
        return 'u';
    }
    if (value === null) {
        return 'l';
    }
    if (Array.isArray(value)) {
        return `a[${value.map((item) => stableStringifyValue(item, seen)).join(',')}]`;
    }
    if (value instanceof Date) {
        return `d${JSON.stringify(value.toISOString())}`;
    }
    if (typeof value === 'object') {
        if (seen.has(value)) {
            throw createError(ErrorCodes.INVALID_ARGUMENT, 'Cannot build a stable cache key for a circular value.');
        }
        seen.add(value);
        const customJson = (value as { toJSON?: () => unknown }).toJSON;
        try {
            if (typeof customJson === 'function' && value.constructor?.name !== 'Object') {
                return stableStringifyValue(customJson.call(value), seen);
            }
            const entries = Object.entries(value as Record<string, unknown>)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, item]) => `${JSON.stringify(key)}:${stableStringifyValue(item, seen)}`);
            return `o{${entries.join(',')}}`;
        } finally {
            seen.delete(value);
        }
    }
    return `${typeof value}:${JSON.stringify(value)}`;
}

export function hashPayload(payload: unknown): string {
    return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

type BookmarkKeyDimsPayload = {
    cursorTypes?: Record<string, unknown>;
    cursorValueNormalizerVersion?: string;
    sort: SortShape;
    limit: number;
    query: Document;
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

function buildBookmarkBaseKey(namespace: string, keyDims: BookmarkKeyDimsPayload): string {
    return `${namespace}:bm:${hashPayload({
        sort: keyDims.sort,
        limit: keyDims.limit,
        query: keyDims.query,
        pipeline: keyDims.pipeline,
        cursorTypes: keyDims.cursorTypes,
        cursorValueNormalizerVersion: keyDims.cursorValueNormalizerVersion,
    })}`;
}

function buildBookmarkPattern(namespace: string, keyDims: BookmarkKeyDimsPayload): string {
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
