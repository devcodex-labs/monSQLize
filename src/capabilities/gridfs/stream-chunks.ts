import type { Readable } from 'node:stream';
import { invalidArgument } from './errors';
import { chunkCount, chunkLengthAt } from './validate';

export interface StreamedChunk {
    index: number;
    bytes: Buffer;
}

function badChunkSize(): never {
    throw invalidArgument('appendChunks', 'data', 'chunk payload must match the session chunk size');
}

function streamClosedError(): Error {
    return invalidArgument('appendChunks', 'data', 'readable closed before the upload completed');
}

function isPrematureClose(source: Readable, ended: boolean): boolean {
    return source.destroyed && !ended && !source.readableEnded;
}

/**
 * Consume a Readable into GridFS-sized slices without buffering the whole payload.
 * Retention is limited to a residual shorter than the next expected slice plus the
 * current incoming `read()` buffer. The stream is not pulled again until the
 * current complete slices have been awaited, so Node backpressure applies.
 *
 * A premature `close` (destroy without error) or an already-destroyed source
 * rejects in finite time and settles once. An in-flight `onChunk` write is
 * awaited before settlement so the caller can release its append claim safely.
 */
export async function consumeReadableChunks(
    source: Readable,
    fromChunk: number,
    length: number,
    chunkSizeBytes: number,
    onChunk: (slice: StreamedChunk) => Promise<void>,
    onBufferedBytes?: (bytes: number) => void,
): Promise<{ bytesAccepted: number }> {
    const total = chunkCount(length, chunkSizeBytes);
    let residual = Buffer.alloc(0);
    let index = fromChunk;
    let bytesAccepted = 0;
    let ended = false;
    let aborted = false;
    let queuedError: unknown;
    let busy = false;
    let settled = false;
    let pending = false;

    const report = (incoming = 0): void => {
        onBufferedBytes?.(residual.length + incoming);
    };

    const emit = async (slice: StreamedChunk): Promise<void> => {
        report();
        await onChunk(slice);
        bytesAccepted += slice.bytes.length;
        index += 1;
    };

    const takeFrom = async (incoming: Buffer): Promise<void> => {
        let offset = 0;
        report(incoming.length);
        while (index < total && offset < incoming.length) {
            const want = chunkLengthAt(index, length, chunkSizeBytes);
            const have = residual.length + (incoming.length - offset);
            if (have < want) {
                const rest = incoming.subarray(offset);
                residual = residual.length === 0
                    ? Buffer.from(rest)
                    : Buffer.concat([residual, rest]);
                report();
                return;
            }
            let bytes: Buffer;
            if (residual.length === 0) {
                bytes = Buffer.from(incoming.subarray(offset, offset + want));
                offset += want;
            } else {
                const need = want - residual.length;
                bytes = Buffer.concat([residual, incoming.subarray(offset, offset + need)]);
                residual = Buffer.alloc(0);
                offset += need;
            }
            await emit({ index, bytes });
        }
        if (index >= total && offset < incoming.length) badChunkSize();
        report();
    };

    await new Promise<void>((resolve, reject) => {
        const detach = (): void => {
            source.removeListener('readable', onReadable);
            source.removeListener('end', onEnd);
            source.removeListener('error', onError);
            source.removeListener('close', onClose);
        };

        const finish = (error?: unknown): void => {
            if (settled) return;
            settled = true;
            detach();
            if (error) reject(error);
            else resolve();
        };

        const abort = (error: unknown): void => {
            aborted = true;
            queuedError = queuedError ?? error;
            if (busy) {
                pending = true;
                return;
            }
            finish(queuedError);
        };

        const onReadable = (): void => run();
        const onEnd = (): void => {
            ended = true;
            run();
        };
        const onError = (error: unknown): void => abort(error);
        const onClose = (): void => {
            if (ended || source.readableEnded) return;
            abort(streamClosedError());
        };

        const pump = async (): Promise<void> => {
            if (settled || busy) return;
            busy = true;
            try {
                let incoming: Buffer | string | null;
                while (!aborted && (incoming = source.read() as Buffer | string | null) !== null) {
                    await takeFrom(Buffer.isBuffer(incoming) ? incoming : Buffer.from(incoming));
                }
                if (queuedError) throw queuedError;
                if (isPrematureClose(source, ended)) throw streamClosedError();
                if (ended || source.readableEnded) {
                    ended = true;
                    if (residual.length > 0) badChunkSize();
                }
            } finally {
                busy = false;
            }
        };

        const run = (): void => {
            if (settled) return;
            if (busy) {
                pending = true;
                return;
            }
            if (queuedError) {
                finish(queuedError);
                return;
            }
            if (isPrematureClose(source, ended)) {
                finish(streamClosedError());
                return;
            }
            pump().then(() => {
                if (settled) return;
                if (pending || queuedError || isPrematureClose(source, ended)) {
                    pending = false;
                    run();
                    return;
                }
                if ((ended || source.readableEnded) && residual.length === 0) finish();
            }, (error: unknown) => finish(error));
        };

        source.on('readable', onReadable);
        source.on('end', onEnd);
        source.on('error', onError);
        source.on('close', onClose);
        if (isPrematureClose(source, ended)) {
            finish(streamClosedError());
            return;
        }
        run();
        if (!ended && source.readableEnded) {
            ended = true;
            run();
        }
    }).finally(() => {
        if (!source.destroyed && !source.readableEnded) source.destroy();
    });

    if (bytesAccepted === 0) badChunkSize();
    return { bytesAccepted };
}
