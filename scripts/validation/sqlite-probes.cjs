'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs } = require('node:util');

const sqliteVersion = '3.54.1';
const sourceId = '2026-10-16 14:45:20 555e07ef33f69a0957d24d8e555b702464a131d6f1607f4c3c1e4551e8e6ca76';
const sourceSha3 = 'e2b869d3003b33c942b7dd7063604fbc53553e1b66609570df39b9b7b558ee81';

/** Runs a short-lived compiler or fixture process and propagates its failure. */
function run(executable, args) {
    const child = spawnSync(executable, args, { encoding: 'utf8', timeout: 240_000 });
    if (child.error) throw child.error;
    if (child.status !== 0) {
        throw new Error(`${path.basename(executable)} failed (${child.status ?? child.signal}): ${child.stderr}`);
    }
    return child.stdout.trim();
}

function main() {
    const [sourceArgument, compilerArgument] = process.argv.slice(2);
    if (!sourceArgument || !compilerArgument) {
        throw new Error('Usage: node scripts/validation/sqlite-probes.cjs <amalgamation-directory> <zig-executable>');
    }

    const source = path.resolve(sourceArgument);
    const compiler = path.resolve(compilerArgument);
    const amalgamation = path.join(source, 'sqlite3.c');
    const digest = createHash('sha3-256').update(fs.readFileSync(amalgamation)).digest('hex');
    assert.equal(digest, sourceSha3, 'SQLite amalgamation must match the B01 source pin');

    const temporaryRoot = fs.realpathSync(os.tmpdir());
    const runDirectory = fs.mkdtempSync(path.join(temporaryRoot, 'monsqlize-b01-sqlite-'));
    try {
        const fixture = path.join(__dirname, '../../test/fixtures/sqlite/preupdate-boundaries.c');
        const executable = path.join(runDirectory, process.platform === 'win32' ? 'preupdate.exe' : 'preupdate');
        const flags = ['-O2', '-DSQLITE_ENABLE_PREUPDATE_HOOK=1', '-DSQLITE_THREADSAFE=1'];
        const libraries = process.platform === 'win32' ? [] : ['-ldl', '-lpthread', '-lm'];
        const compilerVersion = run(compiler, ['version']);
        run(compiler, ['cc', ...flags, '-I', source, fixture, amalgamation, ...libraries, '-o', executable]);

        const result = JSON.parse(run(executable, [path.join(runDirectory, 'fixture.sqlite')]));
        assert.equal(result.sqlite, sqliteVersion);
        assert.equal(result.sourceId, sourceId);
        const evidence = {
            kind: 'SQLite native statement and transaction boundaries',
            platform: process.platform,
            arch: process.arch,
            compiler: `zig ${compilerVersion}`,
            sourceSha3: digest,
            flags,
            result,
        };
        process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
    } finally {
        assert.equal(path.dirname(runDirectory), temporaryRoot);
        fs.rmSync(runDirectory, { recursive: true, force: true });
    }
}

function runProbeEntry() {
    const { values } = parseArgs({ options: {
        probe: { type: 'string' }, stage: { type: 'string' }, report: { type: 'string' },
        tarball: { type: 'string' }, sha256: { type: 'string' }, target: { type: 'string' },
        'node-major': { type: 'string' }, fixture: { type: 'string' }, 'npm-cli': { type: 'string' },
        'incompatible-binding': { type: 'string' },
    } });
    assert.ok(values.report, 'provide --report for a probe run');
    const destination = path.resolve(values.report);
    assert.ok(!fs.existsSync(destination), 'use a fresh probe report');
    const report = { probeId: values.probe ?? null, stage: values.stage ?? null, status: 'failed', subcases: [] };
    try {
        assert.match(values.probe ?? '', /^P(?:0[1-9]|10)$/, 'select one valid nonempty probe ID');
        assert.ok(['foundation', 'complete'].includes(values.stage), 'select foundation or complete');
        assert.equal(values.stage, 'foundation', 'complete probe execution requires the W29 integrated candidate');
        assert.equal(values.probe, 'P01', 'this foundation entry currently executes P01 package installation');
        assert.ok(values.tarball && values.sha256 && values.target && values['node-major'], 'provide package and environment selectors');
        const rawPath = `${destination}.cell.json`;
        const selectors = ['tarball', 'sha256', 'target', 'node-major', 'npm-cli', 'incompatible-binding'];
        const args = [path.join(__dirname, 'run-sqlite-foundation-cell.cjs'), '--report', rawPath];
        for (const name of selectors) {
            if (values[name] !== undefined) args.push(`--${name}`, values[name]);
        }
        args.push('--fixture', values.fixture ?? path.resolve(__dirname, '../../test/fixtures/sqlite/check-foundation-package.cjs'));
        run(process.execPath, args);
        const bytes = fs.readFileSync(rawPath);
        const cell = JSON.parse(bytes);
        assert.equal(cell.status, 'passed');
        assert.equal(cell.target, values.target);
        report.subcases.push({
            subcaseId: `P01/${cell.target}/node${values['node-major']}/package-foundation`,
            status: 'passed', evidencePath: rawPath,
            evidenceSha256: createHash('sha256').update(bytes).digest('hex'),
        });
        report.expectedSubcases = 1;
        assert.equal(report.subcases.length, report.expectedSubcases);
        report.scope = 'selected host package foundation';
        report.status = 'passed';
    } catch (error) {
        report.reason = error.message;
        process.exitCode = 1;
    }
    fs.writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    console.log(JSON.stringify(report));
}

if (process.argv[2]?.startsWith('--')) runProbeEntry();
else main();

