/**
 * Single-document write helper functions for the collection accessor.
 *
 * Provides the underlying implementations of insertOne, updateOne,
 * deleteOne, replaceOne, findOneAndUpdate, and related operations
 * for MongoCollectionAccessor.
 */
import type { Collection, Document } from 'mongodb';
import type { Logger } from '../../../core/logger';
import { createError, ErrorCodes } from '../../../core/errors';
import type { RuntimeDefaults } from '../../../types/internal/query';
import {
    deleteManyDocuments,
    deleteOneDocument,
    findOneAndDeleteDocument,
    findOneAndReplaceDocument,
    findOneAndUpdateDocument,
    insertManyDocuments,
    insertOneDocument,
    replaceOneDocument,
    upsertOneDocument,
    updateManyDocuments,
    updateOneDocument,
} from '../writes';
import { stripWriteCacheControlOptions } from '../writes/write-utils';
import { recordTransactionWriteOperation } from './collection-accessor-cache-helpers';

export type AccessorWriteContext<TSchema extends Document = Document> = {
    dbName: string;
    collectionName: string;
    collectionRef: Collection<TSchema>;
    defaults?: RuntimeDefaults;
    logger?: Logger;
    cvFilter<T>(value: T): T;
    cvDoc<T>(value: T): T;
    cvUpdate<T>(value: T): T;
    prepareCacheForWrite?(options?: unknown): Promise<void>;
    invalidateAll(options?: unknown): Promise<number>;
};

function assertObjectArgument(value: unknown, field: string, message: string, errorCode: string = ErrorCodes.INVALID_ARGUMENT): void {
    if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
        throw createError(errorCode, message, [{ field, type: 'object.required', message }]);
    }
}

function assertUpdateDocument(update: unknown): void {
    if (update === null || update === undefined) {
        throw createError(
            ErrorCodes.INVALID_ARGUMENT,
            'update must be an object (update operators) or array (aggregation pipeline)',
            [{ field: 'update', type: 'object|array.required', message: 'update must be an update-operator object or aggregation pipeline array' }],
        );
    }
    if (Array.isArray(update)) {
        if (update.length === 0) {
            throw createError(
                ErrorCodes.INVALID_ARGUMENT,
                'update aggregation pipeline must not be an empty array',
                [{ field: 'update', type: 'array.empty', message: 'aggregation pipeline must contain at least one stage' }],
            );
        }
        for (let index = 0; index < update.length; index++) {
            const stage = update[index];
            if (stage === null || typeof stage !== 'object' || Array.isArray(stage)) {
                throw createError(
                    ErrorCodes.INVALID_ARGUMENT,
                    `update pipeline stage ${index + 1} must be an object`,
                    [{ field: `update[${index}]`, type: 'object.required', message: 'pipeline stage must be an object' }],
                );
            }
            const stageKeys = Object.keys(stage as object);
            if (stageKeys.length === 0) {
                throw createError(
                    ErrorCodes.INVALID_ARGUMENT,
                    `update pipeline stage ${index + 1} must not be an empty object`,
                    [{ field: `update[${index}]`, type: 'object.empty', message: 'pipeline stage must not be empty' }],
                );
            }
            const stageOperator = stageKeys[0];
            if (!stageOperator.startsWith('$')) {
                throw createError(
                    ErrorCodes.INVALID_ARGUMENT,
                    `update pipeline stage ${index + 1} operator must start with $, got "${stageOperator}"`,
                    [{ field: `update[${index}]`, type: 'object.invalidKeys', message: 'pipeline operator must start with $' }],
                );
            }
        }
        return;
    }

    if (typeof update !== 'object') {
        throw createError(
            ErrorCodes.INVALID_ARGUMENT,
            'update must be an object (update operators) or array (aggregation pipeline)',
            [{ field: 'update', type: 'object|array.required', message: 'update must be an update-operator object or aggregation pipeline array' }],
        );
    }

    const keys = Object.keys(update as object);
    if (keys.length === 0) {
        throw createError(
            ErrorCodes.INVALID_ARGUMENT,
            'update must not be an empty object',
            [{ field: 'update', type: 'object.empty', message: 'update must not be empty' }],
        );
    }
    if (!keys.some((key) => key.startsWith('$'))) {
        throw createError(
            ErrorCodes.INVALID_ARGUMENT,
            'update must use update operators (e.g. $set, $inc)',
            [{ field: 'update', type: 'object.invalidKeys', message: 'use update operators such as $set, $inc, $push' }],
        );
    }
}

