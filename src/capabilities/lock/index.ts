/**
 * Business lock capability.
 *
 * Description:
 * - Responsible for lock manager, lock handle, and fallbackToNoLock.
 * - Public and shared types are managed by `types/lock.d.ts`; only runtime implementation and internal state types are kept here.
 */

import { randomUUID } from 'node:crypto';
import { createError, ErrorCodes } from '../../core/errors';
import type { LoggerLike } from '../../core/logger';
import type { LockOptions, LockStats } from '../../../types/lock';

export type { LockOptions, LockStats } from '../../../types/lock';

interface LockRecord {
    lockId: string;
    expiresAt: number;
}

interface LockManagerOptions {
    logger?: LoggerLike | null;
    lockKeyPrefix?: string;
    maxDuration?: number;
}

/**
 * Error thrown when a distributed lock cannot be acquired.
 * @since v1.4.0
 */
export class LockAcquireError extends Error {
    readonly code = 'LOCK_ACQUIRE_FAILED';

    constructor(message: string) {
        super(message);
        this.name = 'LockAcquireError';
    }
}

/**
 * Error thrown when a distributed lock acquisition times out.
 * @since v1.4.0
 */
export class LockTimeoutError extends Error {
    readonly code = 'LOCK_TIMEOUT';

    constructor(message: string) {
        super(message);
        this.name = 'LockTimeoutError';
    }
}

class NoopLockManager {
    async releaseLock(): Promise<boolean> {
        return true;
    }

    async renewLock(): Promise<boolean> {
        return true;
    }
}

// Module-level singleton shared by all LockManager instances in the same process.
// Isolation is prefix-scoped: use distinct lockKeyPrefix values for independent namespaces.
const globalStore = new Map<string, LockRecord>();

/**
 * Represents an acquired distributed lock.
 * Call {@link Lock#release} when the critical section is complete.
 * @since v1.4.0
 */
export class Lock {
    readonly acquiredAt = Date.now();
    released = false;

    constructor(
        readonly key: string,
        readonly lockId: string,
        readonly manager: {
            releaseLock: (key: string, lockId: string) => Promise<boolean>;
            renewLock: (key: string, lockId: string, ttl: number) => Promise<boolean>;
        },
        readonly ttl: number,
    ) { }

    /**
     * Release the lock.
     * @since v1.4.0
     */
    async release(): Promise<boolean> {
        if (this.released) {
            return false;
        }
        const released = await this.manager.releaseLock(this.key, this.lockId);
        this.released = released || this.released;
        return released;
    }

    /**
     * Renew the lock.
     * @since v1.4.0
     */
    async renew(ttl?: number): Promise<boolean> {
        if (this.released) {
            return false;
        }
        return this.manager.renewLock(this.key, this.lockId, ttl ?? this.ttl);
    }

    /**
     * Check whether the lock is still held.
     * @since v1.4.0
     */
    isHeld(): boolean {
        return !this.released;
    }

    /**
     * Get the duration the lock has been held.
     * @since v1.4.0
     */
    getHoldTime(): number {
        return Date.now() - this.acquiredAt;
    }
}

/**
 * Manages distributed locks backed by an optional Redis store.
 * Falls back to an in-process memory store when Redis is unavailable.
 * @since v1.4.0
 */
export class LockManager {
    private readonly logger: LoggerLike | null;
    private readonly lockKeyPrefix: string;
    private readonly maxDuration: number;
    private readonly stats = {
        locksAcquired: 0,
        locksReleased: 0,
        lockChecks: 0,
        errors: 0,
    };

    constructor(options: LockManagerOptions = {}) {
        this.logger = options.logger ?? null;
        this.lockKeyPrefix = options.lockKeyPrefix ?? 'monsqlize:lock:';
        this.maxDuration = options.maxDuration ?? 300000;
    }

    /**
     * Automatically manage the business lock lifecycle.
     * @since v1.4.0
     */
    async withLock<T>(key: string, callback: () => Promise<T>, options: LockOptions = {}): Promise<T> {
        const lock = await this.acquireLock(key, options);
        try {
            return await callback();
        } finally {
            await lock.release();
        }
    }

