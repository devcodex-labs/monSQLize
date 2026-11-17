'use strict';

const { createHash } = require('node:crypto');
const { addAbortListener } = require('node:events');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const engineBuildHash = require('./engine-build.cjs');
const manifest = require('./source-manifest.json');

let loadedBinding;

function bindingForHost() {
    if (loadedBinding) return loadedBinding;
    const folder = `${process.platform}-${process.arch}`;
    const prebuild = path.join(__dirname, 'prebuild', folder);
    const build = JSON.parse(readFileSync(path.join(prebuild, 'build.json'), 'utf8'));
    const expectedEngineHash = engineBuildHash(manifest);
    if (build.target !== folder || build.sqlite !== manifest.sqliteSourceId || build.napi !== manifest.napi ||
        build.engineBuildHash !== expectedEngineHash ||
        !isDeepStrictEqual(build.patch, manifest.patch) || !isDeepStrictEqual(build.sqliteDefines, manifest.sqliteDefines) ||
        !isDeepStrictEqual(build.sqliteRuntimeOptions, manifest.sqliteRuntimeOptions) ||
        !(Number(process.versions.napi) >= manifest.napi)) {
        throw new Error('SQLite foundation build does not match its source manifest');
    }
    const bindingPath = path.join(prebuild, 'binding.node');
    const digest = createHash('sha256').update(readFileSync(bindingPath)).digest('hex');
    if (digest !== build.artifacts?.binding) {
        throw new Error('SQLite foundation native asset digest mismatch');
    }
    const native = require(bindingPath);
    if (native.sourceId !== manifest.sqliteSourceId || native.engineBuildHash !== expectedEngineHash ||
        !manifest.sqliteRuntimeOptions.every(option => native.compileOptions?.includes(option))) {
        throw new Error('SQLite foundation build does not match its source manifest');
    }
    loadedBinding = native;
    return loadedBinding;
}

function abortError() {
    const error = new Error('SQLite operation was cancelled before it started');
    error.name = 'AbortError';
    return error;
}

function observeAbort(signal, cancel) {
    if (!signal) return undefined;
    if (typeof addAbortListener === 'function' && typeof Symbol.dispose === 'symbol') {
        const listener = addAbortListener(signal, cancel);
        return () => listener[Symbol.dispose]();
    }
    // Early Node 18 releases do not offer listeners immune to stopped propagation.
    const polling = setInterval(() => {
        if (signal.aborted) {
            clearInterval(polling);
            cancel();
        }
    }, 5);
    polling.unref();
    return () => clearInterval(polling);
}

/** B01 foundation operations. The public adapter and the complete raw contract are subsequent work. */
async function openFoundation({ filename, memory = false, readonly = false, create = !readonly, busyTimeoutMS = 0 } = {}) {
    const file = typeof filename === 'string' && filename.length > 0 && filename !== ':memory:';
    if (typeof memory !== 'boolean' || typeof readonly !== 'boolean' || typeof create !== 'boolean' ||
        (typeof filename !== 'undefined' && !file) || file === memory || (readonly && (create || memory)) ||
        !Number.isInteger(busyTimeoutMS) || busyTimeoutMS < 0 || busyTimeoutMS > 0x7fffffff) {
        throw new TypeError('invalid SQLite foundation open options');
    }
    const flags = readonly ? 1 : (create ? 2 | 4 : 2);
    const native = bindingForHost();
    const handle = await native.open(memory ? ':memory:' : filename, flags, busyTimeoutMS);
    let tail = Promise.resolve();
    let closing;
    let closed = false;
    let lastToken = 0n;

    function enqueue(operation) {
        const result = tail.then(operation);
        tail = result.catch(() => {});
        return result;
    }

    function admit(operation) {
        if (closing) return Promise.reject(new Error('SQLite connection is closing or closed'));
        return enqueue(operation);
    }

    return Object.freeze({
        get closed() { return closed; },
        execute(text, bindings = [], { signal } = {}) {
            if (typeof text !== 'string' || !Array.isArray(bindings) ||
                (signal !== undefined && !(signal instanceof globalThis.AbortSignal))) {
                return Promise.reject(new TypeError('invalid SQLite foundation execution arguments'));
            }
            // Admission snapshots mutable buffers before they can wait behind another request.
            const parameters = bindings.map(value => Buffer.isBuffer(value) ? Buffer.from(value) : value);
            return admit(async () => {
                if (signal?.aborted) throw abortError();
                const token = ++lastToken;
                const cancel = () => {
                    if (signal.aborted) native.interrupt(handle, token);
                };
                const dispose = observeAbort(signal, cancel);
                try {
                    return await native.execute(handle, text, parameters, token);
                } finally {
                    dispose?.();
                }
            });
        },
        commitBefore(deadlineEpochMilliseconds) {
            if (typeof deadlineEpochMilliseconds !== 'bigint' || deadlineEpochMilliseconds <= 0n ||
                deadlineEpochMilliseconds > 9223372036854775807n) {
                return Promise.reject(new TypeError('invalid SQLite commit deadline'));
            }
            return admit(() => native.commitBefore(handle, deadlineEpochMilliseconds));
        },
        loadFixtureExtension(filename) {
            if (typeof filename !== 'string' || !path.isAbsolute(filename)) {
                return Promise.reject(new TypeError('SQLite foundation extension must use an absolute path'));
            }
            return admit(() => native.loadExtension(handle, filename));
        },
        close() {
            closing ??= enqueue(async () => {
                try {
                    await native.close(handle);
                    closed = true;
                } catch (error) {
                    closing = undefined;
                    throw error;
                }
            });
            return closing;
        },
    });
}

module.exports = { openFoundation };