function assertReplacementDocument(replacement: unknown): void {
    assertObjectArgument(replacement, 'replacement', 'replacement must be an object');
    if (Object.keys(replacement as Record<string, unknown>).some((key) => key.startsWith('$'))) {
        throw createError(ErrorCodes.INVALID_ARGUMENT, 'replacement must not contain update operators (e.g. $set, $inc)');
    }
}

async function runPostWriteInvalidation<TSchema extends Document>(
    context: AccessorWriteContext<TSchema>,
    options?: unknown,
): Promise<void> {
    try {
        await context.invalidateAll(options);
    } catch (error) {
        try { context.logger?.warn?.('[write] post-write cache invalidation failed', error); } catch { /* Logging must preserve the write result. */ }
    }
}

function markTransactionWrite(options?: unknown): void {
    recordTransactionWriteOperation(options);
}

async function runPreWriteInvalidation<TSchema extends Document>(
    context: AccessorWriteContext<TSchema>,
    options?: unknown,
): Promise<void> {
    try {
        await context.prepareCacheForWrite?.(options);
    } catch (error) {
        context.logger?.warn?.('[write] pre-write cache invalidation failed', error);
        throw createError(ErrorCodes.WRITE_ERROR, 'pre-write cache invalidation failed', undefined, error as Error);
    }
}

export async function insertOneForAccessor<TSchema extends Document = Document>(
    context: AccessorWriteContext<TSchema>,
    doc: Parameters<Collection<TSchema>['insertOne']>[0],
    options?: Parameters<Collection<TSchema>['insertOne']>[1],
): ReturnType<Collection<TSchema>['insertOne']> {
    assertObjectArgument(doc, 'document', 'document must be an object', ErrorCodes.DOCUMENT_REQUIRED);

    let result: Awaited<ReturnType<Collection<TSchema>['insertOne']>>;
    const startedAt = Date.now();
    try {
        await runPreWriteInvalidation(context, options);
        result = await insertOneDocument(context.collectionRef, context.cvDoc(doc), stripWriteCacheControlOptions(options));
        markTransactionWrite(options);
    } catch (err: unknown) {
        const mongoErr = err as { code?: number; message?: string };
        if (mongoErr?.code === 11000) {
            throw createError(
                ErrorCodes.DUPLICATE_KEY,
                'Insert failed: duplicate key violation',
                [{ field: '_id', message: mongoErr.message ?? 'duplicate key' }],
                err as Error,
            );
        }
        throw createError(
            ErrorCodes.WRITE_ERROR,
            `insertOne failed: ${mongoErr?.message ?? String(err)}`,
            undefined,
            err as Error,
        );
    }

    const elapsed = Date.now() - startedAt;
    const threshold = context.defaults?.slowQueryMs ?? 500;
    if (elapsed > threshold && context.logger) {
        try {
            context.logger.warn('[insertOne] slow operation warning', {
                ns: `${context.dbName}.${context.collectionName}`,
                threshold,
                duration: elapsed,
                insertedId: result.insertedId,
                comment: (options as Record<string, unknown>)?.comment,
                op: 'insertOne',
                ts: new Date().toISOString(),
            });
        } catch (_) { /* ignore logging errors */ }
    }

    await runPostWriteInvalidation(context, options);
    return result;
}

export async function insertManyForAccessor<TSchema extends Document = Document>(
    context: AccessorWriteContext<TSchema>,
    documents: Parameters<Collection<TSchema>['insertMany']>[0],
    options?: Parameters<Collection<TSchema>['insertMany']>[1],
): ReturnType<Collection<TSchema>['insertMany']> {
    if (!Array.isArray(documents)) {
        throw createError('DOCUMENTS_REQUIRED', 'documents must be an array');
    }
    if (documents.length === 0) {
        throw createError('DOCUMENTS_REQUIRED', 'documents array must not be empty');
    }
    if (documents.some((item) => item === null || typeof item !== 'object' || Array.isArray(item))) {
        throw createError('DOCUMENTS_REQUIRED', 'every element in documents must be an object');
    }

    const startedAt = Date.now();
    let result: Awaited<ReturnType<Collection<TSchema>['insertMany']>>;
    let dispatched = false;
    try {
        const convertedDocs = documents.map((document) => context.cvDoc(document)) as typeof documents;
        await runPreWriteInvalidation(context, options);
        dispatched = true;
        result = await insertManyDocuments(context.collectionRef, convertedDocs, stripWriteCacheControlOptions(options));
        markTransactionWrite(options);
    } catch (err: unknown) {
        if (dispatched) await runPostWriteInvalidation(context, options).catch(() => undefined);
        const mongoErr = err as { code?: number; message?: string };
        if (mongoErr?.code === 11000) {
            throw createError(
                ErrorCodes.DUPLICATE_KEY,
                'insertMany failed: duplicate key violation',
                [{ field: '_id', message: mongoErr.message ?? 'duplicate key' }],
                err as Error,
            );
        }
        throw err;
    }

    const elapsed = Date.now() - startedAt;
    const threshold = context.defaults?.slowQueryMs ?? 500;
    if (elapsed >= threshold && context.logger) {
        try {
            context.logger.warn('[insertMany] slow operation warning', {
                ns: `${context.dbName}.${context.collectionName}`,
                threshold,
                duration: elapsed,
                documentCount: documents.length,
                insertedCount: result.insertedCount,
                ordered: (options as Record<string, unknown> | undefined)?.ordered ?? true,
                comment: (options as Record<string, unknown> | undefined)?.comment,
                op: 'insertMany',
            });
        } catch {
            // Diagnostics must preserve the successful write and its cache invalidation.
        }
    }

    await runPostWriteInvalidation(context, options);
    return result;
}

