/**
 * populate-promise.ts
 *
 * PopulateProxy implementation: a Promise wrapper for the chainable populate API.
 *
 * Design notes:
 * - PopulatePromise<T> implements PromiseLike<T> (then/catch/finally), so it can
 *   be directly awaited or called via .populate().exec() in a chain.
 * - The paths array accumulates in call order and is passed to the executor all at once by exec().
 *
 * Internal interfaces:
 * - ModelRuntimeLike    — minimal interface for the runtime's scopedCollection/scopedModel (injected by ModelInstance)
 * - ModelCollectionLike — collection operation interface (used during populate path resolution)
 * - PopulatePath        — union type of string | PopulateConfig
 */

import type { DeleteBatchResult, IncrementOneResult, InsertBatchResult, InsertManyResult, UpdateBatchResult, UpdateResult, VectorSearchHit, VectorSearchOptions } from '../../../types/collection';
import type { ModelScopeOptions, PopulateConfig, PopulateProxy } from '../../../types/model';
import { createError, ErrorCodes } from '../../core/errors';

/** Populate path: either a field name string or a full PopulateConfig object. */
export type PopulatePath = string | PopulateConfig;
type PopulateInput = PopulatePath | PopulatePath[];

// ── Internal runtime interfaces (avoids circular imports with runtime-core) ──────────────────────

/** Minimal runtime interface required by ModelInstance, injected via the constructor. */
export interface ModelRuntimeLike {
    scopedCollection<TDocument = Record<string, unknown>>(name: string, options?: ModelScopeOptions): ModelCollectionLike<TDocument>;
    scopedModel<TDocument = Record<string, unknown>>(name: string, options?: ModelScopeOptions): ModelInstance<TDocument>;
}

/** Collection operation interface used during populate resolution (subset of methods required). */
export interface ModelCollectionLike<TDocument = Record<string, unknown>> {
    getNamespace(): { iid: string; type: 'mongodb'; db: string; collection: string; pool?: string; };
    raw(): unknown;
    findOne(query?: unknown, options?: unknown): Promise<unknown>;
    find(query?: unknown, options?: unknown): Promise<unknown[]>;
    findOneById(id: unknown, options?: unknown): Promise<unknown>;
    findByIds(ids: unknown[], options?: unknown): Promise<unknown[]>;
    findAndCount(query?: unknown, options?: unknown): Promise<{ data: TDocument[]; total: number; }>;
    count(query?: unknown, options?: unknown): Promise<number>;
    insertOne(document?: unknown, options?: unknown): Promise<{ acknowledged: boolean; insertedId: unknown; }>;
    insertMany(documents?: unknown[], options?: unknown): Promise<InsertManyResult>;
    updateOne(filter?: unknown, update?: unknown, options?: unknown): Promise<UpdateResult>;
    updateMany(filter?: unknown, update?: unknown, options?: unknown): Promise<UpdateResult>;
    replaceOne(filter?: unknown, replacement?: unknown, options?: unknown): Promise<UpdateResult>;
    findOneAndUpdate(filter?: unknown, update?: unknown, options?: unknown): Promise<TDocument | null>;
    findOneAndReplace(filter?: unknown, replacement?: unknown, options?: unknown): Promise<TDocument | null>;
    findOneAndDelete(filter?: unknown, options?: unknown): Promise<TDocument | null>;
    upsertOne(filter?: unknown, update?: unknown, options?: unknown): Promise<UpdateResult>;
    incrementOne(filter?: unknown, field?: string, increment?: number, options?: unknown): Promise<IncrementOneResult<TDocument>>;
    deleteOne(filter?: unknown, options?: unknown): Promise<unknown>;
    deleteMany(filter?: unknown, options?: unknown): Promise<unknown>;
    createIndex(keys: unknown, options?: unknown): Promise<unknown>;
    createIndexes(specs: Array<{ key: unknown; } & Record<string, unknown>>): Promise<string[]>;
    listIndexes(): Promise<Record<string, unknown>[]>;
    dropIndex(name: string): Promise<unknown>;
    dropIndexes(): Promise<unknown>;
    prewarmBookmarks(keyDims?: unknown, pages?: number[]): Promise<unknown>;
    listBookmarks(keyDims?: unknown): Promise<unknown>;
    clearBookmarks(keyDims?: unknown): Promise<unknown>;
    distinct(key: string, query?: unknown, options?: unknown): Promise<unknown[]>;
    aggregate(pipeline?: unknown[], options?: unknown): Promise<unknown[]>;
    vectorSearch<TVectorDocument = TDocument>(options: VectorSearchOptions): Promise<Array<VectorSearchHit<TVectorDocument>>>;
    stream(query?: unknown, options?: unknown): NodeJS.ReadableStream;
    explain(query?: unknown, options?: unknown): Promise<unknown>;
    invalidate(op?: 'find' | 'findOne' | 'count' | 'findPage' | 'aggregate' | 'distinct'): Promise<number>;
    dropCollection(): Promise<boolean>;
    createCollection(name?: string, options?: Record<string, unknown>): Promise<boolean>;
    createView(name: string, source: string, pipeline?: unknown[]): Promise<boolean>;
    indexStats(): Promise<unknown[]>;
    setValidator(validator: unknown, options?: { validationLevel?: string; validationAction?: string }): Promise<{ ok: number; collection: string }>;
    setValidationLevel(level: string): Promise<{ ok: number; validationLevel: string }>;
    setValidationAction(action: string): Promise<{ ok: number; validationAction: string }>;
    getValidator(): Promise<{ validator: Record<string, unknown> | null; validationLevel: string; validationAction: string }>;
    stats(options?: { scale?: number }): Promise<{ ns: string; count: number; size: number; storageSize: number; totalIndexSize: number; nindexes: number; avgObjSize?: number; scaleFactor?: number }>;
    renameCollection(newName: string, options?: { dropTarget?: boolean }): Promise<{ renamed: boolean; from: string; to: string }>;
    collMod(modifications: Record<string, unknown>): Promise<Record<string, unknown>>;
    convertToCapped(size: number, options?: { max?: number }): Promise<{ ok: number; collection: string; capped: boolean; size: number }>;
    findPage(options?: unknown): Promise<{
        items: TDocument[];
        pageInfo: {
            hasNext: boolean;
            hasPrev: boolean;
            startCursor: string | null;
            endCursor: string | null;
            currentPage?: number;
        };
        totals?: Record<string, unknown>;
    }>;
    watch(pipeline?: unknown[], options?: unknown): unknown;
}

