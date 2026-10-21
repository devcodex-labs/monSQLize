/**
 * schema-dsl runtime integration.
 *
 * monSQLize owns or receives one schema-dsl runtime per MonSQLizeRuntime instance.
 * Model definitions stay registry-only; actual schema compilation and validation
 * happen when a ModelInstance is bound to a runtime.
 */
import { createRequire } from 'node:module';
import type { SchemaDslRuntime, SchemaDslRuntimeOptions } from 'schema-dsl/runtime';
import { ErrorCodes, createError, type MonSQLizeError } from '../../core/errors';
import { isClosureSensitiveFunctionSource } from './schema-dsl-function-source';

type SchemaDslInvoker = (definition: unknown, ...args: unknown[]) => unknown;

export type SchemaDslFn = SchemaDslRuntime['s'];
type SchemaDslCallable = SchemaDslFn | ((definition: unknown, ...args: unknown[]) => unknown);
export type SchemaValidateFn = (
    schema: unknown,
    data: unknown,
) => { valid: boolean; data?: unknown; errors?: Array<{ path?: string; message?: string; keyword?: string }> };

export type SchemaDslRuntimeLike = Partial<Omit<Pick<
    SchemaDslRuntime,
    'dsl' | 's' | 'validate' | 'dispose' | 'registerExtensions'
>, 'dsl' | 's'>> & {
    dsl?: SchemaDslCallable;
    s?: SchemaDslCallable;
};

export type SchemaDslRuntimeConfig = false | {
    enabled?: boolean;
    runtime?: SchemaDslRuntimeLike;
    options?: SchemaDslRuntimeOptions;
    extensions?: readonly unknown[];
};

export type SchemaDslEngine = {
    enabled: boolean;
    owned: boolean;
    runtime: SchemaDslRuntimeLike | null;
    dsl: SchemaDslCallable | null;
    validate: SchemaValidateFn | null;
    dispose(): void;
};

type SchemaDslRuntimeModule = {
    createRuntime?: (options?: SchemaDslRuntimeOptions) => SchemaDslRuntimeLike;
    createSchemaDslRuntime?: (options?: SchemaDslRuntimeOptions) => SchemaDslRuntimeLike;
};

const externalRuntimeExtensionRegistrations = new WeakMap<object, Set<string>>();
const extensionObjectKeys = new WeakMap<object, string>();
const patchedExternalRuntimeLifecycles = new WeakSet<object>();
let extensionObjectKeyCounter = 0;

declare const MONSQLIZE_IMPORT_META_URL: string | undefined;

const schemaDslRuntimeRequire = createRequire(
    typeof MONSQLIZE_IMPORT_META_URL === 'string' ? MONSQLIZE_IMPORT_META_URL : __filename,
);

function createDisabledSchemaDslEngine(): SchemaDslEngine {
    return {
        enabled: false,
        owned: false,
        runtime: null,
        dsl: null,
        validate: null,
        dispose() { },
    };
}

function getExtensionObjectKey(value: object): string {
    let key = extensionObjectKeys.get(value);
    if (!key) {
        extensionObjectKeyCounter += 1;
        key = `ref:${extensionObjectKeyCounter}`;
        extensionObjectKeys.set(value, key);
    }
    return key;
}

function normalizeExtensionFunction(value: Function): string {
    try {
        const source = Function.prototype.toString.call(value);
        if (isClosureSensitiveFunctionSource(source)) {
            return JSON.stringify({
                name: value.name,
                length: value.length,
                source,
                ref: getExtensionObjectKey(value),
                closureSensitive: true,
            });
        }
        return JSON.stringify({
            name: value.name,
            length: value.length,
            source,
        });
    } catch {
        return getExtensionObjectKey(value);
    }
}

