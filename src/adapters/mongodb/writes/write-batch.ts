/**
 * Low-level implementations of batch write operations (insertBatch, updateBatch, deleteBatch).
 *
 * Handles batched writes and progress reporting, called by the collection accessor's batch path.
 */
import { Collection, Document, FindOptions } from 'mongodb';
import { createError, ErrorCodes } from '../../../core/errors';
import { assertManagedTransactionWriteAllowed } from '../../../capabilities/transaction';
import type {
    BatchWriteOptions,
    DeleteBatchResult,
    InsertBatchResult,
    UpdateBatchOptions,
    UpdateBatchResult,
} from '../../../../types/collection';
import { sleep, splitIntoBatches, stripWriteCacheControlOptions } from './write-utils';

type DriverOptions = Record<string, unknown>;
type BatchCursor = AsyncIterable<{ _id: unknown }> & { close?: () => Promise<unknown> | unknown };
type InsertBatchPlan<TSchema extends Document> = {
    batch: TSchema[];
    batchIndex: number;
    batchOffset: number;
};

const NON_IDEMPOTENT_UPDATE_OPERATORS = new Set([
    '$inc',
    '$mul',
    '$rename',
    '$min',
    '$max',
    '$currentDate',
    '$addToSet',
    '$pop',
    '$pull',
    '$pullAll',
    '$push',
    '$bit',
]);

function validateBatchSize(batchSize: number): void {
    if (!Number.isInteger(batchSize) || batchSize <= 0) {
        throw createError(ErrorCodes.INVALID_ARGUMENT, 'batchSize must be a positive integer.');
    }
}

function buildBatchReadOptions(driverOptions: DriverOptions): DriverOptions {
    const {
        arrayFilters: _arrayFilters,
        bypassDocumentValidation: _bypassDocumentValidation,
        upsert: _upsert,
        writeConcern: _writeConcern,
        ...readOptions
    } = driverOptions;
    return readOptions;
}

function buildBatchFindOptions(driverOptions: DriverOptions, sort: unknown): FindOptions {
    return {
        ...buildBatchReadOptions(driverOptions),
        projection: { _id: 1 },
        sort,
    } as FindOptions;
}

async function estimateBatchTotal<TSchema extends Document>(
    collection: Collection<TSchema>,
    filter: Parameters<Collection<TSchema>['find']>[0],
    driverOptions: DriverOptions,
    enabled: boolean,
): Promise<number | null> {
    if (!enabled || typeof collection.countDocuments !== 'function') {
        return null;
    }
    return collection.countDocuments(filter, buildBatchReadOptions(driverOptions));
}

async function processIdBatches<TSchema extends Document>(
    collection: Collection<TSchema>,
    filter: Parameters<Collection<TSchema>['find']>[0],
    findOptions: FindOptions,
    batchSize: number,
    onBatch: (batch: unknown[], batchIndex: number, currentBatch: number, selectedCount: number) => Promise<void>,
): Promise<{ selectedCount: number; batchCount: number }> {
    validateBatchSize(batchSize);
    const cursor = collection.find(filter, findOptions) as unknown as BatchCursor;
    const batch: unknown[] = [];
    let selectedCount = 0;
    let batchCount = 0;

    try {
        for await (const document of cursor) {
            batch.push(document._id);
            selectedCount += 1;
            if (batch.length >= batchSize) {
                batchCount += 1;
                await onBatch([...batch], batchCount - 1, batchCount, selectedCount);
                batch.length = 0;
            }
        }
        if (batch.length > 0) {
            batchCount += 1;
            await onBatch([...batch], batchCount - 1, batchCount, selectedCount);
        }
    } finally {
        if (typeof cursor.close === 'function') {
            await Promise.resolve(cursor.close()).catch(() => undefined);
        }
    }

    return { selectedCount, batchCount };
}

function getWriteErrorIndexes(error: unknown): number[] {
    const candidates = [
        (error as { writeErrors?: unknown })?.writeErrors,
        (error as { result?: { writeErrors?: unknown } })?.result?.writeErrors,
        (error as { result?: { result?: { writeErrors?: unknown } } })?.result?.result?.writeErrors,
    ];
    for (const value of candidates) {
        if (Array.isArray(value)) {
            return value
                .map((item) => Number((item as { index?: unknown }).index))
                .filter((index) => Number.isInteger(index) && index >= 0);
        }
    }
    return [];
}

