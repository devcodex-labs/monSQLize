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
};

async function invokeV1Hook<TDocument>(
    context: ModelMutationContext<TDocument>,
    operation: HookOperation,
    phase: HookPhase,
    hookContext: Record<string, unknown>,
    ...args: unknown[]
): Promise<unknown> {
    return runModelV1Hook(context.hooksFactory, context, operation, phase, hookContext, ...args);
}

async function invokeStandardHook<TDocument>(
    context: ModelMutationContext<TDocument>,
    hookName: string,
    payload: HookContext,
): Promise<void> {
    if (context.hooksFactory) {
        return;
    }
    await context.runHook(hookName, payload);
}

async function invokeStandardOperationHook<TDocument>(
    context: ModelMutationContext<TDocument>,
    operation: HookOperation,
    phase: HookPhase,
    payload: HookContext,
): Promise<void> {
    if (context.hooksFactory) {
        return;
    }
    const canonical = operation === 'insert'
        ? phase === 'before' ? 'beforeCreate' : 'afterCreate'
        : `${phase}${operation[0].toUpperCase()}${operation.slice(1)}`;
    const alias = `${phase}${operation[0].toUpperCase()}${operation.slice(1)}`;
    await invokeStandardHook(context, canonical, payload);
    if (alias !== canonical) {
        await invokeStandardHook(context, alias, payload);
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

function buildSoftDeletePatch(config: ModelSoftDeleteConfig, now: Date): Record<string, unknown> {
    if (!config?.enabled) {
        return {};
    }
    return { [config.field]: config.type === 'boolean' ? true : now };
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

export async function orchestrateModelInsertOne<TDocument = Record<string, unknown>>(
    context: ModelMutationContext<TDocument>,
    document?: unknown,
    options?: unknown,
): Promise<{ acknowledged: boolean; insertedId: unknown }> {
    const hookContext: Record<string, unknown> = {};
    let payload = context.applyDefaults(document as Record<string, unknown> | undefined);

    if (context.hooksFactory) {
        const hookResult = await invokeV1Hook(context, 'insert', 'before', hookContext, payload);
        if (hookResult !== undefined && typeof hookResult === 'object') {
            payload = hookResult as Record<string, unknown>;
        }
    } else {
        await invokeStandardOperationHook(context, 'insert', 'before', { operation: 'insertOne', collection: context.collectionName, data: payload });
    }

    payload = validateModelSchemaPayload({
        validateEnabled: context.validateEnabled,
        schemaCache: context.schemaCache,
        schemaValidateFn: context.schemaValidateFn,
        schemaError: context.schemaError,
    }, payload, options as Record<string, unknown> | undefined);

    payload = applyModelInsertTimestamps(payload, context.timestampsConfig, () => context.nowDate());
    payload = applyModelInsertVersion(payload, context.versionConfig);

    const result = await context.collection.insertOne(payload, options);

    if (context.hooksFactory) {
        try {
            await invokeV1Hook(context, 'insert', 'after', hookContext, result);
        } catch { /* after hooks don't affect operation */ }
    } else {
        await invokeStandardOperationHook(context, 'insert', 'after', {
            operation: 'insertOne',
            collection: context.collectionName,
            data: payload,
            result,
        });
    }

    return result;
}

export async function orchestrateModelInsertMany<TDocument = Record<string, unknown>>(
    context: ModelMutationContext<TDocument>,
    documents?: unknown[],
    options?: unknown,
): Promise<InsertManyResult> {
    const hookContext: Record<string, unknown> = {};
    const docs = (documents ?? []).map((document) => context.applyDefaults(document as Record<string, unknown>));
    if (context.hooksFactory) {
        await invokeV1Hook(context, 'insert', 'before', hookContext, docs);
    } else {
        await invokeStandardOperationHook(context, 'insert', 'before', { operation: 'insertMany', collection: context.collectionName, data: docs });
    }
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
    if (context.hooksFactory) {
        try { await invokeV1Hook(context, 'insert', 'after', hookContext, result); } catch { /* after hooks don't affect operation */ }
    } else {
        await invokeStandardOperationHook(context, 'insert', 'after', { operation: 'insertMany', collection: context.collectionName, data: docs, result });
    }
    return result;
}

export async function orchestrateModelUpdateOne<TDocument = Record<string, unknown>>(
    context: ModelMutationContext<TDocument>,
    filter?: unknown,
    update?: unknown,
    options?: unknown,
): Promise<UpdateResult> {
    const hookContext: Record<string, unknown> = {};
    let nextUpdate = update;

    if (context.hooksFactory) {
        await invokeV1Hook(context, 'update', 'before', hookContext, filter, nextUpdate);
    } else {
        await invokeStandardOperationHook(context, 'update', 'before', {
            operation: 'updateOne',
            collection: context.collectionName,
            filter,
            update: nextUpdate,
        });
    }

    nextUpdate = applyModelVersionIncrement(
        applyModelUpdateTimestamps(nextUpdate, context.timestampsConfig, () => context.nowDate()),
        context.versionConfig,
    );
    const lock = await resolveModelOptimisticLockAsync(context.collection, filter, options, context.versionConfig, 'updateOne');
    const result = await context.collection.updateOne(lock.filter, nextUpdate, lock.driverOptions);
    assertModelOptimisticLockMatched(result, context.versionConfig);

    if (context.hooksFactory) {
        try {
            await invokeV1Hook(context, 'update', 'after', hookContext, result);
        } catch { /* after hooks don't affect operation */ }
    } else {
        await invokeStandardOperationHook(context, 'update', 'after', {
            operation: 'updateOne',
            collection: context.collectionName,
            filter,
            update: nextUpdate,
            result,
        });
    }

    return result;
}

export async function orchestrateModelUpdateMany<TDocument = Record<string, unknown>>(
    context: ModelMutationContext<TDocument>,
    filter?: unknown,
    update?: unknown,
    options?: unknown,
): Promise<UpdateResult> {
    const hookContext: Record<string, unknown> = {};
    let nextUpdate = update;
    if (context.hooksFactory) {
        await invokeV1Hook(context, 'update', 'before', hookContext, filter, nextUpdate);
    } else {
        await invokeStandardOperationHook(context, 'update', 'before', { operation: 'updateMany', collection: context.collectionName, filter, update: nextUpdate });
    }
    const versionMode = resolveModelUpdateManyVersionMode(options, context.versionConfig);
    const timestampedUpdate = applyModelUpdateTimestamps(update, context.timestampsConfig, () => context.nowDate());
    nextUpdate = versionMode.mode === 'off'
        ? timestampedUpdate
        : applyModelVersionIncrement(timestampedUpdate, context.versionConfig);
    const result = versionMode.mode === 'strict'
        ? await runStrictUpdateMany(context, filter, nextUpdate, versionMode.driverOptions)
        : await context.collection.updateMany(filter, nextUpdate, versionMode.driverOptions);
    if (context.hooksFactory) {
        try { await invokeV1Hook(context, 'update', 'after', hookContext, result); } catch { /* after hooks don't affect operation */ }
    } else {
        await invokeStandardOperationHook(context, 'update', 'after', { operation: 'updateMany', collection: context.collectionName, filter, update: nextUpdate, result });
    }
    return result;
}

export async function orchestrateModelReplaceOne<TDocument = Record<string, unknown>>(
    context: ModelMutationContext<TDocument>,
    filter?: unknown,
    replacement?: unknown,
    options?: unknown,
): Promise<UpdateResult> {
    const hookContext: Record<string, unknown> = {};
    if (context.hooksFactory) {
        await invokeV1Hook(context, 'update', 'before', hookContext, filter, replacement);
    } else {
        await invokeStandardOperationHook(context, 'update', 'before', { operation: 'replaceOne', collection: context.collectionName, filter, update: replacement });
    }
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
    if (context.hooksFactory) {
        try { await invokeV1Hook(context, 'update', 'after', hookContext, result); } catch { /* after hooks don't affect operation */ }
    } else {
        await invokeStandardOperationHook(context, 'update', 'after', { operation: 'replaceOne', collection: context.collectionName, filter, update: nextReplacement, result });
    }
    return result;
}

export async function orchestrateModelFindOneAndUpdate<TDocument = Record<string, unknown>>(
    context: ModelMutationContext<TDocument>,
    filter?: unknown,
    update?: unknown,
    options?: unknown,
): Promise<TDocument | null> {
    const hookContext: Record<string, unknown> = {};
    if (context.hooksFactory) {
        await invokeV1Hook(context, 'update', 'before', hookContext, filter, update);
    } else {
        await invokeStandardOperationHook(context, 'update', 'before', { operation: 'findOneAndUpdate', collection: context.collectionName, filter, update });
    }
    const nextUpdate = applyModelVersionIncrement(
        applyModelUpdateTimestamps(update, context.timestampsConfig, () => context.nowDate()),
        context.versionConfig,
    );
    const lock = await resolveModelOptimisticLockAsync(context.collection, filter, options, context.versionConfig, 'findOneAndUpdate');
    const result = await context.collection.findOneAndUpdate(lock.filter, nextUpdate, lock.driverOptions);
    assertModelOptimisticLockDocument(result, context.versionConfig);
    if (context.hooksFactory) {
        try { await invokeV1Hook(context, 'update', 'after', hookContext, result); } catch { /* after hooks don't affect operation */ }
    } else {
        await invokeStandardOperationHook(context, 'update', 'after', { operation: 'findOneAndUpdate', collection: context.collectionName, filter, update: nextUpdate, result });
    }
    return result;
}

export async function orchestrateModelFindOneAndReplace<TDocument = Record<string, unknown>>(
    context: ModelMutationContext<TDocument>,
    filter?: unknown,
    replacement?: unknown,
    options?: unknown,
): Promise<TDocument | null> {
    const hookContext: Record<string, unknown> = {};
    if (context.hooksFactory) {
        await invokeV1Hook(context, 'update', 'before', hookContext, filter, replacement);
    } else {
        await invokeStandardOperationHook(context, 'update', 'before', { operation: 'findOneAndReplace', collection: context.collectionName, filter, update: replacement });
    }
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
    if (context.hooksFactory) {
        try { await invokeV1Hook(context, 'update', 'after', hookContext, result); } catch { /* after hooks don't affect operation */ }
    } else {
        await invokeStandardOperationHook(context, 'update', 'after', { operation: 'findOneAndReplace', collection: context.collectionName, filter, update: nextReplacement, result });
    }
    return result;
}

export async function orchestrateModelFindOneAndDelete<TDocument = Record<string, unknown>>(
    context: ModelMutationContext<TDocument>,
    filter?: unknown,
    options?: unknown,
): Promise<TDocument | null> {
    const hookContext: Record<string, unknown> = {};
    if (context.hooksFactory) {
        await invokeV1Hook(context, 'delete', 'before', hookContext, filter);
    } else {
        await invokeStandardOperationHook(context, 'delete', 'before', { operation: 'findOneAndDelete', collection: context.collectionName, filter });
    }
    const softDeleteConfig = context.softDeleteConfig;
    const resolvedOptions = (options ?? {}) as Record<string, unknown>;
    const result = softDeleteConfig?.enabled && !resolvedOptions._forceDelete
        ? await context.collection.findOneAndUpdate(
            buildSoftDeleteFilter(filter, softDeleteConfig),
            { $set: buildSoftDeletePatch(softDeleteConfig, context.nowDate()) },
            { ...resolvedOptions, returnDocument: resolvedOptions.returnDocument ?? 'before' },
        )
        : await context.collection.findOneAndDelete(filter, options);
    if (context.hooksFactory) {
        try { await invokeV1Hook(context, 'delete', 'after', hookContext, result); } catch { /* after hooks don't affect operation */ }
    } else {
        await invokeStandardOperationHook(context, 'delete', 'after', { operation: 'findOneAndDelete', collection: context.collectionName, filter, result });
    }
    return result;
}

export async function orchestrateModelUpsertOne<TDocument = Record<string, unknown>>(
    context: ModelMutationContext<TDocument>,
    filter?: unknown,
    update?: unknown,
    options?: unknown,
): Promise<UpdateResult> {
    const hookContext: Record<string, unknown> = {};
    if (context.hooksFactory) {
        await invokeV1Hook(context, 'update', 'before', hookContext, filter, update);
    } else {
        await invokeStandardOperationHook(context, 'update', 'before', { operation: 'upsertOne', collection: context.collectionName, filter, update });
    }
    const nextUpdate = applyModelUpsertTimestamps(update, context.timestampsConfig, () => context.nowDate());
    const result = await context.collection.upsertOne(filter, nextUpdate, options);
    if (context.hooksFactory) {
        try { await invokeV1Hook(context, 'update', 'after', hookContext, result); } catch { /* after hooks don't affect operation */ }
    } else {
        await invokeStandardOperationHook(context, 'update', 'after', { operation: 'upsertOne', collection: context.collectionName, filter, update: nextUpdate, result });
    }
    return result;
}

export async function orchestrateModelIncrementOne<TDocument = Record<string, unknown>>(
    context: ModelMutationContext<TDocument>,
    filter?: unknown,
    field?: string | Record<string, number>,
    increment?: number,
    options?: unknown,
): Promise<IncrementOneResult<TDocument>> {
    const hookContext: Record<string, unknown> = {};
    if (context.hooksFactory) {
        await invokeV1Hook(context, 'update', 'before', hookContext, filter, field, increment);
    } else {
        await invokeStandardOperationHook(context, 'update', 'before', { operation: 'incrementOne', collection: context.collectionName, filter, update: field });
    }
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
    if (context.hooksFactory) {
        try { await invokeV1Hook(context, 'update', 'after', hookContext, result); } catch { /* after hooks don't affect operation */ }
    } else {
        await invokeStandardOperationHook(context, 'update', 'after', { operation: 'incrementOne', collection: context.collectionName, filter, update: field, result });
    }
    return result;
}

export async function orchestrateModelInsertBatch<TDocument = Record<string, unknown>>(
    context: ModelMutationContext<TDocument>,
    docs: unknown[],
    options?: unknown,
): Promise<InsertBatchResult> {
    const hookContext: Record<string, unknown> = {};
    const docsToInsert = docs.map((doc) => context.applyDefaults(doc as Record<string, unknown>));
    if (context.hooksFactory) {
        await invokeV1Hook(context, 'insert', 'before', hookContext, docsToInsert);
    } else {
        await invokeStandardOperationHook(context, 'insert', 'before', { operation: 'insertBatch', collection: context.collectionName, data: docsToInsert });
    }
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
    if (context.hooksFactory) {
        try { await invokeV1Hook(context, 'insert', 'after', hookContext, result); } catch { /* after hooks don't affect operation */ }
    } else {
        await invokeStandardOperationHook(context, 'insert', 'after', { operation: 'insertBatch', collection: context.collectionName, data: docsToInsert, result });
    }
    return result;
}

export async function orchestrateModelUpdateBatch<TDocument = Record<string, unknown>>(
    context: ModelMutationContext<TDocument>,
    filter?: unknown,
    update?: unknown,
    options?: unknown,
): Promise<UpdateBatchResult> {
    const hookContext: Record<string, unknown> = {};
    if (context.hooksFactory) {
        await invokeV1Hook(context, 'update', 'before', hookContext, filter, update);
    } else {
        await invokeStandardOperationHook(context, 'update', 'before', { operation: 'updateBatch', collection: context.collectionName, filter, update });
    }
    const versionMode = resolveModelUpdateManyVersionMode(options, context.versionConfig);
    const timestampedUpdate = applyModelUpdateTimestamps(update, context.timestampsConfig, () => context.nowDate());
    const nextUpdate = versionMode.mode === 'off'
        ? timestampedUpdate
        : applyModelVersionIncrement(timestampedUpdate, context.versionConfig);
    const result = versionMode.mode === 'strict'
        ? await runStrictUpdateBatch(context, filter, nextUpdate, versionMode.driverOptions)
        : await context.extendedCollection().updateBatch(filter, nextUpdate, versionMode.driverOptions);
    if (context.hooksFactory) {
        try { await invokeV1Hook(context, 'update', 'after', hookContext, result); } catch { /* after hooks don't affect operation */ }
    } else {
        await invokeStandardOperationHook(context, 'update', 'after', { operation: 'updateBatch', collection: context.collectionName, filter, update: nextUpdate, result });
    }
    return result;
}

export async function orchestrateModelDeleteBatch<TDocument = Record<string, unknown>>(
    context: ModelMutationContext<TDocument>,
    filter?: unknown,
    options?: unknown,
): Promise<DeleteBatchResult | UpdateBatchResult> {
    const softDeleteConfig = context.softDeleteConfig;
    const resolvedOptions = (options ?? {}) as Record<string, unknown>;
    const hookContext: Record<string, unknown> = {};
    if (context.hooksFactory) {
        await invokeV1Hook(context, 'delete', 'before', hookContext, filter);
    } else {
        await invokeStandardOperationHook(context, 'delete', 'before', { operation: 'deleteBatch', collection: context.collectionName, filter });
    }
    const result = softDeleteConfig?.enabled && !resolvedOptions._forceDelete
        ? await context.extendedCollection().updateBatch(
            buildSoftDeleteFilter(filter, softDeleteConfig),
            { $set: buildSoftDeletePatch(softDeleteConfig, context.nowDate()) },
            options,
        )
        : await context.extendedCollection().deleteBatch(filter, options);
    if (context.hooksFactory) {
        try { await invokeV1Hook(context, 'delete', 'after', hookContext, result); } catch { /* after hooks don't affect operation */ }
    } else {
        await invokeStandardOperationHook(context, 'delete', 'after', { operation: 'deleteBatch', collection: context.collectionName, filter, result });
    }
    return result;
}

export async function orchestrateModelDeleteOne<TDocument = Record<string, unknown>>(
    context: ModelMutationContext<TDocument>,
    filter?: unknown,
    options?: unknown,
): Promise<unknown> {
    const softDeleteConfig = context.softDeleteConfig;
    const resolvedOptions = (options ?? {}) as Record<string, unknown>;
    const hookContext: Record<string, unknown> = {};

    if (context.hooksFactory) {
        await invokeV1Hook(context, 'delete', 'before', hookContext, filter);
    } else {
        await invokeStandardOperationHook(context, 'delete', 'before', {
            operation: 'deleteOne',
            collection: context.collectionName,
            filter,
        });
    }

    let result: unknown;
    if (softDeleteConfig?.enabled && !resolvedOptions._forceDelete) {
        result = await context.collection.updateOne(
            buildSoftDeleteFilter(filter, softDeleteConfig),
            { $set: { [softDeleteConfig.field]: softDeleteConfig.type === 'boolean' ? true : context.nowDate() } },
            options,
        );
    } else {
        result = await context.collection.deleteOne(filter, options);
    }

    if (context.hooksFactory) {
        try {
            await invokeV1Hook(context, 'delete', 'after', hookContext, result);
        } catch { /* after hooks don't affect operation */ }
    } else {
        await invokeStandardOperationHook(context, 'delete', 'after', {
            operation: 'deleteOne',
            collection: context.collectionName,
            filter,
            result,
        });
    }

    return result;
}

export async function orchestrateModelDeleteMany<TDocument = Record<string, unknown>>(
    context: ModelMutationContext<TDocument>,
    filter?: unknown,
    options?: unknown,
): Promise<unknown> {
    const softDeleteConfig = context.softDeleteConfig;
    const resolvedOptions = (options ?? {}) as Record<string, unknown>;
    const hookContext: Record<string, unknown> = {};
    if (context.hooksFactory) {
        await invokeV1Hook(context, 'delete', 'before', hookContext, filter);
    } else {
        await invokeStandardOperationHook(context, 'delete', 'before', { operation: 'deleteMany', collection: context.collectionName, filter });
    }
    let result: unknown;
    if (softDeleteConfig?.enabled && !resolvedOptions._forceDelete) {
        result = await context.collection.updateMany(
            { $and: [filter ?? {}, buildModelVisibleSoftDeleteCondition(softDeleteConfig)] },
            { $set: { [softDeleteConfig.field]: softDeleteConfig.type === 'boolean' ? true : context.nowDate() } },
            options,
        );
    } else {
        result = await context.collection.deleteMany(filter, options);
    }
    if (context.hooksFactory) {
        try { await invokeV1Hook(context, 'delete', 'after', hookContext, result); } catch { /* after hooks don't affect operation */ }
    } else {
        await invokeStandardOperationHook(context, 'delete', 'after', { operation: 'deleteMany', collection: context.collectionName, filter, result });
    }
    return result;
}
