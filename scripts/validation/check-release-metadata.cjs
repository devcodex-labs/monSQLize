#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const packageJson = require('../../package.json');
const compatibilityMatrix = require('../../test/compatibility/matrix.json');
const tag = `v${packageJson.version}`;

function git(args) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
    if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
    return result.stdout.trim();
}

try {
    if (compatibilityMatrix.packageVersion !== packageJson.version) {
        throw new Error(`compatibility matrix version drift: expected ${packageJson.version}, got ${compatibilityMatrix.packageVersion}`);
    }
    if (packageJson.version.includes('-')) {
        const candidateNotes = path.join(root, 'changelogs', `v${packageJson.version}.md`);
        if (!fs.existsSync(candidateNotes)) {
            throw new Error(`prerelease notes are missing: changelogs/v${packageJson.version}.md`);
        }
        const content = fs.readFileSync(candidateNotes, 'utf8');
        if (!/not published/i.test(content)) {
            throw new Error(`prerelease notes for ${tag} must state that the candidate is not published`);
        }
        console.log(`[release-metadata] ${tag} is an untagged, not-published rehearsal candidate with local notes.`);
        process.exit(0);
    }
    const releaseNotes = fs.readFileSync(path.join(root, 'changelogs', `${tag}.md`), 'utf8');
    const unreleased = fs.readFileSync(path.join(root, 'changelogs', 'unreleased.md'), 'utf8');
    const releaseDate = releaseNotes.match(/^> Release date: (\d{4}-\d{2}-\d{2})$/m)?.[1];
    if (!releaseDate) {
        throw new Error(`${tag} release notes must contain a YYYY-MM-DD release date`);
    }
    if (compatibilityMatrix.generatedAt !== releaseDate) {
        throw new Error(`compatibility matrix evidence date drift: expected ${releaseDate}, got ${compatibilityMatrix.generatedAt}`);
    }
    const tagDate = git(['for-each-ref', `refs/tags/${tag}`, '--format=%(creatordate:short)']);
    if (!tagDate) {
        if (!unreleased.includes(`Changes after ${tag}`)) {
            throw new Error(`Unreleased must contain a "Changes after ${tag}" section`);
        }
        console.log(`[release-metadata] ${tag} is an untagged stable release candidate; release notes and Unreleased metadata are consistent.`);
        process.exit(0);
    }
    if (!releaseNotes.includes(`Release date: ${tagDate}`)) {
        throw new Error(`${tag} release date must match tag creator date ${tagDate}`);
    }
    const commitsAfterTag = Number.parseInt(git(['rev-list', '--count', `${tag}..HEAD`]), 10);
    if (commitsAfterTag > 0 && /No changes are currently recorded after/.test(unreleased)) {
        throw new Error(`${commitsAfterTag} commit(s) exist after ${tag}, but Unreleased says there are no changes`);
    }
    if (commitsAfterTag > 0 && !unreleased.includes(`Changes after ${tag}`)) {
        throw new Error(`Unreleased must contain a "Changes after ${tag}" section`);
    }
    console.log(`[release-metadata] ${tag} date=${tagDate}; commits-after-tag=${commitsAfterTag}; Unreleased is consistent.`);
} catch (error) {
    console.error(`[release-metadata] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
}