export async function updateOneForAccessor<TSchema extends Document = Document>(
    context: AccessorWriteContext<TSchema>,
    filter: Parameters<Collection<TSchema>['updateOne']>[0],
    update: Parameters<Collection<TSchema>['updateOne']>[1],
    options?: Parameters<Collection<TSchema>['updateOne']>[2],
): ReturnType<Collection<TSchema>['updateOne']> {
    assertObjectArgument(filter, 'filter', 'filter must be an object');
    assertUpdateDocument(update);

    const normalizedFilter = context.cvFilter(filter);
    const finalUpdate = Array.isArray(update)
        ? update
        : context.cvUpdate(update);
    await runPreWriteInvalidation(context, options);
    const result = await updateOneDocument(context.collectionRef, normalizedFilter, finalUpdate, stripWriteCacheControlOptions(options));
    markTransactionWrite(options);
    if (result.modifiedCount > 0 || result.upsertedCount > 0 || result.upsertedId != null) {
        await runPostWriteInvalidation(context, options);
    }
    return result;
}

export async function updateManyForAccessor<TSchema extends Document = Document>(
    context: AccessorWriteContext<TSchema>,
    filter: Parameters<Collection<TSchema>['updateMany']>[0],
    update: Parameters<Collection<TSchema>['updateMany']>[1],
    options?: Parameters<Collection<TSchema>['updateMany']>[2],
): ReturnType<Collection<TSchema>['updateMany']> {
    assertObjectArgument(filter, 'filter', 'filter must be a non-empty object');
    assertUpdateDocument(update);

    const convertedFilter = context.cvFilter(filter);
    const convertedUpdate = context.cvUpdate(update);
    await runPreWriteInvalidation(context, options);
    let result: Awaited<ReturnType<Collection<TSchema>['updateMany']>>;
    try {
        result = await updateManyDocuments(context.collectionRef, convertedFilter, convertedUpdate, stripWriteCacheControlOptions(options));
    } catch (error) {
        await runPostWriteInvalidation(context, options);
        throw error;
    }
    markTransactionWrite(options);
    if (result.modifiedCount > 0 || result.upsertedCount > 0 || result.upsertedId != null) {
        await runPostWriteInvalidation(context, options);
    }
    return result;
}

export async function replaceOneForAccessor<TSchema extends Document = Document>(
    context: AccessorWriteContext<TSchema>,
    filter: Parameters<Collection<TSchema>['replaceOne']>[0],
    replacement: Parameters<Collection<TSchema>['replaceOne']>[1],
    options?: Parameters<Collection<TSchema>['replaceOne']>[2],
): ReturnType<Collection<TSchema>['replaceOne']> {
    assertObjectArgument(filter, 'filter', 'filter must be a non-empty object');
    assertReplacementDocument(replacement);

    await runPreWriteInvalidation(context, options);
    const result = await replaceOneDocument(context.collectionRef, context.cvFilter(filter), context.cvDoc(replacement), stripWriteCacheControlOptions(options));
    markTransactionWrite(options);
    await runPostWriteInvalidation(context, options);
    return result;
}

export async function findOneAndReplaceForAccessor<TSchema extends Document = Document>(
    context: AccessorWriteContext<TSchema>,
    filter: Parameters<Collection<TSchema>['findOneAndReplace']>[0],
    replacement: Parameters<Collection<TSchema>['findOneAndReplace']>[1],
    options?: unknown,
): ReturnType<Collection<TSchema>['findOneAndReplace']> {
    assertObjectArgument(filter, 'filter', 'filter must be a non-empty object');
    assertReplacementDocument(replacement);

    await runPreWriteInvalidation(context, options);
    const result = await findOneAndReplaceDocument(context.collectionRef, context.cvFilter(filter), context.cvDoc(replacement), stripWriteCacheControlOptions(options));
    markTransactionWrite(options);
    if (result != null || (options as { upsert?: boolean } | undefined)?.upsert === true) {
        await runPostWriteInvalidation(context, options);
    }
    return result;
}

