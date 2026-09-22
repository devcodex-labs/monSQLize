import { SSHTunnelSSH2, parseHostFromUri, parsePortFromUri, validateSingleMongoHostUri } from '../capabilities/ssh';
import type { Logger } from '../core/logger';
import type { MonSQLizeOptions } from '../../types/monsqlize';

type RuntimeConnectConfig = MonSQLizeOptions['config'];

export async function prepareSshTunnelConnectConfig(
    connectConfig: RuntimeConnectConfig,
    databaseName: string,
    logger: Logger,
): Promise<{ connectConfig: RuntimeConnectConfig; tunnel: SSHTunnelSSH2 | null }> {
    const sshCfg = (connectConfig as Record<string, unknown> | undefined)?.['ssh'];
    if (!sshCfg || typeof sshCfg !== 'object') {
        return { connectConfig, tunnel: null };
    }

    if (connectConfig?.uri) {
        validateSingleMongoHostUri(connectConfig.uri);
    }

    const cfg = sshCfg as Record<string, unknown>;
    const rawCfg = connectConfig as Record<string, unknown>;
    const uri = String(connectConfig?.uri ?? '');
    const remoteHost = String(cfg['dstHost'] ?? rawCfg['remoteHost'] ?? rawCfg['mongoHost'] ?? parseHostFromUri(uri));
    const remotePort = Number(cfg['dstPort'] ?? rawCfg['remotePort'] ?? rawCfg['mongoPort'] ?? parsePortFromUri(uri));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tunnel = new SSHTunnelSSH2(sshCfg as any, remoteHost, remotePort, { name: databaseName });

    logger.info?.(`[SSH] Establishing tunnel to ${remoteHost}:${remotePort} via ${String(cfg['host'])}`);
    try {
        await tunnel.connect();
        logger.info?.(`[SSH] Tunnel ready — local address: ${tunnel.getLocalAddress()}`);
        return {
            tunnel,
            connectConfig: connectConfig?.uri
                ? { ...connectConfig, uri: tunnel.getTunnelUri('mongodb', connectConfig.uri) }
                : connectConfig,
        };
    } catch (error) {
        await tunnel.close();
        throw error;
    }
}
