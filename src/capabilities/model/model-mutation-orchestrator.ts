/**
 * Model mutation orchestration (ModelMutationOrchestrator).
 *
 * Centralizes pre/post-write hooks (beforeSave/afterSave), timestamp injection,
 * version control (__v), and soft-delete marking to ensure consistent behavior
 * across all write operation paths.
 */
import type { HookContext } from '../../../types/model';
import type { DeleteBatchResult, IncrementOneResult, InsertBatchResult, InsertManyResult, UpdateBatchResult, UpdateResult } from '../../../types/collection';
import { ErrorCodes, createError } from '../../core/errors';
import type { ModelProtectedDeleteGuard } from '../../types/internal/model';
import type { ExtendedModelCollectionLike, ModelCollectionLike } from './populate-promise';
import {
    applyModelInsertTimestamps,
    applyModelInsertVersion,
    applyModelReplaceVersion,
    applyModelReplaceTimestamps,
    applyModelUpdateTimestamps,
    applyModelUpsertTimestamps,
    applyModelVersionIncrement,
    applyModelSoftDeleteFilter,
    buildStrictCandidateFilter,
    isModelVersionConflict,
    buildModelVisibleSoftDeleteCondition,
    iterateModelCandidateBatches,
    assertModelOptimisticLockDocument,
    assertModelOptimisticLockMatched,
    assertNumericExpectedVersion,
    buildModelVersionLookupOptions,
    preserveModelReplaceCreatedAt,
    resolveModelOptimisticLockAsync,
    resolveModelUpdateManyVersionMode,
    type ModelSchemaValidateFn,
    type ModelSoftDeleteConfig,
    type ModelTimestampConfig,
    type ModelV1HooksFactory,
    type ModelVersionConfig,
    runModelV1Hook,
    validateModelSchemaPayload,
} from './model-write-helpers';

type HookOperation = 'find' | 'insert' | 'update' | 'delete';
type HookPhase = 'before' | 'after';

type StrictUpdateManyResult = UpdateResult & {
    conflictCount: number;
    conflictedIds: unknown[];
    skippedCount: number;
    skippedIds: unknown[];
};

export type ModelMutationContext<TDocument = Record<string, unknown>> = {
    collectionName: string;
    collection: ModelCollectionLike<TDocument>;
    extendedCollection(): ExtendedModelCollectionLike<TDocument>;
    applyDefaults(document?: Record<string, unknown>): Record<string, unknown>;
    nowDate(): Date;
    timestampsConfig: ModelTimestampConfig;
    softDeleteConfig: ModelSoftDeleteConfig;
    versionConfig: ModelVersionConfig;
    validateEnabled: boolean;
    schemaCache: unknown;
    schemaValidateFn: ModelSchemaValidateFn;
    schemaError?: Error | null;
    hooksFactory: ModelV1HooksFactory;
    runHook(hookName: string, context: HookContext): Promise<void>;
    protectedDeleteGuard?: ModelProtectedDeleteGuard;
};



async function invokeStandardOperationHook<TDocument>(
    context: ModelMutationContext<TDocument>,
    operation: HookOperation,
    phase: HookPhase,
    payload: Omit<HookContext, 'collection'> & Pick<HookContext, 'operation'>,
): Promise<void> {

    const canonical = operation === 'insert'
        ? phase === 'before' ? 'beforeCreate' : 'afterCreate'
        : `${phase}${operation[0].toUpperCase()}${operation.slice(1)}`;
    const alias = `${phase}${operation[0].toUpperCase()}${operation.slice(1)}`;
    const hookPayload = { ...payload, collection: context.collectionName };
    await context.runHook(canonical, hookPayload);
    if (alias !== canonical) {
        await context.runHook(alias, hookPayload);
    }
}

