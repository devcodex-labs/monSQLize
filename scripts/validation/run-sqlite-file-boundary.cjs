'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const manifest = require('../../packages/sqlite-native/source-manifest.json');

const digest = filename => createHash('sha256').update(fs.readFileSync(filename)).digest('hex');

function run(command, args, timeout) {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 1024 * 1024 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, result.stderr || `fixture exit ${result.status}`);
    return result.stdout.trim();
}

function main() {
    const { values } = parseArgs({ options: {
        sqlite: { type: 'string' }, zig: { type: 'string' }, output: { type: 'string' },
    } });
    assert.equal(process.platform, 'win32', 'this fixture validates Windows file permissions');
    assert.ok(values.sqlite && values.zig && values.output, 'provide --sqlite, --zig and --output');
    const sqlite = fs.realpathSync(values.sqlite);
    const zig = fs.realpathSync(values.zig);
    const output = path.resolve(values.output);
    assert.ok(!fs.existsSync(output), 'use a new output directory for each fixture');
    assert.equal(run(zig, ['version'], 10_000), manifest.zig);
    const source = path.join(sqlite, 'sqlite3.c');
    const header = path.join(sqlite, 'sqlite3.h');
    assert.equal(digest(source), manifest.sha256['sqlite3.c']);
    assert.equal(digest(header), manifest.sha256['sqlite3.h']);
    const fixture = path.resolve(__dirname, '../../test/fixtures/sqlite/native-clients/win32-file-boundary.c');
    const program = path.join(output, 'file-boundary.exe');
    const flags = ['-O2', '-Werror', ...manifest.sqliteDefines.map(define => `-D${define}`)];
    const report = { kind: 'Q2 Windows file permission probe', status: 'failed',
        platform: `${process.platform}-${process.arch}`, node: process.version, compiler: manifest.zig,
        runnerSha256: digest(__filename), fixtureSha256: digest(fixture), sqliteSha256: digest(source),
        headerSha256: digest(header), flags };
    fs.mkdirSync(output);
    try {
        const protectedDirectory = path.join(output, '受控文件 🌿');
        const simpleDirectory = path.join(output, '独立简单文件');
        fs.mkdirSync(protectedDirectory);
        fs.mkdirSync(simpleDirectory);
        run(zig, ['cc', ...flags, '-I', sqlite, source, fixture, '-ladvapi32', '-lshell32', '-o', program], 240_000);
        report.executableSha256 = digest(program);
        const stdout = run(program, [protectedDirectory, simpleDirectory], 15_000);
        fs.writeFileSync(path.join(output, 'results.log'), `${stdout}\n`, { flag: 'wx' });
        const outcomes = JSON.parse(stdout);
        assert.equal(outcomes.sqliteSource, manifest.sqliteSourceId);
        for (const flag of ['windowsRestrictedContext', 'nativeReadActiveWal', 'disabledTriggerWriteRejectedByFilePermissions',
            'mixedSimpleWriteRejected', 'sidecarsAndDirectoryProtected', 'trustedWriteAfterwards',
            'independentSimpleFileNativeWriteAndCapture', 'regeneratedWalReadonly',
            'preGrantedHandleRequiresDrain', 'newWriteDeniedAfterDrain']) assert.equal(outcomes[flag], true, flag);
        assert.equal(outcomes.externalWrites, 0);
        assert.equal(outcomes.externalEvents, 0);
        report.outcomes = outcomes;
        report.rawReportSha256 = digest(path.join(output, 'results.log'));
        report.status = 'passed';
    } catch (error) {
        report.error = error.message;
        process.exitCode = 1;
    }
    fs.writeFileSync(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    console.log(JSON.stringify({ status: report.status, output, error: report.error }));
}

main();
