/**
 * SSH tunnel capability — port-forward MongoDB connections through a bastion host.
 *
 * Reconstructed from v1 SSHTunnelSSH2 behaviour (v1 source was not preserved).
 * Uses the `ssh2` package (already a project dependency).
 */

import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { createError, ErrorCodes } from '../../core/errors';

// ssh2 ships no bundled types; import via require and cast to our minimal interface.
interface SshStream extends NodeJS.ReadWriteStream {
    close(): void;
}
interface SshClientLike {
    connect(config: object): void;
    forwardOut(
        srcHost: string,
        srcPort: number,
        dstHost: string,
        dstPort: number,
        cb: (err: Error | undefined, stream: SshStream) => void,
    ): void;
    end(): void;
    on(event: 'ready', handler: () => void): this;
    on(event: 'error', handler: (err: Error) => void): this;
    on(event: 'close' | 'end', handler: () => void): this;
}
interface SshClientConstructor {
    new(): SshClientLike;
}

// Loaded lazily inside connect() to avoid a top-level require() in the ESM bundle.
function loadSsh2Client(): SshClientConstructor {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return (require('ssh2') as { Client: SshClientConstructor }).Client;
    } catch {
        throw createError(
            ErrorCodes.INVALID_CONFIG,
            'Unable to load ssh2. monsqlize installs ssh2 by default; check that the package installation is complete ' +
            'and that your runtime can resolve bundled dependencies.',
        );
    }
}

export interface SSHConfigInput {
    host: string;
    port?: number;
    username: string;
    password?: string;
    privateKey?: string | Buffer;
    /** Path to an SSH private key file (supports ~ for home directory). v1 compat. */
    privateKeyPath?: string;
    passphrase?: string;
    /** SSH handshake timeout in milliseconds (default: 20000). */
    readyTimeout?: number;
    /** Keep-alive interval in milliseconds (default: 30000). */
    keepaliveInterval?: number;
    /** ssh2 host-key hash algorithm; pair with hostVerifier for pinned fingerprints. */
    hostHash?: string;
    /** Return false to reject a server host key during the SSH handshake. */
    hostVerifier?: (key: string | Buffer) => boolean;
    /** Target remote host as seen from the SSH server (overrides URI auto-parse). */
    dstHost?: string;
    /** Target remote port as seen from the SSH server (overrides URI auto-parse). */
    dstPort?: number;
    /** Fixed local TCP port for the tunnel (default: OS-assigned random port). */
    localPort?: number;
}

interface SshAuthConfig {
    host: string;
    port: number;
    username: string;
    password?: string;
    privateKey?: string | Buffer;
    passphrase?: string;
    readyTimeout: number;
    keepaliveInterval: number;
    hostHash?: string;
    hostVerifier?: (key: string | Buffer) => boolean;
}

export class SSHTunnelSSH2 {
    readonly remoteHost: string;
    readonly remotePort: number;
    readonly name: string;

    isConnected = false;
    localPort: number | null = null;
    sshClient: SshClientLike | null = null;
    server: net.Server | null = null;

    private readonly _sshConfig: SSHConfigInput;
    private readonly _activeSockets = new Set<net.Socket>();

    constructor(
        sshConfig: SSHConfigInput,
        remoteHost: string,
        remotePort: number,
        opts?: { name?: string },
    ) {
        this._sshConfig = sshConfig;
        this.remoteHost = remoteHost;
        this.remotePort = remotePort;
        this.name = opts?.name ?? 'MongoDB';
    }

    _buildAuthConfig(): SshAuthConfig {
        const {
            host,
            username,
            password,
            privateKey,
            privateKeyPath,
            passphrase,
            port = 22,
            readyTimeout = 20000,
            keepaliveInterval = 30000,
            hostHash,
            hostVerifier,
        } = this._sshConfig;

        if (!host || !username) {
            throw createError(ErrorCodes.INVALID_CONFIG, 'SSH config requires: host, username');
        }
        if (!password && !privateKey && !privateKeyPath) {
            throw createError(ErrorCodes.INVALID_CONFIG, 'SSH authentication required: provide password, privateKey, or privateKeyPath');
        }

        const config: SshAuthConfig = { host, port, username, readyTimeout, keepaliveInterval };
        if (hostHash !== undefined) config.hostHash = hostHash;
        if (hostVerifier !== undefined) config.hostVerifier = hostVerifier;

        if (password) {
            config.password = password;
        } else if (privateKey) {
            config.privateKey = privateKey;
            if (passphrase) config.passphrase = passphrase;
        } else {
            // privateKeyPath
            const keyPath = (privateKeyPath as string).replace(/^~/, os.homedir());
            config.privateKey = fs.readFileSync(keyPath);
            if (passphrase) config.passphrase = passphrase;
        }

        return config;
    }