async function runStrictUpdateMany<TDocument>(
    context: ModelMutationContext<TDocument>,
    filter: unknown,
    update: unknown,
    options: unknown,
): Promise<StrictUpdateManyResult> {
    if (!context.versionConfig?.enabled) {
        return context.collection.updateMany(filter, update, options) as Promise<StrictUpdateManyResult>;
    }
    const rawOptions = (options ?? {}) as Record<string, unknown>;
    if (rawOptions.upsert === true) {
        throw createError(ErrorCodes.INVALID_ARGUMENT, 'versionMode "strict" does not support upsert.');
    }
    let matchedCount = 0;
    let modifiedCount = 0;
    const conflictedIds: unknown[] = [];
    const skippedIds: unknown[] = [];
    for await (const batch of iterateModelCandidateBatches(context, filter, rawOptions, 200)) {
        for (const doc of batch) {
            const id = doc._id;
            const expectedVersion = assertNumericExpectedVersion(doc[context.versionConfig.field], 'updateMany');
            const result = await context.collection.updateOne(
                buildStrictCandidateFilter(filter, id, context.versionConfig.field, expectedVersion),
                update,
                options,
            );
            if ((result?.matchedCount ?? 0) === 0) {
                if (await isModelVersionConflict(context, filter, id, context.versionConfig.field, expectedVersion, options)) {
                    conflictedIds.push(id);
                } else {
                    skippedIds.push(id);
                }
                continue;
            }
            matchedCount += result.matchedCount ?? 0;
            modifiedCount += result.modifiedCount ?? 0;
        }
    }
    return {
        acknowledged: true,
        matchedCount,
        modifiedCount,
        upsertedCount: 0,
        upsertedId: null,
        conflictCount: conflictedIds.length,
        conflictedIds,
        skippedCount: skippedIds.length,
        skippedIds,
    };
}

async function runStrictUpdateBatch<TDocument>(
    context: ModelMutationContext<TDocument>,
    filter: unknown,
    update: unknown,
    options: unknown,
): Promise<UpdateBatchResult> {
    if (!context.versionConfig?.enabled) {
        return context.extendedCollection().updateBatch(filter, update, options) as Promise<UpdateBatchResult>;
    }
    const rawOptions = (options ?? {}) as Record<string, unknown>;
    if (rawOptions.upsert === true) {
        throw createError(ErrorCodes.INVALID_ARGUMENT, 'versionMode "strict" does not support upsert.');
    }
    const batchSize = rawOptions.batchSize === undefined ? 1000 : Number(rawOptions.batchSize);
    if (!Number.isInteger(batchSize) || batchSize <= 0) {
        throw createError(ErrorCodes.INVALID_ARGUMENT, 'batchSize must be a positive integer.');
    }
    const {
        batchSize: _batchSize,
        estimateProgress: _estimateProgress,
        onProgress,
        onError: _onError,
        retryAttempts: _retryAttempts,
        retryDelay: _retryDelay,
        onRetry: _onRetry,
        sort: _sort,
        ...driverOptions
    } = rawOptions;
    void _batchSize;
    void _estimateProgress;
    void _onError;
    void _retryAttempts;
    void _retryDelay;
    void _onRetry;
    void _sort;

    const countOptions = buildModelVersionLookupOptions(driverOptions, {});
    delete countOptions.projection;
    const totalCount = await context.collection.count(filter, countOptions);
    const result: UpdateBatchResult = {
        acknowledged: true,
        totalCount,
        matchedCount: 0,
        modifiedCount: 0,
        upsertedCount: 0,
        batchCount: 0,
        errors: [],
        retries: [],
        conflictCount: 0,
        conflictedIds: [],
        skippedCount: 0,
        skippedIds: [],
    };
    for await (const batch of iterateModelCandidateBatches(context, filter, driverOptions, batchSize)) {
        result.batchCount++;
        for (const doc of batch) {
            const id = doc._id;
            const expectedVersion = assertNumericExpectedVersion(doc[context.versionConfig.field], 'updateBatch');
            const updateResult = await context.collection.updateOne(
                buildStrictCandidateFilter(filter, id, context.versionConfig.field, expectedVersion),
                update,
                driverOptions,
            );
            if ((updateResult?.matchedCount ?? 0) === 0) {
                if (await isModelVersionConflict(context, filter, id, context.versionConfig.field, expectedVersion, driverOptions)) {
                    result.conflictCount = (result.conflictCount ?? 0) + 1;
                    result.conflictedIds?.push(id);
                } else {
                    result.skippedCount = (result.skippedCount ?? 0) + 1;
                    result.skippedIds?.push(id);
                }
                continue;
            }
            result.matchedCount += updateResult.matchedCount ?? 0;
            result.modifiedCount += updateResult.modifiedCount ?? 0;
        }
        if (typeof onProgress === 'function') {
            onProgress({
                currentBatch: result.batchCount,
                totalBatches: Math.ceil(totalCount / batchSize),
                modified: result.modifiedCount,
                matched: result.matchedCount,
                total: totalCount,
                percentage: totalCount > 0 ? Math.round((result.modifiedCount / totalCount) * 100) : null,
                errors: result.errors.length,
                retries: result.retries.length,
                conflicts: result.conflictCount ?? 0,
                skipped: result.skippedCount ?? 0,
            });
        }
    }
    return result;
}

