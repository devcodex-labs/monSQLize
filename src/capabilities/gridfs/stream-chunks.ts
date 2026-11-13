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

/** Capture errors before the append claim and keep handling errors from async destruction. */
export function watchReadable(source: Readable) {
    let error: Error | undefined;
    let released = false;
    const detach = (): void => {
        source.removeListener('error', onError);
        source.removeListener('close', detach);
    };
    const onError = (cause: Error): void => {
        error ??= cause;
        if (released) detach();
    };
    source.on('error', onError);
    return {
        source,
        get error() { return error ?? source.errored; },
        release(): void {
            released = true;
            if (source.readableEnded && !source.destroyed) {
                detach();
                return;
            }
            if (!source.closed) source.once('close', detach);
            if (!source.destroyed) source.destroy();
            // A synchronous _destroy can queue an error even after closed is true.
            setImmediate(() => {
                if (source.closed) detach();
            });
        },
    };
}

/**
 * Consume a Readable into GridFS-sized slices without buffering the whole payload.
 * Retention is limited to a residual shorter than the next expected slice plus the
 * current incoming `read()` buffer. The stream is not pulled again until the
 * current complete slices have been awaited, so Node backpressure applies.
 *
 * A premature `close` (destroy without error) or an already-destroyed source
 * rejects in finite time and settles once. An in-flight `onChunk` write is
 * awaited before settlement, and any remaining buffered slices are discarded.
 */
export async function consumeReadableChunks(
    source: Readable,
    fromChunk: number,
    length: number,
    chunkSizeBytes: number,
    onChunk: (slice: StreamedChunk) => Promise<void>,
    onBufferedBytes?: (bytes: number) => void,
    watched?: ReturnType<typeof watchReadable>,
): Promise<{ bytesAccepted: number }> {
    const stream = watched ?? watchReadable(source);
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
        while (offset < incoming.length) {
            if (aborted || stream.error || isPrematureClose(source, ended)) return;
            if (index >= total) badChunkSize();
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
        report();
    };

    await new Promise<void>((resolve, reject) => {
        const detach = (): void => {
            clearInterval(checkDestroyed);
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
                while (!aborted && !stream.error && !isPrematureClose(source, ended) &&
                    (incoming = source.read() as Buffer | string | null) !== null) {
                    await takeFrom(Buffer.isBuffer(incoming) ? incoming : Buffer.from(incoming));
                }
                if (queuedError || stream.error) throw queuedError ?? stream.error;
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
            if (queuedError || stream.error) {
                finish(queuedError ?? stream.error);
                return;
            }
            if (isPrematureClose(source, ended)) {
                finish(streamClosedError());
                return;
            }
            pump().then(() => {
                if (settled) return;
                if (pending || queuedError || stream.error || isPrematureClose(source, ended)) {
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
        // emitClose:false suppresses the notification even when an idle source is destroyed.
        const checkDestroyed = setInterval(() => {
            if (isPrematureClose(source, ended)) abort(stream.error ?? streamClosedError());
        }, 50);
        checkDestroyed.unref();
        run();
        if (!ended && source.readableEnded) {
            ended = true;
            run();
        }
    }).finally(() => {
        if (!watched) stream.release();
    });

    if (bytesAccepted === 0) badChunkSize();
    return { bytesAccepted };
}
