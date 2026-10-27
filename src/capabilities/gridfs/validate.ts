import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { ObjectId, type Document } from 'mongodb';
import type { GridFSDownloadRange, GridFSFindFilesFilter, GridFSFindFilesOptions, GridFSIfExists, ParsedRange } from './types';
import { invalidArgument, rangeInvalid } from './errors';

const SHA256_HEX = /^[0-9a-f]{64}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    if (Buffer.isBuffer(value) || value instanceof Date || value instanceof ObjectId) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

export function assertFilename(filename: unknown, operation: string): asserts filename is string {
    if (typeof filename !== 'string' || filename.length === 0 || filename.includes('\0')) {
        throw invalidArgument(operation, 'filename', 'filename must be a non-empty string');
    }
}

export function assertBucketName(bucketName: unknown): asserts bucketName is string {
    if (typeof bucketName !== 'string' || bucketName.length === 0 || bucketName.includes('\0') || bucketName.includes('$')) {
        throw invalidArgument('gridfs', 'bucketName', 'bucketName must be a non-empty string without "$" or NUL');
    }
}

export function assertChunkSize(value: unknown, operation: string): asserts value is number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
        throw invalidArgument(operation, 'chunkSizeBytes', 'chunkSizeBytes must be a positive integer');
    }
}

export function assertSha256(value: unknown, operation: string): asserts value is string {
    if (typeof value !== 'string' || !SHA256_HEX.test(value)) {
        throw invalidArgument(operation, 'sha256', 'sha256 must be a lowercase hex string of 64 characters');
    }
}

export function assertPositiveLength(value: unknown, operation: string): asserts value is number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
        throw invalidArgument(operation, 'length', 'length must be a positive integer');
    }
}

export function assertObjectId(value: unknown, operation: string, field: string): asserts value is ObjectId {
    if (!(value instanceof ObjectId)) {
        throw invalidArgument(operation, field, `${field} must be an ObjectId`);
    }
}

export function assertIfExists(value: unknown): asserts value is GridFSIfExists {
    if (value !== 'error' && value !== 'skip' && value !== 'duplicate') {
        throw invalidArgument('upload', 'ifExists', 'ifExists must be "error", "skip", or "duplicate"');
    }
}

export function assertContentType(value: unknown, operation: string): void {
    if (value !== undefined && typeof value !== 'string') {
        throw invalidArgument(operation, 'contentType', 'contentType must be a string');
    }
}

export function assertNonNegativeInteger(value: unknown, operation: string, field: string): asserts value is number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw invalidArgument(operation, field, `${field} must be a non-negative integer`);
    }
}

export function isReadableStream(value: unknown): value is Readable {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) return false;
    if (value instanceof Readable) return true;
    return typeof value === 'object' && value !== null
        && typeof (value as Readable).read === 'function'
        && typeof (value as Readable).pipe === 'function';
}

export function toNodeBuffer(data: Buffer | Uint8Array): Buffer {
    if (Buffer.isBuffer(data)) return data;
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

export function sha256Hex(data: Buffer): string {
    return createHash('sha256').update(data).digest('hex');
}

export function chunkCount(length: number, chunkSize: number): number {
    return Math.ceil(length / chunkSize);
}

export function chunkLengthAt(index: number, length: number, chunkSize: number): number {
    const count = chunkCount(length, chunkSize);
    if (index < 0 || index >= count) return -1;
    if (index < count - 1) return chunkSize;
    const remainder = length % chunkSize;
    return remainder === 0 ? chunkSize : remainder;
}

export function assertSafeKey(key: string, operation: string): void {
    if (FORBIDDEN_KEYS.has(key)) {
        throw invalidArgument(operation, key, `key "${key}" is not allowed`);
    }
}

export function buildMetadata(metadata: Record<string, unknown> | undefined, sha256: string | undefined, operation: string): Document | undefined {
    if (metadata !== undefined && !isPlainRecord(metadata)) {
        throw invalidArgument(operation, 'metadata', 'metadata must be a plain object');
    }
    if (!metadata && sha256 === undefined) return undefined;
    const out: Document = {};
    if (metadata) {
        for (const key of Object.keys(metadata)) {
            assertSafeKey(key, operation);
            out[key] = metadata[key];
        }
    }
    if (sha256 !== undefined) out.sha256 = sha256;
    return out;
}

export function parseRangeShape(range: GridFSDownloadRange | undefined, operation: string, bucket: string): ParsedRange {
    if (range === undefined) return {};
    if (!isPlainRecord(range)) throw rangeInvalid(operation, bucket, undefined, undefined);
    const start = range.start;
    const end = range.end;
    if (start !== undefined && (typeof start !== 'number' || !Number.isSafeInteger(start) || start < 0)) {
        throw rangeInvalid(operation, bucket, typeof start === 'number' ? start : undefined, typeof end === 'number' ? end : undefined);
    }
    if (end !== undefined && (typeof end !== 'number' || !Number.isSafeInteger(end) || end < 0)) {
        throw rangeInvalid(operation, bucket, start, typeof end === 'number' ? end : undefined);
    }
    if (start !== undefined && end !== undefined && start >= end) {
        throw rangeInvalid(operation, bucket, start, end);
    }
    return { start, end };
}

export function rangeBounds(range: ParsedRange, length: number, operation: string, bucket: string): { start: number; end: number } | undefined {
    if (range.start === undefined && range.end === undefined) return undefined;
    const start = range.start ?? 0;
    const end = range.end ?? length;
    if (start >= end || end > length) {
        throw rangeInvalid(operation, bucket, range.start, range.end, length);
    }
    return { start, end };
}

export function sanitizeFilter(filter: GridFSFindFilesFilter | undefined, operation: string): Record<string, unknown> {
    if (filter === undefined) return {};
    if (!isPlainRecord(filter)) throw invalidArgument(operation, 'filter', 'filter must be a plain object');
    return sanitizeRecord(filter, operation) as Record<string, unknown>;
}

function sanitizeRecord(record: Record<string, unknown>, operation: string): Document {
    const out: Document = {};
    for (const key of Object.keys(record)) {
        assertSafeKey(key, operation);
        out[key] = sanitizeValue(record[key], operation);
    }
    return out;
}

function sanitizeValue(value: unknown, operation: string): unknown {
    if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry, operation));
    if (isPlainRecord(value)) return sanitizeRecord(value, operation);
    return value;
}

export function assertFindOptions(options: GridFSFindFilesOptions | undefined): void {
    if (options === undefined) return;
    if (!isPlainRecord(options)) throw invalidArgument('findFiles', 'options', 'options must be a plain object');
    if (options.limit !== undefined) {
        if (typeof options.limit !== 'number' || !Number.isSafeInteger(options.limit) || options.limit <= 0) {
            throw invalidArgument('findFiles', 'limit', 'limit must be a positive integer');
        }
    }
    if (options.skip !== undefined) assertNonNegativeInteger(options.skip, 'findFiles', 'skip');
    if (options.sort !== undefined) {
        if (!isPlainRecord(options.sort)) throw invalidArgument('findFiles', 'sort', 'sort must be a plain object');
        for (const key of Object.keys(options.sort)) {
            assertSafeKey(key, 'findFiles');
            if (options.sort[key] !== 1 && options.sort[key] !== -1) {
                throw invalidArgument('findFiles', 'sort', 'sort values must be 1 or -1');
            }
        }
    }
}