function buildSoftDeleteUpdate<TDocument>(context: ModelMutationContext<TDocument>): unknown {
    const config = context.softDeleteConfig!;
    return applyModelVersionIncrement({ $set: { [config.field]: config.type === 'boolean' ? true : context.nowDate() } }, context.versionConfig);
}

function buildSoftDeleteFilter(filter: unknown, config: ModelSoftDeleteConfig): Record<string, unknown> {
    return applyModelSoftDeleteFilter(filter, {}, config) as Record<string, unknown>;
}

function applyModelIncrementVersion(
    field: string | Record<string, number> | undefined,
    increment: number | undefined,
    versionConfig: ModelVersionConfig,
): { field: string | Record<string, number> | undefined; increment: number | undefined } {
    if (!versionConfig?.enabled || field === undefined) {
        return { field, increment };
    }
    if (typeof field === 'string') {
        if (field === versionConfig.field) {
            return { field, increment };
        }
        return {
            field: { [field]: increment ?? 1, [versionConfig.field]: 1 },
            increment: undefined,
        };
    }
    if (field && typeof field === 'object' && !Array.isArray(field)) {
        if (field[versionConfig.field] !== undefined) {
            return { field, increment };
        }
        return {
            field: { ...field, [versionConfig.field]: 1 },
            increment,
        };
    }
    return { field, increment };
}

async function executeModelInsertOne<TDocument = Record<string, unknown>>(
    context: ModelMutationContext<TDocument>,
    document?: unknown,
    options?: unknown,
): Promise<{ acknowledged: boolean; insertedId: unknown }> {
    let payload = context.applyDefaults(document as Record<string, unknown> | undefined);

    await invokeStandardOperationHook(context, 'insert', 'before', { operation: 'insertOne', data: payload });

    payload = validateModelSchemaPayload({
        validateEnabled: context.validateEnabled,
        schemaCache: context.schemaCache,
        schemaValidateFn: context.schemaValidateFn,
        schemaError: context.schemaError,
    }, payload, options as Record<string, unknown> | undefined);

    payload = applyModelInsertTimestamps(payload, context.timestampsConfig, () => context.nowDate());
    payload = applyModelInsertVersion(payload, context.versionConfig);

    const result = await context.collection.insertOne(payload, options);

    await invokeStandardOperationHook(context, 'insert', 'after', {
        operation: 'insertOne',
        data: payload,
        result,
    });

    return result;
}

async function executeModelInsertMany<TDocument = Record<string, unknown>>(
    context: ModelMutationContext<TDocument>,
    documents?: unknown[],
    options?: unknown,
): Promise<InsertManyResult> {
    const docs = (documents ?? []).map((document) => context.applyDefaults(document as Record<string, unknown>));
    await invokeStandardOperationHook(context, 'insert', 'before', { operation: 'insertMany', data: docs });
    const resolvedOptions = (options ?? {}) as Record<string, unknown>;
    for (let index = 0; index < docs.length; index++) {
        let doc = docs[index] as Record<string, unknown>;
        doc = validateModelSchemaPayload({
            validateEnabled: context.validateEnabled,
            schemaCache: context.schemaCache,
            schemaValidateFn: context.schemaValidateFn,
            schemaError: context.schemaError,
        }, doc, resolvedOptions, { index });
        doc = applyModelInsertTimestamps(doc, context.timestampsConfig, () => context.nowDate());
        doc = applyModelInsertVersion(doc, context.versionConfig);
        docs[index] = doc;
    }
    const result = await context.collection.insertMany(docs, options);
    await invokeStandardOperationHook(context, 'insert', 'after', { operation: 'insertMany', data: docs, result });
    return result;
}

