import { ensureWebCryptoGlobal } from './webcrypto';
import {
    configureMemoryServerEnv,
    createMemoryServerDbPath,
    resolveMemoryServerBinaryVersion,
    resolveMemoryServerLaunchTimeoutMs,
    seedMemoryServerBinaryCache,
    stopMemoryServerWithCleanup,
} from './memory-server-policy';

type MemoryServerOptions = {
    uri?: string;
    useEnvironmentUri?: boolean;
    binaryVersion?: string;
    dbName?: string;
};

type MemoryServerContext = {
    uri: string;
    external: boolean;
};

type MemoryServerBootstrap = {
    setup(): Promise<MemoryServerContext>;
    teardown(): Promise<boolean>;
    getUri(): string | null;
};

let memoryServerPromise: Promise<any> | null = null;
let memoryServerInstance: any = null;
let memoryServerDbPath: string | null = null;

export function createMemoryServerBootstrap(options: MemoryServerOptions = {}): MemoryServerBootstrap {
    const externalUri = options.uri || (options.useEnvironmentUri === false ? undefined : process.env.MONSQLIZE_MEMORY_MONGO_URI);
    const binaryVersion = resolveMemoryServerBinaryVersion(options.binaryVersion);

    async function ensureServer(): Promise<MemoryServerContext> {
        if (externalUri) {
            return { uri: externalUri, external: true };
        }

        if (memoryServerInstance) {
            return { uri: memoryServerInstance.getUri(), external: false };
        }

        if (!memoryServerPromise) {
            memoryServerPromise = (async () => {
                ensureWebCryptoGlobal();
                configureMemoryServerEnv(binaryVersion);
                await seedMemoryServerBinaryCache(binaryVersion);
                const { MongoMemoryServer } = require('mongodb-memory-server');
                const dbName = options.dbName || 'monsqlize_p2a';
                const launchTimeout = resolveMemoryServerLaunchTimeoutMs();
                memoryServerDbPath = createMemoryServerDbPath('single', dbName);
                memoryServerInstance = await MongoMemoryServer.create({
                    binary: { version: binaryVersion },
                    instance: {
                        dbName,
                        dbPath: memoryServerDbPath,
                        ...(launchTimeout ? { launchTimeout } : {}),
                    },
                });
                return memoryServerInstance;
            })();
        }

        const server = await memoryServerPromise;
        return { uri: server.getUri(), external: false };
    }

    return {
        async setup() {
            const { uri, external } = await ensureServer();
            return { uri, external };
        },
        async teardown() {
            if (externalUri) {
                return true;
            }

            if (memoryServerInstance) {
                await stopMemoryServerWithCleanup(memoryServerInstance, memoryServerDbPath);
                memoryServerInstance = null;
            }
            memoryServerDbPath = null;
            memoryServerPromise = null;
            return true;
        },
        getUri() {
            if (externalUri) {
                return externalUri;
            }
            return memoryServerInstance?.getUri() || null;
        },
    };
}
