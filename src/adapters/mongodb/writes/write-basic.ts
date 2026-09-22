/**
 * Low-level implementations of basic write operations (insertOne, insertMany, updateOne, deleteOne, etc.).
 *
 * Thin wrappers around the MongoDB driver's single and multi-document write operations,
 * called by the collection accessor.
 */
import { Collection, Document, FindOneAndDeleteOptions, FindOneAndReplaceOptions, FindOneAndUpdateOptions } from 'mongodb';
import { normalizeProjection } from '../../../utils/normalize';
import { createError, ErrorCodes } from '../../../core/errors';
import { assertManagedTransactionWriteAllowed } from '../../../capabilities/transaction';
import type { IncrementOneOptions } from '../../../../types/collection';
import { createIncrementUpdate, stripWriteCacheControlOptions } from './write-utils';

/** Thin wrapper around `collection.insertOne`; delegates directly to the MongoDB driver. */
export async function insertOneDocument<TSchema extends Document = Document>(
    collection: Collection<TSchema>,
    ...args: Parameters<Collection<TSchema>['insertOne']>
): ReturnType<Collection<TSchema>['insertOne']> {
    assertManagedTransactionWriteAllowed(args[1]);
    return collection.insertOne(...args);
}

/** Thin wrapper around `collection.insertMany`; delegates directly to the MongoDB driver. */
export async function insertManyDocuments<TSchema extends Document = Document>(
    collection: Collection<TSchema>,
    ...args: Parameters<Collection<TSchema>['insertMany']>
): ReturnType<Collection<TSchema>['insertMany']> {
    assertManagedTransactionWriteAllowed(args[1]);
    return collection.insertMany(...args);
}

/** Thin wrapper around `collection.updateOne`; delegates directly to the MongoDB driver. */
export async function updateOneDocument<TSchema extends Document = Document>(
    collection: Collection<TSchema>,
    ...args: Parameters<Collection<TSchema>['updateOne']>
): ReturnType<Collection<TSchema>['updateOne']> {
    assertManagedTransactionWriteAllowed(args[2]);
    return collection.updateOne(...args);
}

/** Thin wrapper around `collection.updateMany`; delegates directly to the MongoDB driver. */
export async function updateManyDocuments<TSchema extends Document = Document>(
    collection: Collection<TSchema>,
    ...args: Parameters<Collection<TSchema>['updateMany']>
): ReturnType<Collection<TSchema>['updateMany']> {
    assertManagedTransactionWriteAllowed(args[2]);
    return collection.updateMany(...args);
}

/** Thin wrapper around `collection.replaceOne`; delegates directly to the MongoDB driver. */
export async function replaceOneDocument<TSchema extends Document = Document>(
    collection: Collection<TSchema>,
    ...args: Parameters<Collection<TSchema>['replaceOne']>
): ReturnType<Collection<TSchema>['replaceOne']> {
    assertManagedTransactionWriteAllowed(args[2]);
    return collection.replaceOne(...args);
}

/** Wraps `collection.findOneAndUpdate`; returns the document after/before modification. */
export async function findOneAndUpdateDocument<TSchema extends Document = Document>(
    collection: Collection<TSchema>,
    filter: Parameters<Collection<TSchema>['findOneAndUpdate']>[0],
    update: Parameters<Collection<TSchema>['findOneAndUpdate']>[1],
    options?: unknown,
): ReturnType<Collection<TSchema>['findOneAndUpdate']> {
    assertManagedTransactionWriteAllowed(options);
    if (options !== undefined) {
        return collection.findOneAndUpdate(filter, update, options as FindOneAndUpdateOptions);
    }
    return collection.findOneAndUpdate(filter, update);
}

/** Wraps `collection.findOneAndReplace`; returns the document after/before replacement. */
export async function findOneAndReplaceDocument<TSchema extends Document = Document>(
    collection: Collection<TSchema>,
    filter: Parameters<Collection<TSchema>['findOneAndReplace']>[0],
    replacement: Parameters<Collection<TSchema>['findOneAndReplace']>[1],
    options?: unknown,
): ReturnType<Collection<TSchema>['findOneAndReplace']> {
    assertManagedTransactionWriteAllowed(options);
    if (options !== undefined) {
        return collection.findOneAndReplace(filter, replacement, options as FindOneAndReplaceOptions);
    }
    return collection.findOneAndReplace(filter, replacement);
}

/** Wraps `collection.findOneAndDelete`; returns the deleted document. */
export async function findOneAndDeleteDocument<TSchema extends Document = Document>(
    collection: Collection<TSchema>,
    filter: Parameters<Collection<TSchema>['findOneAndDelete']>[0],
    options?: unknown,
): ReturnType<Collection<TSchema>['findOneAndDelete']> {
    assertManagedTransactionWriteAllowed(options);
    if (options !== undefined) {
        return collection.findOneAndDelete(filter, options as FindOneAndDeleteOptions);
    }
    return collection.findOneAndDelete(filter);
}

