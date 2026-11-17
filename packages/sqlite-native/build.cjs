'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs } = require('node:util');
const engineBuildHash = require('./engine-build.cjs');
const sourceManifest = require('./source-manifest.json');

const targets = {
    'win32-x64': { triple: 'x86_64-windows-gnu', extension: 'probe.dll', flags: [], libraries: [],
        shellFlags: ['-Dmain=monsqlize_sqlite_shell_main'], shellLibraries: ['-lshell32'] },
    'linux-x64': { triple: 'x86_64-linux-gnu', extension: 'probe.so', flags: ['-fPIC'], libraries: ['-ldl', '-lpthread', '-lm'] },
    'linux-arm64': { triple: 'aarch64-linux-gnu', extension: 'probe.so', flags: ['-fPIC'], libraries: ['-ldl', '-lpthread', '-lm'] },
    'darwin-x64': { triple: 'x86_64-macos', extension: 'probe.dylib', flags: ['-fPIC'], libraries: ['-Wl,-undefined,dynamic_lookup'] },
    'darwin-arm64': { triple: 'aarch64-macos', extension: 'probe.dylib', flags: ['-fPIC'], libraries: ['-Wl,-undefined,dynamic_lookup'] },
};

function hash(file, algorithm = 'sha256') {
    return createHash(algorithm).update(fs.readFileSync(file)).digest('hex');
}

function run(command, args) {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 240_000 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${path.basename(command)} failed (${result.status}): ${result.stderr}`);
    return result.stdout.trim();
}

function main() {
    const { values } = parseArgs({
        options: {
            sqlite: { type: 'string' }, zig: { type: 'string' }, headers: { type: 'string' },
            target: { type: 'string' }, 'node-lib': { type: 'string' }, output: { type: 'string' },
        },
    });
    const target = Object.hasOwn(targets, values.target) ? targets[values.target] : undefined;
    assert.ok(target && values.sqlite && values.zig && values.headers && values.output,
        'provide --target, --sqlite, --zig, --headers and --output');
    const source = path.resolve(values.sqlite);
    const headers = path.resolve(values.headers);
    const zig = path.resolve(values.zig);
    const stage = path.resolve(values.output);
    assert.ok(!fs.existsSync(stage), 'use a new staging directory for each build');
    assert.equal(run(zig, ['version']), sourceManifest.zig, 'unexpected compiler version');
    for (const [name, digest] of Object.entries(sourceManifest.sha256)) {
        assert.equal(hash(path.join(source, name)), digest, `unexpected SQLite asset ${name}`);
    }
    assert.equal(hash(path.join(source, 'sqlite3.c'), 'sha3-256'), sourceManifest.sqliteSourceSha3);
    assert.equal(sourceManifest.patch, null, 'an observer patch must be applied before its identity can be advertised');

    const nodeImport = [];
    if (values.target === 'win32-x64') {
        assert.ok(values['node-lib'], 'the Windows target needs the Node.js import library');
        const library = path.resolve(values['node-lib']);
        assert.equal(hash(library), sourceManifest.nodeWindowsX64ImportSha256, 'unexpected node.lib digest');
        nodeImport.push(library);
    }

    const scratchRoot = fs.realpathSync(os.tmpdir());
    const scratch = fs.mkdtempSync(path.join(scratchRoot, 'monsqlize-sqlite-build-'));
    try {
        const bridge = path.join(__dirname, 'src/binding.cc');
        const shellInit = path.join(__dirname, 'src/shell-init.c');
        const wrapper = path.join(__dirname, 'index.cjs');
        const extensionFixture = path.resolve(__dirname, '../../test/fixtures/sqlite/loadable-extension.c');
        const engineHash = engineBuildHash(sourceManifest);
        const engineSource = path.join(scratch, 'engine.c');
        const object = path.join(scratch, 'sqlite3.o');
        const shellObject = path.join(scratch, 'shell.o');
        const binding = path.join(scratch, 'binding.node');
        const extension = path.join(scratch, target.extension);
        const shellName = values.target === 'win32-x64' ? 'sqlite3.exe' : 'sqlite3';
        const shell = path.join(scratch, shellName);
        const common = ['-target', target.triple, '-O2', ...target.flags, '-I', source];
        const sqliteFlags = sourceManifest.sqliteDefines.map(value => `-D${value}`);
        fs.writeFileSync(engineSource, '#include <sqlite3.c>\n' +
            `const char *monsqlize_sqlite_engine_build_hash(void) { return "${engineHash}"; }\n`);
        run(zig, ['cc', ...common, ...sqliteFlags, '-c', engineSource, '-o', object]);
        run(zig, ['c++', ...common, '-shared', '-std=c++17', '-I', headers, `-DNAPI_VERSION=${sourceManifest.napi}`,
            '-DNODE_GYP_MODULE_NAME=monsqlize_sqlite', bridge, object,
            ...nodeImport, ...target.libraries, '-o', binding]);
        run(zig, ['cc', ...common, ...sqliteFlags, '-DSQLITE_SHELL_INIT_PROC=monsqlize_sqlite_shell_init',
            ...(target.shellFlags ?? []), '-c', path.join(source, 'shell.c'), '-o', shellObject]);
        run(zig, ['cc', ...common, shellObject, shellInit, object, ...target.libraries,
            ...(target.shellLibraries ?? []), '-o', shell]);
        run(zig, ['cc', ...common, '-shared', extensionFixture, '-o', extension]);

        const artifacts = path.join(stage, 'prebuild', values.target);
        fs.mkdirSync(artifacts, { recursive: true });
        for (const name of ['index.cjs', 'engine-build.cjs', 'NOTICE', 'package.json', 'source-manifest.json']) {
            fs.copyFileSync(path.join(__dirname, name), path.join(stage, name));
        }
        fs.copyFileSync(path.resolve(__dirname, '../../LICENSE'), path.join(stage, 'LICENSE'));
        fs.copyFileSync(binding, path.join(artifacts, 'binding.node'));
        fs.copyFileSync(extension, path.join(artifacts, target.extension));
        fs.copyFileSync(shell, path.join(artifacts, shellName));
        const evidence = {
            target: values.target, triple: target.triple, compiler: sourceManifest.zig, sqlite: sourceManifest.sqliteSourceId,
            patch: sourceManifest.patch, napi: sourceManifest.napi, sqliteDefines: sourceManifest.sqliteDefines,
            sqliteRuntimeOptions: sourceManifest.sqliteRuntimeOptions,
            engineBuildHash: engineHash,
            nodeApiHeaderSha256: hash(path.join(headers, 'node_api.h')),
            sourceInputs: { bridge: hash(bridge), wrapper: hash(wrapper), shellInit: hash(shellInit), extensionFixture: hash(extensionFixture) },
            artifacts: { binding: hash(binding), extension: hash(extension), shell: hash(shell) },
        };
        fs.writeFileSync(path.join(artifacts, 'build.json'), `${JSON.stringify(evidence, null, 2)}\n`);
        console.log(JSON.stringify(evidence));
    } finally {
        assert.equal(path.dirname(scratch), scratchRoot);
        fs.rmSync(scratch, { recursive: true, force: true });
    }
}

main();