    /**
     * Acquire a lock (blocking with retries).
     * @since v1.4.0
     */
    async acquireLock(key: string, options: LockOptions = {}): Promise<Lock> {
        const retryTimes = options.retryTimes ?? 3;
        const retryDelay = options.retryDelay ?? 100;
        const retryBackoff = options.retryBackoff ?? 1;

        for (let attempt = 0; attempt <= retryTimes; attempt += 1) {
            const lock = await this.tryAcquireLock(key, options);
            if (lock) {
                return lock;
            }
            if (attempt === retryTimes) {
                break;
            }
            const delay = retryDelay * Math.pow(retryBackoff, attempt);
            await sleep(delay);
        }

        this.stats.errors += 1;
        if (options.fallbackToNoLock) {
            this.logger?.warn?.(`[LockManager] fallback to no-lock execution for ${key}`);
            return new Lock(this.normalizeKey(key), `noop:${randomUUID()}`, new NoopLockManager(), options.ttl ?? 10000);
        }

        throw new LockTimeoutError(`Failed to acquire lock for key '${key}' within retry budget.`);
    }

    /**
     * Try to acquire a lock (non-blocking).
     * @since v1.4.0
     */
    async tryAcquireLock(key: string, options: Omit<LockOptions, 'retryTimes'> = {}): Promise<Lock | null> {
        const normalizedKey = this.normalizeKey(key);
        const ttl = options.ttl ?? 10000;
        this.cleanupExpiredLocks();
        this.stats.lockChecks += 1;

        if (globalStore.has(normalizedKey)) {
            return null;
        }

        const lockId = randomUUID();
        globalStore.set(normalizedKey, {
            lockId,
            expiresAt: Date.now() + ttl,
        });
        this.stats.locksAcquired += 1;
        this.logger?.debug?.(`[LockManager] acquired ${normalizedKey}`);

        return new Lock(normalizedKey, lockId, this, ttl);
    }

    /**
     * Check whether a lock exists.
     * @since v1.4.0
     */
    isLocked(key: string): boolean {
        this.cleanupExpiredLocks();
        this.stats.lockChecks += 1;
        return globalStore.has(this.normalizeKey(key));
    }

    /**
     * Release a lock.
     * @since v1.4.0
     */
    async releaseLock(key: string, lockId: string): Promise<boolean> {
        const normalizedKey = this.normalizeKey(key);
        this.cleanupExpiredLocks();
        const current = globalStore.get(normalizedKey);
        if (!current || current.lockId !== lockId) {
            return false;
        }
        globalStore.delete(normalizedKey);
        this.stats.locksReleased += 1;
        this.logger?.debug?.(`[LockManager] released ${normalizedKey}`);
        return true;
    }

    /**
     * Renew a lock.
     * @since v1.4.0
     */
    async renewLock(key: string, lockId: string, ttl: number): Promise<boolean> {
        const normalizedKey = this.normalizeKey(key);
        this.cleanupExpiredLocks();
        const current = globalStore.get(normalizedKey);
        if (!current || current.lockId !== lockId) {
            return false;
        }
        current.expiresAt = Date.now() + ttl;
        return true;
    }

    /**
     * Get lock statistics.
     * @since v1.4.0
     */
    getStats(): LockStats {
        this.cleanupExpiredLocks();
        return {
            ...this.stats,
            lockKeyPrefix: this.lockKeyPrefix,
            maxDuration: this.maxDuration,
            activeLocks: globalStore.size,
        };
    }

    /**
     * Clear all locks (primarily for testing).
     * @since v1.4.0
     */
    clear(): void {
        for (const key of [...globalStore.keys()]) {
            if (key.startsWith(this.lockKeyPrefix)) {
                globalStore.delete(key);
            }
        }
    }

    /**
     * Close the lock manager.
     * @since v1.4.0
     */
    close(): void {
        this.cleanupExpiredLocks();
    }

    private normalizeKey(key: string): string {
        return key.startsWith(this.lockKeyPrefix) ? key : `${this.lockKeyPrefix}${key}`;
    }

    private cleanupExpiredLocks(): void {
        const now = Date.now();
        for (const [key, value] of globalStore.entries()) {
            if (value.expiresAt <= now) {
                globalStore.delete(key);
            }
        }
    }
}