/**
 * Extended version of ModelCollectionLike with bulk-write and field-increment interfaces.
 *
 * Additions over the base interface:
 * - `incrementOne` field parameter accepts `Record<string, number>` (multi-field increment)
 * - `insertBatch` / `updateBatch` bulk operation methods
 *
 * Shared by orchestrateModel* functions and ModelInstance to avoid duplicate definitions.
 */
export type ExtendedModelCollectionLike<TDocument> = ModelCollectionLike<TDocument> & {
    incrementOne(
        filter?: unknown,
        field?: string | Record<string, number>,
        increment?: number,
        options?: unknown,
    ): Promise<IncrementOneResult<TDocument>>;
    insertBatch(docs: unknown[], options?: unknown): Promise<InsertBatchResult>;
    updateBatch(filter?: unknown, update?: unknown, options?: unknown): Promise<UpdateBatchResult>;
    deleteBatch(filter?: unknown, options?: unknown): Promise<DeleteBatchResult>;
};

// Forward type declaration to avoid circular dependency (model-instance.ts imports this file, which needs the ModelInstance type)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ModelInstance<TDocument = Record<string, unknown>> = import('./index').ModelInstance<TDocument> & any;

// ── PopulatePromise ───────────────────────────────────────────────────────────

/**
 * Promise wrapper for the chainable populate API.
 *
 * Usage examples:
 *   const doc = await model.findOne(query).populate('author');
 *   const doc = await model.findOne(query)
 *     .populate('author')
 *     .populate('comments');
 */
export class PopulatePromise<T> implements PopulateProxy<T> {
    readonly [Symbol.toStringTag] = 'Promise';

    constructor(
        private readonly executor: (paths: PopulatePath[]) => Promise<T>,
        private readonly paths: PopulatePath[] = [],
    ) { }

    /**
     * Append a populate path and return a new PopulatePromise (chainable).
     */
    populate(path: PopulateInput, options?: Partial<Omit<PopulateConfig, 'path'>>): PopulateProxy<T> {
        const toConfig = (item: PopulatePath): PopulateConfig => {
            if (typeof item !== 'string' && (typeof item !== 'object' || item === null || Array.isArray(item))) {
                throw createError(ErrorCodes.INVALID_ARGUMENT, 'populate param must be a string, array, or object');
            }
            return typeof item === 'string'
                ? { path: item, ...options }
                : { ...item, ...options };
        };

        if (Array.isArray(path)) {
            return new PopulatePromise(this.executor, [...this.paths, ...path.map(toConfig)]);
        }
        const config = toConfig(path);
        return new PopulatePromise(this.executor, [...this.paths, config]);
    }

    /**
     * Trigger the actual query, populate related documents, and return the final Promise.
     */
    exec(): Promise<T> {
        return this.executor(this.paths);
    }

    then<TResult1 = T, TResult2 = never>(
        onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
        return this.exec().then(onfulfilled ?? undefined, onrejected ?? undefined);
    }

    catch<TResult = never>(
        onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
    ): Promise<T | TResult> {
        return this.exec().catch(onrejected ?? undefined);
    }

    finally(onfinally?: (() => void) | null): Promise<T> {
        return this.exec().finally(onfinally ?? undefined);
    }
}
