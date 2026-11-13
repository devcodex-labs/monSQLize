/**
 * MongoDB Vector Search pipeline construction and result normalization.
 *
 * The public collection method delegates execution to the normal aggregate
 * chain. Keeping the stage builder here ensures the Vector Search placement
 * and result-envelope guarantees are applied before the driver is called.
 */

import { Binary, type Document } from 'mongodb';
import { types as utilTypes } from 'node:util';
import { createError, ErrorCodes } from '../../../core/errors';
import { normalizeProjection } from '../../../utils/normalize';
import type {
    VectorSearchHit,
    VectorSearchOptions,
} from '../../../../types/collection';

export const VECTOR_SEARCH_SCORE_FIELD = '__monsqlize_vector_search_score__';

type VectorSearchPipeline = {
    pipeline: Document[];
    aggregateOptions?: Record<string, unknown>;
};

/**
 * Preserves a driver error while attaching the monSQLize operation that
 * produced it. Vector Search deployment and index failures must not become
 * locally fabricated empty results or replacement error codes.
 */
export function attachVectorSearchOperationContext(
    error: unknown,
    namespace: object,
): Error {
    if (error instanceof Error) {
        const contextualized = error as Error & { monsqlize?: Record<string, unknown> };
        const existing = contextualized.monsqlize;
        try {
            contextualized.monsqlize = {
                ...(existing && typeof existing === 'object' ? existing : {}),
                operation: 'vectorSearch',
                namespace,
            };
        } catch {
            // Preserve immutable driver errors rather than replacing their code/message.
        }
        return error;
    }
    return createError(
        ErrorCodes.MONGODB_ERROR,
        'vectorSearch execution failed',
        [{ operation: 'vectorSearch', namespace, reason: String(error) }],
    );
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw createError(ErrorCodes.INVALID_VECTOR_SEARCH, `${field} must be a non-empty string`, [{ field, reason: 'non-empty string required' }]);
    }
}

function assertPositiveInteger(value: unknown, field: string): asserts value is number {
    if (!Number.isInteger(value) || (value as number) <= 0) {
        throw createError(ErrorCodes.INVALID_VECTOR_SEARCH, `${field} must be a positive integer`, [{ field, reason: 'positive integer required' }]);
    }
}

function isNonArrayObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Captures the representation sent to MongoDB without decoding pre-quantized vectors. */
function normalizeQueryVector(value: unknown): number[] | Binary {
    if (Array.isArray(value)) {
        const vector = [...value];
        if (vector.length === 0) {
            throw createError(ErrorCodes.INVALID_VECTOR_SEARCH, 'queryVector must be a non-empty number array', [{ field: 'queryVector', reason: 'non-empty number array required' }]);
        }
        if (vector.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry))) {
            throw createError(ErrorCodes.INVALID_VECTOR_SEARCH, 'queryVector values must be finite numbers', [{ field: 'queryVector', reason: 'finite numbers required' }]);
        }
        return vector;
    }
    const invalid = (reason: string): never => {
        throw createError(ErrorCodes.INVALID_VECTOR_SEARCH, `queryVector ${reason}`, [{ field: 'queryVector', reason }]);
    };
    // Match BSON's type marker rather than one constructor identity: compatible Binary
    // values can originate in another copy of the driver. Never invoke caller toBSON.
    if (!isNonArrayObject(value) || value._bsontype !== 'Binary') {
        return invalid('must be a non-empty number array or a BSON int8/int1 vector');
    }
    const { buffer, position, sub_type: subtype } = value;
    if (subtype !== Binary.SUBTYPE_VECTOR || !utilTypes.isUint8Array(buffer)) {
        return invalid('must use BSON vector subtype 9 with a byte buffer');
    }
    const bytes = buffer as Uint8Array;
    if (typeof position !== 'number' || !Number.isInteger(position) || position < 3 || position > bytes.byteLength) {
        return invalid('must contain a non-empty vector within its effective byte length');
    }
    const captured = Buffer.from(new Uint8Array(bytes.buffer, bytes.byteOffset, position));
    const dtype = captured[0];
    const padding = captured[1];
    if (dtype === Binary.VECTOR_TYPE.Int8) {
        if (padding !== 0) return invalid('int8 padding must be zero');
    } else if (dtype === Binary.VECTOR_TYPE.PackedBit) {
        if (padding > 7 || (position - 2) * 8 - padding <= 0) {
            return invalid('int1 padding must be between 0 and 7 with non-empty data');
        }
    } else {
        return invalid('must encode an int8 or packed-bit int1 vector');
    }
    return new Binary(captured, Binary.SUBTYPE_VECTOR);
}

