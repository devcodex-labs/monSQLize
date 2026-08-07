/**
 * Main entry (barrel) for the Model capability module.
 *
 * Exports ModelInstance, ModelMutationOrchestrator, and related helpers and types.
 */

import { ErrorCodes, createError } from '../../core/errors';
import type {
    HookContext,
    ModelAutoIndexOptions,
    ModelDefinition,
    ModelEnsureIndexesOptions,
    ModelIndexEnsureResult,
    ModelVectorSearchOptions,
    PopulateConfig,
    PopulateProxy,
    RelationProtectedDeleteOptions,
    RelationProtectedDeleteResult,
    RelationUsageOptions,
    RelationUsageReport,
    RelationConfig,
    RestoreResult,
    ValidationResult,
} from '../../../types/model';
import type {
    IncrementOneResult,
    InsertBatchResult,
    InsertManyResult,
    UpdateBatchResult,
    UpdateResult,
    VectorSearchHit,
} from '../../../types/collection';
import type { SchemaDslEngine, SchemaValidateFn } from './schema-dsl';
import { PopulatePromise } from './populate-promise';
import type { ExtendedModelCollectionLike, PopulatePath, ModelCollectionLike, ModelRuntimeLike } from './populate-promise';
import { validateRelationConfig, normalizePopulateConfig } from './definition-validator';
import { Model } from './model-registry';
import {
    applyModelDefaults,
    hydrateModelDocument,
    populateModelPath,
    type PopulateTraversalState,
    removeModelDocument,
    saveModelDocument,
    validateModelDocument,
} from './model-instance-helpers';
import {
    countOnlyDeletedDocuments,
    countWithDeletedDocuments,
    findOneOnlyDeletedDocument,
    findOneWithDeletedDocument,
    findOnlyDeletedDocuments,
    findWithDeletedDocuments,
    forceDeleteDocument,
    forceDeleteManyDocuments,
    restoreManySoftDeletedDocuments,
    restoreSoftDeletedDocuments,
} from './model-soft-delete-helpers';
import {
    attachModelStatics,
    buildModelSchemaState,
    ensureModelIndexesForCollection,
    getModelEnums,
    initializeModelV1Methods,
    isModelValidationEnabled,
    resolveModelHooksFactory,
    resolveModelSoftDeleteConfig,
    resolveModelTimestampsConfig,
    resolveModelVersionConfig,
    scheduleModelIndexes,
} from './model-instance-config';
import {
    applyModelSoftDeleteFilter,
    runModelV1Hook,
    type ModelV1HooksFactory,
} from './model-write-helpers';
import { resolveAggregateWriteTarget } from '../../adapters/mongodb/common/collection-accessor-cache-helpers';
import {
    orchestrateModelDeleteMany,
    orchestrateModelDeleteBatch,
    orchestrateModelDeleteOne,
    orchestrateModelFindOneAndDelete,
    orchestrateModelFindOneAndReplace,
    orchestrateModelFindOneAndUpdate,
    orchestrateModelIncrementOne,
    orchestrateModelInsertBatch,
    orchestrateModelInsertMany,
    orchestrateModelInsertOne,
    orchestrateModelReplaceOne,
    orchestrateModelUpdateBatch,
    orchestrateModelUpdateMany,
    orchestrateModelUpdateOne,
    orchestrateModelUpsertOne,
} from './model-mutation-orchestrator';
import { runWithModelWriteSource } from '../write-path-policy';
import {
    executeModelVectorSearch,
    executeProtectedRelationDelete,
    executeRelationUsageCheck,
    type ModelP0OperationsHost,
} from './model-p0-operations';

// Public type re-exports (for external consumers)
export type {
    HookContext,
    ModelAutoIndexOptions,
    ModelDeclaredIndex,
    ModelConnection,
    ModelDefinition,
    ModelEnsureAllIndexesOptions,
    ModelEnsureIndexesOptions,
    ModelIndexEnsureResult,
    ModelIndexEnsureSummary,
    ModelVectorSearchOptions,
    ModelScopeOptions,
    PopulateConfig,
    PopulateProxy,
    RelationProtectedDeleteOptions,
    RelationProtectedDeleteResult,
    RelationUsageEntry,
    RelationUsageCoverage,
    RelationUsageOptions,
    RelationUsageReport,
    RegisteredModel,
    RelationConfig,
    ValidationResult,
    VirtualConfig,
} from '../../../types/model';
export { Model };

