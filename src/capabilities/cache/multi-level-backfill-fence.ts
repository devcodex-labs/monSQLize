/** Internal coordination for anonymous L2-to-L1 backfills. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { CacheLike, CacheSetOptions } from 'cache-hub';
import { createError, ErrorCodes } from '../../core/errors';
import { createCacheFacade } from './cache-facade';

interface SharedState {
    generation: number;
    requiresFence: boolean;
    invalidating: number;
    dirty: boolean;
    pending: Set<Promise<void>>;
    tail: Promise<void>;
}

interface Owner {
    generation: number;
    paused: number;
    cleanupFailed: boolean;
    destroyed: boolean;
    pending: Set<Promise<void>>;
    invalidations: Set<Promise<unknown>>;
    cleanupPromise: Promise<void> | null;
}

interface ReadTicket {
    state: SharedState;
    generation: number;
    owner: Owner;
    ownerGeneration: number;
    eligible: boolean;
}

interface ActiveOperation {
    state: SharedState;
    owner: Owner;
    active: boolean;
    parent?: ActiveOperation;
}

export interface BackfillFence {
    local: CacheLike;
    read<T>(operation: () => Promise<T>): Promise<T>;
    write<T>(operation: () => Promise<T>): Promise<T>;
    mutate<T>(operation: () => Promise<T>, clearsLocal?: boolean): Promise<T>;
    invalidate(operation: () => Promise<void>): Promise<void>;
    cleanup(operation: () => Promise<void>): Promise<void>;
    revoke(): void;
}

interface Registry {
    version: 1;
    states: WeakMap<object, SharedState>;
    fences: WeakMap<object, BackfillFence>;
    reads: AsyncLocalStorage<ReadTicket | undefined>;
    operations: AsyncLocalStorage<ActiveOperation | undefined>;
}

// CJS and ESM wrappers sharing one physical L1 must also share tickets and reentry state.
const registryKey = Symbol.for('monsqlize.internal.multi-level-backfill-fence.v1');
const host = globalThis as unknown as Record<symbol, Registry | undefined>;
const registry = host[registryKey] ??= {
    version: 1,
    states: new WeakMap(),
    fences: new WeakMap(),
    reads: new AsyncLocalStorage<ReadTicket | undefined>(),
    operations: new AsyncLocalStorage<ActiveOperation | undefined>(),
};
if (registry.version !== 1) {
    throw createError(ErrorCodes.INVALID_CONFIG, 'Incompatible internal cache backfill registry.');
}

function getState(local: CacheLike): SharedState {
    let state = registry.states.get(local);
    if (!state) {
        state = {
            generation: 0, requiresFence: false, invalidating: 0, dirty: false,
            pending: new Set(), tail: Promise.resolve(),
        };
        registry.states.set(local, state);
    }
    return state;
}

/** Marks only a live dispatch; detached descendants become eligible again after it settles. */
function runActive<T>(state: SharedState, owner: Owner, operation: () => Promise<T>): Promise<T> {
    const active = { state, owner, active: true, parent: registry.operations.getStore() };
    return Promise.resolve().then(() => registry.operations.run(active, operation))
        .finally(() => { active.active = false; });
}

function rejectReentry(state: SharedState): void {
    for (let active = registry.operations.getStore(); active; active = active.parent) {
        if (active.active && active.state === state) {
            throw createError(ErrorCodes.INVALID_OPERATION, 'Cannot await cache cleanup or invalidation from its own active cache operation.');
        }
    }
}

function throwErrors(errors: unknown[], message: string): void {
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, message);
}

