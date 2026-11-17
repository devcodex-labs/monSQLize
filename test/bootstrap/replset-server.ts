import { ensureWebCryptoGlobal } from './webcrypto';
import {
    configureMemoryServerEnv,
    createMemoryServerDbPath,
    resolveMemoryServerLaunchTimeoutMs,
    resolveReplSetBinaryVersion,
    seedMemoryServerBinaryCache,
    stopMemoryServerWithCleanup,
} from './memory-server-policy';

type ReplSetOptions = {
    uri?: string;
    useEnvironmentUri?: boolean;
    binaryVersion?: string;
    dbName?: string;
};

type ReplSetContext = {
    uri: string;
    external: boolean;
};

type ReplSetBootstrap = {
    setup(): Promise<ReplSetContext>;
    teardown(): Promise<boolean>;
    getUri(): string | null;
};

let replSetPromise: Promise<any> | null = null;
let replSetInstance: any = null;
let replSetDbPath: string | null = null;

export function createReplSetBootstrap(options: ReplSetOptions = {}): ReplSetBootstrap {
    const externalUri = options.uri || (options.useEnvironmentUri === false ? undefined : process.env.MONSQLIZE_REPLSET_URI);
    const binaryVersion = resolveReplSetBinaryVersion(options.binaryVersion);

    async function ensureServer(): Promise<ReplSetContext> {
        if (externalUri) {
            return { uri: externalUri, external: true };
        }

        if (replSetInstance) {
            return { uri: replSetInstance.getUri(), external: false };
        }

        if (!replSetPromise) {
            replSetPromise = (async () => {
                ensureWebCryptoGlobal();
                configureMemoryServerEnv(binaryVersion);
                await seedMemoryServerBinaryCache(binaryVersion);
                const { MongoMemoryReplSet } = require('mongodb-memory-server');
                const dbName = options.dbName || 'monsqlize_p4a';
                const launchTimeout = resolveMemoryServerLaunchTimeoutMs();
                replSetDbPath = createMemoryServerDbPath('replset', dbName);
                replSetInstance = await MongoMemoryReplSet.create({
                    binary: { version: binaryVersion },
                    instanceOpts: [
                        {
                            dbPath: replSetDbPath,
                            ...(launchTimeout ? { launchTimeout } : {}),
                        },
                    ],
                    replSet: {
                        count: 1,
                        dbName,
                        storageEngine: 'wiredTiger',
                    },
                });
                return replSetInstance;
            })();
        }

        const replSet = await replSetPromise;
        return { uri: replSet.getUri(), external: false };
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
            if (replSetInstance) {
                await stopMemoryServerWithCleanup(replSetInstance, replSetDbPath);
                replSetInstance = null;
            }
            replSetDbPath = null;
            replSetPromise = null;
            return true;
        },
        getUri() {
            if (externalUri) {
                return externalUri;
            }
            return replSetInstance?.getUri() || null;
        },
    };
}