function resolveModelRegistryName<TDocument>(definition: ModelDefinition<TDocument>, fallback: string): string {
    return Model.list().find((name) => Model.get(name)?.definition === definition) ?? fallback;
}

/**
 * An instantiated model bound to a specific collection and database.
 * Created by calling {@link MonSQLize#model}.
 * @since v1.0.0
 */
export class ModelInstance<TDocument = Record<string, unknown>> {
    readonly collectionName: string;
    readonly dbName: string;
    readonly poolName?: string;
    readonly definition: ModelDefinition<TDocument>;

    private readonly relations: Map<string, RelationConfig>;
    private readonly modelName: string;

    /** v1 compat: expose relations map as _relations */
    get _relations(): Map<string, RelationConfig> { return this.relations; }

    /** v1 compat: get relations as plain object */
    getRelations(): Record<string, RelationConfig> {
        return Object.fromEntries(this.relations);
    }

    /** v1 compat: get enums from definition */
    getEnums(): Record<string, string> {
        return getModelEnums(this.definition);
    }

    // ── v1 compatibility private state ──────────────────────────────────────────
    private _schemaCache: unknown = null;
    private _schemaError: Error | null = null;
    private _validateEnabled = true; // true = validate on insert; false = skip globally
    private _timestampsConfig: { createdAt: string | false; updatedAt: string | false } | null = null;
    private _softDeleteConfig: { enabled: boolean; field: string; type: string; ttl: number | null } | null = null;
    private _versionConfig: { enabled: boolean; field: string; updateMany: 'counter' | 'strict' | 'off' } | null = null;
    private _v1HooksFactory: ModelV1HooksFactory = null;
    private _v1InstanceMethods: Record<string, (...args: unknown[]) => unknown> = {};
    private readonly _schemaValidateFn: SchemaValidateFn | null;
    // Expose softDeleteConfig for v1 test assertions
    softDeleteConfig: { enabled: boolean; field: string; type: string; ttl: number | null } | null = null;

    constructor(
        private readonly collection: ModelCollectionLike<TDocument>,
        private readonly runtime: ModelRuntimeLike,
        options: {
            collectionName: string;
            modelName?: string;
            dbName: string;
            poolName?: string;
            definition: ModelDefinition<TDocument>;
            schemaEngine?: Pick<SchemaDslEngine, 'dsl' | 'validate'> | null;
        },
    ) {
        this.collectionName = options.collectionName;
        this.dbName = options.dbName;
        this.poolName = options.poolName;
        this.definition = options.definition;
        this.modelName = options.modelName ?? resolveModelRegistryName(options.definition, options.collectionName);
        this.relations = new Map(Object.entries(options.definition.relations ?? {}));
        for (const [name, config] of this.relations) {
            validateRelationConfig(name, config);
        }

        attachModelStatics(this, options.definition);

        this._schemaValidateFn = options.schemaEngine?.validate ?? null;
        const schemaState = buildModelSchemaState(options.definition, options.schemaEngine);
        this._schemaCache = schemaState.schemaCache;
        this._schemaError = schemaState.schemaError;
        this._validateEnabled = isModelValidationEnabled(options.definition);
        this._timestampsConfig = resolveModelTimestampsConfig(options.definition);
        this._softDeleteConfig = resolveModelSoftDeleteConfig(options.definition);
        this.softDeleteConfig = this._softDeleteConfig;
        this._versionConfig = resolveModelVersionConfig(options.definition);
        this._v1HooksFactory = resolveModelHooksFactory(options.definition);
        scheduleModelIndexes(this.collection, options.definition, this._softDeleteConfig, {
            runtime: this.runtime as object,
            dbName: options.dbName,
            poolName: options.poolName,
            collectionName: options.collectionName,
            autoIndex: (this.runtime as { options?: { autoIndex?: ModelAutoIndexOptions } }).options?.autoIndex,
        });
        this._v1InstanceMethods = initializeModelV1Methods(
            this,
            options.definition,
            (this.runtime as { logger?: { warn?: (...args: unknown[]) => void } }).logger ?? null,
        );
    }

    getNamespace(): { iid: string; type: 'mongodb'; db: string; collection: string; pool?: string; } {
        return this.collection.getNamespace();
    }

    raw(): unknown {
        return this.collection.raw();
    }

