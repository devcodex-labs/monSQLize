/** MongoDB query chains and adapter operations; extracted query modules remain re-exported. */

import { readThroughCache } from '../../../core/cache-coordination';
import { isStandardAggregateBsonMode, prepareAggregateExecution } from './aggregate-pipeline';
import { canCacheBsonResult } from './bson-read-options';
import { ChangeStream, Collection, Document, FindOptions, Sort } from 'mongodb';

import { createError, ErrorCodes } from '../../../core/errors';
import { assertManagedTransactionWriteAllowed } from '../../../capabilities/transaction';
import { compilePipelineExpressions, hasExpressionInPipeline } from '../../../core/expression';
import type { QueryCacheLike, RuntimeDefaults } from '../../../types/internal/query';
import type {
    AggregateChain as AggregateChainContract,
    FindChain as FindChainContract,
    MetaInfo,
    ResultWithMeta,
} from '../../../../types/collection';
import {
    buildAggregateDriverOptions,
    buildCountDriverOptions,
    buildFindDriverOptions,
    hasSessionOption,
    isCollectionCacheBarrierActive,
    normalizeFindProjectionOptions,
    normalizeQueryFilter,
    snapshotResultOptions,
    snapshotReadInputs,
} from './query-helpers';
import {
    buildPreparedAggregateCacheKey,
    buildFindCacheKey,
} from './query-cache-keys';

// ── Re-exports from extracted modules (backwards compatibility) ───────────────
export type {
    AggregateChain,
    FindAndCountResult,
    FindPageOptions,
    FindPageResult,
} from '../../../../types/collection';
export type { QueryCacheLike, RuntimeDefaults } from '../../../types/internal/query';
export { findPageDocuments } from './find-page';
export { findOneByIdDocument, findByIdsDocuments } from './find-by-id';
export { findAndCountDocuments } from './find-and-count';

function getQueryMetaNamespace<TSchema extends Document = Document>(
    collection: Collection<TSchema>,
    defaults: RuntimeDefaults = {},
): MetaInfo['ns'] {
    const collectionView = collection as unknown as { dbName?: string; collectionName?: string; namespace?: string };
    const namespace = collectionView.namespace ?? '';
    const [namespaceDb, ...namespaceCollectionParts] = namespace.split('.');
    const db = collectionView.dbName ?? namespaceDb ?? '';
    const coll = collectionView.collectionName ?? namespaceCollectionParts.join('.') ?? '';
    const instanceId = defaults.namespace?.instanceId;
    const iid = instanceId ? `${instanceId}:${db}:${coll}` : `${db}:${coll}`;
    return { iid, type: 'mongodb', db, coll };
}

export function isQueryMetaEnabled(options?: Record<string, unknown>): boolean {
    return options?.meta !== undefined && options.meta !== false;
}

export function buildQueryMeta<TSchema extends Document = Document>(
    collection: Collection<TSchema>,
    defaults: RuntimeDefaults | undefined,
    op: string,
    options: Record<string, unknown> | undefined,
    startTs: number,
    error?: unknown,
): MetaInfo {
    const endTs = Date.now();
    const ns = getQueryMetaNamespace(collection, defaults ?? {});
    const meta: MetaInfo = {
        op,
        ns,
        db: ns.db,
        collection: ns.coll,
        timestamp: endTs,
        startTs,
        endTs,
        durationMs: endTs - startTs,
    };

    if (typeof options?.maxTimeMS === 'number') {
        meta.maxTimeMS = options.maxTimeMS;
    }
    if (error !== undefined) {
        const err = error as { code?: string; message?: string };
        meta.error = { code: err.code, message: String(err.message ?? error) };
    }
    return meta;
}

