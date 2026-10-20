import { isRecord, stringifyExtendedJson, type GenericRecord } from './support';

function isPlainRecord(value: unknown): value is GenericRecord {
    if (!isRecord(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

export function cloneDocumentValue(value: unknown): unknown {
    if (value instanceof Date) return new Date(value.getTime());
    if (Buffer.isBuffer(value)) return Buffer.from(value);
    if (Array.isArray(value)) return value.map(cloneDocumentValue);
    if (isPlainRecord(value)) {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneDocumentValue(item)]));
    }
    return value;
}

export function cloneDocument(document: GenericRecord): GenericRecord {
    return cloneDocumentValue(document) as GenericRecord;
}

/**
 * Compare a before-image atomically without query equality's array-element matching.
 * Callers use simple collation so collection defaults cannot weaken the guard.
 */
export function exactDataTaskDocumentFilter(document: GenericRecord): GenericRecord {
    const entries = Object.entries(document);
    const fieldChecks = entries.flatMap(([field, value]) => {
        const actual = { $getField: { field: { $literal: field }, input: '$$ROOT' } };
        return [
            { $ne: [{ $type: actual }, 'missing'] },
            { $eq: [actual, { $literal: value }] },
        ];
    });
    return {
        ...(document._id === undefined ? {} : { _id: document._id }),
        $expr: {
            $and: [
                { $eq: [{ $size: { $objectToArray: '$$ROOT' } }, entries.length] },
                ...fieldChecks,
            ],
        },
    };
}

export class DataTaskFieldPatchError extends Error {}

function documentPath(document: GenericRecord, field: string): { exists: boolean; value?: unknown } {
    const parts = field.split('.');
    let current: unknown = document;
    for (const part of parts) {
        if (!isPlainRecord(current) || !Object.prototype.hasOwnProperty.call(current, part)) return { exists: false };
        current = current[part];
    }
    return { exists: true, value: current };
}

export function setDocumentPath(document: GenericRecord, field: string, value: unknown): void {
    const parts = field.split('.');
    const finalPart = parts.pop();
    if (!finalPart) return;
    let current = document;
    for (const part of parts) {
        if (current[part] === undefined) current[part] = {};
        if (!isPlainRecord(current[part])) {
            throw new DataTaskFieldPatchError(`field path "${field}" crosses a non-object value at "${part}".`);
        }
        current = current[part] as GenericRecord;
    }
    current[finalPart] = cloneDocumentValue(value);
}

export function deleteDocumentPath(document: GenericRecord, field: string): void {
    const parts = field.split('.');
    const finalPart = parts.pop();
    if (!finalPart) return;
    let current = document;
    for (const part of parts) {
        if (!isPlainRecord(current[part])) return;
        current = current[part] as GenericRecord;
    }
    delete current[finalPart];
}

export function applyDataTaskFieldPatch(
    document: GenericRecord,
    rename: Record<string, string>,
    set: GenericRecord,
    unset: string[],
): { document: GenericRecord; unsetPaths: string[] } {
    const patched = cloneDocument(document);
    const unsetPaths = new Set(unset);
    for (const [source, destination] of Object.entries(rename)) {
        const sourceValue = documentPath(patched, source);
        if (!sourceValue.exists) continue;
        const destinationValue = documentPath(patched, destination);
        if (destinationValue.exists && comparableValue(destinationValue.value) !== comparableValue(sourceValue.value)) {
            throw new DataTaskFieldPatchError(`rename destination "${destination}" already contains a different value.`);
        }
        setDocumentPath(patched, destination, sourceValue.value);
        deleteDocumentPath(patched, source);
        unsetPaths.add(source);
    }
    for (const [field, value] of Object.entries(set)) setDocumentPath(patched, field, value);
    for (const field of unset) deleteDocumentPath(patched, field);
    return { document: patched, unsetPaths: [...unsetPaths].sort() };
}

export function deepMergeDocuments(target: GenericRecord, source: GenericRecord): GenericRecord {
    const merged = cloneDocument(target);
    for (const [key, value] of Object.entries(source)) {
        const current = merged[key];
        merged[key] = isPlainRecord(current) && isPlainRecord(value)
            ? deepMergeDocuments(current, value)
            : cloneDocumentValue(value);
    }
    return merged;
}

function comparableValue(value: unknown): string {
    return stringifyExtendedJson(value);
}