    private extendedCollection(): ExtendedModelCollectionLike<TDocument> {
        return this.collection as ExtendedModelCollectionLike<TDocument>;
    }

    private nowDate(): Date {
        return new Date();
    }

    private runModelWrite<TResult>(executor: () => TResult): TResult {
        return runWithModelWriteSource(executor);
    }

    private async runV1HookedOperation<TResult>(
        operation: 'find' | 'insert' | 'update' | 'delete',
        args: unknown[],
        executor: (...resolvedArgs: unknown[]) => Promise<TResult> | TResult,
    ): Promise<TResult> {
        if (!this._v1HooksFactory) {
            return executor(...args);
        }
        const hookContext: Record<string, unknown> = {};
        let resolvedArgs = [...args];
        const beforeResult = await runModelV1Hook(this._v1HooksFactory, this, operation, 'before', hookContext, ...resolvedArgs);
        if (beforeResult !== undefined) {
            resolvedArgs = Array.isArray(beforeResult)
                ? beforeResult
                : [beforeResult, ...resolvedArgs.slice(1)];
        }
        let result = await executor(...resolvedArgs) as Awaited<TResult>;
        try {
            const afterResult = await runModelV1Hook(this._v1HooksFactory, this, operation, 'after', hookContext, result);
            if (afterResult !== undefined) {
                result = afterResult as Awaited<TResult>;
            }
        } catch { /* after hooks don't affect operation */ }
        return result as TResult;
    }

    private isVisibleBySoftDelete(doc: TDocument | null | undefined, options?: unknown): doc is TDocument {
        if (!doc || !this._softDeleteConfig?.enabled) {
            return Boolean(doc);
        }
        const rawOptions = (options ?? {}) as Record<string, unknown>;
        if (rawOptions.withDeleted) {
            return true;
        }
        const value = (doc as Record<string, unknown>)[this._softDeleteConfig.field];
        if (rawOptions.onlyDeleted) {
            return value !== undefined && value !== null;
        }
        return value === undefined || value === null;
    }

    private filterVisibleBySoftDelete(docs: Array<TDocument | null | undefined>, options?: unknown): TDocument[] {
        return docs.filter((doc): doc is TDocument => this.isVisibleBySoftDelete(doc, options));
    }

    private applySoftDeleteFindPageOptions(options?: unknown): unknown {
        const rawOptions = (options ?? {}) as Record<string, unknown>;
        return {
            ...rawOptions,
            query: applyModelSoftDeleteFilter(rawOptions.query, rawOptions, this._softDeleteConfig),
        };
    }

    private applySoftDeleteAggregatePipeline(pipeline?: unknown[], options?: unknown): unknown[] {
        if (!this._softDeleteConfig?.enabled) {
            return pipeline ?? [];
        }
        const rawOptions = (options ?? {}) as Record<string, unknown>;
        if (rawOptions.withDeleted) {
            return pipeline ?? [];
        }
        const softDeleteMatch = applyModelSoftDeleteFilter({}, rawOptions, this._softDeleteConfig) as Record<string, unknown>;
        const matchStage = { $match: softDeleteMatch };
        const stages = [...(pipeline ?? [])];
        if (stages.length > 0 && stages[0] && typeof stages[0] === 'object' && '$geoNear' in (stages[0] as Record<string, unknown>)) {
            return [stages[0], matchStage, ...stages.slice(1)];
        }
        return [matchStage, ...stages];
    }

    // ── public API ────────────────────────────────────────────────────────────────

    find(query?: unknown, options?: unknown): PopulateProxy<Array<TDocument & Record<string, unknown>>> {
        return new PopulatePromise(async (paths) => {
            const filteredQuery = applyModelSoftDeleteFilter(query, options, this._softDeleteConfig);

            if (this._v1HooksFactory) {
                return this.runV1HookedOperation('find', [filteredQuery, options], async (nextQuery, nextOptions) => {
                    const docs = await this.collection.find(nextQuery, nextOptions) as Array<TDocument | null | undefined>;
                    return this.populateDocuments(this.hydrateDocuments(docs), paths);
                });
            }

            await this.runHook('beforeFind', { operation: 'find', collection: this.collectionName, filter: filteredQuery });
            const docs = await this.collection.find(filteredQuery, options) as Array<TDocument | null | undefined>;
            const result = await this.populateDocuments(this.hydrateDocuments(docs), paths);
            await this.runHook('afterFind', { operation: 'find', collection: this.collectionName, filter: filteredQuery, result });

            return result;
        });
    }

