/** findPage execution layer: pagination, totals calculation, and meta tracking. */

import { withCacheReads } from '../../../core/cache-coordination';
import { canCacheBsonResult, hasStableBsonFields } from './bson-read-options';
import { cacheNamespace } from '../../../core/cache-scope';
import { Collection, Document } from 'mongodb';

import { createError, ErrorCodes } from '../../../core/errors';
import type {
    CursorValueNormalizationOptions,
    CursorValueType,
    QueryCacheLike,
    RuntimeDefaults,
    SortShape,
} from '../../../types/internal/query';
import type {
    FindPageOptions,
    FindPageResult,
    MetaInfo,
    MetaOptions,
    TotalsInfo,
    TotalsOptions,
} from '../../../../types/collection';
import {
    buildAggregateDriverOptions,
    buildCursorFilter,
    buildEffectiveProjection,
    decodeCursor,
    encodeCursor,
    getSortValues,
    hasSessionOption,
    isCollectionCacheBarrierActive,
    normalizeFindProjectionOptions,
    normalizeSortShape,
    reverseSort,
    resolveProjectionOption,
    snapshotFindPageOptions,
} from './query-helpers';
import {
    DEFAULT_FIND_PAGE_LIMIT,
    readNearestBookmark,
    type BookmarkResumePoint,
} from './find-page-cache-helpers';
import { computeTotals } from './find-page-totals';
import { buildFindPageCacheKey } from './query-cache-keys';
import { resolveCursorStrategy } from './cursor-strategy';

// ── Internal utilities ────────────────────────────────────────────────────────

function normalizePositiveInteger(value: number | undefined, fallback: number, field: string): number {
    if (value === undefined || value === null) {
        return fallback;
    }
    if (!Number.isInteger(value) || value <= 0) {
        throw createError(ErrorCodes.INVALID_PAGINATION, `${field} must be a positive integer.`);
    }
    return value;
}

const DEFAULT_FIND_MAX_SKIP = 50000;

function normalizeNonNegativeInteger(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
        throw createError(ErrorCodes.INVALID_PAGINATION, `${field} must be a non-negative integer.`);
    }
    return value;
}

function resolveFindMaxSkip(defaults: RuntimeDefaults): number {
    return typeof defaults.findMaxSkip === 'number'
        && Number.isFinite(defaults.findMaxSkip)
        && Number.isInteger(defaults.findMaxSkip)
        && defaults.findMaxSkip >= 0
        ? defaults.findMaxSkip
        : DEFAULT_FIND_MAX_SKIP;
}

function mergeFilters(base: Document, extra?: Document): Document {
    if (!extra || Object.keys(extra).length === 0) {
        return base;
    }
    if (!base || Object.keys(base).length === 0) {
        return extra;
    }
    return { $and: [base, extra] };
}

function cloneFindPageResult<TSchema extends Document>(result: FindPageResult<TSchema>): FindPageResult<TSchema> {
    return {
        ...result,
        items: Array.isArray(result.items) ? [...result.items] : result.items,
        pageInfo: result.pageInfo && typeof result.pageInfo === 'object'
            ? { ...(result.pageInfo as unknown as Record<string, unknown>) } as unknown as FindPageResult<TSchema>['pageInfo']
            : result.pageInfo,
        totals: result.totals && typeof result.totals === 'object'
            ? { ...(result.totals as unknown as Record<string, unknown>) } as unknown as FindPageResult<TSchema>['totals']
            : result.totals,
        meta: result.meta && typeof result.meta === 'object'
            ? {
                ...result.meta,
                ns: { ...result.meta.ns },
                steps: result.meta.steps ? [...result.meta.steps] : undefined,
            }
            : result.meta,
    };
}

// ── Core findPage execution ───────────────────────────────────────────────────

