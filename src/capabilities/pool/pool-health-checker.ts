/**
 * Connection pool health checker.
 *
 * Periodically pings each pool and maintains status / latency / lastCheck state,
 * providing demotion and exclusion signals for the auto selection strategy.
 */
import { createError, ErrorCodes } from '../../core/errors';

export interface HealthStatus {
    status: 'up' | 'down' | 'checking' | 'unknown';
    lastCheck: Date;
    consecutiveFailures: number;
    lastError?: Error | null;
}

interface HealthCheckerPoolManager {
    _getPool(name: string): { db: (name: string) => { command: (cmd: Record<string, unknown>) => Promise<unknown> }; } | null;
}

type HealthCheckerLogger = {
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
};

const SILENT_HEALTH_CHECKER_LOGGER: HealthCheckerLogger = {};

export class HealthChecker {
    private readonly _poolManager: HealthCheckerPoolManager | null;
    private readonly _logger: HealthCheckerLogger;
    private readonly _healthStatus = new Map<string, HealthStatus>();
    private readonly _checkConfigs = new Map<string, Record<string, unknown>>();
    private readonly _clients = new Map<string, unknown>();
    private readonly _intervals = new Map<string, ReturnType<typeof setInterval>>();
    private readonly _inProgress = new Set<string>();
    _started = false;

    constructor(options: { poolManager?: HealthCheckerPoolManager; logger?: HealthCheckerLogger; } = {}) {
        this._poolManager = options.poolManager ?? null;
        this._logger = options.logger ?? SILENT_HEALTH_CHECKER_LOGGER;
    }

    register(poolNameOrConfig: string | Record<string, unknown>, configOrClient?: Record<string, unknown> | null | unknown): void {
        let poolName: string;
        let healthCheckConfig: Record<string, unknown>;
        let client: unknown = null;

        if (typeof poolNameOrConfig === 'string') {
            poolName = poolNameOrConfig;
            healthCheckConfig = (configOrClient as Record<string, unknown>) ?? {};
        } else {
            poolName = poolNameOrConfig.name as string;
            healthCheckConfig = (poolNameOrConfig.healthCheck as Record<string, unknown>) ?? {};
            client = configOrClient ?? null;
        }

        this._checkConfigs.set(poolName, healthCheckConfig);
        if (client !== null) this._clients.set(poolName, client);
        const initialStatus: 'up' | 'down' | 'checking' | 'unknown' = typeof poolNameOrConfig === 'string' ? 'up' : 'unknown';
        this._healthStatus.set(poolName, { status: initialStatus, lastCheck: new Date(), consecutiveFailures: 0 });
        if (this._started) this._startCheckForPool(poolName, healthCheckConfig);
    }

    unregister(poolName: string): void {
        this._stopCheckForPool(poolName);
        this._healthStatus.delete(poolName);
        this._checkConfigs.delete(poolName);
        this._clients.delete(poolName);
    }

    start(): void {
        if (this._started) return;
        this._started = true;
        for (const [poolName, config] of this._checkConfigs.entries()) {
            this._startCheckForPool(poolName, config);
        }
        this._logger.info?.('[HealthChecker] Health check started');
    }

    stop(): void {
        if (!this._started) return;
        this._started = false;
        for (const poolName of this._intervals.keys()) this._stopCheckForPool(poolName);
        this._logger.info?.('[HealthChecker] Health check stopped');
    }

    async checkPool(poolName: string): Promise<void> {
        const config = this._checkConfigs.get(poolName) ?? {};
        await this._checkPool(poolName, config);
    }

    private _startCheckForPool(poolName: string, config: Record<string, unknown>): void {
        if (config.enabled === false) return;
        this._stopCheckForPool(poolName);
        const interval = (config.interval as number) ?? 5000;
        const timer = setInterval(async () => { await this._checkPool(poolName, config); }, interval);
        (timer as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.();
        this._intervals.set(poolName, timer);
        setImmediate(async () => { await this._checkPool(poolName, config); });
    }

    private _stopCheckForPool(poolName: string): void {
        const timer = this._intervals.get(poolName);
        if (timer) {
            clearInterval(timer);
            this._intervals.delete(poolName);
        }
    }

    private async _checkPool(poolName: string, config: Record<string, unknown>): Promise<void> {
        if (this._inProgress.has(poolName)) return;
        this._inProgress.add(poolName);
        try {
            const status = this._healthStatus.get(poolName);
            if (!status) return;

            status.status = 'checking';
            status.lastCheck = new Date();
            const retries = (config.retries as number) ?? 3;
            let success = false;
            let lastError: Error | null = null;

            try {
                await this._pingPool(poolName, (config.timeout as number) ?? 3000);
                success = true;
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
            }

            if (success) {
                status.status = 'up';
                status.consecutiveFailures = 0;
                delete status.lastError;
            } else {
                status.consecutiveFailures += 1;
                if (lastError) status.lastError = lastError;
                if (status.consecutiveFailures >= retries) {
                    status.status = 'down';
                }
            }
        } finally {
            this._inProgress.delete(poolName);
        }
    }

    private async _pingPool(poolName: string, timeout: number): Promise<void> {
        const stored = this._clients.get(poolName);
        const client = (stored ?? this._poolManager?._getPool(poolName)) as {
            db: (name: string) => { command?: (cmd: Record<string, unknown>) => Promise<unknown>; admin?: () => { ping: () => Promise<unknown> }; };
        } | null | undefined;
        if (!client) throw createError(ErrorCodes.POOL_NOT_FOUND, `No client for pool: ${poolName}`);
        const db = client.db('admin');
        const pingFn = db.command ? () => db.command!({ ping: 1 }) : () => db.admin!().ping();
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
        const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(() => reject(new Error('Ping timeout')), timeout);
            timeoutHandle.unref?.();
        });
        try {
            await Promise.race([pingFn(), timeoutPromise]);
        } finally {
            if (timeoutHandle) {
                clearTimeout(timeoutHandle);
            }
        }
    }

    getStatus(poolName: string): HealthStatus | null {
        return this._healthStatus.get(poolName) ?? null;
    }

    getAllStatus(): Map<string, HealthStatus> {
        return new Map(this._healthStatus);
    }
}