    findOne(query?: unknown, options?: unknown): PopulateProxy<(TDocument & Record<string, unknown>) | null> {
        return new PopulatePromise(async (paths) => {
            const filteredQuery = applyModelSoftDeleteFilter(query, options, this._softDeleteConfig);

            if (this._v1HooksFactory) {
                return this.runV1HookedOperation('find', [filteredQuery, options], async (nextQuery, nextOptions) => {
                    const doc = await this.collection.findOne(nextQuery, nextOptions) as TDocument | null | undefined;
                    return this.populateSingle(this.hydrateDocument(doc), paths);
                });
            }

            await this.runHook('beforeFind', { operation: 'findOne', collection: this.collectionName, filter: filteredQuery });
            const doc = await this.collection.findOne(filteredQuery, options) as TDocument | null | undefined;
            const result = await this.populateSingle(this.hydrateDocument(doc), paths);
            await this.runHook('afterFind', { operation: 'findOne', collection: this.collectionName, filter: filteredQuery, result });

            return result;
        });
    }

    findOneById(id: unknown, options?: unknown): PopulateProxy<(TDocument & Record<string, unknown>) | null> {
        return new PopulatePromise(async (paths) => {
            const doc = this._v1HooksFactory
                ? await this.runV1HookedOperation('find', [id, options], (nextId, nextOptions) => this.collection.findOneById(nextId, nextOptions) as Promise<TDocument | null | undefined>)
                : await this.collection.findOneById(id, options) as TDocument | null | undefined;
            return this.populateSingle(this.hydrateDocument(this.isVisibleBySoftDelete(doc, options) ? doc : null), paths);
        });
    }

    findById(id: unknown, options?: unknown): PopulateProxy<(TDocument & Record<string, unknown>) | null> {
        return this.findOneById(id, options);
    }

    findByIds(ids: unknown[], options?: unknown): PopulateProxy<Array<TDocument & Record<string, unknown>>> {
        return new PopulatePromise(async (paths) => {
            const docs = this._v1HooksFactory
                ? await this.runV1HookedOperation('find', [ids, options], (nextIds, nextOptions) => this.collection.findByIds(nextIds as unknown[], nextOptions) as Promise<Array<TDocument | null | undefined>>)
                : await this.collection.findByIds(ids, options) as Array<TDocument | null | undefined>;
            return this.populateDocuments(this.hydrateDocuments(this.filterVisibleBySoftDelete(docs, options)), paths);
        });
    }

    findPage(options?: unknown): PopulateProxy<{
        items: Array<TDocument & Record<string, unknown>>;
        pageInfo: {
            hasNext: boolean;
            hasPrev: boolean;
            startCursor: string | null;
            endCursor: string | null;
            currentPage?: number;
        };
        totals?: Record<string, unknown>;
    }> {
        return new PopulatePromise(async (paths) => {
            const filteredOptions = this.applySoftDeleteFindPageOptions(options);
            const result = this._v1HooksFactory
                ? await this.runV1HookedOperation('find', [filteredOptions], (nextOptions) => this.collection.findPage(nextOptions))
                : await this.collection.findPage(filteredOptions);
            return {
                ...result,
                items: await this.populateDocuments(this.hydrateDocuments(result.items), paths),
            };
        });
    }

    findAndCount(query?: unknown, options?: unknown): PopulateProxy<{
        data: Array<TDocument & Record<string, unknown>>;
        total: number;
    }> {
        return new PopulatePromise(async (paths) => {
            const filteredQuery = applyModelSoftDeleteFilter(query, options, this._softDeleteConfig);
            const result = this._v1HooksFactory
                ? await this.runV1HookedOperation('find', [filteredQuery, options], (nextQuery, nextOptions) => this.collection.findAndCount(nextQuery, nextOptions))
                : await this.collection.findAndCount(filteredQuery, options);
            return {
                data: await this.populateDocuments(this.hydrateDocuments(result.data as Array<TDocument | null | undefined>), paths),
                total: result.total,
            };
        });
    }