/** Rejects find-only projection syntax before the aggregation/cache branches. */
function assertPipelineProjectionSupported(projection: Record<string, unknown>): void {
    for (const [field, value] of Object.entries(projection)) {
        const record = value !== null && typeof value === 'object' && !Array.isArray(value)
            && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
            ? value as Record<string, unknown> : undefined;
        if (field.split('.').includes('$') || (record
            && (Object.prototype.hasOwnProperty.call(record, '$slice')
                || Object.prototype.hasOwnProperty.call(record, '$elemMatch')))) {
            throw createError(ErrorCodes.INVALID_OPERATION, 'findPage with pipeline does not support find-only $slice, $elemMatch, or positional projections. Use aggregate with an aggregation projection instead.');
        }
        // Aggregation expressions (especially $literal) are not nested projection specs.
        if (record && !Object.keys(record).some((key) => key.startsWith('$'))) {
            assertPipelineProjectionSupported(record);
        }
    }
}

/**
 * Core findPage execution function (called by findPageDocuments).
 * Not exported; internal to this module.
 */
export async function executeFindPage<TSchema extends Document = Document>(
    collection: Collection<TSchema>,
    options: FindPageOptions<TSchema> = {},
    defaults: RuntimeDefaults = {},
    queryCache?: QueryCacheLike | null,
): Promise<FindPageResult<TSchema>> {
    options = snapshotFindPageOptions(options, collection.bsonOptions);
    const capturedNativeOptions = options.options as Record<string, unknown>;
    if (typeof (capturedNativeOptions as Record<string, unknown>).out === 'string') {
        throw createError(ErrorCodes.INVALID_OPERATION, 'findPage does not support write aggregation options. Use aggregate instead.');
    }
    // Read-only pagination must check the same captured structure used by every branch.
    if (options.pipeline !== undefined) {
        const pipeline = options.pipeline;
        if (pipeline.some((stage) => stage !== null && typeof stage === 'object'
            && (Object.prototype.hasOwnProperty.call(stage, '$out')
                || Object.prototype.hasOwnProperty.call(stage, '$merge')))) {
            throw createError(ErrorCodes.INVALID_OPERATION, 'findPage does not support write aggregation stages. Use aggregate instead.');
        }
        options = { ...options, pipeline };
    }
    const metaEnabled = options.meta === true || (typeof options.meta === 'object' && options.meta !== null);
    const metaOptions = (options.meta && typeof options.meta === 'object' ? options.meta : {}) as MetaOptions;
    const metaLevel = options.meta === true ? 'op' : (metaOptions.level ?? 'op');
    const metaStartTs = Date.now();
    const metaSteps: NonNullable<MetaInfo['steps']> = [];
    const ext = options as Record<string, unknown>;
    const strategy = resolveCursorStrategy(ext, defaults);
    const page = normalizePositiveInteger(options.page, 1, 'page');
    const rawLimit = normalizePositiveInteger(options.limit, DEFAULT_FIND_PAGE_LIMIT, 'limit');
    const limit = defaults.findPageMaxLimit !== undefined && rawLimit > defaults.findPageMaxLimit
        ? defaults.findPageMaxLimit
        : rawLimit;
    const sort = normalizeSortShape(options.sort);
    const baseQuery = (options.query ?? {}) as Document;
    const cursorSecret = defaults.cursorSecret;
    if (defaults.requireCursorSecret && !cursorSecret) {
        throw createError(
            ErrorCodes.INVALID_CONFIG,
            'findPage requires cursorSecret because requireCursorSecret is enabled.',
        );
    }
    const rawCursorTypes = ext.cursorTypes;
    const optionCursorTypes = rawCursorTypes && typeof rawCursorTypes === 'object' && !Array.isArray(rawCursorTypes)
        ? rawCursorTypes as Record<string, CursorValueType>
        : undefined;
    const cursorValueOptions: CursorValueNormalizationOptions = {
        cursorTypes: {
            ...(defaults.cursorTypes ?? {}),
            ...(optionCursorTypes ?? {}),
        },
        cursorValueNormalizer: typeof ext.cursorValueNormalizer === 'function'
            ? ext.cursorValueNormalizer as (field: string, value: unknown) => unknown
            : defaults.cursorValueNormalizer,
    };
    const dbName = (collection as Collection<TSchema> & { dbName?: string; namespace?: { db?: string; }; }).dbName
        ?? (collection as Collection<TSchema> & { namespace?: { db?: string; }; }).namespace?.db
        ?? '';
    const collectionName = collection.collectionName ?? '';

    const pushMetaStep = (
        name: string,
        durationMs: number,
        phase: NonNullable<MetaInfo['steps']>[number]['phase'],
        index?: number,
    ): void => {
        if (metaEnabled && metaLevel === 'sub') {
            metaSteps.push({ name, phase, durationMs, ...(index !== undefined ? { index } : {}) });
        }
    };

    let effectiveMaxTimeMS: number | undefined;
    const driverOpts: Record<string, unknown> = normalizeFindProjectionOptions({ ...(options.options ?? {}) });
    effectiveMaxTimeMS = (ext.maxTimeMS as number | undefined) ?? defaults.maxTimeMS;
    if (effectiveMaxTimeMS !== undefined) driverOpts.maxTimeMS = effectiveMaxTimeMS;
    if (ext.hint !== undefined) driverOpts.hint = ext.hint;
    if (ext.collation !== undefined) driverOpts.collation = ext.collation;
    if (ext.batchSize !== undefined) driverOpts.batchSize = ext.batchSize;
    if (ext.comment !== undefined) driverOpts.comment = ext.comment;
    if (ext.session !== undefined) driverOpts.session = ext.session;
    if (ext.readConcern !== undefined) driverOpts.readConcern = ext.readConcern;
    if (ext.readPreference !== undefined) driverOpts.readPreference = ext.readPreference;
    if (ext.allowDiskUse !== undefined) driverOpts.allowDiskUse = ext.allowDiskUse;
    if (ext.let !== undefined) driverOpts.let = ext.let;
    const projection = resolveProjectionOption(ext) ?? driverOpts.projection;
    if (projection !== undefined) {
        driverOpts.projection = buildEffectiveProjection(projection, sort);
        if (options.pipeline?.length) {
            assertPipelineProjectionSupported(driverOpts.projection as Record<string, unknown>);
        }
    }

    const jumpOpts = ext.jump as { step: number; maxHops: number } | undefined;
    const offsetJumpOpts = ext.offsetJump as { enable?: boolean; maxSkip?: number } | undefined;
    let offsetJumpSkipCount = 0;
    let useOffsetJump = false;
    if (offsetJumpOpts?.enable === true) {
        const offsetJumpGlobalMaxSkip = resolveFindMaxSkip(defaults);
        let offsetJumpMaxSkip = offsetJumpGlobalMaxSkip;
        if (offsetJumpOpts.maxSkip !== undefined) {
            offsetJumpMaxSkip = normalizeNonNegativeInteger(offsetJumpOpts.maxSkip, 'offsetJump.maxSkip');
            if (offsetJumpMaxSkip > offsetJumpGlobalMaxSkip) {
                throw createError(
                    ErrorCodes.INVALID_PAGINATION,
                    `offsetJump.maxSkip exceeds findMaxSkip (${offsetJumpGlobalMaxSkip}).`,
                );
            }
        }
        offsetJumpSkipCount = page > 1 ? (page - 1) * limit : 0;
        if (!Number.isSafeInteger(offsetJumpSkipCount)) {
            throw createError(ErrorCodes.INVALID_PAGINATION, 'offsetJump skip count exceeds the safe integer range.');
        }
        useOffsetJump = offsetJumpSkipCount <= offsetJumpMaxSkip;
    }
    const cacheTTL = typeof ext.cache === 'number' && ext.cache > 0 ? ext.cache : 0;
    const pageCacheBarrierActive = queryCache
        ? await isCollectionCacheBarrierActive(queryCache, collection, defaults)
        : false;
    const pageResultCache = cacheTTL > 0
        && strategy.cacheable
        && canCacheBsonResult(driverOpts)
        && queryCache
        && options.stream !== true
        && (options.explain === undefined || options.explain === false)
        && !hasSessionOption(driverOpts)
        && !pageCacheBarrierActive
        ? buildFindPageCacheKey(collection, defaults, options)
        : null;
    const shouldRefreshAsyncTotals = (options.totals as TotalsOptions | undefined)?.mode === 'async';
    let findPageCacheHit = false;
    let bookmarkResume: BookmarkResumePoint | null = null;

    const finishResult = (result: FindPageResult<TSchema>): FindPageResult<TSchema> => {
        if (!metaEnabled) {
            return result;
        }

        const metaEndTs = Date.now();
        if (metaLevel === 'sub' && metaSteps.length > 0) {
            const stepTotal = metaSteps.reduce((sum, step) => sum + step.durationMs, 0);
            const delta = (metaEndTs - metaStartTs) - stepTotal;
            if (delta > 0) {
                metaSteps.push({ name: 'finalizeResult', phase: 'fetch', durationMs: delta });
            } else if (delta < 0) {
                const lastStep = metaSteps[metaSteps.length - 1];
                lastStep.durationMs = Math.max(0, lastStep.durationMs + delta);
            }
        }
        result.meta = {
            op: 'findPage',
            ns: {
                iid: defaults.namespace?.instanceId ?? 'default',
                type: 'mongodb',
                db: dbName,
                coll: collectionName,
            },
            db: dbName,
            collection: collectionName,
            timestamp: metaStartTs,
            startTs: metaStartTs,
            endTs: metaEndTs,
            durationMs: metaEndTs - metaStartTs,
            ...(typeof effectiveMaxTimeMS === 'number' ? { maxTimeMS: effectiveMaxTimeMS } : {}),
            cacheHit: findPageCacheHit,
            ...(findPageCacheHit ? { fromCache: true } : {}),
            ...(pageResultCache ? { cacheTtl: cacheTTL, keyHash: pageResultCache.keyHash } : {}),
            page,
            after: Boolean(options.after),
            before: Boolean(options.before),
            hops: options.after || options.before ? 1 : Math.max(0, page - (bookmarkResume?.page ?? 1)),
            ...(jumpOpts ? { step: jumpOpts.step } : {}),
            ...(metaLevel === 'sub' ? { steps: metaSteps } : {}),
        };

        return result;
    };

    // ── Validation ────────────────────────────────────────────────────────────
    if ((options.after || options.before) && Number.isInteger(options.page)) {
        throw createError(ErrorCodes.VALIDATION_ERROR, 'page cannot be used with after/before cursor.');
    }

    // ── Stream conflict check ─────────────────────────────────────────────────
    if (options.stream === true) {
        if (options.explain !== undefined && options.explain !== false) {
            throw createError(ErrorCodes.STREAM_NO_EXPLAIN, 'stream and explain cannot be used together.');
        }
        if (page > 1) {
            throw createError(ErrorCodes.STREAM_NO_JUMP, 'page jump cannot be used in stream mode.');
        }
        if (options.totals !== undefined) {
            throw createError(ErrorCodes.STREAM_NO_TOTALS, 'totals cannot be computed in stream mode.');
        }
    }

    bookmarkResume = page > 1
        && strategy.cacheable
        && hasStableBsonFields(driverOpts)
        && queryCache
        && !hasSessionOption(driverOpts)
        && !options.after
        && !options.before
        && options.stream !== true
        && (options.explain === undefined || options.explain === false)
        && !useOffsetJump
        ? await readNearestBookmark(queryCache, cacheNamespace(`${dbName}:${collectionName}`, defaults), {
            ...ext,
            query: baseQuery,
            sort,
            limit,
            pipeline: options.pipeline as Document[] | undefined,
            cursorTypes: strategy.cursorTypes,
            cursorValueNormalizerVersion: strategy.cursorValueNormalizerVersion,
        }, page)
        : null;

    // ── Page jump validation ───────────────────────────────────────────────────
    const requestedHops = page > 1 ? page - (bookmarkResume?.page ?? 1) : 0;
    if (jumpOpts && page > 1 && requestedHops > jumpOpts.maxHops) {
        throw createError(ErrorCodes.JUMP_TOO_FAR, 'Page jump exceeds maxHops limit.', [
            { page, maxHops: jumpOpts.maxHops, requestedHops },
        ]);
    }

    // ── Internal closures (close over sort / baseQuery / cursorSecret / driverOpts) ──

    /** Builds the query filter and effective sort from a cursor and direction. */
    const buildPageQuery = (cursor?: string, direction: 'after' | 'before' = 'after') => {
        const cursorFilter = cursor
            ? buildCursorFilter(sort, decodeCursor(cursor, cursorSecret), direction, cursorValueOptions)
            : undefined;
        const effectiveSort = direction === 'before' ? reverseSort(sort) : sort;
        return { queryFilter: mergeFilters(baseQuery, cursorFilter), effectiveSort };
    };

    /** Fetches one page of results; callers must reverse the array for the 'before' direction. */
    const fetchItems = async (
        queryFilter: Document,
        effectiveSort: SortShape,
        extra: { skip?: number } = {},
    ): Promise<{ items: TSchema[]; hasMore: boolean }> => {
        const fetchLimit = limit + 1;
        let rows: TSchema[];

        if (options.pipeline && options.pipeline.length > 0) {
            const stages: Document[] = [
                { $match: queryFilter },
                { $sort: effectiveSort as Document },
            ];
            if (extra.skip) stages.push({ $skip: extra.skip });
            stages.push({ $limit: fetchLimit });
            stages.push(...(options.pipeline as Document[]));
            const effectiveProjection = driverOpts.projection as Document | undefined;
            if (effectiveProjection && Object.keys(effectiveProjection).length > 0) {
                stages.push({ $project: effectiveProjection });
            }
            const aggOpts = buildAggregateDriverOptions<TSchema>(driverOpts) as Record<string, unknown>;
            delete aggOpts.projection;
            rows = await collection
                .aggregate(stages, aggOpts as Parameters<Collection<TSchema>['aggregate']>[1])
                .toArray() as TSchema[];
        } else {
            rows = await collection
                .find(queryFilter as Parameters<Collection<TSchema>['find']>[0], {
                    ...driverOpts,
                    sort: effectiveSort,
                    limit: fetchLimit,
                    ...(extra.skip ? { skip: extra.skip } : {}),
                } as Parameters<Collection<TSchema>['find']>[1])
                .toArray() as TSchema[];
        }

        const hasMore = rows.length > limit;
        return { items: hasMore ? rows.slice(0, limit) : rows, hasMore };
    };

    const timedFetchItems = async (
        name: string,
        phase: NonNullable<MetaInfo['steps']>[number]['phase'],
        queryFilter: Document,
        effectiveSort: SortShape,
        extra: { skip?: number } = {},
        index?: number,
    ): Promise<{ items: TSchema[]; hasMore: boolean }> => {
        const stepStartTs = Date.now();
        const result = await fetchItems(queryFilter, effectiveSort, extra);
        pushMetaStep(name, Date.now() - stepStartTs, phase, index);
        return result;
    };

    const timedComputeTotals = async (): Promise<TotalsInfo> => {
        const stepStartTs = Date.now();
        const result = await computeTotals(collection, baseQuery, limit, options.totals as TotalsOptions, defaults, queryCache, driverOpts);
        pushMetaStep('computeTotals', Date.now() - stepStartTs, 'totals');
        return result;
    };

    /** Builds the pageInfo block from a result set. */
    const buildPageInfo = (
        items: TSchema[],
        hasMore: boolean,
        extra: { hasPrev?: boolean; currentPage?: number } = {},
    ) => {
        const first = items[0] ?? null;
        const last = items[items.length - 1] ?? null;
        const enc = (item: TSchema | null) =>
            item
                ? encodeCursor(getSortValues(item, sort), cursorSecret)
                : null;
        return {
            hasNext: hasMore,
            hasPrev: extra.hasPrev ?? false,
            startCursor: enc(first),
            endCursor: enc(last),
            ...(extra.currentPage !== undefined ? { currentPage: extra.currentPage } : {}),
        };
    };

    const writePageResultCache = async (result: FindPageResult<TSchema>): Promise<void> => {
        if (!pageResultCache || !queryCache) {
            return;
        }
        const cacheValue = cloneFindPageResult(result);
        delete cacheValue.meta;
        if (shouldRefreshAsyncTotals) {
            delete cacheValue.totals;
        }
        await Promise.resolve(queryCache.set(pageResultCache.key, cacheValue, cacheTTL));
    };

    const finishAndCache = async (result: FindPageResult<TSchema>): Promise<FindPageResult<TSchema>> => {
        await writePageResultCache(result);
        return finishResult(result);
    };

    if (pageResultCache && queryCache) {
        const cached = await Promise.resolve(queryCache.get(pageResultCache.key)) as FindPageResult<TSchema> | undefined;
        if (cached !== undefined) {
            findPageCacheHit = true;
            const result = cloneFindPageResult(cached);
            if (options.totals && (options.totals as TotalsOptions).mode !== 'none' && (shouldRefreshAsyncTotals || result.totals === undefined)) {
                result.totals = await timedComputeTotals();
            }
            return finishResult(result);
        }
    }

    // ── Stream mode: return a Node.js Readable directly ──────────────────────
    if (options.stream === true) {
        const direction = options.before ? 'before' : 'after';
        const { queryFilter, effectiveSort } = buildPageQuery(options.after ?? options.before, direction);
        return collection
            .find(queryFilter as Parameters<Collection<TSchema>['find']>[0], {
                ...driverOpts,
                sort: effectiveSort,
                limit: limit + 1,
            } as Parameters<Collection<TSchema>['find']>[1])
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .stream() as any;
    }

    // ── Explain mode: return the raw MongoDB explain document ────────────────
    if (options.explain !== undefined && options.explain !== false) {
        const verbosity = typeof options.explain === 'string' ? options.explain : 'queryPlanner';
        let explainQueryFilter: Document;
        const explainExtra: Record<string, unknown> = {};

        if (options.after || options.before) {
            const dir = options.after ? 'after' : 'before';
            explainQueryFilter = buildPageQuery(options.after ?? options.before, dir).queryFilter as Document;
        } else if (useOffsetJump && page > 1) {
            explainQueryFilter = baseQuery;
            explainExtra.skip = offsetJumpSkipCount;
        } else {
            explainQueryFilter = baseQuery;
        }

        return collection
            .find(explainQueryFilter as Parameters<Collection<TSchema>['find']>[0], {
                ...driverOpts,
                ...explainExtra,
                sort,
                limit,
            } as Parameters<Collection<TSchema>['find']>[1])
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .explain(verbosity) as any;
    }

    // ── offsetJump mode: skip-based pagination ────────────────────────────────
    if (useOffsetJump) {
        const { queryFilter, effectiveSort } = buildPageQuery();
        const { items, hasMore } = await timedFetchItems('offsetFetch', 'offset', queryFilter as Document, effectiveSort, { skip: offsetJumpSkipCount });
        const result: FindPageResult<TSchema> = {
            items,
            pageInfo: buildPageInfo(items, hasMore, { hasPrev: page > 1, currentPage: page }),
        };
        if (options.totals && (options.totals as TotalsOptions).mode !== 'none') {
            result.totals = await timedComputeTotals();
        }
        return finishAndCache(result);
    }

    // ── After/Before cursor mode ──────────────────────────────────────────────
    if (options.after || options.before) {
        const direction = options.after ? 'after' : 'before';
        const { queryFilter, effectiveSort } = buildPageQuery(options.after ?? options.before, direction);
        const { items: rawItems, hasMore } = await timedFetchItems('cursorFetch', 'fetch', queryFilter as Document, effectiveSort);
        const items = direction === 'before' ? [...rawItems].reverse() : rawItems;
        const first = items[0] ?? null;
        const last = items[items.length - 1] ?? null;
        const enc = (item: TSchema | null) =>
            item ? encodeCursor(getSortValues(item, sort), cursorSecret) : null;
        const result: FindPageResult<TSchema> = {
            items,
            pageInfo: {
                hasNext: direction === 'before' ? Boolean(options.before) : hasMore,
                hasPrev: direction === 'before' ? hasMore : Boolean(options.after),
                startCursor: enc(first),
                endCursor: enc(last),
            },
        };
        if (options.totals && (options.totals as TotalsOptions).mode !== 'none') {
            result.totals = await timedComputeTotals();
        }
        return finishAndCache(result);
    }

    // ── Page navigation: cursor stepping ─────────────────────────────────────
    let currentPage = 1;
    let items: TSchema[];
    let hasMore: boolean;

    if (bookmarkResume) {
        const { queryFilter: qb, effectiveSort: esb } = buildPageQuery(bookmarkResume.endCursor, 'after');
        const next = await timedFetchItems(`bookmark-${bookmarkResume.page}`, 'hop', qb as Document, esb, {}, bookmarkResume.page + 1);
        items = next.items;
        hasMore = next.hasMore;
        currentPage = bookmarkResume.page + 1;
    } else {
        const { queryFilter: q0, effectiveSort: es0 } = buildPageQuery();
        const first = await timedFetchItems('initialFetch', page > 1 ? 'hop' : 'fetch', q0 as Document, es0, {}, 1);
        items = first.items;
        hasMore = first.hasMore;
    }

    if (page === currentPage) {
        const result: FindPageResult<TSchema> = {
            items,
            pageInfo: buildPageInfo(items, hasMore, { hasPrev: currentPage > 1, currentPage }),
        };
        if (options.totals && (options.totals as TotalsOptions).mode !== 'none') {
            result.totals = await timedComputeTotals();
        }
        return finishAndCache(result);
    }

    for (let cp = currentPage + 1; cp <= page; cp++) {
        const lastItem = items[items.length - 1];
        if (!lastItem) {
            const result: FindPageResult<TSchema> = {
                items,
                pageInfo: buildPageInfo(items, false, { hasPrev: currentPage > 1, currentPage }),
            };
            if (options.totals && (options.totals as TotalsOptions).mode !== 'none') {
                result.totals = await timedComputeTotals();
            }
            return finishAndCache(result);
        }
        const endCursor = encodeCursor(getSortValues(lastItem, sort), cursorSecret);
        const { queryFilter: qN, effectiveSort: esN } = buildPageQuery(endCursor, 'after');
        const next = await timedFetchItems(`hop-${cp}`, 'hop', qN as Document, esN, {}, cp);
        items = next.items;
        hasMore = next.hasMore;
        currentPage = cp;
    }

    const result: FindPageResult<TSchema> = {
        items,
        pageInfo: buildPageInfo(items, hasMore, { hasPrev: page > 1, currentPage: page }),
    };
    if (options.totals && (options.totals as TotalsOptions).mode !== 'none') {
        result.totals = await timedComputeTotals();
    }
    return finishAndCache(result);
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Executes cursor or offset pagination with the legacy result contract. */
async function executeFindPageDocuments<TSchema extends Document = Document>(
    collection: Collection<TSchema>,
    options: FindPageOptions<TSchema> = {},
    defaults?: RuntimeDefaults,
    queryCache?: QueryCacheLike | null,
): Promise<FindPageResult<TSchema>> {
    return executeFindPage(collection, options, defaults ?? {}, queryCache);
}

export function findPageDocuments<TSchema extends Document = Document>(
    collection: Collection<TSchema>, options: FindPageOptions<TSchema> = {},
    defaults: RuntimeDefaults = {}, queryCache?: QueryCacheLike | null,
): Promise<FindPageResult<TSchema>> {
    return queryCache
        ? withCacheReads(queryCache, cache => executeFindPageDocuments(collection, options, defaults, cache))
        : executeFindPageDocuments(collection, options, defaults, queryCache);
}