async function sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Redis-based distributed business lock manager (v1 compat).
 * Implements cross-instance distributed locks via Redis to ensure transaction isolation.
 * @since v1.4.0
 */
export class DistributedCacheLockManager {
    private readonly redis: {
        on: (event: string, handler: (...args: unknown[]) => void) => void;
        set: (key: string, value: string, ...args: unknown[]) => Promise<string | null>;
        eval: (script: string, numkeys: number, ...args: unknown[]) => Promise<unknown>;
        keys: (pattern: string) => Promise<string[]>;
        scan?: (cursor: string, ...args: unknown[]) => Promise<[string | number, string[]]>;
        exists: (key: string) => Promise<number>;
    };
    private readonly lockKeyPrefix: string;
    private readonly maxDuration: number;
    private readonly logger: LoggerLike | null;
    private readonly stats = {
        locksAcquired: 0,
        locksReleased: 0,
        lockChecks: 0,
        errors: 0,
    };

    constructor(options: {
        redis: unknown;
        lockKeyPrefix?: string;
        maxDuration?: number;
        logger?: LoggerLike | null;
    }) {
        if (!options.redis) {
            throw createError(ErrorCodes.INVALID_CONFIG, 'DistributedCacheLockManager requires a Redis instance');
        }
        this.redis = options.redis as typeof this.redis;
        this.lockKeyPrefix = options.lockKeyPrefix ?? 'monsqlize:cache:lock:';
        this.maxDuration = options.maxDuration ?? 300000;
        this.logger = options.logger ?? null;
        this.redis.on('error', (err: unknown) => {
            this.stats.errors++;
            if (this.logger) {
                const msg = err instanceof Error ? err.message : String(err);
                this.logger?.error?.('[DistributedCacheLockManager] Redis error:', msg);
            }
        });
    }

    async addLock(key: string, session: { id: unknown }): Promise<boolean> {
        if (!session || !session.id) return false;
        const lockKey = this.lockKeyPrefix + key;
        const sessionId = String(session.id);
        const ttlSeconds = Math.ceil(this.maxDuration / 1000);
        try {
            const result = await this.redis.set(lockKey, sessionId, 'EX', ttlSeconds, 'NX');
            if (result === 'OK') {
                this.stats.locksAcquired++;
                return true;
            }
            return false;
        } catch (error) {
            this.stats.errors++;
            return false;
        }
    }

    async isLocked(key: string): Promise<boolean> {
        this.stats.lockChecks++;
        try {
            const lockKey = this.lockKeyPrefix + key;
            const exists = await this.redis.exists(lockKey);
            if (exists) return true;
            const pattern = this.lockKeyPrefix + '*';
            const keys = await this._scanKeys(pattern);
            for (const foundKey of keys) {
                const lockPattern = foundKey.replace(this.lockKeyPrefix, '');
                if (lockPattern.includes('*')) {
                    const regex = this._patternToRegex(lockPattern);
                    if (regex.test(key)) return true;
                }
            }
            return false;
        } catch {
            return false;
        }
    }

    async releaseLocks(session: { id: unknown }): Promise<number> {
        if (!session || !session.id) return 0;
        const sessionId = String(session.id);
        const pattern = this.lockKeyPrefix + '*';
        try {
            const keys = await this._scanKeys(pattern);
            if (keys.length === 0) return 0;
            const luaScript = `
                local deletedCount = 0
                for i, key in ipairs(KEYS) do
                    local value = redis.call('GET', key)
                    if value == ARGV[1] then
                        redis.call('DEL', key)
                        deletedCount = deletedCount + 1
                    end
                end
                return deletedCount
            `;
            let totalDeleted = 0;
            for (let index = 0; index < keys.length; index += 500) {
                const batch = keys.slice(index, index + 500);
                const deleted = await this.redis.eval(luaScript, batch.length, ...batch, sessionId) as number;
                totalDeleted += deleted;
            }
            this.stats.locksReleased += totalDeleted;
            return totalDeleted;
        } catch {
            return 0;
        }
    }

