/**
 * Re-export of cache-hub MemoryCache with v1-compat `size` field added to getStats().
 *
 * v1 tests access `cache.getStats().size`; cache-hub returns `entries` instead.
 * This subclass adds `size` as an alias for `entries` to preserve the v1 API surface.
 */

import { MemoryCache as BaseMemoryCache } from 'cache-hub';
import type { LockManager } from 'cache-hub';

class MemoryCache extends BaseMemoryCache {
    private _compatLockManager: LockManager | null = null;

    override getMany(keys: string[]): Record<string, unknown> {
        if (!keys.includes('__proto__')) return super.getMany(keys);
        for (const key of keys) {
            if (typeof key !== 'string' || key.length === 0) return super.getMany(keys);
        }
        const result: Record<string, unknown> = {};
        for (const key of keys) {
            const value = super.get(key);
            if (value !== undefined) Object.defineProperty(result, key, { value, enumerable: true, configurable: true, writable: true });
        }
        return result;
    }

    override getRemainingTtlMany(keys: string[]): Record<string, number | null> {
        if (!keys.includes('__proto__')) return super.getRemainingTtlMany(keys);
        for (const key of keys) {
            if (typeof key !== 'string' || key.length === 0) return super.getRemainingTtlMany(keys);
        }
        const result = super.getRemainingTtlMany(keys.filter((key) => key !== '__proto__'));
        for (const key of keys) {
            if (key !== '__proto__') continue;
            const value = super.getRemainingTtl(key);
            if (value !== undefined) Object.defineProperty(result, key, { value, enumerable: true, configurable: true, writable: true });
        }
        return result;
    }

    override setLockManager(lockManager: LockManager): void {
        this._compatLockManager = lockManager;
        super.setLockManager(lockManager);
    }

    getLockManager(): LockManager | null {
        return this._compatLockManager;
    }

    override getStats() {
        const s = super.getStats();
        return { ...s, size: s.entries };
    }
}

export { MemoryCache };
