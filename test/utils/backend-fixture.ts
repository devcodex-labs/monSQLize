/** Backends represented by the shared contract harness. A configured fixture must be real. */
export type ContractBackend = 'mongodb' | 'sqlite' | 'postgresql' | 'mysql';

type FixtureFactory<T> = () => Promise<T>;

/**
 * Registers independent per-engine fixtures. An unavailable fixture fails the
 * selected contract case instead of producing an empty successful run.
 */
export function registerBackendFixtures<T>(
    registrations: ReadonlyArray<readonly [ContractBackend, FixtureFactory<T>]>,
) {
    const fixtures = new Map<ContractBackend, FixtureFactory<T>>();
    for (const [backend, factory] of registrations) {
        if (fixtures.has(backend)) {
            throw new Error(`Duplicate contract fixture for ${backend}`);
        }
        fixtures.set(backend, factory);
    }

    return {
        configured(): readonly ContractBackend[] {
            return [...fixtures.keys()];
        },

        async open(backend: ContractBackend): Promise<T> {
            const setup = fixtures.get(backend);
            if (!setup) {
                throw new Error(`No contract fixture registered for ${backend}`);
            }
            return setup();
        },
    };
}

