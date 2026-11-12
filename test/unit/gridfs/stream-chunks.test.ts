import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { consumeReadableChunks } from '../../../src/capabilities/gridfs/stream-chunks';

function codeOf(error: unknown): string | undefined {
    return error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : undefined;
}

function delayed(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function readableFromBuffer(data: Buffer, highWaterMark: number): Readable {
    let offset = 0;
    return new Readable({
        highWaterMark,
        read() {
            if (offset >= data.length) {
                this.push(null);
                return;
            }
            const size = Math.min(highWaterMark, data.length - offset);
            const slice = data.subarray(offset, offset + size);
            offset += size;
            this.push(slice);
        },
    });
}

describe('consumeReadableChunks', () => {
    it('keeps peak buffered memory from scaling with input size', async () => {
        async function measure(size: number): Promise<{ peak: number; bytesAccepted: number }> {
            const chunkSize = 1024;
            const highWaterMark = 256;
            const data = Buffer.alloc(size, 7);
            let peak = 0;
            const result = await consumeReadableChunks(
                readableFromBuffer(data, highWaterMark),
                0,
                size,
                chunkSize,
                async () => { await delayed(1); },
                (bytes) => { peak = Math.max(peak, bytes); },
            );
            return { peak, bytesAccepted: result.bytesAccepted };
        }

        const small = await measure(64 * 1024);
        const large = await measure(1024 * 1024);
        assert.equal(small.bytesAccepted, 64 * 1024);
        assert.equal(large.bytesAccepted, 1024 * 1024);
        const bound = 1024 + 256 + 64;
        assert.ok(small.peak <= bound, `small peak ${small.peak} exceeded ${bound}`);
        assert.ok(large.peak <= bound, `large peak ${large.peak} exceeded ${bound}`);
        assert.ok(
            Math.abs(large.peak - small.peak) <= 1024,
            `peak scaled with input: small=${small.peak} large=${large.peak}`,
        );
    });

    it('applies backpressure and does not pull the whole payload during a slow chunk write', async () => {
        const chunkSize = 32;
        const total = 32 * 40;
        const data = Buffer.alloc(total, 3);
        let offset = 0;
        let reads = 0;
        let writing = false;
        let producedWhileWriting = 0;
        const source = new Readable({
            highWaterMark: 16,
            read() {
                reads += 1;
                if (offset >= data.length) {
                    this.push(null);
                    return;
                }
                const size = Math.min(16, data.length - offset);
                const slice = data.subarray(offset, offset + size);
                offset += size;
                if (writing) producedWhileWriting += size;
                this.push(slice);
            },
        });
        let writes = 0;
        await consumeReadableChunks(source, 0, total, chunkSize, async () => {
            writes += 1;
            if (writes === 1) {
                writing = true;
                await delayed(25);
                writing = false;
            }
        });
        assert.equal(writes, 40);
        assert.ok(reads > 1, `expected multiple reads, got ${reads}`);
        assert.ok(
            producedWhileWriting <= 16 * 4,
            `first write pulled ${producedWhileWriting} additional bytes; expected prefetch only, not the full ${total}-byte payload`,
        );
        assert.ok(offset === total, 'stream should eventually be consumed');
    });

    it('rejects a trailing partial after emitting complete chunks, and rejects oversize input', async () => {
        const written: number[] = [];
        await assert.rejects(
            () => consumeReadableChunks(
                Readable.from([Buffer.from('abcd'), Buffer.from('xy')]),
                0,
                8,
                4,
                async (slice) => { written.push(slice.index); },
            ),
            (error: unknown) => codeOf(error) === 'INVALID_ARGUMENT',
        );
        assert.deepEqual(written, [0]);

        const oversized: number[] = [];
        await assert.rejects(
            () => consumeReadableChunks(
                Readable.from([Buffer.from('abcdefgh')]),
                0,
                4,
                4,
                async (slice) => { oversized.push(slice.bytes.length); },
            ),
            (error: unknown) => codeOf(error) === 'INVALID_ARGUMENT',
        );
        assert.deepEqual(oversized, [4]);
    });

    it('surfaces an onChunk failure after earlier slices have been emitted', async () => {
        const written: number[] = [];
        await assert.rejects(
            () => consumeReadableChunks(
                Readable.from([Buffer.from('aaaabbbbcccc')]),
                0,
                12,
                4,
                async (slice) => {
                    written.push(slice.index);
                    if (slice.index === 1) throw new Error('write failed');
                },
            ),
            /write failed/,
        );
        assert.deepEqual(written, [0, 1]);
    });
});
