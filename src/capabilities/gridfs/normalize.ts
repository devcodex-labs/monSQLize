import { Binary, ObjectId } from 'mongodb';
import type { GridFSFileInfo } from './types';
import { invalidArgument } from './errors';

export function filesCollectionName(bucketName: string): string {
    return `${bucketName}.files`;
}

export function chunksCollectionName(bucketName: string): string {
    return `${bucketName}.chunks`;
}

export function uploadsCollectionName(bucketName: string): string {
    return `${bucketName}.uploads`;
}

export function toFileInfo(doc: Record<string, unknown>): GridFSFileInfo {
    const info: GridFSFileInfo = {
        id: doc._id as ObjectId,
        filename: typeof doc.filename === 'string' ? doc.filename : '',
        length: typeof doc.length === 'number' ? doc.length : 0,
        chunkSize: typeof doc.chunkSize === 'number' ? doc.chunkSize : 0,
        uploadDate: doc.uploadDate instanceof Date ? doc.uploadDate : new Date(doc.uploadDate as string | number),
    };
    if (doc.metadata !== undefined && doc.metadata !== null && typeof doc.metadata === 'object') {
        info.metadata = doc.metadata as Record<string, unknown>;
    }
    const storedContentType = info.metadata?.contentType;
    if (typeof doc.contentType === 'string') info.contentType = doc.contentType;
    else if (typeof storedContentType === 'string') info.contentType = storedContentType;
    return info;
}

export function binaryToBuffer(value: unknown, operation: string): Buffer {
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Binary) {
        const bytes = value.value();
        return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    if (value instanceof Uint8Array) {
        return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    }
    throw invalidArgument(operation, 'chunk', 'GridFS chunk data is not binary');
}

export function sameBytes(left: Buffer, right: Buffer): boolean {
    return left.length === right.length && left.equals(right);
}
