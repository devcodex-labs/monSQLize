'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const driverOwners = new Map([
    ['mongodb', 'mongodb'], ['bson', 'mongodb'],
    ['pg', 'postgresql'], ['pg-native', 'postgresql'],
    ['mysql2', 'mysql'],
    ['better-sqlite3', 'sqlite'], ['sqlite3', 'sqlite'], ['@monsqlize/sqlite-native', 'sqlite'], ['node:sqlite', 'sqlite'],
]);
const protectedGraph = /^src\/(core\/(runtime|query)\/|adapters\/(sqlite|postgresql|mysql)\/|capabilities\/)/;
const legacyMongoConsumers = new Set([
    'data-tasks/job-backup', 'data-tasks/job-normalizer', 'data-tasks/job-planner', 'data-tasks/job-restore',
    'gridfs/bucket', 'gridfs/driver', 'gridfs/errors', 'gridfs/index', 'gridfs/indexes', 'gridfs/normalize',
    'gridfs/operations', 'gridfs/ownership', 'gridfs/resumable', 'gridfs/types', 'gridfs/validate',
    'model/model-instance-helpers', 'model/populate-promise', 'pool/index', 'pool/pool-runtime-helpers',
    'slow-query-log/slow-query-log-manager', 'slow-query-log/slow-query-log-storage',
    'sync/index', 'sync/resume-token-store', 'transaction/index',
].map(file => `src/capabilities/${file}.ts`));

function packageName(specifier) {
    if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/');
    return specifier.split('/')[0];
}

function adapterFor(filename) {
    return /^src\/adapters\/([^/]+)(?:\/|$)/.exec(filename)?.[1];
}

function moduleReferences(filename, text) {
    const references = [];
    const source = ts.createSourceFile(filename, text, ts.ScriptTarget.ES2021, true);
    function visit(node) {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
            const typeOnly = ts.isImportDeclaration(node) ? node.importClause?.isTypeOnly : node.isTypeOnly;
            references.push({ specifier: node.moduleSpecifier.text, typeOnly });
        } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
            && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) {
            references.push({ specifier: node.moduleReference.expression.text, typeOnly: node.isTypeOnly });
        } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
            references.push({ specifier: node.argument.literal.text, typeOnly: true });
        } else if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])) {
            const callee = node.expression;
            if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require')) {
                references.push({ specifier: node.arguments[0].text, typeOnly: false });
            }
        }
        ts.forEachChild(node, visit);
    }
    visit(source);
    return references;
}

function relativeTarget(filename, specifier) {
    if (specifier.startsWith('.')) return path.posix.normalize(path.posix.join(path.posix.dirname(filename), specifier));
    if (specifier.startsWith('src/')) return path.posix.normalize(specifier);
    return undefined;
}

function targetFile(files, base) {
    if (!base) return undefined;
    const noExtension = base.replace(/\.[cm]?js$/, '');
    return [base, noExtension + '.ts', noExtension + '.mts', noExtension + '.cts', base + '/index.ts', base + '/index.mts', base + '/index.cts']
        .find(name => files.has(name));
}

/** Checks literal driver imports, cross-adapter imports, and cycles in the scoped implementation graph. */
function checkBoundaries(files) {
    const errors = new Set();
    const graph = new Map();
    for (const [file, source] of files) {
        const fromAdapter = adapterFor(file);
        const fromCore = file.startsWith('src/core/');
        const fromCapability = file.startsWith('src/capabilities/');
        const targets = [];
        for (const { specifier, typeOnly } of moduleReferences(file, source)) {
            const base = relativeTarget(file, specifier);
            const toAdapter = base && adapterFor(base);
            const driverOwner = driverOwners.get(packageName(specifier));
            const existingMongoEdge = (specifier === 'mongodb' && (
                legacyMongoConsumers.has(file) || (file === 'src/core/cache-scope.ts' && typeOnly)
            )) || (file === 'src/capabilities/model/index.ts' && base === 'src/adapters/mongodb/queries/query-helpers');
            if ((fromCore || fromCapability) && !existingMongoEdge && (toAdapter || driverOwner)) {
                errors.add(`${file} imports backend-specific module ${specifier}`);
            }
            if (fromAdapter && toAdapter && toAdapter !== fromAdapter) {
                errors.add(`${file} imports another adapter ${specifier}`);
            }
            if (fromAdapter && driverOwner && driverOwner !== fromAdapter) {
                errors.add(`${file} imports another adapter's driver ${specifier}`);
            }
            const existingGridfsEdge = file === 'src/capabilities/model/index.ts' && base === 'src/entry/runtime-gridfs';
            if ((fromCore || fromCapability || fromAdapter) && !existingGridfsEdge && /^src\/entry(?:\/|$)/.test(base ?? '')) {
                errors.add(`${file} imports from entry ${specifier}`);
            }
            const target = targetFile(files, base);
            if (target && protectedGraph.test(target) && !typeOnly) targets.push(target);
        }
        if (protectedGraph.test(file)) graph.set(file, targets);
    }

    const status = new Map();
    function checkCycle(file, stack) {
        if (status.get(file) === 'complete') return;
        if (status.get(file) === 'visiting') {
            errors.add(`backend boundary cycle: ${[...stack.slice(stack.indexOf(file)), file].join(' -> ')}`);
            return;
        }
        status.set(file, 'visiting');
        for (const dependency of graph.get(file)) checkCycle(dependency, [...stack, file]);
        status.set(file, 'complete');
    }
    for (const file of graph.keys()) checkCycle(file, []);
    return [...errors].sort();
}

function filesBelow(root, folder, files) {
    const target = path.join(root, folder);
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
        const relative = `${folder}/${entry.name}`;
        if (entry.isDirectory()) filesBelow(root, relative, files);
        else if (entry.isFile() && /\.[cm]?ts$/.test(relative)) files.set(relative, fs.readFileSync(path.join(root, relative), 'utf8'));
    }
}

if (require.main === module) {
    const root = path.resolve(__dirname, '../..');
    const files = new Map();
    filesBelow(root, 'src/core', files);
    filesBelow(root, 'src/adapters', files);
    filesBelow(root, 'src/capabilities', files);
    const errors = checkBoundaries(files);
    if (errors.length) {
        process.stderr.write(`${errors.join('\n')}\n`);
        process.exitCode = 1;
    } else {
        process.stdout.write(`Backend boundaries checked over ${files.size} source files.\n`);
    }
}

module.exports = { checkBoundaries };