function getInsertedIdsFromError(error: unknown): Record<string, unknown> {
    const candidates = [
        (error as { insertedIds?: unknown })?.insertedIds,
        (error as { result?: { insertedIds?: unknown } })?.result?.insertedIds,
        (error as { result?: { result?: { insertedIds?: unknown } } })?.result?.result?.insertedIds,
    ];
    for (const value of candidates) {
        if (value && typeof value === 'object') {
            return value as Record<string, unknown>;
        }
    }
    return {};
}

function isRetrySafeUpdate(update: Parameters<Collection<Document>['updateMany']>[1]): boolean {
    if (Array.isArray(update)) {
        return false;
    }
    const updateOperators = Object.keys(update as Record<string, unknown>);
    return updateOperators.every((operator) => !NON_IDEMPOTENT_UPDATE_OPERATORS.has(operator));
}

async function runWithConcurrency<T>(
    items: T[],
    concurrency: number,
    worker: (item: T) => Promise<void>,
): Promise<void> {
    if (concurrency <= 1 || items.length <= 1) {
        for (const item of items) {
            await worker(item);
        }
        return;
    }

    let nextIndex = 0;
    let stopAcquiring = false;
    let firstFatal: unknown;
    const workerCount = Math.min(concurrency, items.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
        while (!stopAcquiring && nextIndex < items.length) {
            const item = items[nextIndex];
            nextIndex += 1;
            try {
                await worker(item);
            } catch (error) {
                if (!stopAcquiring) {
                    firstFatal = error;
                    stopAcquiring = true;
                }
                break;
            }
        }
    }));
    if (stopAcquiring) throw firstFatal;
}

