'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs } = require('node:util');

const testFlags = [
    'crud', 'realExtensionLoaded', 'closeAfterSettlement', 'opaqueNativeControl',
    'inFlightInterrupt', 'interruptedStatementLeftZeroRows', 'staleTokenRejectedDuringSuccessor',
    'packageSignalCancelsDespiteStoppedPropagation', 'rejectedMultipleStatementsBeforePragmaSideEffects',
];
const targets = ['win32-x64', 'linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'];

function sha256(file) {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function runNode(args, directory) {
    const result = spawnSync(process.execPath, args, {
        cwd: directory,
        encoding: 'utf8',
        timeout: 60_000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr.trim() || `command exited with ${result.status ?? result.signal}`);
    return result.stdout.trim();
}

function findNpm(explicit) {
    if (explicit) return fs.realpathSync(explicit);
    const nodeDirectory = path.dirname(process.execPath);
    const candidates = [
        process.env.npm_execpath,
        path.join(nodeDirectory, 'node_modules/npm/bin/npm-cli.js'),
        path.join(nodeDirectory, '../lib/node_modules/npm/bin/npm-cli.js'),
    ];
    const filename = candidates.find(candidate => candidate && fs.existsSync(candidate));
    assert.ok(filename, 'pass --npm-cli with the path to npm-cli.js');
    return fs.realpathSync(filename);
}

function main() {
    const { values } = parseArgs({
        options: {
            tarball: { type: 'string' }, sha256: { type: 'string' }, target: { type: 'string' },
            'node-major': { type: 'string' }, fixture: { type: 'string' }, 'npm-cli': { type: 'string' },
            'incompatible-binding': { type: 'string' },
            report: { type: 'string' },
        },
    });
    assert.ok(values.tarball && values.fixture && values.report && /^[0-9a-f]{64}$/i.test(values.sha256 ?? ''),
        'provide --tarball, --sha256, --target, --node-major, --fixture and --report');
    const target = `${process.platform}-${process.arch}`;
    const nodeMajor = process.versions.node.split('.')[0];
    assert.ok(targets.includes(values.target), 'unrecognized SQLite platform');
    assert.ok(['18', '20', '22', '24'].includes(values['node-major']), 'unrecognized Node matrix version');
    const reportFile = path.resolve(values.report);
    assert.ok(!fs.existsSync(reportFile), 'use a fresh report path');
    const report = { kind: 'sqlite-foundation-cell', target, node: process.version, runnerSha256: sha256(__filename), status: 'failed' };
    const tempRoot = fs.realpathSync(os.tmpdir());
    const temp = fs.mkdtempSync(path.join(tempRoot, 'monsqlize-foundation-cell-'));
    try {
        assert.equal(target, values.target, 'validation must run on the requested OS and architecture');
        assert.equal(nodeMajor, values['node-major'], 'validation must run on the requested Node major');
        const archive = fs.realpathSync(values.tarball);
        const fixture = fs.realpathSync(values.fixture);
        const npm = findNpm(values['npm-cli']);
        report.archiveSha256 = sha256(archive);
        assert.equal(report.archiveSha256, values.sha256.toLowerCase(), 'tarball digest mismatch');
        report.fixtureSha256 = sha256(fixture);
        report.npm = runNode([npm, '--version'], temp);
        fs.writeFileSync(path.join(temp, 'package.json'), '{"private":true}\n');
        runNode([npm, 'install', archive, '--offline', '--ignore-scripts', '--no-fund', '--no-audit',
            '--cache', path.join(temp, 'npm-cache')], temp);
        const assetDirectory = path.join(temp, 'node_modules/@monsqlize/sqlite-native/prebuild', target);
        const buildFile = path.join(assetDirectory, 'build.json');
        const build = JSON.parse(fs.readFileSync(buildFile, 'utf8'));
        assert.equal(build.target, target);
        report.buildManifestSha256 = sha256(buildFile);
        report.patch = build.patch;
        const fixtureArgs = [fixture, temp];
        if (values['incompatible-binding']) {
            const incompatibleBinding = fs.realpathSync(values['incompatible-binding']);
            report.incompatibleBindingSha256 = sha256(incompatibleBinding);
            assert.notEqual(report.incompatibleBindingSha256, build.artifacts.binding);
            fixtureArgs.push(incompatibleBinding);
        }
        const outcomes = JSON.parse(runNode(fixtureArgs, temp));
        assert.equal(outcomes.host, target);
        assert.equal(outcomes.node, process.version);
        assert.equal(outcomes.installedBindingSha256, build.artifacts.binding);
        for (const flag of testFlags) assert.equal(outcomes[flag], true, flag);
        if (build.engineBuildHash !== undefined) {
            assert.equal(outcomes.engineBuildHash, build.engineBuildHash);
            assert.equal(outcomes.installedShellSha256, build.artifacts.shell);
            assert.equal(outcomes.independentShellRead, true);
            assert.equal(outcomes.runtimeCompileOptionsMatched, true);
            assert.equal(outcomes.mismatchedAssetRejectedBeforeOpen, true);
        }
        if (report.incompatibleBindingSha256) {
            assert.equal(outcomes.incompatibleRuntimeRejectedBeforeOpen, true);
        }
        report.outcomes = outcomes;
        report.status = 'passed';
    } catch (error) {
        report.reason = error.message;
        process.exitCode = 1;
    } finally {
        assert.equal(path.dirname(temp), tempRoot);
        fs.rmSync(temp, { recursive: true, force: true });
    }
    fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    console.log(JSON.stringify({ status: report.status, target, node: report.node, report: reportFile }));
}

main();
