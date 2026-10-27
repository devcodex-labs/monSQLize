export type DbType = 'mongodb';

export interface ExpressionObject {
    __expr__: string;
    __compiled__: boolean;
}

export type ExpressionFunction = (expression: string) => ExpressionObject;

/** Context in which an expression is evaluated. @since v1.0.0 */
export type ExpressionContext = '$match' | '$project' | '$group' | 'unknown';

export interface LoggerLike {
    debug?: (...args: unknown[]) => void;
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
    /** Wrap a function execution with a trace ID. @since v1.3.0 */
    withTraceId?: (fn: Function, traceId?: string) => any;
    /** Retrieve the current trace ID. @since v1.3.0 */
    getTraceId?: () => string | null;
}

/** Logger configuration options. @since v1.3.0 */
export interface LoggerOptions {
    /** Enable structured (JSON) log output. */
    structured?: boolean;
    /** Attach the current trace ID to structured logs by default; false disables injection. */
    enableTraceId?: boolean;
}

export declare const enum ErrorCodes {
    INVALID_ARGUMENT = 'INVALID_ARGUMENT',
    INVALID_COLLECTION_NAME = 'INVALID_COLLECTION_NAME',
    INVALID_DATABASE_NAME = 'INVALID_DATABASE_NAME',
    INVALID_EXPRESSION = 'INVALID_EXPRESSION',
    INVALID_PAGINATION = 'INVALID_PAGINATION',
    INVALID_OPERATION = 'INVALID_OPERATION',
    INVALID_VECTOR_SEARCH = 'INVALID_VECTOR_SEARCH',
    INVALID_SEARCH_INDEX_DEFINITION = 'INVALID_SEARCH_INDEX_DEFINITION',
    SEARCH_INDEX_EXISTS = 'SEARCH_INDEX_EXISTS',
    SEARCH_INDEX_NOT_FOUND = 'SEARCH_INDEX_NOT_FOUND',
    SEARCH_INDEX_UNSUPPORTED = 'SEARCH_INDEX_UNSUPPORTED',
    SEARCH_INDEX_BUILD_FAILED = 'SEARCH_INDEX_BUILD_FAILED',
    SEARCH_INDEX_WAIT_TIMEOUT = 'SEARCH_INDEX_WAIT_TIMEOUT',
    GRIDFS_FILE_NOT_FOUND = 'GRIDFS_FILE_NOT_FOUND',
    GRIDFS_FILE_EXISTS = 'GRIDFS_FILE_EXISTS',
    GRIDFS_INTEGRITY_MISMATCH = 'GRIDFS_INTEGRITY_MISMATCH',
    GRIDFS_UPLOAD_INCOMPLETE = 'GRIDFS_UPLOAD_INCOMPLETE',
    GRIDFS_RESUME_MISMATCH = 'GRIDFS_RESUME_MISMATCH',
    GRIDFS_RANGE_INVALID = 'GRIDFS_RANGE_INVALID',
    INVALID_RELATION_SELECT = 'INVALID_RELATION_SELECT',
    RELATION_IN_USE = 'RELATION_IN_USE',
    RELATION_USAGE_UNAVAILABLE = 'RELATION_USAGE_UNAVAILABLE',
    INVALID_CURSOR = 'INVALID_CURSOR',
    INVALID_CONFIG = 'INVALID_CONFIG',
    INVALID_MODEL_DEFINITION = 'INVALID_MODEL_DEFINITION',
    INVALID_SCHEMA_TYPE = 'INVALID_SCHEMA_TYPE',
    NOT_CONNECTED = 'NOT_CONNECTED',
    NO_POOL_MANAGER = 'NO_POOL_MANAGER',
    POOL_NOT_FOUND = 'POOL_NOT_FOUND',
    MODEL_NOT_DEFINED = 'MODEL_NOT_DEFINED',
    MODEL_ALREADY_EXISTS = 'MODEL_ALREADY_EXISTS',
    MISSING_SCHEMA = 'MISSING_SCHEMA',
    UNSUPPORTED_DATABASE = 'UNSUPPORTED_DATABASE',
    CONNECTION_FAILED = 'CONNECTION_FAILED',
    CONNECTION_CLOSED = 'CONNECTION_CLOSED',
    CONNECTION_TIMEOUT = 'CONNECTION_TIMEOUT',
    OPERATION_TIMEOUT = 'OPERATION_TIMEOUT',
    QUERY_TIMEOUT = 'QUERY_TIMEOUT',
    DATABASE_ERROR = 'DATABASE_ERROR',
    CACHE_UNAVAILABLE = 'CACHE_UNAVAILABLE',
    CACHE_ERROR = 'CACHE_ERROR',
    CACHE_TIMEOUT = 'CACHE_TIMEOUT',
    MANAGEMENT_OPERATION_FAILED = 'MANAGEMENT_OPERATION_FAILED',
    VALIDATION_ERROR = 'VALIDATION_ERROR',
    DOCUMENT_REQUIRED = 'DOCUMENT_REQUIRED',
    DOCUMENTS_REQUIRED = 'DOCUMENTS_REQUIRED',
    DUPLICATE_KEY = 'DUPLICATE_KEY',
    WRITE_ERROR = 'WRITE_ERROR',
    WRITE_CONFLICT = 'WRITE_CONFLICT',
    CURSOR_SORT_MISMATCH = 'CURSOR_SORT_MISMATCH',
    JUMP_TOO_FAR = 'JUMP_TOO_FAR',
    STREAM_NO_JUMP = 'STREAM_NO_JUMP',
    STREAM_NO_TOTALS = 'STREAM_NO_TOTALS',
    STREAM_NO_EXPLAIN = 'STREAM_NO_EXPLAIN',
    MONGODB_ERROR = 'MONGODB_ERROR',
    LOCK_ACQUIRE_FAILED = 'LOCK_ACQUIRE_FAILED',
    LOCK_TIMEOUT = 'LOCK_TIMEOUT',
}

export interface MonSQLizeError extends Error {
    code: string;
    details?: unknown[];
    cause?: Error;
}

