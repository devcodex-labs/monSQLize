/**
 * Transaction / cache-lock capability.
 *
 * Description:
 * - Responsible for transaction lifecycle, retry strategy, and cache-lock coordination.
 * - Public and shared types are managed by `types/transaction.d.ts`; only runtime implementation and internal state types are kept here.
 */

import { randomBytes } from 'node:crypto';
import type { MongoClient, ClientSession } from 'mongodb';
import type { CacheLike } from '../cache';
import {
    clearCacheInvalidationBarrier,
} from '../../core/cache-invalidation-barrier';
import { createError, ErrorCodes } from '../../core/errors';
import type { LoggerLike } from '../../core/logger';
import type { CacheInvalidationIntent } from '../../types/internal/query';
import type {
    MongoSession,
    TransactionInfo,
    TransactionOptions,
    TransactionStats,
} from '../../../types/transaction';

export type {
    MongoSession,
    TransactionInfo,
    TransactionOptions,
    TransactionStats,
} from '../../../types/transaction';

/** Rejects a write against a managed session once commit or abort has begun. */
export function assertManagedTransactionWriteAllowed(options: unknown): void {
    const session = (options as { session?: { __monSQLizeTransaction?: Transaction } } | null | undefined)?.session;
    const managed = session?.__monSQLizeTransaction;
    if (typeof managed?.assertAcceptingWrites === 'function') managed.assertAcceptingWrites();
}

function toPublicTransactionStatus(state: Transaction['state']): TransactionInfo['status'] {
    return state === 'active' ? 'started' : state;
}

interface CacheLockRecord {
    ownerId: string;
    expiresAt: number;
}

/**
 * Manages distributed cache-based locks to guard critical sections.
 * @since v1.3.0
 */
export class CacheLockManager {
    private readonly locks = new Map<string, CacheLockRecord>();
    private readonly logger: LoggerLike | null;
    private readonly maxDuration: number;
    private readonly cleanupInterval: number;
    private readonly cleanupTimer: NodeJS.Timeout;
    private _totalLocksAdded = 0;

    constructor(options: { logger?: LoggerLike | null; maxDuration?: number; cleanupInterval?: number; } = {}) {
        this.logger = options.logger ?? null;
        this.maxDuration = options.maxDuration ?? 300000;
        this.cleanupInterval = options.cleanupInterval ?? 10000;
        this.cleanupTimer = setInterval(() => {
            this.cleanupExpiredLocks();
        }, this.cleanupInterval);
        this.cleanupTimer.unref?.();
    }

    /**
     * Add a cache lock.
     * @since v1.4.0
     */
    addLock(key: string, owner: { id?: unknown; } | string): void {
        const ownerId = typeof owner === 'string' ? owner : String(owner.id ?? 'unknown');
        this.locks.set(key, {
            ownerId,
            expiresAt: Date.now() + this.maxDuration,
        });
        this._totalLocksAdded += 1;
    }