export function wrapQueryResultWithMeta<TData, TSchema extends Document = Document>(
    collection: Collection<TSchema>,
    defaults: RuntimeDefaults | undefined,
    op: string,
    options: Record<string, unknown> | undefined,
    startTs: number,
    data: TData,
): TData | ResultWithMeta<TData> {
    if (!isQueryMetaEnabled(options)) {
        return data;
    }
    return {
        data,
        meta: buildQueryMeta(collection, defaults, op, options, startTs),
    };
}

const DEFAULT_FIND_MAX_LIMIT = 10000;
const DEFAULT_FIND_MAX_SKIP = 50000;

function normalizeNonNegativeInteger(value: unknown, field: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
        throw createError(ErrorCodes.INVALID_ARGUMENT, `${field} requires a non-negative integer, got: ${typeof value} (${value})`);
    }
    return value;
}

function resolveNonNegativeBound(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0
        ? value
        : fallback;
}

function validateFindLimitOption(value: unknown, defaults: RuntimeDefaults): number | undefined {
    if (value === undefined) {
        return undefined;
    }
    const limit = normalizeNonNegativeInteger(value, 'limit()');
    const maxLimit = Math.max(1, resolveNonNegativeBound(defaults.findMaxLimit, DEFAULT_FIND_MAX_LIMIT));
    if (limit > 0 && limit > maxLimit) {
        throw createError(ErrorCodes.INVALID_ARGUMENT, `limit() exceeds findMaxLimit (${maxLimit}), got: ${limit}`);
    }
    return limit;
}

function validateFindSkipOption(value: unknown, defaults: RuntimeDefaults): number | undefined {
    if (value === undefined) {
        return undefined;
    }
    const skip = normalizeNonNegativeInteger(value, 'skip()');
    const maxSkip = resolveNonNegativeBound(defaults.findMaxSkip, DEFAULT_FIND_MAX_SKIP);
    if (skip > maxSkip) {
        throw createError(ErrorCodes.INVALID_ARGUMENT, `skip() exceeds findMaxSkip (${maxSkip}), got: ${skip}`);
    }
    return skip;
}

type AggregateWritePipelineHooks = {
    onWriteComplete?: () => void | Promise<void>;
};

/**
 * Chainable wrapper around MongoDB `find()`.
 * Supports `sort`, `skip`, `limit`, `project`, `hint`, `timeout`,
 * stream(), xplain() and thenable/async-iterable protocols.
 * @since v1.0.0
 */
export class FindChain<TSchema extends Document = Document> implements FindChainContract<TSchema> {
    readonly [Symbol.toStringTag] = 'Promise';

    private executed = false;
    private readonly options: Record<string, unknown>;
    private readonly normalizedQuery: Parameters<Collection<TSchema>['find']>[0];

    constructor(
        private readonly collection: Collection<TSchema>,
        query: Parameters<Collection<TSchema>['find']>[0] = {},
        initialOptions: Record<string, unknown> = {},
        private readonly defaults: RuntimeDefaults = {},
        private readonly queryCache?: QueryCacheLike | null,
    ) {
        this.options = { ...initialOptions };
        this.normalizedQuery = defaults.autoConvertObjectId
            ? normalizeQueryFilter(
                (query as Record<string, unknown>) ?? {},
                defaults.autoConvertObjectId,
            ) as Parameters<Collection<TSchema>['find']>[0]
            : query;
    }

    private buildExecuteOptions(): Record<string, unknown> {
        const options: Record<string, unknown> = {
            ...(this.defaults.maxTimeMS !== undefined ? { maxTimeMS: this.defaults.maxTimeMS } : {}),
            ...(this.defaults.findLimit !== undefined ? { limit: this.defaults.findLimit } : {}),
            ...this.options,
        };
        const limit = validateFindLimitOption(options.limit, this.defaults);
        if (limit !== undefined) {
            options.limit = limit;
        }
        const skip = validateFindSkipOption(options.skip, this.defaults);
        if (skip !== undefined) {
            options.skip = skip;
        }
        return normalizeFindProjectionOptions(options);
    }