export async function insertBatchDocuments<TSchema extends Document = Document>(
    collection: Collection<TSchema>,
    documents: TSchema[],
    options: BatchWriteOptions & Parameters<Collection<TSchema>['insertMany']>[1] = {},
): Promise<InsertBatchResult> {
    if (!Array.isArray(documents)) {
        throw createError(ErrorCodes.INVALID_ARGUMENT, 'documents must be an array');
    }
    if (documents.length === 0) {
        throw createError(ErrorCodes.INVALID_ARGUMENT, 'documents array must not be empty');
    }

    const rawOptions = stripWriteCacheControlOptions(options) as BatchWriteOptions & Parameters<Collection<TSchema>['insertMany']>[1] & {
        concurrency?: number;
        onError?: 'stop' | 'skip' | 'collect' | 'retry';
        retryAttempts?: number;
        retryDelay?: number;
        onProgress?: (progress: Record<string, unknown>) => void;
        onRetry?: (retryInfo: Record<string, unknown>) => void;
    };
    const {
        batchSize = 1000,
        ordered = false,
        concurrency,
        onError = 'stop',
        retryAttempts = 3,
        retryDelay = 1000,
        onProgress,
        onRetry,
        ...driverOptions
    } = rawOptions;

    if (concurrency !== undefined && (!Number.isInteger(concurrency) || concurrency < 0)) {
        throw createError(ErrorCodes.INVALID_ARGUMENT, 'concurrency must be a non-negative integer');
    }
    if (!['stop', 'skip', 'collect', 'retry'].includes(onError)) {
        throw createError(ErrorCodes.INVALID_ARGUMENT, 'onError must be one of: stop/skip/collect/retry');
    }
    if (!Number.isInteger(retryAttempts) || retryAttempts < 0) {
        throw createError(ErrorCodes.INVALID_ARGUMENT, 'retryAttempts must be a non-negative integer');
    }

    const batches = splitIntoBatches(documents, batchSize);
    let batchOffset = 0;
    const batchPlans: Array<InsertBatchPlan<TSchema>> = batches.map((batch, batchIndex) => {
        const plan = { batch, batchIndex, batchOffset };
        batchOffset += batch.length;
        return plan;
    });
    const effectiveConcurrency = ordered ? 1 : Math.max(1, concurrency ?? 1);
    const result: InsertBatchResult & {
        retries: Array<Record<string, unknown>>;
        errors: Array<Record<string, unknown>>;
    } = {
        acknowledged: true,
        totalCount: documents.length,
        insertedCount: 0,
        batchCount: batches.length,
        errors: [],
        insertedIds: {},
        retries: [],
    };

    assertManagedTransactionWriteAllowed(driverOptions);
    await runWithConcurrency(batchPlans, effectiveConcurrency, async ({ batchIndex, batch, batchOffset }) => {
        let pendingBatch = batch;
        let pendingIndexes = batch.map((_, index) => index);
        let attempts = 0;

        while (true) {
            try {
                assertManagedTransactionWriteAllowed(driverOptions);
                const batchResult = await collection.insertMany(pendingBatch as unknown as Parameters<Collection<TSchema>['insertMany']>[0], {
                    ...driverOptions,
                    ordered,
                });
                result.insertedCount += batchResult.insertedCount;
                for (const [key, value] of Object.entries(batchResult.insertedIds)) {
                    const localIndex = pendingIndexes[Number.parseInt(key, 10)];
                    result.insertedIds[batchOffset + localIndex] = value;
                }
                onProgress?.({
                    currentBatch: batchIndex + 1,
                    totalBatches: batches.length,
                    inserted: result.insertedCount,
                    total: documents.length,
                    percentage: Math.round((result.insertedCount / documents.length) * 100),
                    retries: result.retries.length,
                });
                break;
            } catch (cause) {
                assertManagedTransactionWriteAllowed(driverOptions);
                const errorRecord = {
                    batchIndex,
                    message: cause instanceof Error ? cause.message : String(cause),
                    error: cause,
                    attempts: attempts + 1,
                };

                if (onError === 'retry' && attempts < retryAttempts) {
                    const failedIndexes = getWriteErrorIndexes(cause);
                    if (failedIndexes.length > 0) {
                        const retryLocalIndexes = ordered
                            ? pendingIndexes.filter((_, index) => index >= Math.min(...failedIndexes))
                            : pendingIndexes.filter((_, index) => failedIndexes.includes(index));
                        const retryIndexSet = new Set(retryLocalIndexes);
                        const insertedIds = getInsertedIdsFromError(cause);
                        const confirmedSuccessCount = pendingIndexes.length - retryLocalIndexes.length;
                        result.insertedCount += confirmedSuccessCount;
                        for (const [key, value] of Object.entries(insertedIds)) {
                            const localIndex = pendingIndexes[Number.parseInt(key, 10)];
                            if (!retryIndexSet.has(localIndex)) {
                                result.insertedIds[batchOffset + localIndex] = value;
                            }
                        }
                        pendingBatch = pendingBatch.filter((_, index) => retryIndexSet.has(pendingIndexes[index]));
                        pendingIndexes = retryLocalIndexes;
                        if (pendingBatch.length === 0) {
                            onProgress?.({
                                currentBatch: batchIndex + 1,
                                totalBatches: batches.length,
                                inserted: result.insertedCount,
                                total: documents.length,
                                percentage: Math.round((result.insertedCount / documents.length) * 100),
                                retries: result.retries.length,
                            });
                            break;
                        }
                    }
                    attempts += 1;
                    const retryInfo = {
                        batchIndex,
                        attempt: attempts,
                        // v1 alias — v1 runtime emitted `attempts` (plural); kept for backward consumers
                        attempts,
                        maxAttempts: retryAttempts,
                        delay: retryDelay,
                        // v1 alias — v1 retry records included `success: false` on each retry entry
                        success: false,
                        error: cause instanceof Error ? cause : new Error(String(cause)),
                    };
                    result.retries.push(retryInfo);
                    onRetry?.(retryInfo);
                    if (retryDelay > 0) {
                        await sleep(retryDelay);
                    }
                    continue;
                }

                result.errors.push(errorRecord);
                onProgress?.({
                    currentBatch: batchIndex + 1,
                    totalBatches: batches.length,
                    inserted: result.insertedCount,
                    total: documents.length,
                    percentage: Math.round((result.insertedCount / documents.length) * 100),
                    retries: result.retries.length,
                });

                if (onError === 'stop') {
                    throw createError(ErrorCodes.WRITE_ERROR, errorRecord.message, undefined, cause as Error);
                }
                break;
            }
        }
    });

    return result;
}

function batchWriteFilter(filter: Record<string, unknown>, batch: unknown[]): Record<string, unknown> {
    const ids = { _id: { $in: batch } };
    return Object.prototype.hasOwnProperty.call(filter, '_id')
        ? { $and: [filter, ids] }
        : { ...filter, ...ids };
}

