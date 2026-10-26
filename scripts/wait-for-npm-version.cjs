#!/usr/bin/env node
'use strict';
/**
 * Waits until `<name>@<version>` is readable from the npm registry and the `latest`
 * dist-tag points at it. npm propagation after publish has been observed at ~1-3 minutes
 * (3.3.3: ~56s, 3.3.4: ~156s), so the default budget is 15 minutes with backoff.
 *
 * Usage: node scripts/wait-for-npm-version.cjs <name> <version>
 * Env: NPM_WAIT_MAX_SECONDS (default 900), NPM_WAIT_INITIAL_SECONDS (10), NPM_WAIT_MAX_INTERVAL_SECONDS (60),
 *      NPM_WAIT_DIST_TAG (default "latest"; empty string skips the dist-tag check), NPM_REGISTRY.
 */
const { execFileSync } = require('node:child_process');

const [name, version] = process.argv.slice(2);
if (!name || !version) {
    console.error('usage: wait-for-npm-version.cjs <name> <version>');
    process.exit(2);
}
const num = (key, fallback) => {
    const value = Number(process.env[key]);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
};
const maxSeconds = num('NPM_WAIT_MAX_SECONDS', 900);
const maxInterval = Math.max(1, num('NPM_WAIT_MAX_INTERVAL_SECONDS', 60));
let interval = Math.max(1, num('NPM_WAIT_INITIAL_SECONDS', 10));
const distTag = process.env.NPM_WAIT_DIST_TAG ?? 'latest';
const registry = process.env.NPM_REGISTRY || 'https://registry.npmjs.org/';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function view(args) {
    try {
        return execFileSync(npm, ['view', ...args, '--registry', registry, '--prefer-online'], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000,
        }).trim();
    } catch {
        return '';
    }
}

const sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

(async () => {
    const started = Date.now();
    for (let attempt = 1; ; attempt++) {
        const seen = view([`${name}@${version}`, 'version']);
        const tagged = distTag ? view([name, `dist-tags.${distTag}`]) : version;
        const elapsed = Math.round((Date.now() - started) / 1000);
        if (seen === version && tagged === version) {
            console.log(`[npm-wait] ${name}@${version} visible${distTag ? ` as ${distTag}` : ''} after ${elapsed}s (attempt ${attempt})`);
            return;
        }
        console.log(`[npm-wait] attempt ${attempt} at ${elapsed}s: version=${seen || 'missing'}${distTag ? `, ${distTag}=${tagged || 'missing'}` : ''}`);
        const remaining = maxSeconds - elapsed;
        if (remaining <= 0) {
            console.error(`::error::${name}@${version} did not become readable from npm (version and dist-tag) within ${maxSeconds}s`);
            process.exit(1);
        }
        await sleep(Math.min(interval, remaining));
        interval = Math.min(maxInterval, Math.ceil(interval * 1.5));
    }
})();
