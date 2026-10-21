import { BSON } from 'mongodb';
import { types as utilTypes } from 'node:util';

/**
 * Captures pipeline structure before policy checks or asynchronous execution.
 * Materializes document serialization before policy checks; BSON leaves retain their types.
 */
export function snapshotPipelineValue<T>(value: T, seen = new WeakMap<object, unknown>()): T {
    return capture(value, seen, Array.isArray(value) ? 0 : 2);
}

function capture<T>(value: T, seen: WeakMap<object, unknown>, conversions: number): T {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
    if (seen.has(value)) return seen.get(value) as T;
    const original = value;
    // BSON invokes a value converter and, for a document result, its document converter.
    // Capture that result now so execution cannot run a different converter after validation.
    for (let count = 0; count < conversions; count += 1) {
        if (count > 0 && (typeof value === 'function' || isNativeLeaf(value) || Array.isArray(value) || utilTypes.isMap(value))) break;
        const converter = (value as { toBSON?: unknown }).toBSON;
        if (typeof converter !== 'function') break;
        value = converter.call(value) as T;
        if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
    }
    if (seen.has(value)) return seen.get(value) as T;
    if (typeof value === 'function' || isNativeLeaf(value)) {
        const copy = copyNativeLeaf(value);
        seen.set(original, copy);
        seen.set(value, copy);
        return copy;
    }
    const copy = Array.isArray(value) ? new Array(value.length)
        : Object.create(Object.getPrototypeOf(value) === null ? null : Object.prototype);
    seen.set(original, copy);
    seen.set(value, copy);
    if (utilTypes.isMap(value)) {
        const keys: string[] = [];
        for (const [key, entry] of value) {
            if (typeof key !== 'string') throw new TypeError('Pipeline document Map keys must be strings.');
            keys.push(key);
            Object.defineProperty(copy, key, {
                value: capture(entry, seen, 2), enumerable: true, configurable: true, writable: true,
            });
        }
        const ordered = preserveKeyOrder(copy, keys);
        seen.set(original, ordered); seen.set(value, ordered);
        return ordered as T;
    }
    for (const key of Reflect.ownKeys(value)) {
        if (Array.isArray(value) && key === 'length') continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        const entry = (value as Record<PropertyKey, unknown>)[key];
        if (key === 'toBSON' && typeof entry === 'function') continue;
        Object.defineProperty(copy, key, {
            value: capture(entry, seen, 2),
            enumerable: descriptor.enumerable,
            configurable: true,
            writable: true,
        });
    }
    const ordered = Array.isArray(value) ? copy : preserveKeyOrder(copy, Reflect.ownKeys(value));
    seen.set(original, ordered); seen.set(value, ordered);
    return ordered as T;
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

function copyNativeLeaf<T extends object>(value: T): T {
    // Do not retain caller-owned converters on a leaf after capturing its native value.
    if (utilTypes.isDate(value)) return new Date(value.getTime()) as T;
    if (utilTypes.isRegExp(value)) return new RegExp(value.source, value.flags) as T;
    if (Buffer.isBuffer(value)) return Buffer.from(value) as T;
    if (utilTypes.isUint8Array(value)) return new Uint8Array(value) as T;
    const stable = new Proxy(value, {
        get(target, key) {
            if (key === 'toBSON') return undefined;
            const entry = Reflect.get(target, key, target) as unknown;
            return typeof entry === 'function' ? entry.bind(target) : entry;
        },
    });
    if (typeof value === 'function') return stable;
    return BSON.deserialize(BSON.serialize({ value: stable }), {
        promoteValues: false, promoteLongs: false, bsonRegExp: true,
    }).value as T;
}