/** Performs an upsert (`updateOne` with `upsert: true`); inserts if no document matches the filter. */
export async function upsertOneDocument<TSchema extends Document = Document>(
    collection: Collection<TSchema>,
    filter: Parameters<Collection<TSchema>['updateOne']>[0],
    update: Parameters<Collection<TSchema>['updateOne']>[1],
    options: NonNullable<Parameters<Collection<TSchema>['updateOne']>[2]> = {},
): ReturnType<Collection<TSchema>['updateOne']> {
    assertManagedTransactionWriteAllowed(options);
    return collection.updateOne(filter, update, {
        ...options,
        upsert: true,
    });
}

/** Thin wrapper around `collection.deleteOne`; delegates directly to the MongoDB driver. */
export async function deleteOneDocument<TSchema extends Document = Document>(
    collection: Collection<TSchema>,
    ...args: Parameters<Collection<TSchema>['deleteOne']>
): ReturnType<Collection<TSchema>['deleteOne']> {
    assertManagedTransactionWriteAllowed(args[1]);
    return collection.deleteOne(...args);
}

/** Thin wrapper around `collection.deleteMany`; delegates directly to the MongoDB driver. */
export async function deleteManyDocuments<TSchema extends Document = Document>(
    collection: Collection<TSchema>,
    ...args: Parameters<Collection<TSchema>['deleteMany']>
): ReturnType<Collection<TSchema>['deleteMany']> {
    assertManagedTransactionWriteAllowed(args[1]);
    return collection.deleteMany(...args);
}

export interface IncrementOneResult<TSchema extends Document = Document> {
    acknowledged: boolean;
    matchedCount: number;
    modifiedCount: number;
    value: TSchema | null;
}

/** Atomically increments a numeric field (or map of fields) on the matched document; returns the updated document. */
export async function incrementOneDocument<TSchema extends Document = Document>(
    collection: Collection<TSchema>,
    filter: Parameters<Collection<TSchema>['findOneAndUpdate']>[0],
    field: string | Record<string, number>,
    incrementOrOptions?: number | IncrementOneOptions,
    maybeOptions?: IncrementOneOptions,
): Promise<IncrementOneResult<TSchema>> {
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
        throw createError(ErrorCodes.INVALID_ARGUMENT, 'filter must be a non-empty object');
    }

    let options: IncrementOneOptions = {};
    let increment = 1;
    if (typeof incrementOrOptions === 'number' || incrementOrOptions === undefined) {
        increment = typeof incrementOrOptions === 'number' ? incrementOrOptions : 1;
        options = maybeOptions ?? {};
    } else if (incrementOrOptions && typeof incrementOrOptions === 'object' && !Array.isArray(incrementOrOptions)) {
        options = incrementOrOptions;
    } else {
        throw createError(ErrorCodes.INVALID_ARGUMENT, 'increment must be a number');
    }

    const updateDocument = createIncrementUpdate(field, increment, options.$set);
    const { $set, projection, returnDocument, ...driverOptions } = stripWriteCacheControlOptions(options);
    void $set;
    const normalizedProjection = normalizeProjection(projection as string[] | Record<string, unknown> | null | undefined);
    const findOptions: Record<string, unknown> = {
        ...driverOptions,
        returnDocument: returnDocument ?? 'after',
        includeResultMetadata: true,
    };
    if (normalizedProjection) findOptions.projection = normalizedProjection;

    assertManagedTransactionWriteAllowed(findOptions);
    const rawResult = await (collection as unknown as Collection<TSchema>).findOneAndUpdate(
        filter as Parameters<Collection<TSchema>['findOneAndUpdate']>[0],
        updateDocument as Parameters<Collection<TSchema>['findOneAndUpdate']>[1],
        findOptions as unknown as FindOneAndUpdateOptions & { includeResultMetadata: true },
    ) as unknown;

    let value: TSchema | null;
    let matchedCount: number;
    let modifiedCount: number;

    if (rawResult && typeof rawResult === 'object' && 'lastErrorObject' in (rawResult as object)) {
        const result = rawResult as { value: TSchema | null; lastErrorObject?: { n?: number; updatedExisting?: boolean }; ok: number };
        value = result.value ?? null;
        matchedCount = result.lastErrorObject?.n ?? 0;
        modifiedCount = (result.lastErrorObject?.updatedExisting === true && value != null) ? 1 : 0;
    } else {
        value = (rawResult as TSchema) ?? null;
        matchedCount = value != null ? 1 : 0;
        modifiedCount = value != null ? 1 : 0;
    }

    return { acknowledged: true, matchedCount, modifiedCount, value };
}
