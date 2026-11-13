'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const distRoot = path.join(root, 'website', 'dist');
const policy = JSON.parse(fs.readFileSync(path.join(root, 'website', 'site-budget.json'), 'utf8'));

function collectFiles(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const absolutePath = path.join(directory, entry.name);
        return entry.isDirectory() ? collectFiles(absolutePath) : [absolutePath];
    });
}

if (!fs.existsSync(distRoot)) throw new Error('website/dist is missing; run the website build before the budget check.');

const files = collectFiles(distRoot).map((absolutePath) => ({
    absolutePath,
    relativePath: path.relative(distRoot, absolutePath).replaceAll('\\', '/'),
    bytes: fs.statSync(absolutePath).size,
}));
const htmlFiles = files.filter((file) => file.relativePath.endsWith('.html'));
const javascriptFiles = files.filter((file) => file.relativePath.endsWith('.js'));
const searchIndexes = files.filter((file) => /^static\/search_index\.[^.]+\.[^.]+\.json$/.test(file.relativePath));
const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
const largest = (candidates) => candidates.reduce((current, file) => !current || file.bytes > current.bytes ? file : current, undefined);
const largestJavaScript = largest(javascriptFiles);
const largestHtml = largest(htmlFiles);
const combinedSearchBytes = searchIndexes.reduce((sum, file) => sum + file.bytes, 0);
const failures = [];

function enforce(label, actual, limit, operator = '<=') {
    const passed = operator === '>=' ? actual >= limit : actual <= limit;
    if (!passed) failures.push(`${label}: ${actual} must be ${operator} ${limit}`);
}

enforce('HTML files', htmlFiles.length, policy.minimumHtmlFiles, '>=');
enforce('all files', files.length, policy.maximumFiles);
enforce('total bytes', totalBytes, policy.maximumTotalBytes);
enforce('largest JavaScript bytes', largestJavaScript?.bytes ?? 0, policy.maximumSingleJavaScriptBytes);
enforce('largest HTML bytes', largestHtml?.bytes ?? 0, policy.maximumSingleHtmlBytes);

for (const locale of policy.requiredSearchLocales) {
    const match = searchIndexes.find((file) => file.relativePath.startsWith(`static/search_index.${locale}.`));
    if (!match) failures.push(`search index for locale ${locale} is missing`);
}

console.log(JSON.stringify({
    files: files.length,
    htmlFiles: htmlFiles.length,
    totalBytes,
    largestJavaScript: largestJavaScript && { path: largestJavaScript.relativePath, bytes: largestJavaScript.bytes },
    largestHtml: largestHtml && { path: largestHtml.relativePath, bytes: largestHtml.bytes },
    combinedSearchIndexBytes: combinedSearchBytes,
    searchIndexes: searchIndexes.map((file) => ({ path: file.relativePath, bytes: file.bytes })),
}, null, 2));

if (failures.length > 0) {
    console.error('Website budget check failed:');
    failures.forEach((failure) => console.error(`- ${failure}`));
    process.exitCode = 1;
} else {
    console.log('Website asset budgets and search-index presence verified.');
}
