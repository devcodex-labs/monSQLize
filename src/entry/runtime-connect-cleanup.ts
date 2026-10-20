import { closeMongo } from '../adapters/mongodb/common/connect';
import type { LoggerLike } from '../core/logger';

interface ClosableResource {
    close(): unknown;
}

interface StoppableResource {
    stop(): unknown;
}

interface AbortableResource {
    abortAll(): unknown;
}

export interface FailedRuntimeConnectionResources {
    client: ClosableResource | null;
    pool: ClosableResource | null;
    tunnel: ClosableResource | null;
    invalidator: ClosableResource | null;
    sync: StoppableResource | null;
    slowQuery: ClosableResource | null;
    transaction: AbortableResource | null;
    lock: ClosableResource | null;
}

export async function cleanupFailedRuntimeConnection(
    resources: FailedRuntimeConnectionResources,
    logger: LoggerLike,
    reason = 'after failed connect',
): Promise<Set<keyof FailedRuntimeConnectionResources>> {
    const failed = new Set<keyof FailedRuntimeConnectionResources>();
    const release = async (key: keyof FailedRuntimeConnectionResources, operation: () => unknown) => {
        try { await Promise.resolve().then(operation); }
        catch (error) {
            failed.add(key);
            try { logger.warn?.(reason === 'during close' && key === 'tunnel' ? '[SSH] Error closing SSH tunnel' : `[MonSQLizeRuntime] ${key === 'lock' ? 'lock ' : ''}cleanup error ${reason}`, error); } catch { /* Continue releasing other owned resources. */ }
        }
    };
    await Promise.all([
        release('lock', () => resources.lock?.close()),
        release('sync', () => resources.sync?.stop()),
        release('slowQuery', () => resources.slowQuery?.close()),
        release('transaction', () => resources.transaction?.abortAll()),
        release('pool', () => resources.pool?.close()),
        release('invalidator', () => resources.invalidator?.close()),
    ]);
    await release('client', () => closeMongo(resources.client as Parameters<typeof closeMongo>[0], logger as Parameters<typeof closeMongo>[1], true));
    await release('tunnel', () => resources.tunnel?.close());
    return failed;
}