    async vectorSearch(
        options: ModelVectorSearchOptions,
    ): Promise<Array<VectorSearchHit<TDocument & Record<string, unknown>>>> {
        return executeModelVectorSearch(this.p0OperationsContext(), options);
    }
    count(query?: unknown, options?: unknown): Promise<number> {
        const filteredQuery = applyModelSoftDeleteFilter(query, options, this._softDeleteConfig);
        return this.runV1HookedOperation('find', [filteredQuery, options], (nextQuery, nextOptions) => this.collection.count(nextQuery, nextOptions));
    }

    async insertOne(document?: unknown, options?: unknown): Promise<{ acknowledged: boolean; insertedId: unknown; }> {
        return this.runModelWrite(() => orchestrateModelInsertOne(this.mutationContext(), document, options));
    }

    async insertMany(documents?: unknown[], options?: unknown): Promise<InsertManyResult> {
        return this.runModelWrite(() => orchestrateModelInsertMany(this.mutationContext(), documents, options));
    }

    async updateOne(filter?: unknown, update?: unknown, options?: unknown): Promise<UpdateResult> {
        return this.runModelWrite(() => orchestrateModelUpdateOne(this.mutationContext(), filter, update, options));
    }

    async updateMany(filter?: unknown, update?: unknown, options?: unknown): Promise<UpdateResult> {
        return this.runModelWrite(() => orchestrateModelUpdateMany(this.mutationContext(), filter, update, options));
    }

    async replaceOne(filter?: unknown, replacement?: unknown, options?: unknown): Promise<UpdateResult> {
        return this.runModelWrite(() => orchestrateModelReplaceOne(this.mutationContext(), filter, replacement, options));
    }

    findOneAndUpdate(filter?: unknown, update?: unknown, options?: unknown): Promise<TDocument | null> {
        return this.runModelWrite(() => orchestrateModelFindOneAndUpdate(this.mutationContext(), filter, update, options));
    }

    findOneAndReplace(filter?: unknown, replacement?: unknown, options?: unknown): Promise<TDocument | null> {
        return this.runModelWrite(() => orchestrateModelFindOneAndReplace(this.mutationContext(), filter, replacement, options));
    }

    findOneAndDelete(filter?: unknown, options?: unknown): Promise<TDocument | null> {
        return this.runModelWrite(() => orchestrateModelFindOneAndDelete(this.mutationContext(), filter, options));
    }

    async upsertOne(filter?: unknown, update?: unknown, options?: unknown): Promise<UpdateResult> {
        return this.runModelWrite(() => orchestrateModelUpsertOne(this.mutationContext(), filter, update, options));
    }

    async incrementOne(filter?: unknown, field?: string | Record<string, number>, increment?: number, options?: unknown): Promise<IncrementOneResult<TDocument>> {
        return this.runModelWrite(() => orchestrateModelIncrementOne(this.mutationContext(), filter, field, increment, options));
    }

    async insertBatch(docs: unknown[], options?: unknown): Promise<InsertBatchResult> {
        return this.runModelWrite(() => orchestrateModelInsertBatch(this.mutationContext(), docs, options));
    }

    async updateBatch(filter?: unknown, update?: unknown, options?: unknown): Promise<UpdateBatchResult> {
        return this.runModelWrite(() => orchestrateModelUpdateBatch(this.mutationContext(), filter, update, options));
    }

    async deleteBatch(filter?: unknown, options?: unknown): Promise<unknown> {
        return this.runModelWrite(() => orchestrateModelDeleteBatch(this.mutationContext(), filter, options));
    }

    async deleteOne(filter?: unknown, options?: unknown): Promise<unknown> {
        return this.runModelWrite(() => orchestrateModelDeleteOne(this.mutationContext(), filter, options));
    }

    async deleteMany(filter?: unknown, options?: unknown): Promise<unknown> {
        return this.runModelWrite(() => orchestrateModelDeleteMany(this.mutationContext(), filter, options));
    }

    /**
     * Inspects only registered and declared inbound relations. It is read-only;
     * callers must check coverage before treating an empty result as safe.
     */
    async checkRelationUsage(filter?: unknown, options?: RelationUsageOptions): Promise<RelationUsageReport> {
        return executeRelationUsageCheck(this.p0OperationsContext(), filter, options);
    }

    async deleteOneWithRelations(
        filter: unknown,
        options?: RelationProtectedDeleteOptions,
    ): Promise<RelationProtectedDeleteResult> {
        return executeProtectedRelationDelete(this.p0OperationsContext(), filter, options, false);
    }

