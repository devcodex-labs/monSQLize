import type { CacheLike, DistributedCacheInvalidator } from '../capabilities/cache';
import type { ConnectionPoolManager } from '../capabilities/pool';

type ComponentStatus = 'up' | 'down' | 'unknown';

export function summarizeRuntimeHealth(
    cacheOption: unknown,
    cache: CacheLike,
    poolManager: ConnectionPoolManager | null,
    invalidator: DistributedCacheInvalidator | null,
) {
    const cacheStats = (cache as { getStats?: () => unknown }).getStats?.();
    const poolHealth = poolManager?.getHealthStatus();
    const distributedStats = invalidator?.getStats() ?? null;
    const cacheInput = cacheOption as { enabled?: boolean; distributed?: { enabled?: boolean } } | undefined;
    const cacheEnabled = cacheInput?.enabled !== false;
    const distributedEnabled = cacheInput?.distributed !== undefined && cacheInput.distributed.enabled !== false;
    const cacheProbe = cacheEnabled ? (cache as { getHealthStatus?: () => unknown }).getHealthStatus?.() : undefined;
    const cacheProbeStatus: ComponentStatus = cacheProbe === true || cacheProbe === 'up'
        ? 'up' : cacheProbe === false || cacheProbe === 'down' ? 'down' : 'unknown';
    const redisState = invalidator as unknown as { pub?: { status?: string }; sub?: { status?: string } } | null;
    const redisStatuses = [redisState?.pub?.status, redisState?.sub?.status];
    const distributedStatus: ComponentStatus = !distributedEnabled || !invalidator
        ? 'unknown' : redisStatuses.every((status) => status === 'ready') ? 'up'
            : redisStatuses.some((status) => status === 'end' || status === 'close') ? 'down' : 'unknown';
    const poolStates = Object.values(poolHealth ?? {}).map((health) => health.status);
    const poolsStatus: ComponentStatus = poolStates.length === 0 ? 'unknown'
        : poolStates.some((status) => status === 'down') ? 'down'
            : poolStates.every((status) => status === 'up') ? 'up' : 'unknown';
    return { cacheStats, poolHealth, distributedStats, cacheEnabled, distributedEnabled,
        cacheProbeStatus, distributedStatus, poolsStatus };
}
