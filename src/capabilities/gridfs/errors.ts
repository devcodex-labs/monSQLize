import type { ObjectId } from 'mongodb';
import { ErrorCodes, createError, type MonSQLizeError } from '../../core/errors';
import type { GridFSContext, GridFSIdOrName } from './types';

export interface GridFSErrorDetails {
    operation: string;
    bucket: string;
    id?: ObjectId;
    filename?: string;
    sha256?: string;
    uploadId?: ObjectId;
    expected?: unknown;
    actual?: unknown;
    missingChunks?: number[];
    fromChunk?: number;
    expectedNextChunk?: number;
    start?: number;
    end?: number;
    length?: number;
}

const GRIDFS_CODES = new Set<string>([
    ErrorCodes.GRIDFS_FILE_NOT_FOUND,
    ErrorCodes.GRIDFS_FILE_EXISTS,
    ErrorCodes.GRIDFS_INTEGRITY_MISMATCH,
    ErrorCodes.GRIDFS_UPLOAD_INCOMPLETE,
    ErrorCodes.GRIDFS_RESUME_MISMATCH,
    ErrorCodes.GRIDFS_RANGE_INVALID,
    ErrorCodes.INVALID_ARGUMENT,
    ErrorCodes.INVALID_OPERATION,
    ErrorCodes.NOT_CONNECTED,
]);

export function isGridFSDomainError(error: unknown): error is MonSQLizeError {
    return error instanceof Error && GRIDFS_CODES.has((error as MonSQLizeError).code);
}

function withMeta(error: MonSQLizeError, details: GridFSErrorDetails): MonSQLizeError {
    Object.defineProperty(error, 'monsqlize', {
        value: { operation: details.operation, bucket: details.bucket, id: details.id, filename: details.filename, uploadId: details.uploadId },
        enumerable: true,
    });
    return error;
}

export function gridfsError(code: string, message: string, details: GridFSErrorDetails, cause?: Error): MonSQLizeError {
    return withMeta(createError(code, message, [stripUndefined(details)], cause), details);
}

function stripUndefined(details: GridFSErrorDetails): GridFSErrorDetails {
    const copy: GridFSErrorDetails = { operation: details.operation, bucket: details.bucket };
    for (const key of Object.keys(details) as Array<keyof GridFSErrorDetails>) {
        if (details[key] !== undefined) {
            (copy as unknown as Record<string, unknown>)[key] = details[key];
        }
    }
    return copy;
}

export function invalidArgument(operation: string, field: string, message: string): MonSQLizeError {
    return createError(ErrorCodes.INVALID_ARGUMENT, message, [{ operation, field, message }]);
}

export function fileNotFound(operation: string, ctx: Pick<GridFSContext, 'bucketName'>, target: { id?: ObjectId; filename?: string }): MonSQLizeError {
    return gridfsError(
        ErrorCodes.GRIDFS_FILE_NOT_FOUND,
        'GridFS file was not found',
        { operation, bucket: ctx.bucketName, id: target.id, filename: target.filename },
    );
}

export function fileExists(operation: string, ctx: Pick<GridFSContext, 'bucketName'>, target: { id?: ObjectId; filename?: string; sha256?: string }): MonSQLizeError {
    return gridfsError(
        ErrorCodes.GRIDFS_FILE_EXISTS,
        'GridFS file already exists',
        { operation, bucket: ctx.bucketName, id: target.id, filename: target.filename, sha256: target.sha256 },
    );
}

export function integrityMismatch(operation: string, bucket: string, fields: { uploadId?: ObjectId; expected?: unknown; actual?: unknown }): MonSQLizeError {
    return gridfsError(
        ErrorCodes.GRIDFS_INTEGRITY_MISMATCH,
        'GridFS content did not match the expected length or sha256',
        { operation, bucket, uploadId: fields.uploadId, expected: fields.expected, actual: fields.actual },
    );
}

export function uploadIncomplete(bucket: string, uploadId: ObjectId, missingChunks: number[]): MonSQLizeError {
    return gridfsError(
        ErrorCodes.GRIDFS_UPLOAD_INCOMPLETE,
        'GridFS resumable upload is missing chunks',
        { operation: 'finalizeResumableUpload', bucket, uploadId, missingChunks },
    );
}

export function resumeMismatch(operation: string, bucket: string, fields: { uploadId?: ObjectId; fromChunk?: number; expectedNextChunk?: number }): MonSQLizeError {
    return gridfsError(
        ErrorCodes.GRIDFS_RESUME_MISMATCH,
        'GridFS resumable upload did not match the open session',
        { operation, bucket, uploadId: fields.uploadId, fromChunk: fields.fromChunk, expectedNextChunk: fields.expectedNextChunk },
    );
}

export function rangeInvalid(operation: string, bucket: string, start: number | undefined, end: number | undefined, length?: number): MonSQLizeError {
    return gridfsError(
        ErrorCodes.GRIDFS_RANGE_INVALID,
        'GridFS download range is invalid',
        { operation, bucket, start, end, length },
    );
}

export function isNamespaceNotFound(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const record = error as { code?: unknown; codeName?: unknown };
    return record.code === 26 || record.codeName === 'NamespaceNotFound';
}

export function isDuplicateKey(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const code = (error as { code?: unknown }).code;
    return code === 11000 || code === 11001;
}

export function isDriverFileNotFound(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const code = (error as { code?: unknown }).code;
    const message = error instanceof Error ? error.message : '';
    return code === 'ENOENT' || /file not found/i.test(message) || /FileNotFound/i.test(message);
}

export function mapDriverError(error: unknown, operation: string, ctx: Pick<GridFSContext, 'bucketName'>, target: { id?: ObjectId; filename?: string; uploadId?: ObjectId } = {}): MonSQLizeError {
    if (isGridFSDomainError(error)) return error;
    if (error instanceof Error && (error as MonSQLizeError).code === ErrorCodes.MONGODB_ERROR) return error as MonSQLizeError;
    const cause = error instanceof Error ? error : new Error(String(error));
    if (isDriverFileNotFound(error)) {
        return fileNotFound(operation, ctx, target);
    }
    if (isDuplicateKey(error)) {
        return fileExists(operation, ctx, { id: target.id, filename: target.filename });
    }
    return gridfsError(ErrorCodes.MONGODB_ERROR, cause.message || 'MongoDB GridFS operation failed', {
        operation,
        bucket: ctx.bucketName,
        id: target.id,
        filename: target.filename,
        uploadId: target.uploadId,
    }, cause);
}

export function targetOf(idOrName: GridFSIdOrName | undefined): { id?: ObjectId; filename?: string } {
    if (!idOrName || typeof idOrName !== 'object') return {};
    if ('filename' in idOrName && typeof idOrName.filename === 'string') return { filename: idOrName.filename };
    return { id: idOrName as ObjectId };
}
