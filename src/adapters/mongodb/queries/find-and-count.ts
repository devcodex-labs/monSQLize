/**
 * findAndCount: returns all matching documents along with the total count.
 *
 * Responsibilities:
 * - Runs find + countDocuments concurrently.
 * - Does not apply findLimit (findAndCount semantics: return all matches).
 * - Returns a v1-compatible structure: { data, total }.
 *
 * Note: does not depend on FindChain; calls the driver directly to avoid circular references.
 */

import { Collection, Document } from 'mongodb';

import type { RuntimeDefaults } from '../../../types/internal/query';
import type { FindAndCountResult } from '../../../../types/collection';
import { buildCountDriverOptions, buildFindDriverOptions, normalizeFindProjectionOptions, snapshotReadInputs } from './query-helpers';

/**
 * Queries all matching documents and fetches the total count concurrently.
 * Unlike `findPage`, this function does not apply `findLimit` and returns all matches.
 * @param collection - Target MongoDB collection.
 * @param query - Filter predicate (default: `{}`).
 * @param options - Native driver `find` options.
 * @param defaults - Runtime-level defaults.
 * @returns `{ data, total }` — full document array and total count.
 * @since v1.0.0
 */
export async function findAndCountDocuments<TSchema extends Document = Document>(
    collection: Collection<TSchema>,
    query?: Parameters<Collection<TSchema>['find']>[0],
    options?: Parameters<Collection<TSchema>['find']>[1],
    defaults?: RuntimeDefaults,
): Promise<FindAndCountResult<TSchema>> {
    // v1 compat: null query is treated as {} (match all)

    // Build driver options (limit/skip/sort/projection apply to data; total uses query only)
    const rawOptions = (options ?? {}) as Record<string, unknown>;
    const { query: normalizedQuery, options: baseOptions } = snapshotReadInputs(query ?? {}, normalizeFindProjectionOptions({
        ...(defaults?.maxTimeMS !== undefined ? { maxTimeMS: defaults.maxTimeMS } : {}),
        ...rawOptions,
    }), collection.bsonOptions);
    const driverOptions = buildFindDriverOptions(baseOptions);
    const countOptions = buildCountDriverOptions(baseOptions);
    // v1 compat: limit/skip apply to data only, not to total.
    delete (countOptions as Record<string, unknown>).limit;
    delete (countOptions as Record<string, unknown>).skip;

    const [data, total] = await Promise.all([
        collection.find(
            normalizedQuery,
            driverOptions as Parameters<Collection<TSchema>['find']>[1],
        ).toArray() as Promise<TSchema[]>,
        collection.countDocuments(
            normalizedQuery as Parameters<Collection<TSchema>['countDocuments']>[0],
            countOptions,
        ),
    ]);

    // v1 compat: expose `documents` as an alias for `data`
    return { data, total, documents: data };
}