    limit(value: number): FindChain<TSchema> {
        this.options.limit = validateFindLimitOption(value, this.defaults);
        return this;
    }

    skip(value: number): FindChain<TSchema> {
        this.options.skip = validateFindSkipOption(value, this.defaults);
        return this;
    }

    sort(value: Sort | Record<string, 1 | -1>): FindChain<TSchema> {
        if (!value || typeof value !== 'object') {
            throw createError(ErrorCodes.INVALID_ARGUMENT, `sort() requires an object or array, got: ${typeof value}`);
        }
        this.options.sort = value;
        return this;
    }

    project(value: Document): FindChain<TSchema> {
        this.options.projection = value;
        return this;
    }

    hint(value: unknown): FindChain<TSchema> {
        this.options.hint = value;
        return this;
    }

    collation(value: Record<string, unknown>): FindChain<TSchema> {
        this.options.collation = value;
        return this;
    }

    comment(value: string): FindChain<TSchema> {
        this.options.comment = value;
        return this;
    }

    maxTimeMS(value: number): FindChain<TSchema> {
        this.options.maxTimeMS = value;
        return this;
    }

    batchSize(value: number): FindChain<TSchema> {
        this.options.batchSize = value;
        return this;
    }

    private prepareRead() {
        return snapshotReadInputs(this.normalizedQuery, this.buildExecuteOptions(), this.collection.bsonOptions);
    }

    private wrapResult<TResult>(op: string, startTs: number, result: TResult): TResult | ResultWithMeta<TResult> {
        return wrapQueryResultWithMeta(this.collection, this.defaults, op, this.options, startTs, result);
    }

    explain(verbosity: boolean | string = 'queryPlanner'): Promise<unknown> {
        const { query, options } = this.prepareRead();
        return this.collection.find(query, buildFindDriverOptions<TSchema>(options)).explain(verbosity === true ? 'queryPlanner' : verbosity);
    }

    stream(): NodeJS.ReadableStream {
        const { query, options } = this.prepareRead();
        return this.collection.find(query, buildFindDriverOptions<TSchema>(options)).stream();
    }

    private runToArray(prepared: ReturnType<FindChain<TSchema>['prepareRead']>): Promise<TSchema[]> {
        if (this.executed) {
            throw createError(ErrorCodes.INVALID_OPERATION, 'Query already executed.');
        }
        this.executed = true;
        return this.collection.find(prepared.query, buildFindDriverOptions<TSchema>(prepared.options)).toArray() as Promise<TSchema[]>;
    }

    toArray(): Promise<TSchema[]> {
        if (this.executed) {
            throw createError(ErrorCodes.INVALID_OPERATION, 'Query already executed.');
        }
        return this.executeResult() as Promise<TSchema[]>;
    }

    private async executeResult(): Promise<TSchema[] | ResultWithMeta<TSchema[]>> {
        const startTs = Date.now();
        const prepared = this.prepareRead();

        // v1 compat: explain option routes to .explain() instead of toArray()
        if (this.options.explain !== undefined && this.options.explain !== false) {
            const verbosity = typeof this.options.explain === 'string' ? this.options.explain : 'queryPlanner';
            return this.collection.find(prepared.query, buildFindDriverOptions<TSchema>(prepared.options)).explain(verbosity)
                .then((result) => this.wrapResult('find', startTs, result as TSchema[]) as TSchema[] | ResultWithMeta<TSchema[]>);
        }

        // v1 compat: cache option (TTL in ms) — read-through cache
        const cacheTTL = typeof this.options.cache === 'number' ? this.options.cache : 0;
        const executeOptions = prepared.options;
        if (
            cacheTTL > 0
            && this.queryCache
            && canCacheBsonResult(executeOptions)
            && !hasSessionOption(executeOptions)
            && !(await isCollectionCacheBarrierActive(this.queryCache, this.collection, this.defaults))
        ) {
            const cacheKey = buildFindCacheKey(this.collection, this.defaults, prepared.query, executeOptions);
            const result = await readThroughCache(this.queryCache, cacheKey, cacheTTL, () => this.runToArray(prepared));
            return this.wrapResult('find', startTs, result) as TSchema[] | ResultWithMeta<TSchema[]>;
        }

        return this.runToArray(prepared).then((result) => this.wrapResult('find', startTs, result) as TSchema[] | ResultWithMeta<TSchema[]>);
    }