async function executeModelUpdateOne<TDocument = Record<string, unknown>>(
    context: ModelMutationContext<TDocument>,
    filter?: unknown,
    update?: unknown,
    options?: unknown,
): Promise<UpdateResult> {
    let nextUpdate = update;

    await invokeStandardOperationHook(context, 'update', 'before', {
        operation: 'updateOne',
        filter,
        update: nextUpdate,
    });

    nextUpdate = applyModelVersionIncrement(
        applyModelUpdateTimestamps(nextUpdate, context.timestampsConfig, () => context.nowDate()),
        context.versionConfig,
    );
    const lock = await resolveModelOptimisticLockAsync(context.collection, filter, options, context.versionConfig, 'updateOne');
    const result = await context.collection.updateOne(lock.filter, nextUpdate, lock.driverOptions);
    assertModelOptimisticLockMatched(result, context.versionConfig);

    await invokeStandardOperationHook(context, 'update', 'after', {
        operation: 'updateOne',
        filter,
        update: nextUpdate,
        result,
    });

    return result;
}

async function executeModelUpdateMany<TDocument = Record<string, unknown>>(
    context: ModelMutationContext<TDocument>,
    filter?: unknown,
    update?: unknown,
    options?: unknown,
): Promise<UpdateResult> {
    let nextUpdate = update;
    await invokeStandardOperationHook(context, 'update', 'before', { operation: 'updateMany', filter, update: nextUpdate });
    const versionMode = resolveModelUpdateManyVersionMode(options, context.versionConfig);
    const timestampedUpdate = applyModelUpdateTimestamps(update, context.timestampsConfig, () => context.nowDate());
    nextUpdate = versionMode.mode === 'off'
        ? timestampedUpdate
        : applyModelVersionIncrement(timestampedUpdate, context.versionConfig);
    const result = versionMode.mode === 'strict'
        ? await runStrictUpdateMany(context, filter, nextUpdate, versionMode.driverOptions)
        : await context.collection.updateMany(filter, nextUpdate, versionMode.driverOptions);
    await invokeStandardOperationHook(context, 'update', 'after', { operation: 'updateMany', filter, update: nextUpdate, result });
    return result;
}

async function executeModelReplaceOne<TDocument = Record<string, unknown>>(
    context: ModelMutationContext<TDocument>,
    filter?: unknown,
    replacement?: unknown,
    options?: unknown,
): Promise<UpdateResult> {
    await invokeStandardOperationHook(context, 'update', 'before', { operation: 'replaceOne', filter, update: replacement });
    let nextReplacement = validateModelSchemaPayload({
        validateEnabled: context.validateEnabled,
        schemaCache: context.schemaCache,
        schemaValidateFn: context.schemaValidateFn,
        schemaError: context.schemaError,
    }, replacement as Record<string, unknown>, options as Record<string, unknown> | undefined);
    nextReplacement = preserveModelReplaceCreatedAt(
        replacement as Record<string, unknown>,
        nextReplacement,
        context.timestampsConfig,
    );
    const lock = await resolveModelOptimisticLockAsync(context.collection, filter, options, context.versionConfig, 'replaceOne');
    nextReplacement = applyModelReplaceVersion(
        applyModelReplaceTimestamps(nextReplacement, context.timestampsConfig, () => context.nowDate()),
        context.versionConfig,
        lock.expectedVersion,
    ) as Record<string, unknown>;
    const result = await context.collection.replaceOne(lock.filter, nextReplacement, lock.driverOptions);
    assertModelOptimisticLockMatched(result, context.versionConfig);
    await invokeStandardOperationHook(context, 'update', 'after', { operation: 'replaceOne', filter, update: nextReplacement, result });
    return result;
}

async function executeModelFindOneAndUpdate<TDocument = Record<string, unknown>>(
    context: ModelMutationContext<TDocument>,
    filter?: unknown,
    update?: unknown,
    options?: unknown,
): Promise<TDocument | null> {
    await invokeStandardOperationHook(context, 'update', 'before', { operation: 'findOneAndUpdate', filter, update });
    const nextUpdate = applyModelVersionIncrement(
        applyModelUpdateTimestamps(update, context.timestampsConfig, () => context.nowDate()),
        context.versionConfig,
    );
    const lock = await resolveModelOptimisticLockAsync(context.collection, filter, options, context.versionConfig, 'findOneAndUpdate');
    const result = await context.collection.findOneAndUpdate(lock.filter, nextUpdate, lock.driverOptions);
    assertModelOptimisticLockDocument(result, context.versionConfig);
    await invokeStandardOperationHook(context, 'update', 'after', { operation: 'findOneAndUpdate', filter, update: nextUpdate, result });
    return result;
}