    async forceDeleteWithRelations(
        filter: unknown,
        options?: RelationProtectedDeleteOptions,
    ): Promise<RelationProtectedDeleteResult> {
        return executeProtectedRelationDelete(this.p0OperationsContext(), filter, options, true);
    }

    // ── soft-delete extended methods (only meaningful when softDelete is enabled) ──

    findWithDeleted(query?: unknown, options?: unknown): PopulateProxy<Array<TDocument & Record<string, unknown>>> {
        return findWithDeletedDocuments(this.softDeleteContext(), query, options);
    }

    findOnlyDeleted(query?: unknown, options?: unknown): PopulateProxy<Array<TDocument & Record<string, unknown>>> {
        return findOnlyDeletedDocuments(this.softDeleteContext(), query, options);
    }

    findOneWithDeleted(query?: unknown, options?: unknown): PopulateProxy<(TDocument & Record<string, unknown>) | null> {
        return findOneWithDeletedDocument(this.softDeleteContext(), query, options);
    }

    findOneOnlyDeleted(query?: unknown, options?: unknown): PopulateProxy<(TDocument & Record<string, unknown>) | null> {
        return findOneOnlyDeletedDocument(this.softDeleteContext(), query, options);
    }

    countWithDeleted(query?: unknown, options?: unknown): Promise<number> {
        return countWithDeletedDocuments(this.softDeleteContext(), query, options);
    }
    countOnlyDeleted(query?: unknown, options?: unknown): Promise<number> {
        return countOnlyDeletedDocuments(this.softDeleteContext(), query, options);
    }

    async restore(filter?: unknown, options?: unknown): Promise<RestoreResult> {
        return this.runModelWrite(() => restoreSoftDeletedDocuments(this.softDeleteContext(), filter, options));
    }

    async restoreMany(filter?: unknown, options?: unknown): Promise<RestoreResult> {
        return this.runModelWrite(() => restoreManySoftDeletedDocuments(this.softDeleteContext(), filter, options));
    }

    async forceDelete(filter?: unknown, options?: unknown): Promise<unknown> {
        return this.runModelWrite(() => forceDeleteDocument(this.softDeleteContext(), filter, options));
    }

    async forceDeleteMany(filter?: unknown, options?: unknown): Promise<unknown> {
        return this.runModelWrite(() => forceDeleteManyDocuments(this.softDeleteContext(), filter, options));
    }
    createIndex(keys: unknown, options?: unknown): Promise<unknown> {
        return this.runModelWrite(() => this.collection.createIndex(keys, options));
    }

    createIndexes(specs: Array<{ key: unknown; } & Record<string, unknown>>): Promise<string[]> {
        return this.runModelWrite(() => this.collection.createIndexes(specs));
    }

    listIndexes(): Promise<Record<string, unknown>[]> {
        return this.collection.listIndexes();
    }

    ensureIndexes(options: ModelEnsureIndexesOptions = {}): Promise<ModelIndexEnsureResult> {
        return this.runModelWrite(() => ensureModelIndexesForCollection(this.collection, this.definition, this._softDeleteConfig, {
            ...options,
            runtime: this.runtime as object,
            dbName: this.dbName,
            poolName: this.poolName,
            collectionName: this.collectionName,
        }));
    }

    dropIndex(name: string): Promise<unknown> {
        return this.runModelWrite(() => this.collection.dropIndex(name));
    }

    dropIndexes(): Promise<unknown> {
        return this.runModelWrite(() => this.collection.dropIndexes());
    }

    prewarmBookmarks(keyDims?: unknown, pages?: number[]): Promise<unknown> {
        return this.extendedCollection().prewarmBookmarks(keyDims, pages);
    }

    listBookmarks(keyDims?: unknown): Promise<unknown> {
        return this.extendedCollection().listBookmarks(keyDims);
    }

    clearBookmarks(keyDims?: unknown): Promise<unknown> {
        return this.extendedCollection().clearBookmarks(keyDims);
    }

    distinct(key: string, query?: unknown, options?: unknown): Promise<unknown[]> {
        const filteredQuery = applyModelSoftDeleteFilter(query, options, this._softDeleteConfig);
        return this.runV1HookedOperation('find', [key, filteredQuery, options], (nextKey, nextQuery, nextOptions) => this.collection.distinct(nextKey as string, nextQuery, nextOptions));
    }