/** Creates one wrapper owner while coordinating all wrappers of the original L1 adapter. */
export function createBackfillFence(local: CacheLike, canBackfill: boolean): BackfillFence {
    const state = getState(local);
    // Anonymous entries can outlive their producer, so retain the shared requirement.
    state.requiresFence ||= canBackfill;
    const owner: Owner = {
        generation: 0, paused: 0, cleanupFailed: false, destroyed: false,
        pending: new Set(), invalidations: new Set(), cleanupPromise: null,
    };
    const bypassLocal = () => state.dirty || owner.paused > 0 || owner.cleanupFailed || owner.destroyed;
    const valid = (ticket: ReadTicket) => ticket.eligible
        && ticket.generation === state.generation
        && ticket.ownerGeneration === ticket.owner.generation
        && !state.invalidating && !state.dirty
        && !ticket.owner.paused && !ticket.owner.cleanupFailed && !ticket.owner.destroyed;

    const guardedLocal = createCacheFacade(local, {
        get(target, property) {
            if (property === 'get') return (key: string) => bypassLocal() ? undefined : target.get(key);
            if (property === 'getMany') return (keys: string[]) => bypassLocal() ? {} : target.getMany(keys);
            if (property === 'exists') return (key: string) => bypassLocal() ? false : target.exists(key);
            if (property === 'has') return (key: string) => bypassLocal() ? false : target.has(key);
            if (property === 'set') {
                return (key: string, value: unknown, ttl?: number, options?: CacheSetOptions) => {
                    const ticket = registry.reads.getStore();
                    if (!ticket || ticket.state !== state) return target.set(key, value, ttl, options);
                    if (!valid(ticket)) return undefined;
                    // Register before dispatch so invalidation cannot miss an asynchronous setter.
                    const task = Promise.resolve().then(async () => {
                        if (!valid(ticket)) return;
                        await runActive(state, ticket.owner, async () => {
                            if (valid(ticket)) await target.set(key, value, ttl, options);
                        });
                    });
                    state.pending.add(task);
                    ticket.owner.pending.add(task);
                    return task.finally(() => {
                        state.pending.delete(task);
                        ticket.owner.pending.delete(task);
                    });
                };
            }
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });

    return {
        local: guardedLocal,
        read<T>(operation: () => Promise<T>): Promise<T> {
            if (!state.requiresFence) return operation();
            const ticket: ReadTicket = {
                state, generation: state.generation, owner, ownerGeneration: owner.generation,
                eligible: canBackfill && !state.invalidating && !bypassLocal(),
            };
            return registry.reads.run(ticket, operation);
        },
        write<T>(operation: () => Promise<T>): Promise<T> {
            return registry.reads.run(undefined, operation);
        },
        mutate<T>(operation: () => Promise<T>, clearsLocal = false): Promise<T> {
            if (!state.requiresFence) return operation();
            try { rejectReentry(state); } catch (error) { return Promise.reject(error); }
            state.generation += 1;
            state.invalidating += 1;
            const task = Promise.resolve().then(async () => {
                await Promise.allSettled([...state.pending]);
                return runActive(state, owner, async () => {
                    try {
                        const value = await operation();
                        if (clearsLocal) state.dirty = false;
                        return value;
                    } catch (error) {
                        if (clearsLocal) state.dirty = true;
                        throw error;
                    }
                });
            });
            const result = task.finally(() => {
                state.invalidating -= 1;
                owner.invalidations.delete(result);
            });
            owner.invalidations.add(result);
            return result;
        },
        invalidate(operation: () => Promise<void>): Promise<void> {
            if (!state.requiresFence) return operation();
            try { rejectReentry(state); } catch (error) { return Promise.reject(error); }
            state.generation += 1;
            state.invalidating += 1;
            const task = state.tail.then(async () => {
                await Promise.allSettled([...state.pending]);
                await runActive(state, owner, async () => {
                    const errors: unknown[] = [];
                    try { await operation(); } catch (error) { errors.push(error); }
                    try {
                        await local.clear();
                        state.dirty = false;
                    } catch (error) {
                        state.dirty = true;
                        errors.push(error);
                    }
                    throwErrors(errors, 'Cache tag invalidation and local cleanup failed.');
                });
            });
            const result = task.finally(() => {
                state.invalidating -= 1;
                owner.invalidations.delete(result);
            });
            owner.invalidations.add(result);
            state.tail = result.then(() => undefined, () => undefined);
            return result;
        },
        cleanup(operation: () => Promise<void>): Promise<void> {
            try { rejectReentry(state); } catch (error) { return Promise.reject(error); }
            if (owner.cleanupPromise) return owner.cleanupPromise;
            owner.paused += 1;
            owner.generation += 1;
            const task = Promise.resolve().then(async () => {
                await Promise.allSettled([...owner.pending, ...owner.invalidations]);
                await runActive(state, owner, operation);
                owner.cleanupFailed = false;
            }).catch((error: unknown) => {
                owner.cleanupFailed = true;
                throw error;
            });
            const result = task.finally(() => {
                owner.paused -= 1;
                if (owner.cleanupPromise === result) owner.cleanupPromise = null;
            });
            owner.cleanupPromise = result;
            return result;
        },
        revoke(): void {
            owner.generation += 1;
            owner.destroyed = true;
            state.generation += 1;
        },
    };
}

export function registerBackfillFence(cache: object, fence: BackfillFence): void {
    registry.fences.set(cache, fence);
}

/** Internal lifecycle hook; does not take ownership of the adapters. */
export function withMultiLevelBackfillCleanup(cache: object, cleanup: () => Promise<void>): Promise<void> {
    return registry.fences.get(cache)?.cleanup(cleanup) ?? cleanup();
}