    async withLock<T>(key: string, callback: () => Promise<T>, options: {
        ttl?: number;
        retryTimes?: number;
        retryDelay?: number;
        fallbackToNoLock?: boolean;
    } = {}): Promise<T> {
        let lock: Lock;
        try {
            lock = await this.acquireLock(key, options);
        } catch (error) {
            if (this._isRedisConnectionError(error as Error) && options.fallbackToNoLock) {
                return callback();
            }
            throw error;
        }
        try {
            return await callback();
        } finally {
            await lock.release().catch(() => { });
        }
    }

    async acquireLock(key: string, options: {
        ttl?: number;
        retryTimes?: number;
        retryDelay?: number;
    } = {}): Promise<Lock> {
        const ttl = options.ttl ?? 10000;
        const retryTimes = options.retryTimes ?? 3;
        const retryDelay = options.retryDelay ?? 100;
        const lockId = this._generateLockId();
        const fullKey = this.lockKeyPrefix + key;
        for (let attempt = 0; attempt <= retryTimes; attempt++) {
            try {
                const result = await this.redis.set(fullKey, lockId, 'PX', ttl, 'NX');
                if (result === 'OK') {
                    this.stats.locksAcquired++;
                    return new Lock(key, lockId, this, ttl);
                }
                if (attempt === retryTimes) break;
                await sleep(retryDelay);
            } catch (error) {
                if (attempt === retryTimes) throw error;
                await sleep(retryDelay);
            }
        }
        this.stats.errors++;
        throw new LockAcquireError(`Failed to acquire lock: ${key}`);
    }

    async tryAcquireLock(key: string, options: { ttl?: number } = {}): Promise<Lock | null> {
        const ttl = options.ttl ?? 10000;
        const lockId = this._generateLockId();
        const fullKey = this.lockKeyPrefix + key;
        try {
            const result = await this.redis.set(fullKey, lockId, 'PX', ttl, 'NX');
            if (result === 'OK') {
                this.stats.locksAcquired++;
                return new Lock(key, lockId, this, ttl);
            }
            return null;
        } catch {
            return null;
        }
    }

    async releaseLock(key: string, lockId: string): Promise<boolean> {
        const fullKey = this.lockKeyPrefix + key;
        try {
            const luaScript = `
                if redis.call("get", KEYS[1]) == ARGV[1] then
                    return redis.call("del", KEYS[1])
                else
                    return 0
                end
            `;
            const result = await this.redis.eval(luaScript, 1, fullKey, lockId) as number;
            if (result === 1) {
                this.stats.locksReleased++;
                return true;
            }
            return false;
        } catch {
            this.stats.errors++;
            return false;
        }
    }

    async renewLock(key: string, lockId: string, ttl: number): Promise<boolean> {
        const fullKey = this.lockKeyPrefix + key;
        try {
            const luaScript = `
                if redis.call("get", KEYS[1]) == ARGV[1] then
                    return redis.call("pexpire", KEYS[1], ARGV[2])
                else
                    return 0
                end
            `;
            const result = await this.redis.eval(luaScript, 1, fullKey, lockId, ttl) as number;
            return result === 1;
        } catch {
            return false;
        }
    }

    getStats() {
        return { ...this.stats, lockKeyPrefix: this.lockKeyPrefix, maxDuration: this.maxDuration };
    }

    stop(): void { }

    async cleanup(): Promise<void> { }

    _generateLockId(): string {
        return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }

    private async _scanKeys(pattern: string): Promise<string[]> {
        if (typeof this.redis.scan !== 'function') {
            return this.redis.keys(pattern);
        }

        const keys: string[] = [];
        let cursor = '0';
        do {
            const [nextCursor, batch] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
            if (Array.isArray(batch)) {
                keys.push(...batch.map(String));
            }
            cursor = String(nextCursor);
        } while (cursor !== '0');

        return keys;
    }

    private _patternToRegex(pattern: string): RegExp {
        const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const wildcarded = escaped.replace(/\\\*/g, '.*');
        return new RegExp(`^${wildcarded}$`);
    }

    private _isRedisConnectionError(error: Error): boolean {
        const msg = error.message || '';
        return msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT') ||
            msg.includes('ENOTFOUND') || msg.includes('Connection is closed');
    }
}