export async function updateBatchDocuments<TSchema extends Document = Document>(
    collection: Collection<TSchema>,
    filter: Parameters<Collection<TSchema>['find']>[0],
    update: Parameters<Collection<TSchema>['updateMany']>[1],
    options: UpdateBatchOptions & Parameters<Collection<TSchema>['updateMany']>[2] = {},
): Promise<UpdateBatchResult> {
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
        throw createError(ErrorCodes.INVALID_ARGUMENT, 'filter must be a non-array object');
    }
    if (!update || typeof update !== 'object') {
        throw createError(ErrorCodes.INVALID_ARGUMENT, 'update must be an object (update operators) or array (aggregation pipeline)');
    }
    if (!Array.isArray(update)) {
        const keys = Object.keys(update as Record<string, unknown>);
        if (keys.length === 0 || !keys.some((key) => key.startsWith('$'))) {
            throw createError(ErrorCodes.INVALID_ARGUMENT, 'update must use update operators (e.g. $set, $inc)');
        }
    }

    const rawOptions = stripWriteCacheControlOptions(options) as UpdateBatchOptions & Parameters<Collection<TSchema>['updateMany']>[2] & {
        onError?: 'stop' | 'skip' | 'collect' | 'retry';
        retryAttempts?: number;
        retryDelay?: number;
        onProgress?: (progress: Record<string, unknown>) => void;
        onRetry?: (retryInfo: Record<string, unknown>) => void;
    };
    const {
        batchSize = 1000,
        sort = { _id: 1 },
        estimateProgress = true,
        onProgress,
        onError = 'stop',
        retryAttempts = 3,
        retryDelay = 1000,
        onRetry,
        ...driverOptions
    } = rawOptions;
    if (!['stop', 'skip', 'collect', 'retry'].includes(onError)) {
        throw createError(ErrorCodes.INVALID_ARGUMENT, 'onError must be one of: stop/skip/collect/retry');
    }
    if (!Number.isInteger(retryAttempts) || retryAttempts < 0) {
        throw createError(ErrorCodes.INVALID_ARGUMENT, 'retryAttempts must be a non-negative integer');
    }
    if ((driverOptions as { upsert?: unknown }).upsert !== undefined && (driverOptions as { upsert?: unknown }).upsert !== false) {
        throw createError(
            ErrorCodes.INVALID_ARGUMENT,
            'updateBatch does not support upsert: true; use upsertOne() for single-document upserts, or updateMany(..., { upsert: true }) only for MongoDB native single-insert-on-no-match semantics',
        );
    }
    if (onError === 'retry' && !isRetrySafeUpdate(update as Parameters<Collection<Document>['updateMany']>[1])) {
        throw createError(
            ErrorCodes.INVALID_ARGUMENT,
            'updateBatch retry requires an idempotent update; non-idempotent operators such as $inc/$push cannot be safely replayed',
        );
    }
    assertManagedTransactionWriteAllowed(driverOptions);
    const estimatedTotal = await estimateBatchTotal(collection, filter, driverOptions, estimateProgress);
    const totalBatches = estimatedTotal === null ? null : Math.ceil(estimatedTotal / batchSize);
    const result: UpdateBatchResult = {
        acknowledged: true,
        totalCount: estimatedTotal,
        matchedCount: 0,
        modifiedCount: 0,
        upsertedCount: 0,
        batchCount: 0,
        errors: [],
        retries: [],
    };

    const processed = await processIdBatches(collection, filter, buildBatchFindOptions(driverOptions, sort), batchSize, async (batch, batchIndex, currentBatch) => {
        let attempts = 0;
        while (true) {
            try {
                assertManagedTransactionWriteAllowed(driverOptions);
                const batchResult = await collection.updateMany(
                    batchWriteFilter(filter, batch) as Parameters<Collection<TSchema>['updateMany']>[0],
                    update,
                    driverOptions,
                );
                result.matchedCount += batchResult.matchedCount;
                result.modifiedCount += batchResult.modifiedCount;
                onProgress?.({
                    currentBatch,
                    totalBatches: totalBatches ?? currentBatch,
                    modified: result.modifiedCount,
                    matched: result.matchedCount,
                    total: estimatedTotal,
                    percentage: estimatedTotal && estimatedTotal > 0 ? Math.round((result.modifiedCount / estimatedTotal) * 100) : null,
                    errors: result.errors.length,
                    retries: result.retries.length,
                });
                break;
            } catch (cause) {
                assertManagedTransactionWriteAllowed(driverOptions);
                const errorRecord = {
                    batchIndex,
                    message: cause instanceof Error ? cause.message : String(cause),
                    error: cause,
                    attempts: attempts + 1,
                };
                if (onError === 'retry' && attempts < retryAttempts) {
                    attempts += 1;
                    const retryInfo = {
                        batchIndex,
                        attempt: attempts,
                        // v1 alias — v1 runtime emitted `attempts` (plural)
                        attempts,
                        maxAttempts: retryAttempts,
                        delay: retryDelay,
                        // v1 alias — v1 retry records included `success: false`
                        success: false,
                        error: cause instanceof Error ? cause : new Error(String(cause)),
                    };
                    result.retries.push(retryInfo);
                    onRetry?.(retryInfo);
                    if (retryDelay > 0) {
                        await sleep(retryDelay);
                    }
                    continue;
                }
                result.errors.push(errorRecord);
                if (onError === 'stop') {
                    throw createError(ErrorCodes.WRITE_ERROR, errorRecord.message, undefined, cause as Error);
                }
                break;
            }
        }
    });
    result.batchCount = processed.batchCount;
    if (estimateProgress && result.totalCount === null) {
        result.totalCount = processed.selectedCount;
    }

    return result;
}