    async connect(): Promise<void> {
        const authConfig = this._buildAuthConfig();
        const SshClient = loadSsh2Client();

        return new Promise<void>((resolve, reject) => {
            const ssh = new SshClient();
            let settled = false;
            const fail = (err: Error) => {
                if (settled) {
                    this.markDisconnected();
                    return;
                }
                settled = true;
                this.isConnected = false;
                this.localPort = null;
                this.server = null;
                this.sshClient = null;
                for (const socket of this._activeSockets) socket.destroy();
                this._activeSockets.clear();
                void closeServer(server);
                try { ssh.end(); } catch { /* failed handshake may already be closed */ }
                reject(err);
            };

            const server = net.createServer((socket) => {
                this._activeSockets.add(socket);
                socket.on('close', () => this._activeSockets.delete(socket));
                ssh.forwardOut(
                    '127.0.0.1', 0,
                    this.remoteHost, this.remotePort,
                    (err, stream) => {
                        if (err) {
                            socket.destroy();
                            return;
                        }
                        socket.pipe(stream as unknown as NodeJS.WritableStream);
                        (stream as unknown as NodeJS.ReadableStream).pipe(socket);
                        stream.on('close', () => socket.destroy());
                        socket.on('close', () => { try { stream.close(); } catch { /* ignore */ } });
                    },
                );
            });

            server.on('error', fail);

            server.listen(this._sshConfig.localPort ?? 0, '127.0.0.1', () => {
                this.server = server;
                const addr = server.address() as net.AddressInfo;
                this.localPort = addr.port;

                ssh.on('ready', () => {
                    if (!settled) {
                        settled = true;
                        this.sshClient = ssh;
                        this.isConnected = true;
                        resolve();
                    }
                });

                ssh.on('error', (err) => {
                    if (!settled) {
                        fail(err);
                        return;
                    }
                    this.markDisconnected();
                });
                const handleDisconnect = () => {
                    if (!settled) {
                        fail(createError(ErrorCodes.CONNECTION_FAILED, 'SSH connection closed before the tunnel became ready'));
                        return;
                    }
                    this.markDisconnected();
                };
                ssh.on('close', handleDisconnect);
                ssh.on('end', handleDisconnect);

                try { ssh.connect(authConfig); } catch (err) { fail(err as Error); }
            });
        });
    }

    getTunnelUri(_protocol: string, originalUri: string): string {
        if (!this.isConnected || this.localPort === null) {
            throw createError(ErrorCodes.NOT_CONNECTED, `SSH tunnel [${this.remoteHost}:${this.remotePort}] not connected`);
        }
        return rewriteMongoUriForSshTunnel(originalUri, `localhost:${this.localPort}`);
    }

    getLocalAddress(): string {
        if (!this.isConnected || this.localPort === null) {
            throw createError(ErrorCodes.NOT_CONNECTED, `SSH tunnel [${this.remoteHost}:${this.remotePort}] not connected`);
        }
        return `localhost:${this.localPort}`;
    }

    async close(): Promise<void> {
        const server = this.server;
        const ssh = this.sshClient;

        this.isConnected = false;
        this.localPort = null;
        this.sshClient = null;
        this.server = null;
        for (const socket of this._activeSockets) {
            socket.destroy();
        }
        this._activeSockets.clear();

        await closeServer(server);

        ssh?.end();
    }

    private markDisconnected(): void {
        const ssh = this.sshClient;
        this.isConnected = false;
        this.localPort = null;
        this.sshClient = null;
        const server = this.server;
        this.server = null;
        for (const socket of this._activeSockets) {
            socket.destroy();
        }
        this._activeSockets.clear();
        void closeServer(server);
        try { ssh?.end(); } catch { /* already disconnected */ }
    }
}

/** Extract the first host from a MongoDB URI (handles user:pass@ prefix). */
export function parseHostFromUri(uri: string): string {
    const host = parseMongoHostToken(parseMongoHostTokens(uri)[0] ?? '');
    return host.host ?? 'localhost';
}

/** Extract the port from a MongoDB URI (defaults to 27017). */
export function parsePortFromUri(uri: string): number {
    const host = parseMongoHostToken(parseMongoHostTokens(uri)[0] ?? '');
    return host.port ?? 27017;
}

export function parseMongoHostTokens(uri: string): string[] {
    const match = uri.match(/^mongodb(?:\+srv)?:\/\/([^/?#]+)/i);
    if (!match) return [];
    const authority = match[1];
    const hostList = authority.includes('@')
        ? authority.slice(authority.lastIndexOf('@') + 1)
        : authority;
    return hostList.split(',').map((host) => host.trim()).filter(Boolean);
}

export function validateSingleMongoHostUri(uri: string): void {
    const hosts = parseMongoHostTokens(uri);
    if (/^mongodb\+srv:\/\//i.test(uri) || hosts.length !== 1) {
        throw createError(
            ErrorCodes.INVALID_CONFIG,
            'SSH tunnel mode supports a single MongoDB host only. Use a direct single-host URI or configure SSH tunneling outside monSQLize for replica set/SRV URIs.',
        );
    }
}

export function rewriteMongoUriForSshTunnel(uri: string, localHostToken: string): string {
    validateSingleMongoHostUri(uri);
    const match = uri.match(/^(mongodb:\/\/)([^/?#]+)(.*)$/i);
    if (!match) {
        throw createError(ErrorCodes.INVALID_CONFIG, 'Invalid MongoDB URI for SSH tunnel mode.');
    }
    const [, prefix, authority, suffix] = match;
    const at = authority.lastIndexOf('@');
    const credentials = at >= 0 ? authority.slice(0, at + 1) : '';
    return `${prefix}${credentials}${localHostToken}${suffix}`;
}

function parseMongoHostToken(token: string): { host?: string; port?: number } {
    if (!token) return {};
    if (token.startsWith('[')) {
        const end = token.indexOf(']');
        const host = end >= 0 ? token.slice(1, end) : token;
        const portPart = end >= 0 && token[end + 1] === ':' ? token.slice(end + 2) : undefined;
        return { host, port: parsePortPart(portPart) };
    }
    const [host, portPart] = token.split(':');
    return { host, port: parsePortPart(portPart) };
}

function parsePortPart(value: string | undefined): number | undefined {
    if (!value) return undefined;
    const port = Number.parseInt(value, 10);
    return Number.isFinite(port) ? port : undefined;
}

function closeServer(server: net.Server | null): Promise<void> {
    if (!server) return Promise.resolve();
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, 1000);
        timer.unref?.();
        try {
            server.close(() => {
                clearTimeout(timer);
                resolve();
            });
        } catch {
            clearTimeout(timer);
            resolve();
        }
    });
}
