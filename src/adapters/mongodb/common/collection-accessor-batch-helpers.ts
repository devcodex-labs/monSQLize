/**
 * Batch write helper functions for the collection accessor.
 *
 * Provides the underlying implementations of insertBatch, updateBatch,
 * deleteBatch, and incrementOne for MongoCollectionAccessor, keeping
 * the main file size manageable.
 */
import type { Collection, Document } from 'mongodb';
import { createError, ErrorCodes } from '../../../core/errors';
import {
    deleteBatchDocuments,
    incrementOneDocument,
    insertBatchDocuments,
    updateBatchDocuments,
    type BatchWriteOptions,
    type DeleteBatchResult,
    type IncrementOneOptions,
    type IncrementOneResult,
    type InsertBatchResult,
    type UpdateBatchOptions,
    type UpdateBatchResult,
} from '../writes';
import { stripWriteCacheControlOptions } from '../writes/write-utils';
import { recordTransactionWriteOperation } from './collection-accessor-cache-helpers';

type BatchAccessorContext<TSchema extends Document> = {
    collectionRef: Collection<TSchema>;
    cvFilter: <T>(value: T) => T;
    cvDoc: <T>(value: T) => T;
    cvUpdate: <T>(value: T) => T;
    prepareCacheForWrite?: (options?: unknown) => Promise<void>;
    invalidateAll: (options?: unknown) => Promise<number>;
};

async function runPostWriteInvalidation<TSchema extends Document>(
    context: BatchAccessorContext<TSchema>,
    options?: unknown,
): Promise<void> {
    try { await context.invalidateAll(options); } catch { /* Preserve the original write result or error. */ }
}

function markTransactionWrite(options?: unknown): void {
    recordTransactionWriteOperation(options);
}

async function runPreWriteInvalidation<TSchema extends Document>(
    context: BatchAccessorContext<TSchema>,
    options?: unknown,
): Promise<void> {
    try {
        await context.prepareCacheForWrite?.(options);
    } catch (error) {
        throw createError(ErrorCodes.WRITE_ERROR, 'pre-write cache invalidation failed', undefined, error as Error);
    }
}

export async function insertBatchForAccessor<TSchema extends Document>(
    context: BatchAccessorContext<TSchema>,
    documents: TSchema[],
    options?: BatchWriteOptions & Parameters<Collection<TSchema>['insertMany']>[1],
): Promise<InsertBatchResult> {
    if (!Array.isArray(documents)) {
        throw createError(ErrorCodes.INVALID_ARGUMENT, 'documents must be an array');
    }
    await runPreWriteInvalidation(context, options);
    let result: InsertBatchResult;
    try {
        result = await insertBatchDocuments(context.collectionRef, documents.map((document) => context.cvDoc(document)), stripWriteCacheControlOptions(options));
    } catch (error) {
        await runPostWriteInvalidation(context, options);
        throw error;
    }
    markTransactionWrite(options);
    await runPostWriteInvalidation(context, options);
    return result;
}

export async function updateBatchForAccessor<TSchema extends Document>(
    context: BatchAccessorContext<TSchema>,
    filter: Parameters<Collection<TSchema>['find']>[0],
    update: Parameters<Collection<TSchema>['updateMany']>[1],
    options?: UpdateBatchOptions & Parameters<Collection<TSchema>['updateMany']>[2],
): Promise<UpdateBatchResult> {
    await runPreWriteInvalidation(context, options);
    let result: UpdateBatchResult;
    try {
        result = await updateBatchDocuments(context.collectionRef, context.cvFilter(filter), context.cvUpdate(update), stripWriteCacheControlOptions(options));
    } catch (error) {
        await runPostWriteInvalidation(context, options);
        throw error;
    }
    markTransactionWrite(options);
    if (result.modifiedCount > 0 || result.errors.length > 0) {
        await runPostWriteInvalidation(context, options);
    }
    return result;
}

export async function deleteBatchForAccessor<TSchema extends Document>(
    context: BatchAccessorContext<TSchema>,
    filter: Parameters<Collection<TSchema>['find']>[0],
    options?: UpdateBatchOptions & Parameters<Collection<TSchema>['deleteMany']>[1],
): Promise<DeleteBatchResult> {
    await runPreWriteInvalidation(context, options);
    let result: DeleteBatchResult;
    try {
        result = await deleteBatchDocuments(context.collectionRef, context.cvFilter(filter), stripWriteCacheControlOptions(options));
    } catch (error) {
        await runPostWriteInvalidation(context, options);
        throw error;
    }
    markTransactionWrite(options);
    if (result.deletedCount > 0 || result.errors.length > 0) {
        await runPostWriteInvalidation(context, options);
    }
    return result;
}

export async function incrementOneForAccessor<TSchema extends Document>(
    context: BatchAccessorContext<TSchema>,
    filter: Parameters<Collection<TSchema>['findOneAndUpdate']>[0],
    field: string | Record<string, number>,
    incrementOrOptions?: number | IncrementOneOptions,
    maybeOptions?: IncrementOneOptions,
): Promise<IncrementOneResult<TSchema>> {
    await runPreWriteInvalidation(context, typeof incrementOrOptions === 'object' && incrementOrOptions !== null
        ? incrementOrOptions
        : maybeOptions);
    const result = await incrementOneDocument(
        context.collectionRef,
        context.cvFilter(filter),
        field,
        incrementOrOptions,
        maybeOptions,
    );
    markTransactionWrite(typeof incrementOrOptions === 'object' && incrementOrOptions !== null
        ? incrementOrOptions
        : maybeOptions);
    if (result.modifiedCount > 0 || result.matchedCount > 0) {
        const options = typeof incrementOrOptions === 'object' && incrementOrOptions !== null
            ? incrementOrOptions
            : maybeOptions;
        await runPostWriteInvalidation(context, options);
    }
    return result;
}
