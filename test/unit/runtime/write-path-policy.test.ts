import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    assertClientLevelWritePathAllowed,
    assertDbLevelWritePathAllowed,
    assertWritePathAllowed,
    normalizeWritePathPolicy,
    resolveWritePathRule,
} from '../../../src/capabilities/write-path-policy';

const MonSQLize = require('../../../dist/cjs/index.cjs');

type RuntimeOptions = Record<string, unknown>;

type RuntimeHarness = {
    runtime: any;
    calls: Array<{ op: string; db?: string; collection?: string }>;
};

function createFakeCollection(dbName: string, collectionName: string, calls: RuntimeHarness['calls']) {
    return {
        collectionName,
        namespace: `${dbName}.${collectionName}`,
        insertOne: async () => {
            calls.push({ op: 'insertOne', db: dbName, collection: collectionName });
            return { acknowledged: true, insertedId: `${collectionName}-id` };
        },
        updateOne: async () => {
            calls.push({ op: 'updateOne', db: dbName, collection: collectionName });
            return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null };
        },
        deleteOne: async () => {
            calls.push({ op: 'deleteOne', db: dbName, collection: collectionName });
            return { acknowledged: true, deletedCount: 1 };
        },
        createIndex: async () => {
            calls.push({ op: 'createIndex', db: dbName, collection: collectionName });
            return `${collectionName}_idx`;
        },
        createCollection: async () => {
            calls.push({ op: 'createCollection', db: dbName, collection: collectionName });
            return true;
        },
        createIndexes: async () => {
            calls.push({ op: 'createIndexes', db: dbName, collection: collectionName });
            return [`${collectionName}_idx`];
        },
        listIndexes: () => ({
            toArray: async () => [],
        }),
        aggregate: () => ({
            toArray: async () => {
                calls.push({ op: 'aggregate', db: dbName, collection: collectionName });
                return [];
            },
        }),
        rename: async (newName: string) => {
            calls.push({ op: 'renameCollection', db: dbName, collection: newName });
            return createFakeCollection(dbName, newName, calls);
        },
        drop: async () => {
            calls.push({ op: 'dropCollection', db: dbName, collection: collectionName });
            return true;
        },
    };
}

function createFakeDb(dbName: string, calls: RuntimeHarness['calls']) {
    return {
        databaseName: dbName,
        collection: (collectionName: string) => createFakeCollection(dbName, collectionName, calls),
        command: async () => {
            calls.push({ op: 'runCommand', db: dbName });
            return { ok: 1 };
        },
        createCollection: async (collectionName: string) => {
            calls.push({ op: 'createCollection', db: dbName, collection: collectionName });
            return createFakeCollection(dbName, collectionName, calls);
        },
        dropDatabase: async () => {
            calls.push({ op: 'dropDatabase', db: dbName });
            return true;
        },
        listCollections: () => ({
            toArray: async () => [],
        }),
        admin: () => ({
            listDatabases: async () => ({ databases: [] }),
        }),
    };
}

function createConnectedRuntime(options: RuntimeOptions = {}): RuntimeHarness {
    const calls: RuntimeHarness['calls'] = [];
    const runtime = new MonSQLize({
        type: 'mongodb',
        databaseName: 'policy_db',
        ...options,
    });
    runtime._connected = true;
    runtime._client = {
        db: (dbName: string) => createFakeDb(dbName, calls),
    };
    return { runtime, calls };
}

async function expectBlocked(operation: Promise<unknown> | (() => unknown)): Promise<void> {
    if (typeof operation === 'function') {
        assert.throws(operation, /writePathPolicy blocked/);
        return;
    }
    await assert.rejects(operation, /writePathPolicy blocked/);
}

