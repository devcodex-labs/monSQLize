'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const currentMajor = Number.parseInt(packageJson.version, 10);
const currentDocuments = [
    'README.md',
    'docs/en/business-lock.md',
    'docs/en/configuration.md',
    'docs/zh/configuration.md',
    'docs/en/objectid-cross-version.md',
    'docs/zh/objectid-cross-version.md',
    'docs/en/objectid-cross-version-faq.md',
    'docs/zh/objectid-cross-version-faq.md',
    'docs/en/chaining-methods.md',
    'docs/zh/chaining-methods.md',
    'docs/en/runtime-architecture.md',
    'docs/zh/runtime-architecture.md',
];

const failures = [];
for (const relativePath of currentDocuments) {
    const content = fs.readFileSync(path.join(root, relativePath), 'utf8');
    const stalePattern = relativePath === 'README.md'
        ? /(?:current v2|v2 runtime|v2 publishing surface|v2 line|v2 package)/i
        : /\bv2(?:\.0)?\b/i;
    if (stalePattern.test(content)) failures.push(`${relativePath}: current-contract document still presents v2 terminology`);
}

const memoryPolicy = JSON.parse(fs.readFileSync(path.join(root, 'config', 'mongodb-memory-server.json'), 'utf8'));
const requiredMajors = [...new Set(memoryPolicy.requiredVersions.map((entry) => Number.parseInt(entry.version, 10)))];
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
for (const major of requiredMajors) {
    if (!readme.includes(`${major}.x`)) failures.push(`README.md: missing MongoDB server major ${major}.x from memory-server policy`);
}
if (!readme.includes(`v${currentMajor} package`)) failures.push(`README.md: missing current v${currentMajor} package source-of-truth statement`);

const schemaDslVersion = packageJson.dependencies?.['schema-dsl'];
if (typeof schemaDslVersion !== 'string') {
    failures.push('package.json: missing exact schema-dsl dependency');
} else {
    const schemaDslDocuments = [
        {
            path: 'README.md',
            markers: [`schema-dsl@${schemaDslVersion}`],
        },
        {
            path: 'docs/en/file-dependency-governance.md',
            markers: [`Exact stable version \`${schemaDslVersion}\``, `schema-dsl@${schemaDslVersion}`, `fixed to registry \`${schemaDslVersion}\``],
        },
        {
            path: 'docs/zh/file-dependency-governance.md',
            markers: [`稳定精确版本 \`${schemaDslVersion}\``, `schema-dsl@${schemaDslVersion}`, `固定为 registry \`${schemaDslVersion}\``],
        },
    ];
    for (const document of schemaDslDocuments) {
        const content = fs.readFileSync(path.join(root, document.path), 'utf8');
        for (const marker of document.markers) {
            if (!content.includes(marker)) failures.push(`${document.path}: missing current schema-dsl marker ${marker}`);
        }
        const staleReferences = [...content.matchAll(/schema-dsl@(\d+\.\d+\.\d+)/g)]
            .map((match) => match[1])
            .filter((version) => version !== schemaDslVersion);
        if (staleReferences.length > 0) {
            failures.push(`${document.path}: stale exact schema-dsl references ${[...new Set(staleReferences)].join(', ')}`);
        }
    }
}

if (failures.length > 0) {
    console.error('Current-version terminology check failed:');
    failures.forEach((failure) => console.error(`- ${failure}`));
    process.exitCode = 1;
} else {
    console.log(`Current-version terminology verified for v${currentMajor}, schema-dsl ${schemaDslVersion}, and MongoDB ${requiredMajors.join('.x / ')}.x.`);
}
