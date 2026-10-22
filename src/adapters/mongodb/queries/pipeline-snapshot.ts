import { BSON } from 'mongodb';
import { types as utilTypes } from 'node:util';

/**
 * Captures pipeline structure before policy checks or asynchronous execution.
 * Materializes document serialization before policy checks; BSON leaves retain their types.
 */
export function snapshotPipelineValue<T>(value: T, seen = new WeakMap<object, unknown>(), serializeFunctions = false): T {
    return capture(value, seen, Array.isArray(value) ? 0 : 2, serializeFunctions);
}

function capture<T>(value: T, seen: WeakMap<object, unknown>, conversions: number, serializeFunctions: boolean): T {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
    if (seen.has(value)) throw new BSON.BSONError('Cannot convert circular structure to BSON');
    const original = value;
    // A value converter precedes native type dispatch. An ordinary document then
    // enters its own converter without dispatching the returned type again.
    if (conversions > 0) {
        if (typeof (value as { toBSON?: unknown }).toBSON === 'function') value = (value as unknown as { toBSON(): T }).toBSON();
        if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
    }
    if (seen.has(value)) throw new BSON.BSONError('Cannot convert circular structure to BSON');
    // Track ancestors, not aliases: BSON evaluates each function occurrence separately.
    seen.set(original, true); seen.set(value, true);
    try {
        if (typeof value === 'object' && (value as { _bsontype?: unknown })._bsontype === 'Code') {
            const code = value as unknown as BSON.Code, scope = code.scope, source = code.code;
            const scoped = scope !== null && typeof scope === 'object';
            // Let BSON preserve scoped/nonscoped source coercion without consuming scope early.
            const shell = new Proxy(code, { get(target, key) {
                if (key === 'scope') return scoped ? {} : null;
                if (key === 'code') return source;
                if (key === 'toBSON') return undefined;
                return Reflect.get(target, key, target);
            } });
            const copy = copyNativeLeaf(shell, serializeFunctions);
            if (scoped) copy.scope = captureDocument(scope, seen, serializeFunctions, true);
            return copy as T;
        }
        if (typeof value === 'object' && (value as { _bsontype?: unknown })._bsontype === 'DBRef') {
            const ref = value as unknown as BSON.DBRef & { namespace: string };
            const merged: Record<string, unknown> = { $ref: ref.collection || ref.namespace, $id: ref.oid };
            if (ref.db != null) merged.$db = ref.db;
            Object.assign(merged, ref.fields);
            const document = captureDocument(merged, seen, serializeFunctions, true, true, false);
            // DBRef enters a document directly with ignoreUndefined=true. Keep that
            // boundary instead of decoding through a constructor that can rewrite $ref.
            return new BSON.DBRef('', undefined as never, undefined, { toBSON: () => document }) as T;
        }
        if (typeof value === 'function' || isNativeLeaf(value)) return copyNativeLeaf(value, serializeFunctions);
        return captureDocument(value, seen, serializeFunctions, true, false) as T;
    } finally { seen.delete(original); seen.delete(value); }
}

/** Code.scope enters serializeInto directly, before value-position conversion/dispatch. */
function captureDocument(value: unknown, seen: WeakMap<object, unknown>, serializeFunctions: boolean, root: boolean, track = root, protectMarker = true): Record<string, unknown> {
    const original = value as object, array = Array.isArray(value), map = utilTypes.isMap(value);
    if (track && seen.has(original)) throw new BSON.BSONError('Cannot convert circular structure to BSON');
    if (track) seen.set(original, true);
    try {
        if (root && !array && !map && typeof (value as { toBSON?: unknown }).toBSON === 'function') {
            value = (value as { toBSON(): unknown }).toBSON();
            if (value != null && typeof value !== 'object') throw new BSON.BSONError('toBSON function did not return an object');
        }
        const copy = array ? [] : Object.create(Object.getPrototypeOf(value) === null ? null : Object.prototype);
        const entries: Iterable<[string, unknown]> = map ? (value as Map<string, unknown>).entries()
            : (function* () {
                if (array) {
                    for (let index = 0; index < (value as unknown[]).length; index++) yield [String(index), (value as unknown[])[index]] as [string, unknown];
                } else for (const key of Object.keys(value as object)) yield [key, (value as Record<string, unknown>)[key]] as [string, unknown];
            })();
        const keys: string[] = [];
        for (const [key, entry] of entries) {
            if (typeof key !== 'string') throw new TypeError('Pipeline document Map keys must be strings.');
            if (key === 'toBSON' && typeof entry === 'function' && !serializeFunctions) continue;
            keys.push(key);
            Object.defineProperty(copy, key, { value: capture(entry, seen, 2, serializeFunctions),
                enumerable: true, configurable: true, writable: true });
        }
        if (!array && !map && !track) {
            // Non-BSON metadata is retained without evaluating ignored getters/converters.
            for (const key of Reflect.ownKeys(value as object)) {
                const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
                if (key !== 'toBSON' && (typeof key === 'symbol' || !descriptor.enumerable)) Object.defineProperty(copy, key, descriptor);
            }
        }
        // A document-position BSON marker is data, not a new leaf dispatch.
        if (protectMarker && !array && Object.prototype.hasOwnProperty.call(copy, '_bsontype')) return new Map(keys.map(key => [key, (copy as Record<string, unknown>)[key]])) as unknown as Record<string, unknown>;
        return (array ? copy : preserveKeyOrder(copy, keys)) as Record<string, unknown>;
    } finally { if (track) seen.delete(original); }
}

/** A native Map can serialize integer-like field names in insertion order. */
function preserveKeyOrder(copy: object, keys: Array<string | symbol>): object {
    const current = Reflect.ownKeys(copy);
    const expected = keys.filter((key) => Object.prototype.hasOwnProperty.call(copy, key));
    if (current.every((key, index) => key === expected[index])) return copy;
    return new Proxy(copy, { ownKeys: (target) => [
        ...expected.filter((key) => Object.prototype.hasOwnProperty.call(target, key)),
        ...Reflect.ownKeys(target).filter((key) => !expected.includes(key)),
    ] });
}

function isNativeLeaf(value: unknown): boolean {
    return utilTypes.isDate(value) || utilTypes.isRegExp(value) || utilTypes.isUint8Array(value)
        || (value != null && (value as { _bsontype?: unknown })._bsontype != null);
}

function copyNativeLeaf<T extends object>(value: T, serializeFunctions: boolean): T {
    // Do not retain caller-owned converters on a leaf after capturing its native value.
    if (utilTypes.isDate(value)) return new Date(value.getTime()) as T;
    if (utilTypes.isRegExp(value)) return new RegExp(value.source, value.flags) as T;
    if (Buffer.isBuffer(value)) return Buffer.from(value) as T;
    if (utilTypes.isUint8Array(value)) return new Uint8Array(value) as T;
    const stable = new Proxy(value, {
        get(target, key) {
            if (key === 'toBSON') return undefined;
            const entry = Reflect.get(target, key, target) as unknown;
            return typeof entry === 'function' && key !== 'code' ? entry.bind(target) : entry;
        },
    });
    if (typeof value === 'function' && !serializeFunctions) return stable;
    return BSON.deserialize(BSON.serialize({ value: stable }, { serializeFunctions }), {
        promoteValues: false, promoteLongs: false, bsonRegExp: true,
    }).value as T;
}