export async function deleteBatchDocuments<TSchema extends Document = Document>(
    collection: Collection<TSchema>,
    filter: Parameters<Collection<TSchema>['find']>[0],
    options: UpdateBatchOptions & Parameters<Collection<TSchema>['deleteMany']>[1] = {},
): Promise<DeleteBatchResult> {
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
        throw createError(ErrorCodes.INVALID_ARGUMENT, 'filter must be a non-array object');
    }

    const rawOptions = stripWriteCacheControlOptions(options) as UpdateBatchOptions & Parameters<Collection<TSchema>['deleteMany']>[1] & {
        estimateProgress?: boolean;
        onProgress?: (progress: Record<string, unknown>) => void;
        onError?: 'stop' | 'skip' | 'collect' | 'retry';
        retryAttempts?: number;
        retryDelay?: number;
        onRetry?: (retryInfo: Record<string, unknown>) => void;
    };
    const {
        batchSize = 1000,
        sort = { _id: 1 },
        estimateProgress = true,
        onProgress,
        onError = 'stop',
        retryAttempts = 3,
        retryDelay = 1000,
        onRetry,
        ...driverOptions
    } = rawOptions;
    if (!['stop', 'skip', 'collect', 'retry'].includes(onError)) {
        throw createError(ErrorCodes.INVALID_ARGUMENT, 'onError must be one of: stop/skip/collect/retry');
    }
    if (!Number.isInteger(retryAttempts) || retryAttempts < 0) {
        throw createError(ErrorCodes.INVALID_ARGUMENT, 'retryAttempts must be a non-negative integer');
    }

    assertManagedTransactionWriteAllowed(driverOptions);
    const estimatedTotal = await estimateBatchTotal(collection, filter, driverOptions, estimateProgress);
    const totalBatches = estimatedTotal === null ? null : Math.ceil(estimatedTotal / batchSize);
    const result: DeleteBatchResult & {
        retries: Array<Record<string, unknown>>;
        errors: Array<Record<string, unknown>>;
    } = {
        acknowledged: true,
        totalCount: estimatedTotal,
        deletedCount: 0,
        batchCount: 0,
        errors: [],
        retries: [],
    };

    const processed = await processIdBatches(collection, filter, buildBatchFindOptions(driverOptions, sort), batchSize, async (batch, batchIndex, currentBatch) => {
        let attempts = 0;
        while (true) {
            try {
                assertManagedTransactionWriteAllowed(driverOptions);
                const batchResult = await collection.deleteMany(
                    batchWriteFilter(filter, batch) as Parameters<Collection<TSchema>['deleteMany']>[0],
                    driverOptions,
                );
                result.deletedCount += batchResult.deletedCount;
                onProgress?.({
                    currentBatch,
                    totalBatches: totalBatches ?? currentBatch,
                    deleted: result.deletedCount,
                    total: estimatedTotal,
                    percentage: estimatedTotal && estimatedTotal > 0 ? Math.round((result.deletedCount / estimatedTotal) * 100) : null,
                    errors: result.errors.length,
                    retries: result.retries.length,
                });
                break;
            } catch (cause) {
                assertManagedTransactionWriteAllowed(driverOptions);
                const errorRecord = {
                    batchIndex,
                    message: cause instanceof Error ? cause.message : String(cause),
                    error: cause,
                    attempts: attempts + 1,
                };
                if (onError === 'retry' && attempts < retryAttempts) {
                    attempts += 1;
                    const retryInfo = {
                        batchIndex,
                        attempt: attempts,
                        // v1 alias — v1 runtime emitted `attempts` (plural)
                        attempts,
                        maxAttempts: retryAttempts,
                        delay: retryDelay,
                        // v1 alias — v1 retry records included `success: false`
                        success: false,
                        error: cause instanceof Error ? cause : new Error(String(cause)),
                    };
                    result.retries.push(retryInfo);
                    onRetry?.(retryInfo);
                    if (retryDelay > 0) {
                        await sleep(retryDelay);
                    }
                    continue;
                }
                result.errors.push(errorRecord);
                if (onError === 'stop') {
                    throw createError(ErrorCodes.WRITE_ERROR, errorRecord.message, undefined, cause as Error);
                }
                break;
            }
        }
    });
    result.batchCount = processed.batchCount;
    if (estimateProgress && result.totalCount === null) {
        result.totalCount = processed.selectedCount;
    }

    return result;
}
