/**
 * Error system.
 *
 * Description:
 * - Provides unified error codes (ErrorCodes) and error factories (createError / createConnectionError).
 * - Covers all error scenarios: argument validation, connection, pagination, cache, write operations, locks, etc.
 */

import type { MonSQLizeError } from '../../../types/base';

export type { MonSQLizeError } from '../../../types/base';

/**
 * Enumeration of all MonSQLize error codes.
 * Use these with {@link createError} to produce structured errors.
 * @since v1.0.0
 */
export const ErrorCodes = {
    INVALID_ARGUMENT: 'INVALID_ARGUMENT',
    INVALID_COLLECTION_NAME: 'INVALID_COLLECTION_NAME',
    INVALID_DATABASE_NAME: 'INVALID_DATABASE_NAME',
    INVALID_EXPRESSION: 'INVALID_EXPRESSION',
    INVALID_PAGINATION: 'INVALID_PAGINATION',
    INVALID_OPERATION: 'INVALID_OPERATION',
    /** Invalid local Vector Search options before the driver is called. */
    INVALID_VECTOR_SEARCH: 'INVALID_VECTOR_SEARCH',
    /** Relation select is outside the supported inclusion-only top-level contract. */
    INVALID_RELATION_SELECT: 'INVALID_RELATION_SELECT',
    /** A protected delete found declared Model relations that still reference its target. */
    RELATION_IN_USE: 'RELATION_IN_USE',
    /** Relation usage coverage is incomplete, so a protected delete must not continue. */
    RELATION_USAGE_UNAVAILABLE: 'RELATION_USAGE_UNAVAILABLE',
    CACHE_UNAVAILABLE: 'CACHE_UNAVAILABLE',
    MANAGEMENT_OPERATION_FAILED: 'MANAGEMENT_OPERATION_FAILED',
    NOT_CONNECTED: 'NOT_CONNECTED',
    CONNECTION_FAILED: 'CONNECTION_FAILED',
    CONNECTION_CLOSED: 'CONNECTION_CLOSED',
    INVALID_CONFIG: 'INVALID_CONFIG',
    OPERATION_TIMEOUT: 'OPERATION_TIMEOUT',
    UNSUPPORTED_DATABASE: 'UNSUPPORTED_DATABASE',
    /** v1 compat: insertOne requires a non-null, non-array object document */
    DOCUMENT_REQUIRED: 'DOCUMENT_REQUIRED',
    /** v1 compat: MongoDB duplicate key (error code 11000) */
    DUPLICATE_KEY: 'DUPLICATE_KEY',
    /** v1 compat: general write failure (maps from MongoError in insert/update/delete) */
    WRITE_ERROR: 'WRITE_ERROR',
    /** v1 compat: model-layer schema validation failure */
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    /** v1 compat: stream mode cannot use page jump (page > 1 with stream: true) */
    STREAM_NO_JUMP: 'STREAM_NO_JUMP',
    /** v1 compat: stream mode cannot compute totals */
    STREAM_NO_TOTALS: 'STREAM_NO_TOTALS',
    /** v1 compat: stream mode cannot use explain */
    STREAM_NO_EXPLAIN: 'STREAM_NO_EXPLAIN',
    /** v1 compat: page jump exceeds the maxHops limit */
    JUMP_TOO_FAR: 'JUMP_TOO_FAR',
    /** v1 compat: generic MongoDB driver error (maps numeric MongoDB error codes) */
    MONGODB_ERROR: 'MONGODB_ERROR',
    /** v1 compat: cursor sort options mismatch between pages */
    CURSOR_SORT_MISMATCH: 'CURSOR_SORT_MISMATCH',
    /** v1 compat: invalid or expired cursor token */
    INVALID_CURSOR: 'INVALID_CURSOR',
    /** v1 compat: connection timeout */
    CONNECTION_TIMEOUT: 'CONNECTION_TIMEOUT',
    /** v1 compat: generic database error */
    DATABASE_ERROR: 'DATABASE_ERROR',
    /** v1 compat: query execution timeout */
    QUERY_TIMEOUT: 'QUERY_TIMEOUT',
    /** v1 compat: cache backend error */
    CACHE_ERROR: 'CACHE_ERROR',
    /** v1 compat: cache operation timeout */
    CACHE_TIMEOUT: 'CACHE_TIMEOUT',
    /** v1 compat: model.define() called without schema */
    MISSING_SCHEMA: 'MISSING_SCHEMA',
    /** v1 compat: model already registered under same name */
    MODEL_ALREADY_EXISTS: 'MODEL_ALREADY_EXISTS',
    /** v1 compat: write requires at least one document */
    DOCUMENTS_REQUIRED: 'DOCUMENTS_REQUIRED',
    /** v1 compat: concurrent write conflict in transaction */
    WRITE_CONFLICT: 'WRITE_CONFLICT',
    /** v1 compat: business lock acquire failed */
    LOCK_ACQUIRE_FAILED: 'LOCK_ACQUIRE_FAILED',
    /** v1 compat: business lock wait timeout */
    LOCK_TIMEOUT: 'LOCK_TIMEOUT',
    /** v1 compat: model.model() called when not connected */
    MODEL_NOT_DEFINED: 'MODEL_NOT_DEFINED',
    /** v1 compat: pool() called without pools configured */
    NO_POOL_MANAGER: 'NO_POOL_MANAGER',
    /** v1 compat: pool() called with a pool name that does not exist */
    POOL_NOT_FOUND: 'POOL_NOT_FOUND',
    /** v1 compat: model definition is not a valid object */
    INVALID_MODEL_DEFINITION: 'INVALID_MODEL_DEFINITION',
    /** v1 compat: schema property is not a function or object */
    INVALID_SCHEMA_TYPE: 'INVALID_SCHEMA_TYPE',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];


/**
 * Creates a standard error object.
 * @since v1.3.0
 */
export function createError(
    code: ErrorCode | string,
    message: string,
    details?: unknown[],
    cause?: Error,
): MonSQLizeError {
    const error = new Error(message) as MonSQLizeError;
    error.code = code;
    if (details !== undefined) {
        error.details = details;
    }
    if (cause !== undefined) {
        error.cause = cause;
    }
    return error;
}

/**
 * Creates a connection error.
 * @since v1.3.0
 */
export function createConnectionError(message: string, cause?: Error): MonSQLizeError {
    return createError(ErrorCodes.CONNECTION_FAILED, message, undefined, cause);
}

/**
 * Creates a parameter validation error.
 * @since v1.3.0
 */
export function createValidationError(details: unknown[]): MonSQLizeError {
    return createError(ErrorCodes.VALIDATION_ERROR, 'Validation failed', details);
}

/**
 * Creates a cursor error.
 * @since v1.3.0
 */
export function createCursorError(message = 'Invalid cursor'): MonSQLizeError {
    return createError(ErrorCodes.INVALID_CURSOR, message);
}

/**
 * Creates a query timeout error.
 * @since v1.3.0
 */
export function createQueryTimeoutError(timeoutMs?: number): MonSQLizeError {
    const msg = timeoutMs !== undefined
        ? `query timeout (${timeoutMs}ms)`
        : 'query timeout';
    return createError(ErrorCodes.QUERY_TIMEOUT, msg);
}