    aggregate(pipeline?: unknown[], options?: unknown): Promise<unknown[]> {
        const filteredPipeline = this.applySoftDeleteAggregatePipeline(pipeline, options);
        return this.runV1HookedOperation('find', [filteredPipeline, options], (nextPipeline, nextOptions) => {
            const execute = () => this.collection.aggregate(nextPipeline as unknown[] | undefined, nextOptions);
            if (resolveAggregateWriteTarget(Array.isArray(nextPipeline) ? nextPipeline as never[] : [])) {
                return this.runModelWrite(execute);
            }
            return execute();
        });
    }

    stream(query?: unknown, options?: unknown): NodeJS.ReadableStream {
        return this.extendedCollection().stream(applyModelSoftDeleteFilter(query, options, this._softDeleteConfig), options);
    }

    explain(query?: unknown, options?: unknown): Promise<unknown> {
        return this.extendedCollection().explain(applyModelSoftDeleteFilter(query, options, this._softDeleteConfig), options);
    }

    invalidate(op?: 'find' | 'findOne' | 'count' | 'findPage' | 'aggregate' | 'distinct'): Promise<number> {
        return this.extendedCollection().invalidate(op);
    }

    dropCollection(): Promise<boolean> {
        return this.runModelWrite(() => this.extendedCollection().dropCollection());
    }

    createCollection(name?: string, options?: Record<string, unknown>): Promise<boolean> {
        return this.runModelWrite(() => this.extendedCollection().createCollection(name, options));
    }

    createView(name: string, source: string, pipeline?: unknown[]): Promise<boolean> {
        return this.runModelWrite(() => this.extendedCollection().createView(name, source, pipeline));
    }

    indexStats(): Promise<unknown[]> {
        return this.extendedCollection().indexStats();
    }

    setValidator(validator: unknown, options?: { validationLevel?: string; validationAction?: string }): Promise<{ ok: number; collection: string }> {
        return this.runModelWrite(() => this.extendedCollection().setValidator(validator, options));
    }

    setValidationLevel(level: string): Promise<{ ok: number; validationLevel: string }> {
        return this.runModelWrite(() => this.extendedCollection().setValidationLevel(level));
    }

    setValidationAction(action: string): Promise<{ ok: number; validationAction: string }> {
        return this.runModelWrite(() => this.extendedCollection().setValidationAction(action));
    }

    getValidator(): Promise<{ validator: Record<string, unknown> | null; validationLevel: string; validationAction: string }> {
        return this.extendedCollection().getValidator();
    }

    stats(options?: { scale?: number }): Promise<{ ns: string; count: number; size: number; storageSize: number; totalIndexSize: number; nindexes: number; avgObjSize?: number; scaleFactor?: number }> {
        return this.extendedCollection().stats(options);
    }

    renameCollection(newName: string, options?: { dropTarget?: boolean }): Promise<{ renamed: boolean; from: string; to: string }> {
        return this.runModelWrite(() => this.extendedCollection().renameCollection(newName, options));
    }

    collMod(modifications: Record<string, unknown>): Promise<Record<string, unknown>> {
        return this.runModelWrite(() => this.extendedCollection().collMod(modifications));
    }

    convertToCapped(size: number, options?: { max?: number }): Promise<{ ok: number; collection: string; capped: boolean; size: number }> {
        return this.runModelWrite(() => this.extendedCollection().convertToCapped(size, options));
    }

    watch(pipeline?: unknown[], options?: unknown): unknown {
        return this.collection.watch(pipeline, options);
    }

    validate(document?: unknown): ValidationResult {
        return validateModelDocument({
            schemaError: this._schemaError,
            schemaCache: this._schemaCache,
            schemaValidateFn: this._schemaValidateFn,
        }, document);
    }

    private async populateSingle(
        doc: (TDocument & Record<string, unknown>) | null,
        paths: PopulatePath[],
    ): Promise<(TDocument & Record<string, unknown>) | null> {
        if (!doc) {
            return null;
        }
        const [result] = await this.populateDocuments([doc], paths);
        return result ?? null;
    }

    async populateDocuments(
        docs: Array<TDocument & Record<string, unknown>>,
        paths: PopulatePath[],
        traversalState?: PopulateTraversalState,
    ): Promise<Array<TDocument & Record<string, unknown>>> {
        let current = docs;
        for (const path of paths) {
            current = await this.populatePath(current, path, traversalState);
        }
        return current;
    }