function normalizeExtensionValue(value: unknown, stack: WeakSet<object>): string {
    if (value === null) {
        return 'null';
    }
    switch (typeof value) {
        case 'string':
            return `string:${JSON.stringify(value)}`;
        case 'number':
            if (Number.isNaN(value)) {
                return 'number:NaN';
            }
            return `number:${Object.is(value, -0) ? '-0' : String(value)}`;
        case 'boolean':
        case 'bigint':
        case 'undefined':
            return `${typeof value}:${String(value)}`;
        case 'symbol':
            return `symbol:${String(value.description)}`;
        case 'function':
            return `function:${normalizeExtensionFunction(value)}`;
        case 'object':
            break;
        default:
            return `${typeof value}:${String(value)}`;
    }

    if (value instanceof Date) {
        return `date:${Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString()}`;
    }
    if (value instanceof RegExp) {
        return `regexp:${value.source}/${value.flags}`;
    }

    const objectValue = value as object;
    if (stack.has(objectValue)) {
        return `circular:${getExtensionObjectKey(objectValue)}`;
    }

    const prototype = Object.getPrototypeOf(objectValue);
    const isPlainObject = prototype === Object.prototype || prototype === null;
    if (!Array.isArray(objectValue) && !isPlainObject) {
        return `object:${prototype?.constructor?.name ?? 'unknown'}:${getExtensionObjectKey(objectValue)}`;
    }

    stack.add(objectValue);
    try {
        if (Array.isArray(objectValue)) {
            return `array:[${objectValue.map((item) => normalizeExtensionValue(item, stack)).join(',')}]`;
        }
        const entries = Object.keys(objectValue as Record<string, unknown>)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${normalizeExtensionValue((objectValue as Record<string, unknown>)[key], stack)}`);
        return `object:{${entries.join(',')}}`;
    } finally {
        stack.delete(objectValue);
    }
}

function createExtensionRegistrationKeys(extensions: readonly unknown[]): string[] {
    const stack = new WeakSet<object>();
    return extensions.map((extension) => normalizeExtensionValue(extension, stack));
}

function patchExternalRuntimeLifecycle(runtime: SchemaDslRuntimeLike): void {
    if (patchedExternalRuntimeLifecycles.has(runtime)) {
        return;
    }
    patchedExternalRuntimeLifecycles.add(runtime);

    const mutableRuntime = runtime as SchemaDslRuntimeLike & {
        configure?: (...args: unknown[]) => unknown;
        dispose?: (...args: unknown[]) => unknown;
    };
    const originalConfigure = mutableRuntime.configure;
    if (typeof originalConfigure === 'function') {
        try {
            mutableRuntime.configure = function patchedConfigure(this: unknown, ...args: unknown[]): unknown {
                const control = args[1] as { mode?: unknown } | undefined;
                const mode = control && typeof control === 'object' ? control.mode : undefined;
                try {
                    return originalConfigure.apply(this, args);
                } finally {
                    if (mode === 'reset' || mode === 'replace') {
                        externalRuntimeExtensionRegistrations.delete(runtime);
                    }
                }
            };
        } catch {
            // Some runtime-like objects may expose non-writable lifecycle methods.
        }
    }

    const originalDispose = mutableRuntime.dispose;
    if (typeof originalDispose === 'function') {
        try {
            mutableRuntime.dispose = function patchedDispose(this: unknown, ...args: unknown[]): unknown {
                try {
                    return originalDispose.apply(this, args);
                } finally {
                    externalRuntimeExtensionRegistrations.delete(runtime);
                }
            };
        } catch {
            // Some runtime-like objects may expose non-writable lifecycle methods.
        }
    }
}

function resolveRuntime(config: SchemaDslRuntimeConfig | null | undefined): { runtime: SchemaDslRuntimeLike; owned: boolean } | null {
    if (config === false || config?.enabled === false) {
        return null;
    }
    if (config?.runtime) {
        return { runtime: config.runtime, owned: false };
    }
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = schemaDslRuntimeRequire('schema-dsl/runtime') as SchemaDslRuntimeModule;
        const createRuntime = mod.createRuntime ?? mod.createSchemaDslRuntime;
        if (!createRuntime) {
            throw createSchemaDslRuntimeError('schema-dsl/runtime did not export createRuntime or createSchemaDslRuntime.');
        }
        return { runtime: createRuntime(config?.options), owned: true };
    } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === ErrorCodes.INVALID_CONFIG) {
            throw error;
        }
        throw createSchemaDslRuntimeError('Failed to load schema-dsl/runtime for Model schema validation.', error);
    }
}

function resolveDsl(runtime: SchemaDslRuntimeLike): SchemaDslCallable | null {
    return runtime.s ?? runtime.dsl ?? null;
}

function resolveValidate(runtime: SchemaDslRuntimeLike): SchemaValidateFn | null {
    if (typeof runtime.validate !== 'function') {
        return null;
    }
    const validate = runtime.validate.bind(runtime) as unknown as SchemaValidateFn;
    return (schema, data) => validate(schema, data);
}

function registerRuntimeExtensions(runtime: SchemaDslRuntimeLike, extensions: readonly unknown[] | undefined, owned: boolean): void {
    if (!extensions || extensions.length === 0 || typeof runtime.registerExtensions !== 'function') {
        return;
    }
    if (!owned) {
        // External runtimes survive failed connects, close/reconnect, and multi-instance reuse.
        // Register one by one because schema-dsl's batch API is not transactionally atomic.
        // Successful prefixes must be remembered even if a later extension still fails.
        patchExternalRuntimeLifecycle(runtime);
        const registrationKeys = createExtensionRegistrationKeys(extensions);
        let registeredKeys = externalRuntimeExtensionRegistrations.get(runtime);
        if (!registeredKeys) {
            registeredKeys = new Set<string>();
            externalRuntimeExtensionRegistrations.set(runtime, registeredKeys);
        }
        for (const [index, extension] of extensions.entries()) {
            const key = registrationKeys[index];
            if (!key || registeredKeys.has(key)) {
                continue;
            }
            runtime.registerExtensions([extension] as unknown as readonly [unknown, ...unknown[]]);
            registeredKeys.add(key);
        }
        return;
    }
    runtime.registerExtensions(extensions as readonly [unknown, ...unknown[]]);
}

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}

function createSchemaDslRuntimeError(message: string, cause?: unknown): MonSQLizeError {
    return createError(
        ErrorCodes.INVALID_CONFIG,
        `${message} Check the bundled schema-dsl dependency installation, package-manager pruning, and runtime module resolution. Set schemaDsl: false only when Model schema validation is intentionally disabled.`,
        undefined,
        cause === undefined ? undefined : toError(cause),
    );
}

export function createSchemaDslEngine(config?: SchemaDslRuntimeConfig | null): SchemaDslEngine {
    const resolved = resolveRuntime(config);
    if (!resolved) {
        return createDisabledSchemaDslEngine();
    }

    const extensions = config === false ? undefined : config?.extensions;
    try {
        registerRuntimeExtensions(resolved.runtime, extensions, resolved.owned);
    } catch (err) {
        if (resolved.owned) {
            try {
                resolved.runtime.dispose?.();
            } catch {
                // Preserve the original registration failure; cleanup is best effort here.
            }
        }
        throw err;
    }
    const dsl = resolveDsl(resolved.runtime);
    const validate = resolveValidate(resolved.runtime);
    if (!dsl || !validate) {
        if (resolved.owned) {
            resolved.runtime.dispose?.();
        }
        throw createSchemaDslRuntimeError('schema-dsl/runtime did not provide the required s/dsl and validate APIs.');
    }

    let disposed = false;
    return {
        enabled: true,
        owned: resolved.owned,
        runtime: resolved.runtime,
        dsl,
        validate,
        dispose() {
            if (disposed) {
                return;
            }
            disposed = true;
            if (resolved.owned) {
                resolved.runtime.dispose?.();
            }
        },
    };
}

/**
 * Wrap the schema-dsl dsl() function while keeping schema-dsl as the single DSL authority.
 *
 * Behavior:
 * - monsqlize no longer keeps a duplicate schema-dsl type allowlist.
 * - Unknown types, custom types, aliases, and fallback behavior are delegated to schema-dsl.
 * - A future schema-dsl diagnostics API can be consumed here without parsing DSL strings in monsqlize.
 */
export function _makeValidatingDslFn(realDsl: SchemaDslCallable): SchemaDslFn {
    const validating = function validatingDsl(fields: unknown, ...args: unknown[]): unknown {
        return (realDsl as unknown as SchemaDslInvoker)(fields, ...args);
    };
    return new Proxy(validating as SchemaDslFn, {
        get(target, property, receiver) {
            if (Reflect.has(target, property)) {
                return Reflect.get(target, property, receiver);
            }
            const value = Reflect.get(realDsl as object, property);
            return typeof value === 'function' ? value.bind(realDsl) : value;
        },
    });
}
