import { types as utilTypes } from 'node:util';

// Match the pinned driver's nullish inheritance without touching live resources.
const defaults: Record<string, unknown> = {
    raw: false, useBigInt64: false, promoteLongs: true, promoteValues: true, promoteBuffers: false,
    ignoreUndefined: false, bsonRegExp: false, serializeFunctions: false, enableUtf8Validation: true,
};
const prototypeGetter = Object.getOwnPropertyDescriptor(Object.prototype, '__proto__')?.get;

function captureFields(value: Record<string, unknown>): Record<string, boolean> | null {
    const entries = new Map<string, boolean>();
    for (let level = value; level; level = Object.getPrototypeOf(level)) {
        if (utilTypes.isProxy(level)) return null;
        for (const key of Object.getOwnPropertyNames(level)) {
            if (entries.has(key)) continue;
            const descriptor = Object.getOwnPropertyDescriptor(level, key)!;
            if ('value' in descriptor) entries.set(key, Boolean(descriptor.value));
            else if (key === '__proto__' && descriptor.get === prototypeGetter) {
                entries.set(key, Boolean(Object.getPrototypeOf(value)));
            } else return null;
        }
    }
    return Object.assign(Object.create(null), Object.fromEntries(entries));
}
const standardFields = captureFields({})!;

/** Freeze BSON data options once; dynamic decoding maps retain native lazy access. */
export function captureBsonOptions(options: Record<string, unknown> = {}, inherited: object = {}): Record<string, unknown> {
    const captured = { ...options };
    const parent = inherited as Record<string, unknown>;
    for (const [key, value] of Object.entries(defaults)) captured[key] = captured[key] ?? parent[key] ?? value;
    const fields = (captured.fieldsAsRaw ?? parent.fieldsAsRaw ?? {}) as Record<string, unknown>;
    captured.fieldsAsRaw = captureFields(fields) ?? fields;
    return captured;
}

/** Effective flags, rather than only caller overrides, identify a shared cache entry. */
export function bsonKeyOptions(options: Record<string, unknown> = {}, inherited: object = {}, count = false): Record<string, unknown> {
    const captured = captureBsonOptions(options, inherited), key: Record<string, unknown> = {};
    for (const name of Object.keys(defaults)) key[name] = captured[name];
    if (!count) key.fieldsAsRaw = captureFields(captured.fieldsAsRaw as Record<string, unknown>) ?? 'dynamic';
    return key;
}

/** JSON-backed caches cannot preserve nonstandard BSON decoding result types. */
export function canCacheBsonResult(options: Record<string, unknown>, strict = false): boolean {
    for (const [key, value] of Object.entries(defaults)) {
        if (!strict && ['ignoreUndefined', 'serializeFunctions', 'enableUtf8Validation'].includes(key)) continue;
        if (options[key] !== value) return false;
    }
    const fields = captureFields(options.fieldsAsRaw as Record<string, unknown>);
    return fields !== null && [...new Set([...Object.keys(fields), ...Object.keys(standardFields)])]
        .every(key => Boolean(fields[key]) === Boolean(standardFields[key]));
}

/** Bookmark identity must not evaluate caller accessors or dynamic Proxy traps. */
export function hasStableBsonFields(options: Record<string, unknown>): boolean {
    return captureFields(options.fieldsAsRaw as Record<string, unknown>) !== null;
}

export function canCacheBsonCount(options: Record<string, unknown>): boolean {
    return canCacheBsonResult({ ...options, fieldsAsRaw: standardFields });
}