async function executeModelFindOneAndReplace<TDocument = Record<string, unknown>>(
    context: ModelMutationContext<TDocument>,
    filter?: unknown,
    replacement?: unknown,
    options?: unknown,
): Promise<TDocument | null> {
    await invokeStandardOperationHook(context, 'update', 'before', { operation: 'findOneAndReplace', filter, update: replacement });
    let nextReplacement = validateModelSchemaPayload({
        validateEnabled: context.validateEnabled,
        schemaCache: context.schemaCache,
        schemaValidateFn: context.schemaValidateFn,
        schemaError: context.schemaError,
    }, replacement as Record<string, unknown>, options as Record<string, unknown> | undefined);
    nextReplacement = preserveModelReplaceCreatedAt(
        replacement as Record<string, unknown>,
        nextReplacement,
        context.timestampsConfig,
    );
    const lock = await resolveModelOptimisticLockAsync(context.collection, filter, options, context.versionConfig, 'findOneAndReplace');
    nextReplacement = applyModelReplaceVersion(
        applyModelReplaceTimestamps(nextReplacement, context.timestampsConfig, () => context.nowDate()),
        context.versionConfig,
        lock.expectedVersion,
    ) as Record<string, unknown>;
    const result = await context.extendedCollection().findOneAndReplace(lock.filter, nextReplacement, lock.driverOptions);
    assertModelOptimisticLockDocument(result, context.versionConfig);
    await invokeStandardOperationHook(context, 'update', 'after', { operation: 'findOneAndReplace', filter, update: nextReplacement, result });
    return result;
}

async function executeModelFindOneAndDelete<TDocument = Record<string, unknown>>(
    context: ModelMutationContext<TDocument>,
    filter?: unknown,
    options?: unknown,
): Promise<TDocument | null> {
    await invokeStandardOperationHook(context, 'delete', 'before', { operation: 'findOneAndDelete', filter });
    const softDeleteConfig = context.softDeleteConfig;
    const resolvedOptions = (options ?? {}) as Record<string, unknown>;
    const result = softDeleteConfig?.enabled && !resolvedOptions._forceDelete
        ? await context.collection.findOneAndUpdate(
            buildSoftDeleteFilter(filter, softDeleteConfig),
            buildSoftDeleteUpdate(context),
            { ...resolvedOptions, returnDocument: resolvedOptions.returnDocument ?? 'before' },
        )
        : await context.collection.findOneAndDelete(filter, options);
    await invokeStandardOperationHook(context, 'delete', 'after', { operation: 'findOneAndDelete', filter, result });
    return result;
}

async function executeModelUpsertOne<TDocument = Record<string, unknown>>(
    context: ModelMutationContext<TDocument>,
    filter?: unknown,
    update?: unknown,
    options?: unknown,
): Promise<UpdateResult> {
    await invokeStandardOperationHook(context, 'update', 'before', { operation: 'upsertOne', filter, update });
    const nextUpdate = applyModelUpsertTimestamps(update, context.timestampsConfig, () => context.nowDate());
    const result = await context.collection.upsertOne(filter, nextUpdate, options);
    await invokeStandardOperationHook(context, 'update', 'after', { operation: 'upsertOne', filter, update: nextUpdate, result });
    return result;
}

async function executeModelIncrementOne<TDocument = Record<string, unknown>>(
    context: ModelMutationContext<TDocument>,
    filter?: unknown,
    field?: string | Record<string, number>,
    increment?: number,
    options?: unknown,
): Promise<IncrementOneResult<TDocument>> {
    await invokeStandardOperationHook(context, 'update', 'before', { operation: 'incrementOne', filter, update: field });
    const timestamps = context.timestampsConfig;
    let result: IncrementOneResult<TDocument>;
    const incrementArgs = applyModelIncrementVersion(field, increment, context.versionConfig);
    if (timestamps && timestamps.updatedAt !== false) {
        const resolvedOptions = (options ?? {}) as Record<string, unknown>;
        const $set = {
            ...((resolvedOptions.$set ?? {}) as Record<string, unknown>),
            [timestamps.updatedAt]: context.nowDate(),
        };
        result = await context.extendedCollection().incrementOne(filter, incrementArgs.field, incrementArgs.increment, { ...resolvedOptions, $set });
    } else {
        result = await context.extendedCollection().incrementOne(filter, incrementArgs.field, incrementArgs.increment, options);
    }
    await invokeStandardOperationHook(context, 'update', 'after', { operation: 'incrementOne', filter, update: field, result });
    return result;
}