function normalizeVectorProjection(value: unknown): Record<string, unknown> | undefined {
    if (value === undefined) return undefined;
    if (Array.isArray(value)) {
        if (value.some((field) => typeof field !== 'string' || field.length === 0)) {
            throw createError(ErrorCodes.INVALID_VECTOR_SEARCH, 'projection array entries must be non-empty strings', [{ field: 'projection', reason: 'array entries must be non-empty strings' }]);
        }
        return normalizeProjection(value);
    }
    if (!isNonArrayObject(value)) {
        throw createError(ErrorCodes.INVALID_VECTOR_SEARCH, 'projection must be an object or string array', [{ field: 'projection', reason: 'object or string array required' }]);
    }
    return normalizeProjection(value);
}

function normalizeAggregateOptions(value: unknown): Record<string, unknown> | undefined {
    if (value === undefined) return undefined;
    if (!isNonArrayObject(value)) {
        throw createError(ErrorCodes.INVALID_VECTOR_SEARCH, 'aggregateOptions must be a non-array object', [{ field: 'aggregateOptions', reason: 'non-array object required' }]);
    }
    for (const key of ['meta', 'stream', 'explain']) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
            throw createError(ErrorCodes.INVALID_VECTOR_SEARCH, `aggregateOptions.${key} is not supported by vectorSearch()`, [{ field: `aggregateOptions.${key}`, reason: 'reserved aggregate option' }]);
        }
    }
    return { ...value };
}

/**
 * Validates public vector-search options and constructs the exact pipeline
 * handed to the aggregate executor. `$vectorSearch` is always the first stage.
 */
export function buildVectorSearchPipeline(options: VectorSearchOptions): VectorSearchPipeline {
    if (!isNonArrayObject(options)) {
        throw createError(ErrorCodes.INVALID_VECTOR_SEARCH, 'vectorSearch options must be a non-array object', [{ field: 'options', reason: 'non-array object required' }]);
    }

    assertNonEmptyString(options.index, 'index');
    assertNonEmptyString(options.path, 'path');
    assertPositiveInteger(options.limit, 'limit');

    const queryVector = normalizeQueryVector(options.queryVector);
    if (options.exact !== undefined && typeof options.exact !== 'boolean') {
        throw createError(ErrorCodes.INVALID_VECTOR_SEARCH, 'exact must be a boolean', [{ field: 'exact', reason: 'boolean required' }]);
    }
    if (options.filter !== undefined && !isNonArrayObject(options.filter)) {
        throw createError(ErrorCodes.INVALID_VECTOR_SEARCH, 'filter must be a non-array object', [{ field: 'filter', reason: 'non-array object required' }]);
    }

    const isExactSearch = options.exact === true;
    if (isExactSearch) {
        if (options.numCandidates !== undefined) {
            throw createError(ErrorCodes.INVALID_VECTOR_SEARCH, 'numCandidates is not supported when exact is true', [{ field: 'numCandidates', reason: 'ANN-only option' }]);
        }
    } else {
        assertPositiveInteger(options.numCandidates, 'numCandidates');
        if (options.numCandidates < options.limit) {
            throw createError(ErrorCodes.INVALID_VECTOR_SEARCH, 'numCandidates must be greater than or equal to limit', [{ field: 'numCandidates', reason: 'must be greater than or equal to limit' }]);
        }
    }

    const vectorSearchStage: Document = {
        index: options.index.trim(),
        path: options.path.trim(),
        queryVector,
        limit: options.limit,
        ...(isExactSearch ? { exact: true } : { numCandidates: options.numCandidates }),
        ...(options.filter === undefined ? {} : { filter: options.filter }),
    };
    const projection = normalizeVectorProjection(options.projection);
    const scoreStage: Document = projection
        ? {
            $project: {
                ...projection,
                [VECTOR_SEARCH_SCORE_FIELD]: { $meta: 'vectorSearchScore' },
            },
        }
        : {
            $set: {
                [VECTOR_SEARCH_SCORE_FIELD]: { $meta: 'vectorSearchScore' },
            },
        };

    return {
        pipeline: [
            { $vectorSearch: vectorSearchStage },
            scoreStage,
        ],
        aggregateOptions: normalizeAggregateOptions(options.aggregateOptions),
    };
}

/** Converts internal score-bearing aggregate documents into public result envelopes. */
export function mapVectorSearchRows<TDocument>(rows: Document[]): Array<VectorSearchHit<TDocument>> {
    return rows.map((row) => {
        const score = row[VECTOR_SEARCH_SCORE_FIELD];
        if (typeof score !== 'number' || !Number.isFinite(score)) {
            throw createError(ErrorCodes.INVALID_OPERATION, 'Vector Search result did not contain a finite score');
        }
        const document = { ...row } as Record<string, unknown>;
        delete document[VECTOR_SEARCH_SCORE_FIELD];
        return {
            document: document as unknown as TDocument,
            score,
        };
    });
}
