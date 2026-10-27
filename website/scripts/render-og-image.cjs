#!/usr/bin/env node
'use strict';

/**
 * Render the docs social card.
 *
 * Source: website/assets/og-image.svg
 * Output: docs/public/og-image.png (1200x630, committed, copied into the site build)
 *
 * Requires rsvg-convert (librsvg2-bin) and optipng. The SVG uses Inter, with
 * Liberation Sans as a fallback. Re-run with: npm run render:og-image
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const websiteRoot = path.resolve(__dirname, '..');
const svgPath = path.join(websiteRoot, 'assets', 'og-image.svg');
const pngPath = path.resolve(websiteRoot, '..', 'docs', 'public', 'og-image.png');
const width = 1200;
const height = 630;
const maxBytes = 300 * 1024;

function run(command, args) {
    const result = spawnSync(command, args, { stdio: 'inherit' });
    if (result.error) {
        console.error(`[og-image] failed to run ${command}: ${result.error.message}`);
        process.exit(1);
    }
    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }
}

function readPngSize(filePath) {
    const header = Buffer.alloc(24);
    const fd = fs.openSync(filePath, 'r');
    try {
        fs.readSync(fd, header, 0, 24, 0);
    } finally {
        fs.closeSync(fd);
    }
    if (header.toString('ascii', 1, 4) !== 'PNG') {
        throw new Error(`${filePath} is not a PNG`);
    }
    return {
        width: header.readUInt32BE(16),
        height: header.readUInt32BE(20),
    };
}

run('rsvg-convert', [
    '--width', String(width),
    '--height', String(height),
    '--output', pngPath,
    svgPath,
]);
run('optipng', ['-o7', '-strip', 'all', '-quiet', pngPath]);

const size = readPngSize(pngPath);
const bytes = fs.statSync(pngPath).size;
if (size.width !== width || size.height !== height) {
    console.error(`[og-image] expected ${width}x${height}, got ${size.width}x${size.height}`);
    process.exit(1);
}
if (bytes > maxBytes) {
    console.error(`[og-image] ${bytes} bytes exceeds ${maxBytes} bytes`);
    process.exit(1);
}

console.log(`[og-image] wrote ${path.relative(path.resolve(websiteRoot, '..'), pngPath)} ${size.width}x${size.height} ${bytes} bytes`);
