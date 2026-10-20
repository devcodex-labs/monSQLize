import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const { Logger } = require('../../../dist/cjs/index.cjs');

describe('Logger trace contract', () => {
    it('keeps omitted trace options enabled and honors explicit false at every level', async () => {
        for (const options of [{}, { enableTraceId: undefined }, { enableTraceId: true }, { enableTraceId: false }]) {
            const entries: string[] = [];
            const levels = ['debug', 'info', 'warn', 'error'];
            const sink = Object.fromEntries(levels.map((level) => [level, (message: string) => entries.push(message)]));
            const logger = new Logger(sink, { structured: true, ...options });
            await Logger.withTraceId(async () => {
                for (const level of levels) logger[level]('message', { context: true });
                assert.equal(Logger.getTraceId(), 'trace-contract');
            }, 'trace-contract');
            assert.equal(entries.length, 4);
            for (const [index, entry] of entries.entries()) {
                const parsed = JSON.parse(entry);
                assert.equal(parsed.level, levels[index].toUpperCase());
                assert.equal(parsed.traceId, options.enableTraceId === false ? undefined : 'trace-contract');
                assert.equal(parsed.message, 'message'); assert.deepEqual(parsed.context, { context: true });
                assert.ok(Number.isFinite(Date.parse(parsed.timestamp)));
            }
        }
        assert.equal(Logger.getTraceId(), null);
    });

    it('preserves non-structured arguments and trace context when output injection is disabled', async () => {
        const args: unknown[][] = [], context = { raw: true };
        const sink = Object.fromEntries(['debug', 'info', 'warn', 'error'].map((level) => [level, (...values: unknown[]) => args.push(values)]));
        const logger = Logger.create(sink, { enableTraceId: false });
        await Logger.withTraceId(() => { logger.info('raw', context); assert.equal(Logger.getTraceId(), 'context'); }, 'context');
        assert.deepEqual(args, [['raw', context]]); assert.equal(args[0][1], context);
    });

    it('generates and injects trace IDs in an independent pure ESM process', () => {
        const entry = pathToFileURL(path.resolve(__dirname, '../../../dist/esm/index.mjs')).href;
        const source = `import assert from 'node:assert/strict'; import Runtime, { Logger } from ${JSON.stringify(entry)};
            assert.equal(typeof globalThis.require, 'undefined'); assert.equal(Runtime.Logger, Logger);
            const id = Logger.generateTraceId(); assert.match(id, /^[0-9a-f]{16}$/);
            const entries = []; const sink = Object.fromEntries(['debug','info','warn','error'].map(k => [k, m => entries.push(m)]));
            await Logger.withTraceId(() => Logger.create(sink, {structured:true}).info('esm'));
            assert.match(JSON.parse(entries[0]).traceId, /^[0-9a-f]{16}$/);`;
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr || result.stdout);
    });
});