async function executeModelInsertBatch<TDocument = Record<string, unknown>>(
    context: ModelMutationContext<TDocument>,
    docs: unknown[],
    options?: unknown,
): Promise<InsertBatchResult> {
    const docsToInsert = docs.map((doc) => context.applyDefaults(doc as Record<string, unknown>));
    await invokeStandardOperationHook(context, 'insert', 'before', { operation: 'insertBatch', data: docsToInsert });
    const resolvedOptions = (options ?? {}) as Record<string, unknown>;
    for (let index = 0; index < docsToInsert.length; index++) {
        let record = docsToInsert[index] as Record<string, unknown>;
        record = validateModelSchemaPayload({
            validateEnabled: context.validateEnabled,
            schemaCache: context.schemaCache,
            schemaValidateFn: context.schemaValidateFn,
            schemaError: context.schemaError,
        }, record, resolvedOptions, { index });
        record = applyModelInsertTimestamps(record, context.timestampsConfig, () => context.nowDate());
        record = applyModelInsertVersion(record, context.versionConfig) as Record<string, unknown>;
        docsToInsert[index] = record;
    }
    const result = await context.extendedCollection().insertBatch(docsToInsert, options);
    await invokeStandardOperationHook(context, 'insert', 'after', { operation: 'insertBatch', data: docsToInsert, result });
    return result;
}

async function executeModelUpdateBatch<TDocument = Record<string, unknown>>(
    context: ModelMutationContext<TDocument>,
    filter?: unknown,
    update?: unknown,
    options?: unknown,
): Promise<UpdateBatchResult> {
    await invokeStandardOperationHook(context, 'update', 'before', { operation: 'updateBatch', filter, update });
    const versionMode = resolveModelUpdateManyVersionMode(options, context.versionConfig);
    const timestampedUpdate = applyModelUpdateTimestamps(update, context.timestampsConfig, () => context.nowDate());
    const nextUpdate = versionMode.mode === 'off'
        ? timestampedUpdate
        : applyModelVersionIncrement(timestampedUpdate, context.versionConfig);
    const result = versionMode.mode === 'strict'
        ? await runStrictUpdateBatch(context, filter, nextUpdate, versionMode.driverOptions)
        : await context.extendedCollection().updateBatch(filter, nextUpdate, versionMode.driverOptions);
    await invokeStandardOperationHook(context, 'update', 'after', { operation: 'updateBatch', filter, update: nextUpdate, result });
    return result;
}

async function executeModelDeleteBatch<TDocument = Record<string, unknown>>(
    context: ModelMutationContext<TDocument>,
    filter?: unknown,
    options?: unknown,
): Promise<DeleteBatchResult | UpdateBatchResult> {
    const softDeleteConfig = context.softDeleteConfig;
    const resolvedOptions = (options ?? {}) as Record<string, unknown>;
    await invokeStandardOperationHook(context, 'delete', 'before', { operation: 'deleteBatch', filter });
    const result = softDeleteConfig?.enabled && !resolvedOptions._forceDelete
        ? await context.extendedCollection().updateBatch(
            buildSoftDeleteFilter(filter, softDeleteConfig),
            buildSoftDeleteUpdate(context),
            options,
        )
        : await context.extendedCollection().deleteBatch(filter, options);
    await invokeStandardOperationHook(context, 'delete', 'after', { operation: 'deleteBatch', filter, result });
    return result;
}

async function executeModelDeleteOne<TDocument = Record<string, unknown>>(
    context: ModelMutationContext<TDocument>,
    filter?: unknown,
    options?: unknown,
): Promise<unknown> {
    const softDeleteConfig = context.softDeleteConfig;

    await invokeStandardOperationHook(context, 'delete', 'before', {
        operation: 'deleteOne',
        filter,
    });

    if (context.protectedDeleteGuard) {
        // Keep the guard in private context so replacing options cannot drop it.
        const checked = await context.protectedDeleteGuard(filter, options);
        filter = checked.filter;
        options = checked.options;
    }
    const resolvedOptions = (options ?? {}) as Record<string, unknown>;
    let result: unknown;
    if (softDeleteConfig?.enabled && (context.protectedDeleteGuard || !resolvedOptions._forceDelete)) {
        result = await context.collection.updateOne(
            buildSoftDeleteFilter(filter, softDeleteConfig),
            buildSoftDeleteUpdate(context),
            options,
        );
    } else {
        result = await context.collection.deleteOne(filter, options);
    }

    await invokeStandardOperationHook(context, 'delete', 'after', {
        operation: 'deleteOne',
        filter,
        result,
    });

    return result;
}

