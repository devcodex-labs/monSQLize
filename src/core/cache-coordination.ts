import type { QueryCacheLike, CacheInvalidationIntent } from '../types/internal/query';

type Ticket = { key: string; valid: boolean };
type Coordinator = { tickets: Set<Ticket>; tails: Map<string, Promise<unknown>> };
const coordinators = new WeakMap<object, Coordinator>();
const origins = new WeakMap<object, QueryCacheLike>();

function coordinator(cache: QueryCacheLike): Coordinator {
    const origin = origins.get(cache) ?? cache;
    let state = coordinators.get(origin);
    if (!state) {
        state = { tickets: new Set(), tails: new Map() };
        coordinators.set(origin, state);
    }
    return state;
}

function matches(intent: CacheInvalidationIntent, key: string): boolean {
    if (intent.type === 'key') return intent.value === key;
    const pattern = intent.value.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    return new RegExp(`^${pattern}$`).test(key);
}

function serialize<T>(state: Coordinator, key: string, task: () => Promise<T>): Promise<T> {
    const result = (state.tails.get(key) ?? Promise.resolve()).catch(() => undefined).then(task);
    state.tails.set(key, result);
    void result.finally(() => {
        if (state.tails.get(key) === result) state.tails.delete(key);
    }).catch(() => undefined);
    return result;
}

/** A query owns its tickets until settlement; invalidation revokes late fills. */
export async function withCacheReads<T>(cache: QueryCacheLike, task: (cache: QueryCacheLike) => Promise<T>): Promise<T> {
    cache = origins.get(cache) ?? cache;
    const state = coordinator(cache);
    const tickets = new Map<string, Ticket>();
    const ticketFor = (key: string): Ticket => {
        let ticket = tickets.get(key);
        if (!ticket) {
            ticket = { key, valid: true };
            tickets.set(key, ticket);
            state.tickets.add(ticket);
        }
        return ticket;
    };
    const get = (key: string) => { ticketFor(key); return cache.get(key); };
    const set: QueryCacheLike['set'] = (key, value, ttl) => {
        const ticket = ticketFor(key);
        return serialize(state, key, async () => {
            if (!ticket.valid) return false;
            const result = await cache.set(key, value, ttl);
            return result !== false;
        });
    };
    const guarded = new Proxy(cache, {
        get(target, property) {
            if (property === 'get') return get;
            if (property === 'set') return set;
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
    origins.set(guarded, origins.get(cache) ?? cache);
    try { return await task(guarded); }
    finally { for (const ticket of tickets.values()) state.tickets.delete(ticket); }
}

export function readThroughCache<T>(cache: QueryCacheLike, key: string, ttl: number, fetch: () => Promise<T>): Promise<T> {
    return withCacheReads(cache, async guarded => {
        const value = await guarded.get(key);
        if (value !== undefined) return value as T;
        const result = await fetch();
        await guarded.set(key, result, ttl);
        return result;
    });
}

/** Revoke synchronously, then wait for already dispatched fills before deleting. */
export async function coordinateInvalidation<T>(
    cache: QueryCacheLike, intents: CacheInvalidationIntent[], task: () => Promise<T>,
): Promise<T> {
    const state = coordinator(cache);
    for (const ticket of state.tickets) {
        if (intents.some(intent => matches(intent, ticket.key))) ticket.valid = false;
    }
    const keys = [...state.tails.keys()].filter(key => intents.some(intent => matches(intent, key)));
    const previous = keys.map(key => state.tails.get(key)!);
    // Reserve each affected key before yielding so subsequent fills wait for deletion.
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const pending = keys.map(key => serialize(state, key, () => done));
    try {
        await Promise.allSettled(previous);
        return await task();
    } finally {
        finish();
        await Promise.allSettled(pending);
    }
}