    then<TResult1 = TSchema[], TResult2 = never>(
        onfulfilled?: ((value: TSchema[]) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
        return this.executeResult().then(onfulfilled as never, onrejected ?? undefined) as Promise<TResult1 | TResult2>;
    }

    catch<TResult = never>(onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null): Promise<TSchema[] | TResult> {
        return this.executeResult().catch(onrejected ?? undefined) as Promise<TSchema[] | TResult>;
    }

    finally(onfinally?: (() => void) | null): Promise<TSchema[]> {
        return this.executeResult().finally(onfinally ?? undefined) as Promise<TSchema[]>;
    }
}

class AggregateChain<TResult = unknown, TSchema extends Document = Document> implements AggregateChainContract<TResult> {
    readonly [Symbol.toStringTag] = 'Promise';

    private executed = false;
    private readonly options: Record<string, unknown>;

    constructor(
        private readonly collection: Collection<TSchema>,
        private readonly pipeline: Document[] = [],
        initialOptions: Record<string, unknown> = {},
        private readonly defaults: RuntimeDefaults = {},
        private readonly queryCache?: QueryCacheLike | null,
        private readonly writePipelineHooks?: AggregateWritePipelineHooks,
    ) {
        this.options = { ...initialOptions };
    }

    private buildExecuteOptions(): Record<string, unknown> {
        return {
            ...(this.defaults.maxTimeMS !== undefined ? { maxTimeMS: this.defaults.maxTimeMS } : {}),
            ...this.options,
        };
    }

    hint(value: unknown): AggregateChain<TResult, TSchema> {
        this.options.hint = snapshotResultOptions({ hint: value }).hint;
        return this;
    }

    collation(value: Record<string, unknown>): AggregateChain<TResult, TSchema> {
        this.options.collation = snapshotResultOptions({ collation: value }).collation;
        return this;
    }

    comment(value: string): AggregateChain<TResult, TSchema> {
        this.options.comment = value;
        return this;
    }

    maxTimeMS(value: number): AggregateChain<TResult, TSchema> {
        this.options.maxTimeMS = value;
        return this;
    }

    allowDiskUse(value: boolean): AggregateChain<TResult, TSchema> {
        this.options.allowDiskUse = value;
        return this;
    }

    batchSize(value: number): AggregateChain<TResult, TSchema> {
        this.options.batchSize = value;
        return this;
    }

    private buildCacheKey(executeOptions: Record<string, unknown>): string {
        return buildPreparedAggregateCacheKey(this.collection, this.defaults, this.pipeline, executeOptions);
    }

    explain(verbosity: boolean | string = 'queryPlanner'): Promise<unknown> {
        return this.collection.aggregate(this.pipeline, buildAggregateDriverOptions<TSchema>(this.buildExecuteOptions())).explain(verbosity === true ? 'queryPlanner' : verbosity);
    }

    stream(): NodeJS.ReadableStream {
        const executeOptions = this.buildExecuteOptions();
        if (this.writePipelineHooks) assertManagedTransactionWriteAllowed(executeOptions);
        const stream = this.collection.aggregate(this.pipeline, buildAggregateDriverOptions<TSchema>(executeOptions)).stream();
        const onWriteComplete = this.writePipelineHooks?.onWriteComplete;
        if (onWriteComplete) {
            stream.once('end', () => {
                void Promise.resolve(onWriteComplete()).catch(() => undefined);
            });
        }
        return stream;
    }