async function executeModelDeleteMany<TDocument = Record<string, unknown>>(
    context: ModelMutationContext<TDocument>,
    filter?: unknown,
    options?: unknown,
): Promise<unknown> {
    const softDeleteConfig = context.softDeleteConfig;
    const resolvedOptions = (options ?? {}) as Record<string, unknown>;
    await invokeStandardOperationHook(context, 'delete', 'before', { operation: 'deleteMany', filter });
    let result: unknown;
    if (softDeleteConfig?.enabled && !resolvedOptions._forceDelete) {
        result = await context.collection.updateMany(
            { $and: [filter ?? {}, buildModelVisibleSoftDeleteCondition(softDeleteConfig)] },
            buildSoftDeleteUpdate(context),
            options,
        );
    } else {
        result = await context.collection.deleteMany(filter, options);
    }
    await invokeStandardOperationHook(context, 'delete', 'after', { operation: 'deleteMany', filter, result });
    return result;
}

type MutationExecutor = (context: ModelMutationContext, ...args: never[]) => Promise<unknown>;

function withMutationHooks<T extends MutationExecutor>(
    operation: HookOperation, executor: T, defaultsKind: 'one' | 'many' | false = false,
): T {
    const wrapped = async (context: ModelMutationContext, ...args: never[]) => {
        if (!context.hooksFactory) return executor(context, ...args);
        let resolvedArgs: unknown[] = [...args];
        if (defaultsKind) {
            const input = resolvedArgs[0];
            resolvedArgs[0] = defaultsKind === 'one'
                ? context.applyDefaults(input as Record<string, unknown> | undefined)
                : Array.isArray(input) ? input.map((doc) => context.applyDefaults(doc)) : input;
        }
        const hookContext: Record<string, unknown> = {};
        const before = await runModelV1Hook(context.hooksFactory, context, operation, 'before', hookContext, ...resolvedArgs);
        if (before !== null && typeof before === 'object') resolvedArgs = Array.isArray(before) ? before : [before, ...resolvedArgs.slice(1)];
        const writeContext = {
            ...context, hooksFactory: null, runHook: async () => undefined,
            applyDefaults: defaultsKind ? (document?: Record<string, unknown>) => ({ ...document }) : context.applyDefaults,
        };
        let result = await executor(writeContext, ...resolvedArgs as never[]);
        try {
            const after = await runModelV1Hook(context.hooksFactory, context, operation, 'after', hookContext, result);
            if (after !== undefined) result = after;
        } catch { /* V1 after hooks do not undo completed writes. */ }
        return result;
    };
    // The wrapper retains each executor's generic arguments and return type.
    return wrapped as T;
}

export const orchestrateModelInsertOne = withMutationHooks('insert', executeModelInsertOne, 'one');
export const orchestrateModelInsertMany = withMutationHooks('insert', executeModelInsertMany, 'many');
export const orchestrateModelUpdateOne = withMutationHooks('update', executeModelUpdateOne);
export const orchestrateModelUpdateMany = withMutationHooks('update', executeModelUpdateMany);
export const orchestrateModelReplaceOne = withMutationHooks('update', executeModelReplaceOne);
export const orchestrateModelFindOneAndUpdate = withMutationHooks('update', executeModelFindOneAndUpdate);
export const orchestrateModelFindOneAndReplace = withMutationHooks('update', executeModelFindOneAndReplace);
export const orchestrateModelFindOneAndDelete = withMutationHooks('delete', executeModelFindOneAndDelete);
export const orchestrateModelUpsertOne = withMutationHooks('update', executeModelUpsertOne);
export const orchestrateModelIncrementOne = withMutationHooks('update', executeModelIncrementOne);
export const orchestrateModelInsertBatch = withMutationHooks('insert', executeModelInsertBatch, 'many');
export const orchestrateModelUpdateBatch = withMutationHooks('update', executeModelUpdateBatch);
export const orchestrateModelDeleteBatch = withMutationHooks('delete', executeModelDeleteBatch);
export const orchestrateModelDeleteOne = withMutationHooks('delete', executeModelDeleteOne);
export const orchestrateModelDeleteMany = withMutationHooks('delete', executeModelDeleteMany);