    private async populatePath(
        docs: Array<TDocument & Record<string, unknown>>,
        path: PopulatePath,
        traversalState?: PopulateTraversalState,
    ): Promise<Array<TDocument & Record<string, unknown>>> {
        return populateModelPath({
            relations: this.relations,
            runtime: this.runtime,
            dbName: this.dbName,
            poolName: this.poolName,
        }, docs, path, traversalState);
    }

    hydrateDocuments(docs: Array<TDocument | null | undefined>): Array<TDocument & Record<string, unknown>> {
        return docs.filter(Boolean).map((doc) => this.hydrateDocument(doc) as TDocument & Record<string, unknown>);
    }

    private hydrateDocument(doc: TDocument | null | undefined): (TDocument & Record<string, unknown>) | null {
        return hydrateModelDocument({
            definition: this.definition,
            v1InstanceMethods: this._v1InstanceMethods,
            saveDocument: (document) => this.saveDocument(document),
            removeDocument: (document) => this.removeDocument(document),
            validateDocument: (document) => this.validate(document),
            populateDocument: (document, paths) => this.populateSingle(document, paths),
        }, doc);
    }

    private p0OperationsContext(): ModelP0OperationsHost<TDocument> {
        return {
            collection: this.collection,
            softDeleteConfig: this._softDeleteConfig,
            modelName: this.modelName,
            runtime: this.runtime,
            dbName: this.dbName,
            poolName: this.poolName,
            hydrateDocument: (doc) => this.hydrateDocument(doc),
            deleteOne: (filter, options) => this.deleteOne(filter, options),
            forceDelete: (filter, options) => this.forceDelete(filter, options),
        };
    }

    private softDeleteContext() {
        return {
            collection: this.collection,
            softDeleteConfig: this._softDeleteConfig,
            hydrateDocuments: (docs: Array<TDocument | null | undefined>) => this.hydrateDocuments(docs),
            hydrateDocument: (doc: TDocument | null | undefined) => this.hydrateDocument(doc),
            populateDocuments: (docs: Array<TDocument & Record<string, unknown>>, paths: PopulatePath[]) => this.populateDocuments(docs, paths),
            populateSingle: (doc: (TDocument & Record<string, unknown>) | null, paths: PopulatePath[]) => this.populateSingle(doc, paths),
        };
    }
    private async saveDocument(document: TDocument & Record<string, unknown>): Promise<TDocument & Record<string, unknown>> {
        return this.runModelWrite(() => saveModelDocument(this.collection, document, {
            timestampsConfig: this._timestampsConfig,
            versionConfig: this._versionConfig,
            schemaValidationContext: {
                validateEnabled: this._validateEnabled,
                schemaCache: this._schemaCache,
                schemaValidateFn: this._schemaValidateFn,
            },
            nowFactory: () => this.nowDate(),
        }));
    }
    private async removeDocument(document: TDocument & Record<string, unknown>): Promise<boolean> {
        return this.runModelWrite(() => removeModelDocument(this.collection, document));
    }
    private applyDefaults(document?: Record<string, unknown>): Record<string, unknown> {
        return applyModelDefaults(this.definition, document);
    }

    private mutationContext() {
        return {
            collectionName: this.collectionName,
            collection: this.collection,
            extendedCollection: () => this.extendedCollection(),
            applyDefaults: (document?: Record<string, unknown>) => this.applyDefaults(document),
            nowDate: () => this.nowDate(),
            timestampsConfig: this._timestampsConfig,
            softDeleteConfig: this._softDeleteConfig,
            versionConfig: this._versionConfig,
            validateEnabled: this._validateEnabled,
            schemaCache: this._schemaCache,
            schemaValidateFn: this._schemaValidateFn,
            hooksFactory: this._v1HooksFactory,
            runHook: (hookName: string, context: HookContext) => this.runHook(hookName, context),
        };
    }

    private async runHook(
        hookName: string,
        context: HookContext,
    ): Promise<void> {
        if (this._v1HooksFactory) return; // v1 factory – handled separately
        const hook = (this.definition.hooks as Record<string, unknown> | undefined)?.[hookName as string];
        if (typeof hook === 'function') {
            await (hook as (ctx: HookContext) => Promise<void> | void)(context);
        }
    }
}
