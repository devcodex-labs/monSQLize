import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { readConfig, reportJson, main } = require(path.resolve('scripts/validation/run-search-real-env.cjs'));
const { runSearchSuite } = require(path.resolve('scripts/validation/search-real-env-suite.cjs'));

describe('opt-in Search verification tooling', () => {
    it('validates explicit configuration before skipping and selects only the first non-empty URI', () => {
        assert.deepEqual(readConfig({}), { uri: '', out: undefined, timeoutMs: 600000 });
        assert.equal(readConfig({ MONSQLIZE_VECTOR_SEARCH_URI: ' ', MONSQLIZE_ATLAS_LOCAL_URI: ' mongodb://fallback ' }).uri, 'mongodb://fallback');
        assert.equal(readConfig({ MONSQLIZE_VECTOR_SEARCH_URI: 'mongodb://first', MONSQLIZE_ATLAS_LOCAL_URI: 'mongodb://second' }).uri, 'mongodb://first');
        for (const value of ['', '0', '-1', 'NaN', '1.2', '9007199254740992']) {
            assert.throws(() => readConfig({ MONSQLIZE_SEARCH_REAL_TIMEOUT_MS: value }));
        }
        assert.throws(() => readConfig({ MONSQLIZE_SEARCH_REAL_OUT: '  ' }));
    });

    it('skips without opening a client and writes the skipped result when requested', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msq-search-cli-'));
        try {
            const out = path.join(dir, 'result.json');
            let calls = 0; let stdout = '';
            const code = await main({ MONSQLIZE_SEARCH_REAL_OUT: out }, {
                run: () => { calls++; throw new Error('must not connect'); }, write: (text: string) => { stdout = text; },
            });
            assert.equal(code, 0); assert.equal(calls, 0);
            assert.equal(JSON.parse(stdout).status, 'skipped');
            assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), JSON.parse(stdout));
            stdout = '';
            assert.equal(await main({ MONSQLIZE_SEARCH_REAL_TIMEOUT_MS: '0' }, { write: (text: string) => { stdout = text; } }), 1);
            assert.equal(JSON.parse(stdout).status, 'failed');
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    it('redacts URI credentials from error copies without mutating the original error', () => {
        const uri = 'mongodb://searchUser:s3cr%40t@localhost:27017/db';
        const error = new Error(`Unable to connect to ${uri}; password s3cr@t`);
        const original = error.message;
        const report = { status: 'failed', error: { message: error.message, code: 8, cause: { message: uri } } };
        const output = reportJson(report, [uri]);
        assert.ok(!output.includes('s3cr')); assert.ok(!output.includes('searchUser'));
        assert.equal(JSON.parse(output).error.code, 8);
        assert.equal(error.message, original);
        for (const password of ['a', '1', 'passed', 'redacted', 'a.b+$[x]']) {
            const redacted = JSON.parse(reportJson({ status: 'passed', error: { message: `password ${password}` } }, [`mongodb://user:${password}@localhost`]));
            assert.equal(redacted.status, 'passed');
            assert.equal(redacted.error.message, 'password <redacted>');
        }
    });

    it('fails if a requested output cannot be written even when the suite passed', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msq-search-output-'));
        try {
            let stdout = '';
            const code = await main({ MONSQLIZE_VECTOR_SEARCH_URI: 'mongodb://fake', MONSQLIZE_SEARCH_REAL_OUT: dir }, {
                run: async () => ({ status: 'passed', cleanup: [{ ok: true }] }), write: (value: string) => { stdout = value; },
            });
            assert.equal(code, 1);
            assert.equal(JSON.parse(stdout).status, 'failed');
            assert.equal(JSON.parse(stdout).errors[0].operation, 'write-report');
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });

    it('preserves a suite failure and cleans only its generated database and clients', async () => {
        const dropped: string[] = []; const closed: string[] = [];
        class Native extends EventEmitter {
            async connect() { return this; }
            db(name: string) {
                return {
                    command: async (command: Record<string, unknown>) => command.buildInfo ? { version: 'fake' } : { featureCompatibilityVersion: { version: 'fake' } },
                    collection: () => ({ insertMany: async (docs: unknown[]) => ({ insertedCount: docs.length }) }),
                    dropDatabase: async () => { dropped.push(name); },
                };
            }
            async close() { closed.push('native'); }
        }
        class Runtime {
            static Model = {};
            async connect() { return this; }
            collection() {
                return { raw: () => ({ client: new EventEmitter() }), createSearchIndex: async () => { throw Object.assign(new Error('index build rejected'), { code: 2 }); } };
            }
            async close() { closed.push('runtime'); }
        }
        const report = await runSearchSuite({ uri: 'mongodb://fake/production', timeoutMs: 1000 }, { MongoClient: Native, library: Runtime });
        assert.equal(report.status, 'failed');
        assert.equal(report.steps.find((step: any) => step.name === 'index.baseline.create').error.code, 2);
        assert.equal(dropped.length, 1); assert.match(dropped[0], /^msq_search_real_\d+_[a-f0-9]+$/);
        assert.notEqual(dropped[0], 'production');
        assert.deepEqual(closed, ['runtime', 'native']);
        assert.ok(report.cleanup.every((step: any) => step.ok));
    });
});
