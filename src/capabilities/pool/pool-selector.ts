/**
 * Pool selection strategies (PoolSelector).
 *
 * Implements five routing strategies — auto / roundRobin / leastConnections /
 * weighted / manual — with dynamic target selection based on role, tags, and weight.
 */
import { createError, ErrorCodes } from '../../core/errors';
import type { LoggerLike } from '../../core/logger';

type PoolSelectorPoolConfig = {
    name: string;
    role?: string;
    weight?: number;
    status?: string;
    tags?: string[];
};

type PoolSelectorContext = {
    operation?: string;
    stats?: Record<string, { connections?: number }>;
    poolPreference?: {
        role?: string;
        tags?: string[];
    };
};

type PoolSelectorOptions = {
    strategy?: string;
    logger?: Pick<LoggerLike, 'warn' | 'info'>;
};

const SILENT_POOL_SELECTOR_LOGGER: Pick<LoggerLike, 'warn' | 'info'> = {};

const POOL_STRATEGY_ALIASES: Record<string, string> = {
    'round-robin': 'roundRobin',
    'least-connections': 'leastConnections',
    random: 'weighted',
};

function normalizePoolStrategy(strategy: string | undefined): string {
    const value = strategy ?? 'auto';
    return POOL_STRATEGY_ALIASES[value] ?? value;
}

/**
 * Pool routing selector.
 *
 * Design notes:
 * - Implements five strategies, switchable at runtime via setStrategy() without rebuilding the instance:
 *   · auto             — read/write split first (read→secondary / write→primary),
 *                        then filter candidates by role/tags, finally route by weighted random.
 *   · roundRobin       — maintains a round-robin cursor per operation key, respecting role filters.
 *   · leastConnections — prefers the pool with the fewest active connections (requires stats input).
 *   · weighted         — pure weighted random, ignores role.
 *   · manual           — always returns the first pool (caller controls ordering).
 * - Tag filtering: single tag → some (any match); multiple tags → every (all must match).
 * - Strategy fallback: unknown strategies silently fall back to auto with a warn log.
 * @since v1.5.0
 */
export class PoolSelector {
    private _strategy: string;
    private readonly _logger: Pick<LoggerLike, 'warn' | 'info'>;
    private readonly _roundRobinIndex = new Map<string, number>();

    constructor(options: PoolSelectorOptions = {}) {
        this._strategy = normalizePoolStrategy(options.strategy);
        this._logger = options.logger ?? SILENT_POOL_SELECTOR_LOGGER;
    }

    select(pools: PoolSelectorPoolConfig[], context: PoolSelectorContext): string {
        if (!pools || pools.length === 0) {
            throw createError(ErrorCodes.INVALID_OPERATION, 'No available pools');
        }
        switch (this._strategy) {
            case 'auto':
                return this.selectByAuto(pools, context);
            case 'roundRobin':
                return this.selectByRoundRobin(pools, context);
            case 'leastConnections':
                return this.selectByLeastConnections(pools, context);
            case 'weighted':
                return this.selectByWeighted(pools);
            case 'manual':
                return pools[0].name;
            default:
                this._logger.warn?.(`[PoolSelector] Unknown strategy: ${this._strategy}, falling back to auto`);
                return this.selectByAuto(pools, context);
        }
    }

    private selectByAuto(pools: PoolSelectorPoolConfig[], context: PoolSelectorContext): string {
        const { operation, poolPreference } = context;
        let candidates = pools;

        const preferred = this.filterByPreference(pools, poolPreference);
        if (preferred.length > 0) {
            candidates = preferred;
        } else if (operation === 'read') {
            const secondaries = pools.filter((pool) => pool.role === 'secondary');
            if (secondaries.length > 0) {
                candidates = secondaries;
            }
        } else if (operation === 'write') {
            const primaries = pools.filter((pool) => pool.role === 'primary');
            if (primaries.length > 0) {
                candidates = primaries;
            }
        }

        if (candidates.length === 1) {
            return candidates[0].name;
        }
        return this.selectByWeighted(candidates);
    }

    private filterByPreference(
        pools: PoolSelectorPoolConfig[],
        poolPreference: PoolSelectorContext['poolPreference'],
    ): PoolSelectorPoolConfig[] {
        let candidates = pools;
        let applied = false;

        if (poolPreference?.role) {
            const filteredByRole = candidates.filter((pool) => pool.role === poolPreference.role);
            if (filteredByRole.length > 0) {
                candidates = filteredByRole;
                applied = true;
            }
        }

        if (poolPreference?.tags?.length) {
            const tags = poolPreference.tags;
            const filteredByTags = candidates.filter((pool) => {
                if (!pool.tags) {
                    return false;
                }
                return tags.length === 1
                    ? tags.some((tag) => pool.tags?.includes(tag))
                    : tags.every((tag) => pool.tags?.includes(tag));
            });
            if (filteredByTags.length > 0) {
                candidates = filteredByTags;
                applied = true;
            }
        }

        return applied ? candidates : [];
    }

    private selectByRoundRobin(pools: PoolSelectorPoolConfig[], context: PoolSelectorContext): string {
        let candidates = pools;
        if (context.operation === 'read') {
            const nonPrimary = pools.filter((pool) => pool.role === 'secondary' || pool.role === 'analytics');
            if (nonPrimary.length > 0) {
                candidates = nonPrimary;
            }
        } else if (context.operation === 'write') {
            const primaries = pools.filter((pool) => pool.role === 'primary');
            if (primaries.length > 0) {
                candidates = primaries;
            }
        }

        const key = context.operation ?? 'default';
        const index = this._roundRobinIndex.get(key) ?? 0;
        const pool = candidates[index % candidates.length];
        this._roundRobinIndex.set(key, (index + 1) % candidates.length);
        return pool.name;
    }

    private selectByLeastConnections(pools: PoolSelectorPoolConfig[], context: PoolSelectorContext): string {
        if (!context.stats) {
            return this.selectByRoundRobin(pools, context);
        }

        let minConnections = Infinity;
        let selectedPool = pools[0];
        for (const pool of pools) {
            const poolStats = context.stats[pool.name];
            if (!poolStats) {
                continue;
            }
            const connections = poolStats.connections ?? 0;
            if (connections < minConnections) {
                minConnections = connections;
                selectedPool = pool;
            }
        }
        return selectedPool.name;
    }

    private selectByWeighted(pools: PoolSelectorPoolConfig[]): string {
        let totalWeight = 0;
        for (const pool of pools) {
            totalWeight += pool.weight ?? 1;
        }
        let random = Math.random() * totalWeight;
        for (const pool of pools) {
            random -= pool.weight ?? 1;
            if (random <= 0) {
                return pool.name;
            }
        }
        return pools[0].name;
    }

    setStrategy(strategy: string): void {
        this._strategy = normalizePoolStrategy(strategy);
        this._logger.info?.(`[PoolSelector] Strategy changed: ${this._strategy}`);
    }

    getStrategy(): string {
        return this._strategy;
    }
}
