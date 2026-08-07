import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
    ErrorCodes,
    createError,
    createConnectionError,
    createValidationError,
    createCursorError,
    createQueryTimeoutError,
} = require('../../../dist/cjs/index.cjs');

type MonSQLizeError = Error & {
    code?: string;
    details?: unknown;
    cause?: unknown;
};

describe('Error system: ErrorCodes', () => {
    it('all expected error codes are defined as strings', () => {
        const expected = [
            'INVALID_ARGUMENT', 'INVALID_COLLECTION_NAME', 'INVALID_DATABASE_NAME',
            'INVALID_EXPRESSION', 'INVALID_PAGINATION', 'INVALID_OPERATION',
            'INVALID_VECTOR_SEARCH', 'INVALID_RELATION_SELECT',
            'RELATION_IN_USE', 'RELATION_USAGE_UNAVAILABLE',
            'CACHE_UNAVAILABLE', 'MANAGEMENT_OPERATION_FAILED', 'NOT_CONNECTED',
            'CONNECTION_FAILED', 'CONNECTION_CLOSED', 'INVALID_CONFIG',
            'OPERATION_TIMEOUT', 'UNSUPPORTED_DATABASE', 'DOCUMENT_REQUIRED',
            'DUPLICATE_KEY', 'WRITE_ERROR', 'VALIDATION_ERROR',
            'STREAM_NO_JUMP', 'STREAM_NO_TOTALS', 'STREAM_NO_EXPLAIN',
            'JUMP_TOO_FAR', 'MONGODB_ERROR', 'CURSOR_SORT_MISMATCH',
            'INVALID_CURSOR', 'CONNECTION_TIMEOUT', 'DATABASE_ERROR',
            'QUERY_TIMEOUT', 'CACHE_ERROR', 'CACHE_TIMEOUT',
            'MISSING_SCHEMA', 'MODEL_ALREADY_EXISTS', 'DOCUMENTS_REQUIRED',
            'WRITE_CONFLICT', 'LOCK_ACQUIRE_FAILED', 'LOCK_TIMEOUT',
            'MODEL_NOT_DEFINED', 'NO_POOL_MANAGER', 'POOL_NOT_FOUND',
            'INVALID_MODEL_DEFINITION', 'INVALID_SCHEMA_TYPE',
        ];
        for (const code of expected) {
            assert.equal(
                typeof ErrorCodes[code],
                'string',
                `ErrorCodes.${code} should be a string`,
            );
            assert.equal(ErrorCodes[code], code, `ErrorCodes.${code} value should equal "${code}"`);
        }
    });

    it('ErrorCodes values are all strings', () => {
        for (const [, value] of Object.entries(ErrorCodes)) {
            assert.equal(typeof value, 'string');
        }
    });
});

describe('Error system: createError()', () => {
    it('creates an Error with .code and .message', () => {
        const err = createError('INVALID_ARGUMENT', 'bad arg') as MonSQLizeError;
        assert.ok(err instanceof Error);
        assert.equal(err.code, 'INVALID_ARGUMENT');
        assert.equal(err.message, 'bad arg');
    });

    it('attaches .details when provided', () => {
        const details = [{ field: 'name', message: 'required' }];
        const err = createError('VALIDATION_ERROR', 'validation failed', details) as MonSQLizeError;
        assert.deepEqual(err.details, details);
    });

    it('does not attach .details when not provided', () => {
        const err = createError('INVALID_ARGUMENT', 'msg') as MonSQLizeError;
        assert.equal('details' in err, false);
    });

    it('attaches .cause when provided', () => {
        const cause = new Error('root cause');
        const err = createError('DATABASE_ERROR', 'db failed', undefined, cause) as MonSQLizeError;
        assert.equal(err.cause, cause);
    });

    it('does not attach .cause when not provided', () => {
        const err = createError('INVALID_ARGUMENT', 'msg') as MonSQLizeError;
        assert.equal('cause' in err, false);
    });

    it('accepts custom non-enum error codes', () => {
        const err = createError('CUSTOM_CODE', 'custom error') as MonSQLizeError;
        assert.equal(err.code, 'CUSTOM_CODE');
    });
});

describe('Error system: createConnectionError()', () => {
    it('produces CONNECTION_FAILED code', () => {
        const err = createConnectionError('cannot connect') as MonSQLizeError;
        assert.equal(err.code, 'CONNECTION_FAILED');
        assert.equal(err.message, 'cannot connect');
    });

    it('attaches cause when provided', () => {
        const cause = new Error('ECONNREFUSED');
        const err = createConnectionError('connection refused', cause) as MonSQLizeError;
        assert.equal(err.cause, cause);
    });
});

describe('Error system: createValidationError()', () => {
    it('produces VALIDATION_ERROR code with details', () => {
        const details = [{ path: 'email', message: 'invalid format' }];
        const err = createValidationError(details) as MonSQLizeError;
        assert.equal(err.code, 'VALIDATION_ERROR');
        assert.deepEqual(err.details, details);
    });

    it('uses the default message', () => {
        const err = createValidationError([]) as MonSQLizeError;
        assert.equal(err.message, 'Validation failed');
    });
});

describe('Error system: createCursorError()', () => {
    it('produces INVALID_CURSOR code with default message', () => {
        const err = createCursorError() as MonSQLizeError;
        assert.equal(err.code, 'INVALID_CURSOR');
        assert.equal(err.message, 'Invalid cursor');
    });

    it('accepts a custom message', () => {
        const err = createCursorError('cursor expired') as MonSQLizeError;
        assert.equal(err.code, 'INVALID_CURSOR');
        assert.equal(err.message, 'cursor expired');
    });
});

describe('Error system: createQueryTimeoutError()', () => {
    it('produces QUERY_TIMEOUT code', () => {
        const err = createQueryTimeoutError() as MonSQLizeError;
        assert.equal(err.code, 'QUERY_TIMEOUT');
        assert.ok(err.message.includes('timeout'));
    });

    it('includes timeout duration when provided', () => {
        const err = createQueryTimeoutError(5000) as MonSQLizeError;
        assert.equal(err.code, 'QUERY_TIMEOUT');
        assert.ok(err.message.includes('5000'));
    });
});