export async function findOneAndUpdateForAccessor<TSchema extends Document = Document>(
    context: AccessorWriteContext<TSchema>,
    filter: Parameters<Collection<TSchema>['findOneAndUpdate']>[0],
    update: Parameters<Collection<TSchema>['findOneAndUpdate']>[1],
    options?: unknown,
): ReturnType<Collection<TSchema>['findOneAndUpdate']> {
    assertObjectArgument(filter, 'filter', 'filter must be a non-empty object');
    assertUpdateDocument(update);

    await runPreWriteInvalidation(context, options);
    const result = await findOneAndUpdateDocument(context.collectionRef, context.cvFilter(filter), context.cvUpdate(update), stripWriteCacheControlOptions(options));
    markTransactionWrite(options);
    if (result != null || (options as { upsert?: boolean } | undefined)?.upsert === true) {
        await runPostWriteInvalidation(context, options);
    }
    return result;
}

export async function findOneAndDeleteForAccessor<TSchema extends Document = Document>(
    context: AccessorWriteContext<TSchema>,
    filter: Parameters<Collection<TSchema>['findOneAndDelete']>[0],
    options?: unknown,
): ReturnType<Collection<TSchema>['findOneAndDelete']> {
    assertObjectArgument(filter, 'filter', 'filter must be a non-empty object');

    await runPreWriteInvalidation(context, options);
    const result = await findOneAndDeleteDocument(context.collectionRef, context.cvFilter(filter), stripWriteCacheControlOptions(options));
    markTransactionWrite(options);
    if (result) {
        await runPostWriteInvalidation(context, options);
    }
    return result;
}

export async function upsertOneForAccessor<TSchema extends Document = Document>(
    context: AccessorWriteContext<TSchema>,
    filter: Parameters<Collection<TSchema>['updateOne']>[0],
    update: Parameters<Collection<TSchema>['updateOne']>[1],
    options?: Parameters<Collection<TSchema>['updateOne']>[2],
): ReturnType<Collection<TSchema>['updateOne']> {
    assertObjectArgument(filter, 'filter', 'filter must be a non-empty object');
    assertObjectArgument(update, 'update', 'update must be a non-empty object');

    const updateDoc = Object.keys(update as Record<string, unknown>).some((key) => key.startsWith('$'))
        ? update
        : { $set: update as Record<string, unknown> };
    await runPreWriteInvalidation(context, options);
    const result = await upsertOneDocument(
        context.collectionRef,
        context.cvFilter(filter),
        context.cvUpdate(updateDoc) as Parameters<Collection<TSchema>['updateOne']>[1],
        stripWriteCacheControlOptions(options),
    );
    markTransactionWrite(options);
    await runPostWriteInvalidation(context, options);
    const normalizedResult = result.upsertedId === null
        ? { ...result, upsertedId: undefined }
        : result;
    return normalizedResult as Awaited<ReturnType<Collection<TSchema>['updateOne']>>;
}

export async function deleteOneForAccessor<TSchema extends Document = Document>(
    context: AccessorWriteContext<TSchema>,
    filter: Parameters<Collection<TSchema>['deleteOne']>[0],
    options?: Parameters<Collection<TSchema>['deleteOne']>[1],
): ReturnType<Collection<TSchema>['deleteOne']> {
    assertObjectArgument(filter, 'filter', 'filter must be an object');

    await runPreWriteInvalidation(context, options);
    const result = await deleteOneDocument(context.collectionRef, context.cvFilter(filter), stripWriteCacheControlOptions(options));
    markTransactionWrite(options);
    if (result.deletedCount > 0) {
        await runPostWriteInvalidation(context, options);
    }
    return result;
}

export async function deleteManyForAccessor<TSchema extends Document = Document>(
    context: AccessorWriteContext<TSchema>,
    filter: Parameters<Collection<TSchema>['deleteMany']>[0],
    options?: Parameters<Collection<TSchema>['deleteMany']>[1],
): ReturnType<Collection<TSchema>['deleteMany']> {
    assertObjectArgument(filter, 'filter', 'filter must be a non-empty object');

    await runPreWriteInvalidation(context, options);
    const result = await deleteManyDocuments(context.collectionRef, context.cvFilter(filter), stripWriteCacheControlOptions(options));
    markTransactionWrite(options);
    if (result.deletedCount > 0) {
        await runPostWriteInvalidation(context, options);
    }
    return result;
}
