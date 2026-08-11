#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveLocalRehearsalDependencyTarballs } = require('./validation/local-rehearsal-dependencies.cjs');

const root = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'monsqlize-pack-install-'));
const consumerRoot = path.join(tempRoot, 'consumer');
const registry = 'https://registry.npmjs.org/';
const localRehearsalTarballs = resolveLocalRehearsalDependencyTarballs(root, ['schema-dsl']);

function run(command, args, options = {}) {
    const useShell = options.shell ?? (process.platform === 'win32' && command === 'npm');
    const result = spawnSync(command, args, {
        cwd: options.cwd ?? root,
        encoding: 'utf8',
        shell: useShell,
        env: { ...process.env, npm_config_registry: registry },
    });
    if (!options.quiet && result.stdout) process.stdout.write(result.stdout);
    if (!options.quiet && result.stderr) process.stderr.write(result.stderr);
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(' ')} exited with ${result.status ?? 'no status'}`);
    }
    return result.stdout;
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function findDependencyVersion(tree, dependencyName) {
    const directDependency = tree?.dependencies?.[dependencyName];
    if (directDependency?.version) return directDependency.version;

    for (const dependency of Object.values(tree?.dependencies ?? {})) {
        const nestedVersion = findDependencyVersion(dependency, dependencyName);
        if (nestedVersion) return nestedVersion;
    }
    return undefined;
}

try {
    fs.mkdirSync(consumerRoot, { recursive: true });
    fs.writeFileSync(path.join(consumerRoot, 'package.json'), JSON.stringify({ private: true }, null, 2));

    const packOutput = run('npm', ['pack', '--json', '--pack-destination', tempRoot], { quiet: true });
    const packResult = JSON.parse(packOutput)[0];
    assert(packResult.version === packageJson.version, `pack version ${packResult.version} does not match ${packageJson.version}`);

    const paths = packResult.files.map((entry) => entry.path);
    for (const requiredPath of [
        'dist/cjs/index.cjs',
        'dist/esm/index.mjs',
        'dist/types/index.d.ts',
        'dist/types/index.d.mts',
        'dist/cjs/cli/data-task.cjs',
        `changelogs/v${packageJson.version}.md`,
        'MIGRATION.md',
        'SECURITY.md',
    ]) {
        assert(paths.includes(requiredPath), `packed artifact is missing ${requiredPath}`);
    }
    assert(!paths.some((entry) => entry.endsWith('.map')), 'packed artifact must not contain sourcemaps');

    const tarballPath = path.join(tempRoot, packResult.filename);
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...localRehearsalTarballs, tarballPath], { cwd: consumerRoot });

    run(process.execPath, ['-e', "const M=require('monsqlize'); const p=require('monsqlize/package.json'); if(!M || p.version!==process.argv[1] || typeof M.defineModel!=='function' || typeof M.dataTasks?.preview!=='function' || typeof M.dataTasks?.restore!=='function') process.exit(1)", packageJson.version], { cwd: consumerRoot });
    run(process.execPath, ['--input-type=module', '-e', "import M,{dataTasks,defineModel} from 'monsqlize'; import {createRequire} from 'node:module'; const p=createRequire(import.meta.url)('monsqlize/package.json'); if(!M || p.version!==process.argv[1] || typeof M.defineModel!=='function' || typeof defineModel!=='function' || M.dataTasks!==undefined || typeof dataTasks?.apply!=='function' || typeof dataTasks?.previewRestore!=='function') process.exit(1)", packageJson.version], { cwd: consumerRoot });
    const dependencyTree = JSON.parse(run('npm', ['ls', '--all', '--json'], { cwd: consumerRoot, quiet: true }));
    const installedSchemaDslVersion = findDependencyVersion(dependencyTree, 'schema-dsl');
    assert(
        installedSchemaDslVersion === packageJson.dependencies['schema-dsl'],
        `installed schema-dsl version ${installedSchemaDslVersion ?? '<missing>'} does not match ${packageJson.dependencies['schema-dsl']}`,
    );

    const typeFixture = path.join(consumerRoot, 'consumer.ts');
    fs.writeFileSync(typeFixture, "import MonSQLize, { dataTasks, defineModel, Model, type DataTaskJob, type InferModelDocument } from 'monsqlize';\nconst source = { type: 'mongodb' as const, databaseName: 'source', config: { uri: 'mongodb://localhost:27017' } };\nconst target = { ...source, databaseName: 'target' };\nconst job: DataTaskJob = { name: 'smoke', source, target, targetEnvironment: 'test', collections: [{ name: 'items', indexes: [{ key: { code: 1 }, options: { unique: true } }], data: { all: true, identity: { mode: 'fields', fields: ['code'] }, maxDocuments: 100 } }], backup: { maxBytes: 1048576 } };\nconst User = defineModel('typed_users', { schema: { email: 'email!', age: 'number?' } });\ntype IsAny<T> = 0 extends (1 & T) ? true : false;\ntype AssertFalse<T extends false> = T;\ntype DescriptorDocumentIsNotAny = AssertFalse<IsAny<InferModelDocument<typeof User>>>;\nModel.define(User);\nconst typedRuntime = new MonSQLize(source);\nconst typedUsers = typedRuntime.model(User);\nvoid (null as DescriptorDocumentIsNotAny | null); void typedUsers; void dataTasks.preview(job);\n");
    fs.writeFileSync(path.join(consumerRoot, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2022', skipLibCheck: true }, files: ['consumer.ts'] }, null, 2));
    run(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', path.join(consumerRoot, 'tsconfig.json')]);

    const installedPackage = JSON.parse(fs.readFileSync(path.join(consumerRoot, 'node_modules', 'monsqlize', 'package.json'), 'utf8'));
    assert(installedPackage.bin?.monsqlize, 'installed package does not expose the monsqlize bin');
    const cliPath = path.join(consumerRoot, 'node_modules', 'monsqlize', installedPackage.bin.monsqlize);
    const help = run(process.execPath, [cliPath, '--help'], { cwd: consumerRoot });
    const version = run(process.execPath, [cliPath, '--version'], { cwd: consumerRoot }).trim();
    assert(help.includes('monsqlize data-task'), 'installed CLI help is incomplete');
    assert(version === packageJson.version, `installed CLI version ${version} does not match ${packageJson.version}`);

    console.log(`[pack-install-smoke] passed ${packageJson.name}@${packageJson.version}: CJS, ESM, dataTasks facade, schema-dsl, types, docs, bin, help, version`);
} finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
}