    private wrapResult<TData>(op: string, startTs: number, result: TData): TData | ResultWithMeta<TData> {
        return wrapQueryResultWithMeta(this.collection, this.defaults, op, this.options, startTs, result);
    }

    private runToArray(executeOptions: Record<string, unknown>): Promise<TResult[]> {
        if (this.executed) {
            throw createError(ErrorCodes.INVALID_OPERATION, 'Query already executed.');
        }
        this.executed = true;
        if (this.writePipelineHooks) assertManagedTransactionWriteAllowed(executeOptions);
        return this.collection.aggregate(this.pipeline, buildAggregateDriverOptions<TSchema>(executeOptions))
            .toArray()
            .then(async (result) => {
                await this.writePipelineHooks?.onWriteComplete?.();
                return result as TResult[];
            });
    }

    toArray(): Promise<TResult[]> {
        if (this.executed) {
            throw createError(ErrorCodes.INVALID_OPERATION, 'Query already executed.');
        }
        return this.executeResult() as Promise<TResult[]>;
    }

    private async executeResult(): Promise<TResult[] | ResultWithMeta<TResult[]> | NodeJS.ReadableStream> {
        const startTs = Date.now();

        // v1 compat: explain option routes to .explain() instead of toArray()
        if (this.options.explain !== undefined && this.options.explain !== false) {
            const verbosity = typeof this.options.explain === 'string' ? this.options.explain : 'queryPlanner';
            return this.explain(verbosity).then((result) => this.wrapResult('aggregate', startTs, result as TResult[]) as TResult[] | ResultWithMeta<TResult[]>);
        }
        // v1 compat: stream option routes to .stream() instead of toArray()
        if (this.options.stream === true) {
            return Promise.resolve(this.stream());
        }
        const cacheTTL = typeof this.options.cache === 'number' ? this.options.cache : 0;
        const executeOptions = this.buildExecuteOptions();
        if (
            cacheTTL > 0
            && this.queryCache
            && !hasSessionOption(executeOptions)
            && !this.writePipelineHooks?.onWriteComplete
            && isStandardAggregateBsonMode(executeOptions)
            && !(await isCollectionCacheBarrierActive(this.queryCache, this.collection, this.defaults))
        ) {
            const cacheKey = this.buildCacheKey(executeOptions);
            const result = await readThroughCache(this.queryCache, cacheKey, cacheTTL, () => this.runToArray(executeOptions));
            return this.wrapResult('aggregate', startTs, result) as TResult[] | ResultWithMeta<TResult[]>;
        }
        return this.runToArray(executeOptions).then((result) => this.wrapResult('aggregate', startTs, result) as TResult[] | ResultWithMeta<TResult[]>);
    }

