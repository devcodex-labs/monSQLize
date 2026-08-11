#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = packageJson.version;
const packageLockPath = path.join(root, 'package-lock.json');

function ensureReleaseNodeVersion() {
    const major = Number.parseInt(process.versions.node.split('.')[0], 10);
    if (major < 22) {
        console.error(`[release-preflight] Node.js 22+ is required for the release/docs toolchain; current=${process.version}. The published runtime contract remains Node.js >=18.`);
        process.exit(1);
    }
}

const requiredFiles = [
    'CHANGELOG.md',
    'MIGRATION.md',
    'SECURITY.md',
    `changelogs/v${version}.md`,
    'docs/en/support-matrix.md',
    'docs/en/file-dependency-governance.md',
    'docs/en/verification-entrypoints.md',
    'docs/zh/support-matrix.md',
    'docs/zh/file-dependency-governance.md',
    'docs/zh/verification-entrypoints.md',
    'docs/en/release-preflight.md',
    'docs/zh/release-preflight.md',
];

function ensureExists(relativePath) {
    const absolutePath = path.join(root, relativePath);
    if (!fs.existsSync(absolutePath)) {
        console.error(`[release-preflight] missing required file: ${relativePath}`);
        process.exit(1);
    }
}

function ensureNoLocalDependencySpecs(dependencies, label) {
    if (!dependencies) return;

    for (const [name, spec] of Object.entries(dependencies)) {
        if (typeof spec !== 'string') continue;
        if (/^(file:|workspace:|link:)/.test(spec)) {
            console.error(`[release-preflight] ${label} contains non-publishable local dependency: ${name} -> ${spec}`);
            process.exit(1);
        }
    }
}

function ensureLockfileIsReleaseReady() {
    if (!fs.existsSync(packageLockPath)) {
        console.error('[release-preflight] missing required file: package-lock.json');
        process.exit(1);
    }

    const packageLock = JSON.parse(fs.readFileSync(packageLockPath, 'utf8'));
    const rootPackage = packageLock.packages?.[''] ?? {};

    if (packageLock.name !== packageJson.name || packageLock.version !== version) {
        console.error(`[release-preflight] package-lock root metadata drift: expected ${packageJson.name}@${version}, got ${packageLock.name}@${packageLock.version}`);
        process.exit(1);
    }
    if (rootPackage.name !== packageJson.name || rootPackage.version !== version) {
        console.error(`[release-preflight] package-lock packages[""] drift: expected ${packageJson.name}@${version}, got ${rootPackage.name}@${rootPackage.version}`);
        process.exit(1);
    }

    const localPathEntries = [];
    for (const [entryPath, meta] of Object.entries(packageLock.packages ?? {})) {
        if (entryPath.startsWith('../') || entryPath.startsWith('..\\')) {
            localPathEntries.push(entryPath);
        }

        const resolved = meta && typeof meta === 'object' ? meta.resolved : undefined;
        if (typeof resolved === 'string' && (/^(file:|workspace:|link:)/.test(resolved) || resolved.startsWith('../') || resolved.startsWith('..\\'))) {
            localPathEntries.push(`${entryPath} -> ${resolved}`);
        }
    }

    if (localPathEntries.length) {
        console.error('[release-preflight] package-lock contains local path entries:');
        for (const entry of localPathEntries) {
            console.error(`  - ${entry}`);
        }
        process.exit(1);
    }
}

function ensurePackageContractIsReleaseReady() {
    const requiredMetadata = ['name', 'version', 'description', 'license', 'repository', 'homepage', 'bugs', 'engines', 'publishConfig'];
    for (const field of requiredMetadata) {
        if (!packageJson[field]) {
            console.error(`[release-preflight] package.json is missing release metadata: ${field}`);
            process.exit(1);
        }
    }

    const requiredArtifacts = [
        packageJson.main,
        packageJson.module,
        packageJson.types,
        packageJson.bin?.monsqlize,
        `changelogs/v${version}.md`,
        'MIGRATION.md',
        'SECURITY.md',
    ];
    for (const artifact of requiredArtifacts) {
        const normalizedArtifact = artifact?.replace(/^\.\//, '');
        const isCovered = normalizedArtifact && packageJson.files.some((pattern) => {
            const normalizedPattern = pattern.replace(/^\.\//, '');
            const wildcardIndex = normalizedPattern.indexOf('*');
            return wildcardIndex === -1
                ? normalizedArtifact === normalizedPattern
                : normalizedArtifact.startsWith(normalizedPattern.slice(0, wildcardIndex));
        });
        if (!isCovered) {
            console.error(`[release-preflight] package files do not cover required artifact: ${artifact ?? '<missing>'}`);
            process.exit(1);
        }
    }

    if (packageJson.scripts?.prepublishOnly !== 'npm run release:preflight') {
        console.error('[release-preflight] prepublishOnly must consume release:preflight');
        process.exit(1);
    }
    if (!packageJson.scripts?.['release:publish']?.startsWith('npm run release:preflight && ')) {
        console.error('[release-preflight] release:publish must consume release:preflight before npm publish');
        process.exit(1);
    }
}

function run(command, args) {
    const result = spawnSync(command, args, {
        cwd: root,
        stdio: 'inherit',
        shell: process.platform === 'win32',
    });
    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
}

ensureReleaseNodeVersion();

for (const file of requiredFiles) {
    ensureExists(file);
}

ensureNoLocalDependencySpecs(packageJson.dependencies, 'dependencies');
ensureNoLocalDependencySpecs(packageJson.optionalDependencies, 'optionalDependencies');
ensureNoLocalDependencySpecs(packageJson.devDependencies, 'devDependencies');
ensureLockfileIsReleaseReady();
ensurePackageContractIsReleaseReady();

console.log(`[release-preflight] validating release assets for v${version}`);
run('npm', ['run', 'check:release-candidate']);
run('npm', ['run', 'verify:fast']);
run('npm', ['test']);
run('npm', ['run', 'test:coverage']);
run('npm', ['run', 'test:examples']);
run('npm', ['run', 'test:server-matrix']);
run('npm', ['run', 'test:data-tasks:integration']);
run('npm', ['run', 'test:data-task-cli']);
run('npm', ['run', 'test:audit']);
run('npm', ['run', 'test:pack-install']);
run('npm', ['--prefix', 'website', 'ci']);
run('npm', ['--prefix', 'website', 'audit', '--audit-level=high']);
run('npm', [
    '--prefix',
    'website',
    'exec',
    '--',
    'playwright',
    'install',
    ...(process.platform === 'linux' ? ['--with-deps'] : []),
    'chromium',
]);
run('npm', ['--prefix', 'website', 'run', 'verify']);
run('npm', ['pack', '--dry-run']);
run('npm', ['run', 'check:release-candidate']);

console.log('[release-preflight] ✅ preflight passed');
console.log('[release-preflight] next steps: confirm remote CI for this commit, then create the immutable release tag');
