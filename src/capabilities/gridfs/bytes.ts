import { Readable } from 'node:stream';

export async function readReadable(source: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of source) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}

export function releaseReadable(source: Readable): void {
    if (!source.destroyed) source.destroy();
}