    then<TResult1 = TResult[], TResult2 = never>(
        onfulfilled?: ((value: TResult[]) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
        return this.executeResult().then(onfulfilled as never, onrejected ?? undefined) as Promise<TResult1 | TResult2>;
    }

    catch<TResultCatch = never>(onrejected?: ((reason: unknown) => TResultCatch | PromiseLike<TResultCatch>) | null): Promise<TResult[] | TResultCatch> {
        return this.executeResult().catch(onrejected ?? undefined) as Promise<TResult[] | TResultCatch>;
    }

    finally(onfinally?: (() => void) | null): Promise<TResult[]> {
        return this.executeResult().finally(onfinally ?? undefined) as Promise<TResult[]>;
    }
}

/** Builds a find chain with runtime defaults and optional result caching. */
export function createFindChain<TSchema extends Document = Document>(
    collection: Collection<TSchema>,
    query?: Parameters<Collection<TSchema>['find']>[0],
    options?: Parameters<Collection<TSchema>['find']>[1],
    defaults?: RuntimeDefaults,
    queryCache?: QueryCacheLike | null,
): FindChainContract<TSchema> {
    return new FindChain(collection, query, (options ?? {}) as Record<string, unknown>, defaults ?? {}, queryCache);
}

/** Captures an aggregate execution before target policy and cache classification. */
export function createAggregateChain<TSchema extends Document = Document, TResult = Document>(
    collection: Collection<TSchema>,
    pipeline: Document[] = [],
    options?: Parameters<Collection<TSchema>['aggregate']>[1],
    defaults?: RuntimeDefaults,
    queryCache?: QueryCacheLike | null,
    writePipelineHooks?: AggregateWritePipelineHooks | ((pipeline: Document[], options: Record<string, unknown>) => AggregateWritePipelineHooks | undefined),
): AggregateChainContract<TResult> {
    const prepared = prepareAggregateExecution(pipeline, (options ?? {}) as Record<string, unknown>, defaults,
        collection.bsonOptions as Record<string, unknown> | undefined);
    // Policy checks must see the exact compiled pipeline passed to the driver.
    const preparedHooks = typeof writePipelineHooks === 'function'
        ? writePipelineHooks(prepared.pipeline, prepared.options)
        : writePipelineHooks;

    return new AggregateChain<TResult, TSchema>(
        collection,
        prepared.pipeline,
        prepared.options,
        defaults ?? {},
        queryCache,
        preparedHooks,
    );
}

/** Forwards native find arguments and collects the cursor. */
export async function findDocuments<TSchema extends Document = Document>(
    collection: Collection<TSchema>,
    ...args: Parameters<Collection<TSchema>['find']>
): Promise<TSchema[]> {
    return collection.find(...args).toArray() as Promise<TSchema[]>;
}

/**
 * Queries a single document.
 * @since v1.3.0
 */
export async function findOneDocument<TSchema extends Document = Document>(
    collection: Collection<TSchema>,
    ...args: Parameters<Collection<TSchema>['findOne']>
): ReturnType<Collection<TSchema>['findOne']> {
    const [query, options] = args;
    const rawOptions = (options ?? {}) as FindOptions & { explain?: boolean | string; };
    const findOptions = buildFindDriverOptions<TSchema>(rawOptions as Record<string, unknown>) as FindOptions;

    if (rawOptions.explain) {
        const verbosity = rawOptions.explain === true ? 'queryPlanner' : rawOptions.explain;
        return collection.find((query ?? {}) as Parameters<Collection<TSchema>['find']>[0], findOptions)
            .limit(1)
            .explain(verbosity) as ReturnType<Collection<TSchema>['findOne']>;
    }

    return collection.findOne(
        (query ?? {}) as Parameters<Collection<TSchema>['findOne']>[0],
        findOptions as Parameters<Collection<TSchema>['findOne']>[1],
    ) as ReturnType<Collection<TSchema>['findOne']>;
}

/**
 * Counts the number of documents.
 * @since v1.3.0
 */
export async function countDocuments<TSchema extends Document = Document>(
    collection: Collection<TSchema>,
    query?: Parameters<Collection<TSchema>['countDocuments']>[0],
    options?: Parameters<Collection<TSchema>['countDocuments']>[1],
): Promise<unknown> {
    const rawQuery = (query ?? {}) as Record<string, unknown>;
    const rawOptions = (options ?? {}) as Record<string, unknown>;
    const isEmptyQuery = Object.keys(rawQuery).length === 0;
    const explain = rawOptions.explain;
    const countOptions = buildCountDriverOptions<TSchema>(rawOptions);
    const maxTimeMS = rawOptions.maxTimeMS as number | undefined;
    const comment = rawOptions.comment as string | undefined;
    const signal = rawOptions.signal as AbortSignal | undefined;
    const canUseEstimatedCount = isEmptyQuery
        && !hasSessionOption(rawOptions)
        && rawOptions.collation === undefined
        && rawOptions.hint === undefined
        && rawOptions.skip === undefined
        && rawOptions.limit === undefined
        && rawOptions.readConcern === undefined
        && rawOptions.readPreference === undefined;

    if (explain) {
        const verbosity = typeof explain === 'string' ? explain : 'queryPlanner';
        if (canUseEstimatedCount) {
            return {
                queryPlanner: { plannerVersion: 1, namespace: collection.namespace },
                executionStats: { executionSuccess: true, estimatedCount: true },
                command: { estimatedDocumentCount: collection.collectionName },
            };
        }

        const pipeline = [{ $match: rawQuery }, { $count: 'total' }];
        const aggregateOptions = buildAggregateDriverOptions<TSchema>(rawOptions);
        return collection.aggregate(pipeline, aggregateOptions).explain(verbosity);
    }

    if (canUseEstimatedCount) {
        const estimatedOptions: Record<string, unknown> = {};
        if (maxTimeMS !== undefined) estimatedOptions.maxTimeMS = maxTimeMS;
        if (comment) estimatedOptions.comment = comment;
        if (signal) estimatedOptions.signal = signal;
        return collection.estimatedDocumentCount(estimatedOptions as Parameters<Collection<TSchema>['estimatedDocumentCount']>[0]);
    }

    return collection.countDocuments(rawQuery as Parameters<Collection<TSchema>['countDocuments']>[0], countOptions as Parameters<Collection<TSchema>['countDocuments']>[1]);
}

/**
 * Runs an aggregation query.
 * @since v1.3.0
 */
export async function aggregateDocuments<TSchema extends Document = Document>(
    collection: Collection<TSchema>,
    pipeline: Document[] = [],
    options?: Parameters<Collection<TSchema>['aggregate']>[1],
): Promise<Document[]> {
    return createAggregateChain<TSchema, Document>(collection, pipeline, options).toArray();
}

/**
 * Queries distinct values for a field.
 * @since v1.3.0
 */
export async function distinctValues<TSchema extends Document = Document>(
    collection: Collection<TSchema>,
    key: string,
    filter?: Document,
    options?: Parameters<Collection<TSchema>['distinct']>[2],
): ReturnType<Collection<TSchema>['distinct']> {
    const normalizedFilter = (filter ?? {}) as Parameters<Collection<TSchema>['distinct']>[1];
    if (options === undefined) {
        return collection.distinct(key, normalizedFilter);
    }
    return collection.distinct(key, normalizedFilter, options);
}

/**
 * Watches the collection for change stream events.
 * @since v1.3.0
 */
export function watchDocuments<TSchema extends Document = Document>(
    collection: Collection<TSchema>,
    pipeline: Document[] = [],
    options?: Parameters<Collection<TSchema>['watch']>[1],
): ChangeStream<TSchema> {
    const processedPipeline = hasExpressionInPipeline(pipeline)
        ? compilePipelineExpressions(pipeline)
        : pipeline;

    return collection.watch(processedPipeline, options);
}


/** Streams all matches without applying the runtime findLimit. */
export function streamDocuments<TSchema extends Document = Document>(
    collection: Collection<TSchema>,
    query?: Parameters<Collection<TSchema>['find']>[0],
    options?: Parameters<Collection<TSchema>['find']>[1],
    defaults?: RuntimeDefaults,
): NodeJS.ReadableStream {
    // stream returns all results; findLimit does NOT apply.
    const streamDefaults: RuntimeDefaults = defaults ? { ...defaults, findLimit: undefined } : {};
    return createFindChain(collection, query, options, streamDefaults).stream();
}

/** Explains a find query using the requested verbosity and runtime defaults. */
export function explainDocuments<TSchema extends Document = Document>(
    collection: Collection<TSchema>,
    query?: Parameters<Collection<TSchema>['find']>[0],
    options?: Parameters<Collection<TSchema>['find']>[1] & { explain?: boolean | string; },
    defaults?: RuntimeDefaults,
): Promise<unknown> {
    return createFindChain(collection, query, options, defaults).explain(options?.explain ?? 'queryPlanner');
}
