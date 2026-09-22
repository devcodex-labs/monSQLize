import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { insertOneDocument } from '../../../src/adapters/mongodb/writes/write-basic';
import { insertBatchDocuments } from '../../../src/adapters/mongodb/writes/write-batch';

const MonSQLize = require('../../../dist/cjs/index.cjs');

function createFakeSession() {
    let inTransaction = false;
    let startOptions: Record<string, unknown> | undefined;
    return {
        id: { toString: () => 'session-1' },
        inTransaction() {
            return inTransaction;
        },
        getStartOptions() {
            return startOptions;
        },
        startTransaction(options?: Record<string, unknown>) {
            startOptions = options;
            inTransaction = true;
        },
        commitTransaction() {
            inTransaction = false;
            return Promise.resolve();
        },
        abortTransaction() {
            inTransaction = false;
            return Promise.resolve();
        },
        endSession() {
            inTransaction = false;
            return Promise.resolve();
        },
    };
}

function createFakeClient() {
    return {
        startSession() {
            return createFakeSession();
        },
    };
}

describe('P4-A transaction', () => {
    afterEach(() => {
        const cacheLockManager = new MonSQLize.CacheLockManager();
        cacheLockManager.clear();
        cacheLockManager.stop();
    });

    it('supports Transaction lifecycle and cache invalidation records', async () => {
        const cache = new MonSQLize.MemoryCache({ enableStats: true });
        cache.set('users:1', { id: 1 }, 60000);
        const cacheLockManager = new MonSQLize.CacheLockManager();
        const transaction = new MonSQLize.Transaction(createFakeSession(), {
            cache,
            lockManager: cacheLockManager,
        });

        await transaction.start();
        assert.equal(transaction.session.inTransaction(), true);

        await transaction.recordInvalidation('users:*');
        assert.equal(cacheLockManager.isLocked('users:1'), true);
        assert.deepEqual(cache.get('users:1'), { id: 1 });
        assert.equal(transaction.getInfo().status, 'started');
        assert.deepEqual({
            state: transaction.getStats().state,
            hasWriteOperation: transaction.getStats().hasWriteOperation,
            operationCount: transaction.getStats().operationCount,
            lockedKeysCount: transaction.getStats().lockedKeysCount,
        }, {
            state: 'active',
            hasWriteOperation: true,
            operationCount: 1,
            lockedKeysCount: 1,
        });

        await transaction.commit();
        assert.equal(transaction.getInfo().status, 'committed');
        assert.equal(cache.get('users:1'), undefined);
        assert.equal(cacheLockManager.isLocked('users:1'), false);

        await transaction.end();
        cacheLockManager.stop();
    });

    it('replays exact cache key invalidation only after commit', async () => {
        const cache = new MonSQLize.MemoryCache({ enableStats: true });
        cache.set('users:1', { id: 1 }, 60000);
        const transaction = new MonSQLize.Transaction(createFakeSession(), { cache });

        await transaction.start();
        await transaction.recordCacheInvalidation({ type: 'key', value: 'users:1' });

        assert.deepEqual(cache.get('users:1'), { id: 1 });

        await transaction.commit();

        assert.equal(cache.get('users:1'), undefined);
        await transaction.end();
    });

    it('retries UnknownTransactionCommitResult during commit', async () => {
        let commits = 0;
        const session = {
            ...createFakeSession(),
            commitTransaction() {
                commits += 1;
                if (commits === 1) {
                    return Promise.reject({
                        hasErrorLabel: (label: string) => label === 'UnknownTransactionCommitResult',
                    });
                }
                return Promise.resolve();
            },
        };
        const transaction = new MonSQLize.Transaction(session);

        await transaction.start();
        await transaction.commit();

        assert.equal(commits, 2);
        assert.equal(transaction.getInfo().status, 'committed');
        await transaction.end();
    });

    it('retries a wrapped transient transaction error through its cause chain', async () => {
        const manager = new MonSQLize.TransactionManager({ client: createFakeClient(), maxRetries: 1, retryDelay: 0 });
        let callbacks = 0;
        const result = await manager.withTransaction(async () => {
            callbacks += 1;
            if (callbacks === 1) {
                const wrapped = new Error('write adapter failed') as Error & { cause?: unknown };
                wrapped.cause = { code: 112, errorLabels: ['TransientTransactionError'] };
                throw wrapped;
            }
            return 'recovered';
        });
        assert.equal(result, 'recovered');
        assert.equal(callbacks, 2);
    });

    it('retries only commit for a wrapped unknown commit result with a transient cause', async () => {
        let callbacks = 0;
        let commits = 0;
        const client = {
            startSession() {
                return {
                    ...createFakeSession(),
                    commitTransaction() {
                        commits += 1;
                        if (commits === 1) {
                            const wrapped = new Error('commit outcome unknown') as Error & { cause?: unknown };
                            wrapped.cause = { code: 112, errorLabels: ['UnknownTransactionCommitResult'] };
                            return Promise.reject(wrapped);
                        }
                        return Promise.resolve();
                    },
                };
            },
        };
        const manager = new MonSQLize.TransactionManager({ client, maxRetries: 2, retryDelay: 0 });
        await manager.withTransaction(async () => { callbacks += 1; });
        assert.equal(callbacks, 1);
        assert.equal(commits, 2);
    });

    it('rejects late wrapped writes while abort is in progress, including batch subwrites', async () => {
        let releaseAbort: () => void = () => undefined;
        const abortPending = new Promise<void>((resolve) => { releaseAbort = resolve; });
        const session = {
            ...createFakeSession(),
            abortTransaction: () => abortPending,
        };
        const transaction = new MonSQLize.Transaction(session);
        await transaction.start();
        let driverWrites = 0;
        const collection = {
            insertOne: async () => { driverWrites += 1; return { acknowledged: true, insertedId: 1 }; },
            insertMany: async () => { driverWrites += 1; return { acknowledged: true, insertedCount: 1, insertedIds: { 0: 1 } }; },
        } as any;
        const aborting = transaction.abort();
        await assert.rejects(() => insertOneDocument(collection, { n: 1 }, { session } as any), /no longer accepting writes/);
        await assert.rejects(() => insertBatchDocuments(collection, [{ n: 1 }], { session, batchSize: 1 } as any), /no longer accepting writes/);
        assert.equal(driverWrites, 0);
        releaseAbort();
        await aborting;
        await transaction.end();
    });

    it('commits database before logging post-commit cache invalidation failures', async () => {
        const warnings: unknown[] = [];
        let commits = 0;
        const session = {
            ...createFakeSession(),
            commitTransaction() {
                commits += 1;
                return Promise.resolve();
            },
        };
        const transaction = new MonSQLize.Transaction(session, {
            cache: {
                set: async () => undefined,
                delPattern: async () => {
                    throw new Error('cache down');
                },
            },
            logger: { warn: (...args: unknown[]) => warnings.push(args) },
        });

        await transaction.start();
        await transaction.recordInvalidation('users:*');
        await transaction.recordInvalidation('posts:*');
        await assert.doesNotReject(() => transaction.commit());

        assert.equal(commits, 1);
        assert.equal(transaction.getInfo().status, 'committed');
        assert.ok(warnings.some((entry) => String((entry as unknown[])[0]).includes('post-commit cache invalidation failed')));
        await transaction.end();
    });

    it('does not throw when post-commit cache invalidation fails', async () => {
        const warnings: unknown[] = [];
        let delPatternCalls = 0;
        const transaction = new MonSQLize.Transaction(createFakeSession(), {
            cache: {
                set: async () => undefined,
                del: async () => undefined,
                delPattern: async () => {
                    delPatternCalls += 1;
                    if (delPatternCalls > 1) {
                        throw new Error('cache down');
                    }
                    return 1;
                },
            },
            logger: { warn: (...args: unknown[]) => warnings.push(args) },
        });

        await transaction.start();
        await transaction.recordInvalidation('users:*');
        await transaction.recordInvalidation('posts:*');
        await assert.doesNotReject(() => transaction.commit());

        assert.equal(transaction.getInfo().status, 'committed');
        assert.ok(warnings.some((entry) => String((entry as unknown[])[0]).includes('post-commit cache invalidation failed')));
        await transaction.end();
    });

    it('records write transaction stats after commit clears pending invalidations', async () => {
        const manager = new MonSQLize.TransactionManager({
            client: createFakeClient(),
            maxRetries: 0,
            retryDelay: 1,
        });

        await manager.withTransaction(async (tx: { recordInvalidation(pattern: string): Promise<void> }) => {
            await tx.recordInvalidation('users:*');
        });

        const stats = manager.getStats();
        assert.equal(stats.writeTransactions, 1);
        assert.equal(stats.readOnlyTransactions, 0);
    });

    it('records write transaction stats independently of cache invalidation intents', async () => {
        const manager = new MonSQLize.TransactionManager({
            client: createFakeClient(),
            maxRetries: 0,
            retryDelay: 1,
        });

        await manager.withTransaction(async (tx: { recordWriteOperation(): void }) => {
            tx.recordWriteOperation();
        });

        const stats = manager.getStats();
        assert.equal(stats.writeTransactions, 1);
        assert.equal(stats.readOnlyTransactions, 0);
    });

    it('logs and cleans up when abortTransaction fails', async () => {
        const warnings: unknown[] = [];
        const cacheLockManager = new MonSQLize.CacheLockManager();
        const session = {
            ...createFakeSession(),
            abortTransaction() {
                return Promise.reject(new Error('abort failed'));
            },
        };
        const transaction = new MonSQLize.Transaction(session, {
            lockManager: cacheLockManager,
            logger: { warn: (...args: unknown[]) => warnings.push(args) },
        });

        await transaction.start();
        await transaction.recordInvalidation('users:*');
        await assert.doesNotReject(() => transaction.abort());

        assert.equal(transaction.getInfo().status, 'aborted');
        assert.equal(cacheLockManager.isLocked('users:1'), false);
        assert.ok(warnings.some((entry) => String((entry as unknown[])[0]).includes('abortTransaction failed')));
        await transaction.end();
        cacheLockManager.stop();
    });

    it('supports TransactionManager startSession / withTransaction / retry / stats', async () => {
        const cacheLockManager = new MonSQLize.CacheLockManager();
        const manager = new MonSQLize.TransactionManager({
            client: createFakeClient(),
            lockManager: cacheLockManager,
            maxRetries: 1,
            retryDelay: 1,
        });

        const session = await manager.startSession();
        await session.start();
        assert.equal(session.getInfo().status, 'started');
        await session.abort();
        await session.end();

        let attempts = 0;
        const result = await manager.withTransaction((tx: { id: string }) => {
            attempts += 1;
            if (attempts === 1) {
                const error = new Error('transient') as Error & { code?: number };
                error.code = 112;
                return Promise.reject(error);
            }
            return Promise.resolve(tx.id);
        });

        assert.equal(typeof result, 'string');
        assert.equal(attempts, 2);
        const stats = manager.getStats();
        assert.equal(stats.totalTransactions, 2);
        assert.equal(stats.successfulTransactions, 1);
        assert.equal(stats.failedTransactions, 1);
        assert.equal(stats.readOnlyTransactions, 2);
        assert.equal(stats.writeTransactions, 0);
        assert.equal(stats.activeTransactions, 0);
        assert.equal(typeof stats.p95Duration, 'number');
        assert.equal(typeof stats.p99Duration, 'number');
        assert.equal(stats.successRate, '50.00%');
        assert.equal(stats.readOnlyRatio, '100.00%');
        assert.equal(stats.sampleCount, 2);

        await manager.abortAll();
        cacheLockManager.stop();
    });

    it('forwards global and per-transaction options to startTransaction', async () => {
        const sessions = [createFakeSession(), createFakeSession()];
        const usedSessions: any[] = [];
        const manager = new MonSQLize.TransactionManager({
            client: {
                startSession: () => {
                    const session = sessions.shift();
                    usedSessions.push(session);
                    return session;
                },
            },
            defaultReadConcern: { level: 'majority' },
            defaultWriteConcern: { w: 'majority' },
            defaultReadPreference: 'primary',
            maxStatsSamples: 1,
        });

        await manager.withTransaction(async () => 'default');
        const defaultOptions = usedSessions[0].getStartOptions();
        assert.equal(defaultOptions?.readConcern?.level, 'majority');
        assert.equal(defaultOptions?.writeConcern?.w, 'majority');
        assert.equal(defaultOptions?.readPreference, 'primary');

        await manager.withTransaction(async () => 'override', {
            readConcern: { level: 'snapshot' },
            writeConcern: { w: 1 },
            readPreference: 'secondary',
        });
        const overrideOptions = usedSessions[1].getStartOptions();
        assert.equal(overrideOptions?.readConcern?.level, 'snapshot');
        assert.equal(overrideOptions?.writeConcern?.w, 1);
        assert.equal(overrideOptions?.readPreference, 'secondary');
        assert.equal(manager.getStats().sampleCount, 1);
    });
});
