/** A method view whose proxy invariants are independent of a frozen adapter. */
export function createCacheFacade<T extends object>(
    raw: T,
    handlers: Pick<ProxyHandler<T>, 'get' | 'has'>,
): T {
    return new Proxy(Object.create(Object.getPrototypeOf(raw)) as T, {
        get(_target, property) {
            if (handlers.get) return handlers.get(raw, property, raw);
            const value = Reflect.get(raw, property, raw) as unknown;
            return typeof value === 'function' ? value.bind(raw) : value;
        },
        has(_target, property) {
            return handlers.has ? handlers.has(raw, property) : Reflect.has(raw, property);
        },
        set(_target, property, value) { return Reflect.set(raw, property, value, raw); },
        deleteProperty(_target, property) { return Reflect.deleteProperty(raw, property); },
        ownKeys() { return Reflect.ownKeys(raw); },
        getOwnPropertyDescriptor(_target, property) {
            const descriptor = Reflect.getOwnPropertyDescriptor(raw, property);
            return descriptor ? { ...descriptor, configurable: true } : undefined;
        },
        defineProperty(_target, property, descriptor) {
            // A non-configurable shadow would forbid method wrapping on subsequent reads.
            const configurable = descriptor.configurable ?? Reflect.getOwnPropertyDescriptor(raw, property)?.configurable ?? false;
            return configurable && Reflect.defineProperty(raw, property, descriptor);
        },
        preventExtensions() { return false; },
    });
}
