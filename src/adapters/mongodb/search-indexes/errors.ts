/**
 * Maps driver/server errors raised by Search index commands to monSQLize codes.
 * Code-based rules come first; message patterns are a last-resort fallback.
 * Server codes are provisional until verified on atlas-local (A06 / OA5).
 */
import { ErrorCodes, createError } from '../../../core/errors';
import type { MonSQLizeError } from '../../../core/errors';

export type SearchIndexErrorKind = 'exists' | 'unsupported' | 'notFound' | 'invalid' | 'namespaceNotFound' | 'other';

const CODE_INDEX_ALREADY_EXISTS = 68;
const CODE_INDEX_NOT_FOUND = 27;
const CODE_NAMESPACE_NOT_FOUND = 26;
const CODE_COMMAND_NOT_FOUND = 59;
const CODE_COMMAND_NOT_SUPPORTED = 115;
/** mongod 7.0 without Atlas: "$listSearchIndexes stage is only allowed on MongoDB Atlas" (observed on memory-server 7.0.37). */
const CODE_LIST_SEARCH_ATLAS_ONLY = 6047401;
const CODE_BAD_VALUE = 2;
const CODE_FAILED_TO_PARSE = 9;
const CODE_INVALID_OPTIONS = 72;

const UNSUPPORTED_MESSAGE = /search index commands are only supported|mongot|atlas search|\$listSearchIndexes stage is only allowed/i;

function readCode(error: unknown): { code?: number; codeName?: string; message: string; } {
    const e = error as { code?: unknown; codeName?: unknown; message?: unknown; } | null;
    return {
        code: typeof e?.code === 'number' ? e.code : undefined,
        codeName: typeof e?.codeName === 'string' ? e.codeName : undefined,
        message: typeof e?.message === 'string' ? e.message : String(error),
    };
}

export function classifySearchIndexError(error: unknown): SearchIndexErrorKind {
    const { code, codeName, message } = readCode(error);
    if (code === CODE_INDEX_ALREADY_EXISTS || codeName === 'IndexAlreadyExists') return 'exists';
    if (code === CODE_NAMESPACE_NOT_FOUND || codeName === 'NamespaceNotFound') return 'namespaceNotFound';
    if (code === CODE_INDEX_NOT_FOUND || codeName === 'IndexNotFound') return 'notFound';
    if (code === CODE_COMMAND_NOT_FOUND || code === CODE_COMMAND_NOT_SUPPORTED || code === CODE_LIST_SEARCH_ATLAS_ONLY
        || codeName === 'CommandNotFound' || codeName === 'CommandNotSupported' || codeName === 'SearchNotEnabled') return 'unsupported';
    if (code === CODE_BAD_VALUE || code === CODE_FAILED_TO_PARSE || code === CODE_INVALID_OPTIONS
        || codeName === 'BadValue' || codeName === 'FailedToParse' || codeName === 'InvalidOptions') return 'invalid';
    if (UNSUPPORTED_MESSAGE.test(message)) return 'unsupported';
    if (code === undefined && codeName === undefined && /already exists/i.test(message)) return 'exists';
    return 'other';
}

interface ErrorContext { operation: string; namespace: object; indexName?: string; }

function attachContext(error: Error, ctx: ErrorContext): Error {
    const contextualized = error as Error & { monsqlize?: Record<string, unknown>; };
    try {
        contextualized.monsqlize = {
            ...(contextualized.monsqlize && typeof contextualized.monsqlize === 'object' ? contextualized.monsqlize : {}),
            operation: ctx.operation,
            namespace: ctx.namespace,
            indexName: ctx.indexName,
        };
    } catch {
        // Preserve immutable driver errors unchanged.
    }
    return error;
}

export function searchIndexError(code: string, message: string, ctx: ErrorContext, extra: Record<string, unknown> = {}, cause?: Error): MonSQLizeError {
    return createError(code, message, [{ operation: ctx.operation, namespace: ctx.namespace, indexName: ctx.indexName, ...extra }], cause);
}

/** Converts an unknown failure from a driver Search index call into the contract error. */
export function mapSearchIndexError(error: unknown, ctx: ErrorContext): Error {
    if (!(error instanceof Error)) {
        return createError(ErrorCodes.MONGODB_ERROR, `${ctx.operation} failed`, [{ ...ctx, reason: String(error) }]);
    }
    if ((error as { code?: unknown; }).code !== undefined && typeof (error as { code?: unknown; }).code === 'string'
        && String((error as { code?: unknown; }).code).startsWith('SEARCH_INDEX_')) {
        return error;
    }
    const { code, codeName, message } = readCode(error);
    const server = { serverCode: code, serverCodeName: codeName, serverMessage: message };
    switch (classifySearchIndexError(error)) {
    case 'exists':
        return searchIndexError(ErrorCodes.SEARCH_INDEX_EXISTS, `Search index "${ctx.indexName}" already exists`, ctx, server, error);
    case 'notFound':
        return searchIndexError(ErrorCodes.SEARCH_INDEX_NOT_FOUND, `Search index "${ctx.indexName}" was not found`, ctx, server, error);
    case 'unsupported':
        return searchIndexError(ErrorCodes.SEARCH_INDEX_UNSUPPORTED, 'This deployment does not support Search index commands (requires Atlas, MongoDB 8.2+ with mongot, or mongodb-atlas-local)', ctx, server, error);
    case 'invalid':
        return searchIndexError(ErrorCodes.INVALID_SEARCH_INDEX_DEFINITION, `Server rejected Search index definition: ${message}`, ctx, server, error);
    default:
        return attachContext(error, ctx);
    }
}