    /**
     * Check whether a cache key is locked.
     * @since v1.4.0
     */
    isLocked(key: string): boolean {
        this.cleanupExpiredLocks();
        if (this.locks.has(key)) {
            return true;
        }
        for (const pattern of this.locks.keys()) {
            if (!pattern.includes('*')) {
                continue;
            }
            const regex = new RegExp(`^${escapeRegExp(pattern).replace(/\\\*/g, '.*')}$`);
            if (regex.test(key)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Release all cache locks held by the given owner.
     * @since v1.4.0
     */
    releaseLocks(owner: { id?: unknown; } | string): void {
        const ownerId = typeof owner === 'string' ? owner : String(owner.id ?? 'unknown');
        for (const [key, record] of this.locks.entries()) {
            if (record.ownerId === ownerId) {
                this.locks.delete(key);
            }
        }
    }

    /**
     * Get cache lock statistics.
     * @since v1.4.0
     */
    getStats(): { totalLocks: number; activeLocks: number; maxDuration: number; } {
        this.cleanupExpiredLocks();
        return {
            totalLocks: this._totalLocksAdded,
            activeLocks: this.locks.size,
            maxDuration: this.maxDuration,
        };
    }

    /**
     * Clear all cache locks.
     * @since v1.4.0
     */
    clear(): void {
        this.locks.clear();
    }

    /**
     * Stop the cache lock manager.
     * @since v1.4.0
     */
    stop(): void {
        clearInterval(this.cleanupTimer);
    }

    private cleanupExpiredLocks(): void {
        const now = Date.now();
        for (const [key, value] of this.locks.entries()) {
            if (value.expiresAt <= now) {
                this.locks.delete(key);
            }
        }
    }
}

/**
 * Represents a single database transaction lifecycle (pending → active → committed/aborted).
 * @since v1.3.0
 */
export class Transaction {
    readonly id = `tx_${randomBytes(8).toString('hex')}`;
    state: 'pending' | 'active' | 'committed' | 'aborted' = 'pending';
    private acceptingWrites = false;
    private startedAt: number | null = null;
    private timeoutTimer: NodeJS.Timeout | null = null;
    readonly pendingInvalidations = new Set<string>();
    private readonly pendingInvalidationIntents = new Map<string, CacheInvalidationIntent>();
    private recordedWriteOperationCount = 0;
    private recordedInvalidationCount = 0;

    constructor(
        readonly session: MongoSession,
        private readonly options: {
            cache?: CacheLike | null;
            logger?: LoggerLike | null;
            lockManager?: CacheLockManager | null;
        timeout?: number;
        transactionOptions?: Record<string, unknown>;
    } = {},
    ) {
        (this.session as MongoSession & { __monSQLizeTransaction?: Transaction; }).__monSQLizeTransaction = this;
    }

    /**
     * Start the transaction.
     * @since v1.4.0
     */
    async start(): Promise<void> {
        if (this.state !== 'pending') {
            throw createError(ErrorCodes.INVALID_OPERATION, `Cannot start transaction in state: ${this.state}`);
        }
        this.session.startTransaction(this.options.transactionOptions);
        this.state = 'active';
        this.acceptingWrites = true;
        this.startedAt = Date.now();
        const timeout = this.options.timeout ?? 30000;
        if (timeout > 0) {
            this.timeoutTimer = setTimeout(() => {
                if (this.state === 'active') {
                    this.options.logger?.warn?.(`[Transaction] auto-abort on timeout: ${this.id}`);
                    void this.abort().catch((error: unknown) => {
                        this.options.logger?.warn?.('[Transaction] auto-abort failed.', error);
                    });
                }
            }, timeout);
            this.timeoutTimer.unref?.();
        }
    }

    /**
     * Commit the transaction.
     * @since v1.4.0
     */
    async commit(): Promise<void> {
        if (this.state !== 'active') {
            throw createError(ErrorCodes.INVALID_OPERATION, `Cannot commit transaction in state: ${this.state}`);
        }
        this.acceptingWrites = false;
        if (typeof (this.session as unknown as Record<string, unknown>).commitTransaction === 'function') {
            await commitTransactionWithRetry(this.session, this.options.logger);
        }
        this.state = 'committed';
        try {
            try {
                await this.flushPendingInvalidations();
            } catch (error) {
                this.options.logger?.warn?.('[Transaction] post-commit cache invalidation failed.', error);
            }
        } finally {
            await this.clearPendingInvalidationBarriers().catch((error) => {
                this.options.logger?.warn?.('[Transaction] failed to clear cache invalidation barrier.', error);
            });
            this.options.lockManager?.releaseLocks(this.id);
            this.pendingInvalidations.clear();
            this.pendingInvalidationIntents.clear();
            this.clearTimeout();
        }
    }

    /**
     * Roll back the transaction.
     * @since v1.4.0
     */
    async abort(): Promise<void> {
        this.acceptingWrites = false;
        if (this.state !== 'pending' && this.state !== 'active') {
            return;
        }
        try {
            if (this.state === 'active') {
                if (typeof (this.session as unknown as Record<string, unknown>).abortTransaction === 'function') {
                    await this.session.abortTransaction();
                }
            }
        } catch (error) {
            this.options.logger?.warn?.('[Transaction] abortTransaction failed.', error);
        } finally {
            this.state = 'aborted';
            this.options.lockManager?.releaseLocks(this.id);
            this.pendingInvalidations.clear();
            this.pendingInvalidationIntents.clear();
            this.clearTimeout();
        }
    }

    /**
     * End the transaction session.
     * @since v1.4.0
     */
    async end(): Promise<void> {
        this.acceptingWrites = false;
        this.clearTimeout();
        this.options.lockManager?.releaseLocks(this.id);
        await this.session.endSession();
    }

    assertAcceptingWrites(): void {
        if (this.state !== 'active' || !this.acceptingWrites) {
            throw createError(ErrorCodes.INVALID_OPERATION, `Managed transaction ${this.id} is no longer accepting writes.`);
        }
    }

    /**
     * Record a cache invalidation intent.
     * @since v1.4.0
     */
    async recordInvalidation(pattern: string): Promise<void> {
        await this.recordCacheInvalidation({ type: 'pattern', value: pattern });
    }

    async recordCacheInvalidation(intent: CacheInvalidationIntent): Promise<void> {
        if (!intent.value) {
            return;
        }
        const id = `${intent.type}:${intent.value}`;
        if (!this.pendingInvalidationIntents.has(id)) {
            this.recordedInvalidationCount += 1;
        }
        this.pendingInvalidationIntents.set(id, intent);
        this.pendingInvalidations.add(intent.value);
        this.options.lockManager?.addLock(intent.value, this.id);
    }

    recordWriteOperation(): void {
        this.recordedWriteOperationCount += 1;
    }

    private async flushPendingInvalidations(): Promise<void> {
        if (!this.options.cache) {
            return;
        }
        const cacheWithDelete = this.options.cache as CacheLike & { delete?: (key: string) => unknown | Promise<unknown> };
        for (const intent of this.pendingInvalidationIntents.values()) {
            if (intent.type === 'pattern') {
                await this.options.cache.delPattern?.(intent.value);
            } else if (typeof cacheWithDelete.del === 'function') {
                await cacheWithDelete.del(intent.value);
            } else if (typeof cacheWithDelete.delete === 'function') {
                await cacheWithDelete.delete(intent.value);
            }
        }
    }

    private async clearPendingInvalidationBarriers(): Promise<void> {
        if (!this.options.cache || this.pendingInvalidationIntents.size === 0) {
            return;
        }
        const patterns = [...this.pendingInvalidationIntents.values()]
            .filter((intent) => intent.type === 'pattern')
            .map((intent) => intent.value);
        if (patterns.length > 0) {
            await clearCacheInvalidationBarrier(this.options.cache, patterns);
        }
    }

    /**
     * Get the transaction duration.
     * @since v1.4.0
     */
    getDuration(): number {
        if (!this.startedAt) {
            return 0;
        }
        return Date.now() - this.startedAt;
    }

    /**
     * Get transaction info.
     * @since v1.4.0
     */
    getInfo(): TransactionInfo {
        return {
            id: this.id,
            status: toPublicTransactionStatus(this.state),
            duration: this.getDuration(),
            sessionId: stringifySessionId(this.session.id),
        };
    }

    /**
     * Get v1-compatible transaction statistics for this transaction instance.
     * @since v1.4.0
     */
    getStats(): {
        id: string;
        state: Transaction['state'];
        duration: number;
        hasWriteOperation: boolean;
        operationCount: number;
        lockedKeysCount: number;
    } {
        return {
            id: this.id,
            state: this.state,
            duration: this.getDuration(),
            hasWriteOperation: this.hasWriteOperation(),
            operationCount: this.recordedWriteOperationCount || this.recordedInvalidationCount,
            lockedKeysCount: this.recordedInvalidationCount,
        };
    }

    hasWriteOperation(): boolean {
        return this.recordedWriteOperationCount > 0 || this.recordedInvalidationCount > 0;
    }

    private clearTimeout(): void {
        if (this.timeoutTimer) {
            clearTimeout(this.timeoutTimer);
            this.timeoutTimer = null;
        }
    }
}

/**
 * Coordinates transaction creation, commit, abort, and retry logic.
 * @since v1.3.0
 */
export class TransactionManager {
    private readonly logger: LoggerLike | null;
    private readonly cache: CacheLike | null;
    private readonly lockManager: CacheLockManager | null;
    private readonly defaultOptions: Required<Pick<TransactionOptions, 'maxDuration' | 'enableRetry' | 'maxRetries' | 'retryDelay' | 'retryBackoff'>>;
    private readonly defaultReadConcern: TransactionOptions['readConcern'] | undefined;
    private readonly defaultWriteConcern: TransactionOptions['writeConcern'] | undefined;
    private readonly defaultReadPreference: TransactionOptions['readPreference'] | undefined;
    private readonly maxStatsSamples: number;
    readonly activeTransactions = new Map<string, Transaction>();
    private readonly durations: number[] = [];
    private readonly stats = {
        totalTransactions: 0,
        successfulTransactions: 0,
        failedTransactions: 0,
        readOnlyTransactions: 0,
        writeTransactions: 0,
    };

    constructor(options: {
        client: MongoClient;
        cache?: CacheLike | null;
        logger?: LoggerLike | null;
        lockManager?: CacheLockManager | null;
        maxDuration?: number;
        enableRetry?: boolean;
        maxRetries?: number;
        retryDelay?: number;
        retryBackoff?: number;
        defaultReadConcern?: TransactionOptions['readConcern'];
        defaultWriteConcern?: TransactionOptions['writeConcern'];
        defaultReadPreference?: TransactionOptions['readPreference'];
        maxStatsSamples?: number;
    });
    constructor(
        client: MongoClient,
        cache?: CacheLike | null,
        options?: {
            logger?: LoggerLike | null;
            lockManager?: CacheLockManager | null;
            maxDuration?: number;
            enableRetry?: boolean;
            maxRetries?: number;
            retryDelay?: number;
            retryBackoff?: number;
            defaultReadConcern?: TransactionOptions['readConcern'];
            defaultWriteConcern?: TransactionOptions['writeConcern'];
            defaultReadPreference?: TransactionOptions['readPreference'];
            maxStatsSamples?: number;
        },
    );
    constructor(
        input: {
            client: MongoClient;
            cache?: CacheLike | null;
            logger?: LoggerLike | null;
            lockManager?: CacheLockManager | null;
            maxDuration?: number;
            enableRetry?: boolean;
            maxRetries?: number;
            retryDelay?: number;
            retryBackoff?: number;
        } | MongoClient,
        legacyCache?: CacheLike | null,
        legacyOptions: {
            logger?: LoggerLike | null;
            lockManager?: CacheLockManager | null;
            maxDuration?: number;
            enableRetry?: boolean;
            maxRetries?: number;
            retryDelay?: number;
            retryBackoff?: number;
            defaultReadConcern?: TransactionOptions['readConcern'];
            defaultWriteConcern?: TransactionOptions['writeConcern'];
            defaultReadPreference?: TransactionOptions['readPreference'];
            maxStatsSamples?: number;
        } = {},
    ) {
        const options = ('client' in (input as object))
            ? input as unknown as { client: MongoClient; cache?: unknown; logger?: unknown; lockManager?: unknown; maxDuration?: number; enableRetry?: boolean; maxRetries?: number; retryDelay?: number; retryBackoff?: number; defaultReadConcern?: TransactionOptions['readConcern']; defaultWriteConcern?: TransactionOptions['writeConcern']; defaultReadPreference?: TransactionOptions['readPreference']; maxStatsSamples?: number }
            : {
                client: input as MongoClient,
                cache: legacyCache,
                ...legacyOptions,
            } as { client: MongoClient; cache?: unknown; logger?: unknown; lockManager?: unknown; maxDuration?: number; enableRetry?: boolean; maxRetries?: number; retryDelay?: number; retryBackoff?: number; defaultReadConcern?: TransactionOptions['readConcern']; defaultWriteConcern?: TransactionOptions['writeConcern']; defaultReadPreference?: TransactionOptions['readPreference']; maxStatsSamples?: number };
        this.client = options.client;
        this.cache = (options.cache ?? null) as CacheLike | null;
        this.logger = options.logger ?? null;
        this.lockManager = (options.lockManager ?? null) as CacheLockManager | null;
        this.defaultReadConcern = options.defaultReadConcern;
        this.defaultWriteConcern = options.defaultWriteConcern;
        this.defaultReadPreference = options.defaultReadPreference;
        this.maxStatsSamples = options.maxStatsSamples ?? 1000;
        this.defaultOptions = {
            maxDuration: options.maxDuration ?? 30000,
            enableRetry: options.enableRetry ?? true,
            maxRetries: options.maxRetries ?? 3,
            retryDelay: options.retryDelay ?? 100,
            retryBackoff: options.retryBackoff ?? 2,
        };
    }

    private readonly client: MongoClient;

    /**
     * Create a manual transaction session.
     * @since v1.4.0
     */
    async startSession(options: TransactionOptions = {}): Promise<Transaction> {
        const session = this.client.startSession({
            causalConsistency: options.causalConsistency !== false,
        }) as ClientSession as unknown as MongoSession;
        const transactionOptions = {
            readConcern: options.readConcern ?? this.defaultReadConcern,
            writeConcern: options.writeConcern ?? this.defaultWriteConcern,
            readPreference: options.readPreference ?? this.defaultReadPreference,
        };
        const transaction = new Transaction(session, {
            cache: this.cache,
            logger: this.logger,
            lockManager: options.enableCacheLock === false ? null : this.lockManager,
            timeout: options.timeout ?? options.maxDuration ?? this.defaultOptions.maxDuration,
            transactionOptions: compactUndefined(transactionOptions),
        });
        const originalEnd = transaction.end.bind(transaction);
        transaction.end = async () => {
            await originalEnd();
            this.activeTransactions.delete(transaction.id);
        };
        this.activeTransactions.set(transaction.id, transaction);
        return transaction;
    }

    /**
     * Automatically manage the transaction lifecycle.
     * @since v1.4.0
     */
    async withTransaction<T>(callback: (transaction: Transaction) => Promise<T>, options: TransactionOptions = {}): Promise<T> {
        const maxRetries = options.maxRetries ?? this.defaultOptions.maxRetries;
        const retryDelay = options.retryDelay ?? this.defaultOptions.retryDelay;
        const retryBackoff = options.retryBackoff ?? this.defaultOptions.retryBackoff;
        const enableRetry = options.enableRetry ?? this.defaultOptions.enableRetry;

        let lastError: unknown;
        for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
            const transaction = await this.startSession(options);
            const startedAt = Date.now();
            try {
                await transaction.start();
                const result = await callback(transaction);
                await transaction.commit();
                this.recordStats(transaction, Date.now() - startedAt, true);
                return result;
            } catch (error) {
                lastError = error;
                if (transaction.state === 'committed') {
                    throw error;
                }
                await transaction.abort();
                this.recordStats(transaction, Date.now() - startedAt, false);
                if (!enableRetry || attempt === maxRetries || isUnknownTransactionCommitResult(error) || !isTransientTransactionError(error)) {
                    throw error;
                }
                await sleep(retryDelay * Math.pow(retryBackoff, attempt));
            } finally {
                await transaction.end();
            }
        }
        throw lastError instanceof Error ? lastError : new Error('Transaction failed.');
    }

    /**
     * Get all active transactions.
     * @since v1.4.0
     */
    getActiveTransactions(): Transaction[] {
        return [...this.activeTransactions.values()];
    }

    /**
     * Abort all active transactions.
     * @since v1.4.0
     */
    async abortAll(): Promise<void> {
        const transactions = this.getActiveTransactions();
        for (const transaction of transactions) {
            await transaction.abort();
            await transaction.end();
            this.activeTransactions.delete(transaction.id);
        }
    }

    /**
     * Get transaction statistics.
     * @since v1.4.0
     */
    getStats(): TransactionStats {
        const averageDuration = this.durations.length === 0
            ? 0
            : this.durations.reduce((sum, item) => sum + item, 0) / this.durations.length;
        const sortedDurations = [...this.durations].sort((a, b) => a - b);
        const p95Duration = percentile(sortedDurations, 0.95);
        const p99Duration = percentile(sortedDurations, 0.99);
        const totalTransactions = this.stats.totalTransactions;
        return {
            totalTransactions,
            successfulTransactions: this.stats.successfulTransactions,
            failedTransactions: this.stats.failedTransactions,
            readOnlyTransactions: this.stats.readOnlyTransactions,
            writeTransactions: this.stats.writeTransactions,
            activeTransactions: this.activeTransactions.size,
            averageDuration,
            p95Duration,
            p99Duration,
            successRate: totalTransactions > 0
                ? `${((this.stats.successfulTransactions / totalTransactions) * 100).toFixed(2)}%`
                : '0%',
            readOnlyRatio: totalTransactions > 0
                ? `${((this.stats.readOnlyTransactions / totalTransactions) * 100).toFixed(2)}%`
                : '0%',
            sampleCount: this.durations.length,
        };
    }

    private recordStats(transaction: Transaction, duration: number, success: boolean): void {
        this.stats.totalTransactions += 1;
        if (success) {
            this.stats.successfulTransactions += 1;
        } else {
            this.stats.failedTransactions += 1;
        }
        if (transaction.hasWriteOperation()) {
            this.stats.writeTransactions += 1;
        } else {
            this.stats.readOnlyTransactions += 1;
        }
        this.durations.push(duration);
        if (this.durations.length > this.maxStatsSamples) {
            this.durations.shift();
        }
    }
}

function percentile(sortedValues: number[], ratio: number): number {
    if (sortedValues.length === 0) {
        return 0;
    }
    const index = Math.floor(sortedValues.length * ratio);
    return sortedValues[Math.min(index, sortedValues.length - 1)] ?? 0;
}

function compactUndefined<T extends Record<string, unknown>>(value: T): Partial<T> | undefined {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    return entries.length === 0 ? undefined : Object.fromEntries(entries) as Partial<T>;
}

function stringifySessionId(id: unknown): string {
    if (typeof id === 'string') {
        return id;
    }
    if (typeof id === 'object' && id !== null) {
        const candidate = id as { toHexString?: () => string; toString?: () => string; id?: { buffer?: Uint8Array; }; };
        if (typeof candidate.toHexString === 'function') {
            return candidate.toHexString();
        }
        if (candidate.id?.buffer) {
            return Buffer.from(candidate.id.buffer).toString('hex');
        }
        if (typeof candidate.toString === 'function') {
            return candidate.toString();
        }
    }
    return String(id);
}

function transactionErrorChain(error: unknown): Array<Record<string, unknown>> {
    const chain: Array<Record<string, unknown>> = [];
    const seen = new Set<object>();
    let current = error;
    while (current && typeof current === 'object' && chain.length < 8 && !seen.has(current)) {
        seen.add(current);
        const candidate = current as Record<string, unknown>;
        chain.push(candidate);
        current = candidate.cause;
    }
    return chain;
}

function hasTransactionErrorLabel(candidate: Record<string, unknown>, label: string): boolean {
    if (Array.isArray(candidate.errorLabels) && candidate.errorLabels.includes(label)) return true;
    if (typeof candidate.hasErrorLabel === 'function') {
        try {
            return Boolean((candidate.hasErrorLabel as (value: string) => boolean).call(candidate, label));
        } catch { /* fall through to code and cause */ }
    }
    return false;
}

function isUnknownTransactionCommitResult(error: unknown): boolean {
    return transactionErrorChain(error).some((candidate) => hasTransactionErrorLabel(candidate, 'UnknownTransactionCommitResult'));
}

function isTransientTransactionError(error: unknown): boolean {
    if (isUnknownTransactionCommitResult(error)) return false;
    return transactionErrorChain(error).some((candidate) =>
        hasTransactionErrorLabel(candidate, 'TransientTransactionError')
        || candidate.code === 112
        || candidate.code === 117
        || candidate.codeName === 'WriteConflict'
        || candidate.codeName === 'LockTimeout');
}

async function commitTransactionWithRetry(session: MongoSession, logger?: LoggerLike | null): Promise<void> {
    const maxAttempts = 3;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
            await session.commitTransaction();
            return;
        } catch (error) {
            if (!isUnknownTransactionCommitResult(error) || attempt === maxAttempts - 1) {
                throw error;
            }
            logger?.warn?.(`[Transaction] retrying commit after UnknownTransactionCommitResult (attempt ${attempt + 2}/${maxAttempts})`);
            await sleep(100 * (attempt + 1));
        }
    }
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

