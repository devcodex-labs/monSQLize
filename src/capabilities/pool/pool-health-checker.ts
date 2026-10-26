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
    private readonly _inProgress = new Map<string, { client: unknown; promise: Promise<unknown>; awaited: boolean }>();
    private readonly _epochs = new Map<string, number>();
    private readonly _pingOverride?: (poolName: string) => Promise<unknown>;
    _started = false;

    constructor(options: { poolManager?: HealthCheckerPoolManager; logger?: HealthCheckerLogger; ping?: (poolName: string) => Promise<unknown>; } = {}) {
        this._poolManager = options.poolManager ?? null;
        this._pingOverride = options.ping;
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

        this.cancel(poolName);
        this._checkConfigs.set(poolName, healthCheckConfig);
        if (client !== null) this._clients.set(poolName, client);
        const initialStatus: 'up' | 'down' | 'checking' | 'unknown' = typeof poolNameOrConfig === 'string' ? 'up' : 'unknown';
        this._healthStatus.set(poolName, { status: initialStatus, lastCheck: new Date(), consecutiveFailures: 0 });
        if (this._started) this._startCheckForPool(poolName, healthCheckConfig);
    }

    unregister(poolName: string): void {
        this.cancel(poolName);
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
        this._started = false;
        for (const poolName of this._checkConfigs.keys()) this.cancel(poolName);
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
        const timer = setInterval(() => { if (this._started) void this._checkPool(poolName, config); }, interval);
        (timer as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.();
        this._intervals.set(poolName, timer);
        setImmediate(() => { if (this._started && this._checkConfigs.get(poolName) === config) void this._checkPool(poolName, config); });
    }

    private _stopCheckForPool(poolName: string): void {
        const timer = this._intervals.get(poolName);
        if (timer) {
            clearInterval(timer);
            this._intervals.delete(poolName);
        }
    }

    cancel(poolName: string): void {
        this._epochs.set(poolName, (this._epochs.get(poolName) ?? 0) + 1);
    }

    private async _checkPool(poolName: string, config: Record<string, unknown>): Promise<void> {
        const status = this._healthStatus.get(poolName);
        if (!status) return;
        const client = this._clients.get(poolName) ?? this._poolManager?._getPool(poolName);
        const pending = this._inProgress.get(poolName);
        // One ping per pool at a time. A check already waiting on it owns the result; once that
        // wait timed out, later checks wait on the same hung ping again so every timeout window
        // still counts as a failure and `retries` can be reached without stacking new pings.
        if (pending && pending.client === client && pending.awaited) return;
        const epoch = this._epochs.get(poolName);
        let operation: { client: unknown; promise: Promise<unknown>; awaited: boolean };
        if (pending && pending.client === client) {
            operation = pending;
        } else {
            const promise = Promise.resolve().then(() => {
                if (this._epochs.get(poolName) !== epoch || this._healthStatus.get(poolName) !== status) return;
                return this._pingOverride ? this._pingOverride(poolName) : this._pingPool(poolName);
            });
            operation = { client, promise, awaited: true };
            this._inProgress.set(poolName, operation);
            const clearPending = () => { if (this._inProgress.get(poolName) === operation) this._inProgress.delete(poolName); };
            void promise.then(clearPending, clearPending);
        }
        operation.awaited = true;
        const promise = operation.promise;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let lastError: Error | null = null;
        try {
            await Promise.race([promise, new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('Ping timeout')), (config.timeout as number) ?? 3000);
                timer.unref?.();
            })]);
        } catch (error) { lastError = error instanceof Error ? error : new Error(String(error)); }
        finally { if (timer) clearTimeout(timer); operation.awaited = false; }
        if (this._epochs.get(poolName) !== epoch || this._healthStatus.get(poolName) !== status) return;
        status.lastCheck = new Date();
        if (!lastError) {
            status.status = 'up';
            status.consecutiveFailures = 0;
            delete status.lastError;
        } else {
            status.consecutiveFailures++;
            status.lastError = lastError;
            status.status = status.consecutiveFailures >= Math.max(1, (config.retries as number) ?? 3) || status.status === 'down' ? 'down' : 'up';
        }
    }

    private async _pingPool(poolName: string): Promise<void> {
        const client = (this._clients.get(poolName) ?? this._poolManager?._getPool(poolName)) as {
            db: (name: string) => { command?: (cmd: Record<string, unknown>) => Promise<unknown>; admin?: () => { ping: () => Promise<unknown> }; };
        } | null | undefined;
        if (!client) throw createError(ErrorCodes.POOL_NOT_FOUND, `No client for pool: ${poolName}`);
        const db = client.db('admin');
        await (db.command ? db.command({ ping: 1 }) : db.admin!().ping());
    }

    getStatus(poolName: string): HealthStatus | null {
        return this._healthStatus.get(poolName) ?? null;
    }

    getAllStatus(): Map<string, HealthStatus> {
        return new Map(this._healthStatus);
    }
}