describe('writePathPolicy runtime enforcement', () => {
    afterEach(() => {
        MonSQLize.Model._clear();
    });

    it('keeps collection writes allowed when writePathPolicy is not configured', async () => {
        const { runtime, calls } = createConnectedRuntime();

        await runtime.collection('users').insertOne({ name: 'Ada' });
        runtime.collection('users').raw();

        assert.deepEqual(calls.map((call) => call.op), ['insertOne']);
    });

    it('blocks direct collection writes, raw access, and db raw commands in model-only mode', async () => {
        const { runtime, calls } = createConnectedRuntime({
            writePathPolicy: {
                default: 'model-only',
            },
        });

        await expectBlocked(runtime.collection('users').insertOne({ name: 'Ada' }));
        await expectBlocked(() => runtime.collection('users').raw());
        await expectBlocked(runtime.db().runCommand({ ping: 1 }));
        await expectBlocked(() => runtime._adapter.client);
        await expectBlocked(() => runtime.collection('users').aggregate([{ $out: 'users_archive' }]));
        await expectBlocked(runtime._adapter.collection('policy_db', 'users').aggregate([{ $merge: 'users_archive' }]));
        await expectBlocked(runtime._adapter.dropDatabase('policy_db', { confirm: true }));

        assert.equal(calls.length, 0);
    });

    it('allows model writes and model management operations in model-only mode', async () => {
        const { runtime, calls } = createConnectedRuntime({
            writePathPolicy: {
                default: 'model-only',
            },
        });
        MonSQLize.Model.define('users', { schema: {} });

        const users = runtime.model('users');
        await users.insertOne({ name: 'Ada' });
        await users.createIndex({ name: 1 });
        await users.aggregate([{ $match: {} }, { $out: 'users_archive' }]);

        assert.deepEqual(calls.map((call) => call.op), ['insertOne', 'createIndex', 'aggregate']);
    });

    it('honors namespace overrides without relaxing unrelated collections', async () => {
        const { runtime, calls } = createConnectedRuntime({
            writePathPolicy: {
                default: 'model-only',
                namespaces: {
                    'policy_db.users': 'allow-both',
                },
            },
        });

        await runtime.collection('users').insertOne({ name: 'Ada' });
        await expectBlocked(runtime.collection('orders').insertOne({ total: 42 }));

        assert.deepEqual(calls, [{ op: 'insertOne', db: 'policy_db', collection: 'users' }]);
    });

    it('ignores inherited namespace properties but accepts explicit prototype-named keys', async () => {
        const inherited = Object.create({ toString: 'allow-both' });
        inherited.users = 'allow-both';
        const policy = normalizeWritePathPolicy({ default: 'model-only', namespaces: inherited });
        for (const collection of ['toString', 'constructor', 'valueOf']) {
            assert.equal(resolveWritePathRule(policy, { collection }).key, 'default');
        }
        assert.equal(resolveWritePathRule(policy, { collection: 'users' }).key, 'users');

        const { runtime, calls } = createConnectedRuntime({
            writePathPolicy: {
                default: 'model-only',
                namespaces: { toString: 'allow-both', constructor: 'allow-both', valueOf: 'allow-both' },
            },
        });
        for (const collection of ['toString', 'constructor', 'valueOf']) {
            await runtime.collection(collection).insertOne({ allowed: true });
        }
        await expectBlocked(runtime.collection('other').insertOne({ allowed: false }));
        assert.deepEqual(calls.map((call) => call.collection), ['toString', 'constructor', 'valueOf']);
    });

    it('supports explicit raw and management overrides under model-only mode', async () => {
        const { runtime, calls } = createConnectedRuntime({
            writePathPolicy: {
                default: {
                    mode: 'model-only',
                    raw: 'allow',
                    management: 'allow',
                },
            },
        });

        runtime.collection('users').raw();
        assert.ok(runtime._adapter.client);
        await runtime.collection('users').createIndex({ name: 1 });
        await expectBlocked(runtime.collection('users').insertOne({ name: 'Ada' }));

        assert.deepEqual(calls, [{ op: 'createIndex', db: 'policy_db', collection: 'users' }]);
    });

    it('blocks native client access when a namespace blocks raw access', async () => {
        const { runtime } = createConnectedRuntime({
            writePathPolicy: {
                default: 'allow-both',
                namespaces: {
                    'policy_db.users': 'model-only',
                },
            },
        });

        await expectBlocked(() => runtime._adapter.client);
    });

    it('prefers throwing namespace rules over a warning default for db and client raw access', async () => {
        const { runtime, calls } = createConnectedRuntime({
            writePathPolicy: {
                default: {
                    mode: 'model-only',
                    onViolation: 'warn',
                },
                namespaces: {
                    'policy_db.users': {
                        mode: 'model-only',
                        onViolation: 'throw',
                    },
                },
            },
        });

        await expectBlocked(() => runtime.collection('users').raw());
        await expectBlocked(runtime.db().runCommand({ insert: 'users', documents: [] }));
        await expectBlocked(() => runtime._adapter.client);

        assert.equal(calls.length, 0);
    });

    it('keeps warning-only db and client raw guards available for migration observation', async () => {
        const policy = normalizeWritePathPolicy({
            default: {
                mode: 'model-only',
                onViolation: 'warn',
            },
            namespaces: {
                'policy_db.users': {
                    mode: 'model-only',
                    onViolation: 'warn',
                },
            },
        });
        const warnings: unknown[][] = [];
        const { runtime, calls } = createConnectedRuntime({
            writePathPolicy: {
                default: {
                    mode: 'model-only',
                    onViolation: 'warn',
                },
                namespaces: {
                    'policy_db.users': {
                        mode: 'model-only',
                        onViolation: 'warn',
                    },
                },
            },
        });

        await runtime.db().runCommand({ insert: 'users', documents: [] });
        assert.ok(runtime._adapter.client);
        assert.doesNotThrow(() => assertDbLevelWritePathAllowed({
            policy,
            dbName: 'policy_db',
            operation: 'runCommand',
            category: 'raw',
            logger: {
                warn: (...args: unknown[]) => warnings.push(args),
            },
        }));
        assert.doesNotThrow(() => assertClientLevelWritePathAllowed({
            policy,
            operation: 'client',
            logger: {
                warn: (...args: unknown[]) => warnings.push(args),
            },
        }));

        assert.deepEqual(calls, [{ op: 'runCommand', db: 'policy_db' }]);
        assert.equal(warnings.length, 2);
        assert.match(String(warnings[0][0]), /WritePathPolicy/);
        assert.match(String(warnings[1][0]), /WritePathPolicy/);
    });

    it('matches pool-scoped namespace rules before db and collection fallbacks', () => {
        const policy = normalizeWritePathPolicy({
            default: 'model-only',
            namespaces: {
                'analytics:policy_db.users': 'allow-both',
                'policy_db.users': {
                    mode: 'model-only',
                    onViolation: 'warn',
                },
            },
        });

        const poolRule = resolveWritePathRule(policy, {
            pool: 'analytics',
            db: 'policy_db',
            collection: 'users',
        });
        const dbRule = resolveWritePathRule(policy, {
            db: 'policy_db',
            collection: 'users',
        });

        assert.equal(poolRule.key, 'analytics:policy_db.users');
        assert.equal(poolRule.rule.mode, 'allow-both');
        assert.equal(dbRule.key, 'policy_db.users');
        assert.equal(dbRule.rule.mode, 'model-only');
        assert.equal(dbRule.rule.onViolation, 'warn');
    });

    it('validates malformed writePathPolicy options at construction time', () => {
        assert.throws(
            () => new MonSQLize({
                type: 'mongodb',
                databaseName: 'policy_db',
                writePathPolicy: {
                    default: {
                        mode: 'invalid',
                    },
                },
            }),
            /Invalid writePathPolicy config/,
        );
    });

    it('rejects reserved and whitespace namespace keys at construction time', () => {
        assert.throws(
            () => normalizeWritePathPolicy({
                namespaces: {
                    default: 'model-only',
                },
            }),
            /namespace key "default" is reserved/,
        );
        assert.throws(
            () => new MonSQLize({
                type: 'mongodb',
                databaseName: 'policy_db',
                writePathPolicy: {
                    namespaces: {
                        default: 'model-only',
                    },
                },
            }),
            /namespace key "default" is reserved/,
        );
        assert.throws(
            () => normalizeWritePathPolicy({
                namespaces: {
                    ' policy_db.users': 'model-only',
                },
            }),
            /leading or trailing whitespace/,
        );
    });

    it('allows a collection literally named default through db-qualified namespace rules', () => {
        const policy = normalizeWritePathPolicy({
            default: 'allow-both',
            namespaces: {
                'policy_db.default': 'model-only',
            },
        });
        const defaultCollectionRule = resolveWritePathRule(policy, {
            db: 'policy_db',
            collection: 'default',
        });

        assert.equal(defaultCollectionRule.key, 'policy_db.default');
        assert.equal(defaultCollectionRule.rule.mode, 'model-only');
        assert.throws(
            () => assertWritePathAllowed({
                policy,
                namespace: { db: 'policy_db', collection: 'default' },
                source: 'collection',
                operation: 'insertOne',
                category: 'write',
            }),
            /writePathPolicy blocked/,
        );
        assert.doesNotThrow(() => assertWritePathAllowed({
            policy,
            namespace: { db: 'policy_db', collection: 'default' },
            source: 'model',
            operation: 'insertOne',
            category: 'write',
        }));
        assert.doesNotThrow(() => assertWritePathAllowed({
            policy,
            namespace: { db: 'policy_db', collection: 'users' },
            source: 'collection',
            operation: 'insertOne',
            category: 'write',
        }));
    });

    it('warns instead of throwing when onViolation is warn', () => {
        const warnings: unknown[][] = [];
        const policy = normalizeWritePathPolicy({
            default: {
                mode: 'model-only',
                onViolation: 'warn',
            },
        });

        assert.doesNotThrow(() => assertWritePathAllowed({
            policy,
            namespace: { db: 'policy_db', collection: 'users' },
            source: 'collection',
            operation: 'insertOne',
            category: 'write',
            logger: {
                warn: (...args: unknown[]) => warnings.push(args),
            },
        }));

        assert.equal(warnings.length, 1);
        assert.match(String(warnings[0][0]), /WritePathPolicy/);
    });

    it('blocks management operations when the target namespace is model-only', async () => {
        const { runtime, calls } = createConnectedRuntime({
            writePathPolicy: {
                default: 'allow-both',
                namespaces: {
                    'policy_db.archive': 'model-only',
                },
            },
        });

        await expectBlocked(runtime.collection('users').createCollection('archive'));
        await expectBlocked(runtime.collection('users').createView('archive', 'users'));
        await expectBlocked(runtime.collection('users').renameCollection('archive'));

        assert.equal(calls.length, 0);
    });

    it('matches instance-scoped rules for database-level raw operations', () => {
        const policy = normalizeWritePathPolicy({
            default: 'allow-both',
            namespaces: {
                'tenant_a:policy_db:users': 'model-only',
            },
        });

        assert.throws(
            () => assertDbLevelWritePathAllowed({
                policy,
                dbName: 'policy_db',
                operation: 'runCommand',
                category: 'raw',
            }),
            /writePathPolicy blocked/,
        );
        assert.doesNotThrow(() => assertDbLevelWritePathAllowed({
            policy,
            dbName: 'other_db',
            operation: 'runCommand',
            category: 'raw',
        }));
    });
});
