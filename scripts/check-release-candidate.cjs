#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const ORIGIN_HEADS_REFSPEC = '+refs/heads/*:refs/remotes/origin/*';
const SHALLOW_DEEPEN_STEPS = [64, 256, 1024, 4096];

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: root,
        encoding: 'utf8',
        shell: process.platform === 'win32',
        ...options,
    });
    if (result.status !== 0) {
        const detail = (result.stderr || result.stdout || '').trim();
        throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
    }
    return result.stdout.trim();
}

function gitResult(cwd, args) {
    return spawnSync('git', ['-c', 'color.ui=false', ...args], {
        cwd,
        encoding: 'utf8',
        // Keep refspecs literal. A Windows shell would expand `*` in the fetch refspec.
        shell: false,
    });
}

function gitFailure(args, result) {
    const detail = `${result.stderr || ''}${result.stdout || ''}`.trim();
    return new Error(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
}

function git(cwd, args) {
    const result = gitResult(cwd, args);
    if (result.error) throw result.error;
    if (result.status !== 0) throw gitFailure(args, result);
    return result;
}

function isShallowRepository(cwd) {
    return git(cwd, ['rev-parse', '--is-shallow-repository']).stdout.trim() === 'true';
}

function refExists(cwd, ref) {
    const result = gitResult(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (result.error) throw result.error;
    return result.status === 0;
}

function isOriginRemoteBranch(name) {
    return name.startsWith('refs/remotes/origin/') && name !== 'refs/remotes/origin/HEAD';
}

function remoteTipRefs(cwd, head) {
    const output = git(cwd, ['ls-remote', 'origin']).stdout;
    const refs = [];
    for (const line of output.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const [commit, ref] = line.split(/\s+/, 2);
        if (commit === head && ref) refs.push(ref);
    }
    return refs;
}

function upstreamOriginRef(cwd) {
    const result = gitResult(cwd, ['rev-parse', '--symbolic-full-name', '@{upstream}']);
    if (result.error) throw result.error;
    if (result.status !== 0) return null;
    const name = result.stdout.trim();
    // A local branch or another remote can be @{upstream}. Only origin's
    // remote-tracking refs prove the commit was pushed to origin.
    if (!isOriginRemoteBranch(name)) return null;
    return name;
}

function originBranchRefs(cwd) {
    const output = git(cwd, ['for-each-ref', '--format=%(refname)', 'refs/remotes/origin']).stdout;
    const refs = new Set();
    for (const line of output.split(/\r?\n/)) {
        const name = line.trim();
        if (!isOriginRemoteBranch(name)) continue;
        refs.add(name);
    }
    if (refExists(cwd, 'refs/remotes/origin/main')) refs.add('refs/remotes/origin/main');
    const upstream = upstreamOriginRef(cwd);
    if (upstream && refExists(cwd, upstream)) refs.add(upstream);
    return [...refs];
}

function refsContainingCommit(cwd, head) {
    const containing = new Set();
    for (const ref of originBranchRefs(cwd)) {
        const result = gitResult(cwd, ['merge-base', '--is-ancestor', head, ref]);
        if (result.error) throw result.error;
        if (result.status === 0) {
            containing.add(ref);
            continue;
        }
        if (result.status !== 1) throw gitFailure(['merge-base', '--is-ancestor', head, ref], result);
    }

    const listed = git(cwd, ['for-each-ref', '--contains', head, '--format=%(refname)', 'refs/remotes/origin']);
    for (const line of listed.stdout.split(/\r?\n/)) {
        const name = line.trim();
        if (!isOriginRemoteBranch(name)) continue;
        containing.add(name);
    }
    return [...containing].sort();
}

function fetchOriginHeads(cwd, extraArgs = []) {
    git(cwd, ['fetch', '--prune', '--no-tags', ...extraArgs, 'origin', ORIGIN_HEADS_REFSPEC]);
}

function deepenShallowHistory(cwd, head) {
    let containing = [];
    for (const step of SHALLOW_DEEPEN_STEPS) {
        if (!isShallowRepository(cwd)) break;
        fetchOriginHeads(cwd, [`--deepen=${step}`]);
        containing = refsContainingCommit(cwd, head);
        if (containing.length > 0) return containing;
    }
    if (containing.length === 0 && isShallowRepository(cwd)) {
        fetchOriginHeads(cwd, ['--unshallow']);
        containing = refsContainingCommit(cwd, head);
    }
    return containing;
}

/**
 * HEAD is published when it is the tip of an origin ref, or an ancestor of an
 * origin branch (at least refs/remotes/origin/main and an upstream ref only
 * when that upstream is under refs/remotes/origin/).
 * Shallow clones fetch and deepen until that ancestry can be decided.
 * @param {string} cwd
 * @returns {{ head: string, refs: string[], relationship: 'tip' | 'ancestor' }}
 */
function assertHeadPublished(cwd) {
    const head = git(cwd, ['rev-parse', 'HEAD']).stdout.trim();
    const tipRefs = remoteTipRefs(cwd, head);
    if (tipRefs.length > 0) {
        return { head, refs: tipRefs.sort(), relationship: 'tip' };
    }

    // ls-remote only sees tips. Fetch branch history so a commit that origin
    // already contains still passes after a newer commit becomes the tip.
    fetchOriginHeads(cwd);
    let containing = refsContainingCommit(cwd, head);
    if (containing.length === 0 && isShallowRepository(cwd)) {
        containing = deepenShallowHistory(cwd, head);
    }
    if (containing.length === 0) {
        throw new Error(`HEAD ${head} is not present on origin; push the reviewed commit before release preflight.`);
    }
    return { head, refs: containing, relationship: 'ancestor' };
}

function fail(message) {
    console.error(`[release-candidate] ${message}`);
    process.exit(1);
}

function main() {
    const status = run('git', ['status', '--porcelain=v1', '--untracked-files=all']);
    if (status) fail(`worktree is not clean:\n${status}`);

    run('npm', ['ls', '--all', '--json'], { stdio: 'pipe' });

    const publication = assertHeadPublished(root);
    console.log(`[release-candidate] passed: clean tree, valid installed dependency graph, origin contains ${publication.head}`);
    console.log(`[release-candidate] remote refs: ${publication.refs.join(', ')}`);
}

module.exports = { assertHeadPublished };

if (require.main === module) {
    try {
        main();
    } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
    }
}
