import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const projectRoot = process.cwd();
const { assertHeadPublished } = require(path.join(projectRoot, 'scripts/check-release-candidate.cjs')) as {
    assertHeadPublished: (cwd: string) => { head: string; refs: string[]; relationship: 'tip' | 'ancestor' };
};

const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Release Candidate Test',
    GIT_AUTHOR_EMAIL: 'release-candidate-test@example.com',
    GIT_COMMITTER_NAME: 'Release Candidate Test',
    GIT_COMMITTER_EMAIL: 'release-candidate-test@example.com',
};

function gitResult(cwd: string, args: string[]) {
    return spawnSync('git', args, {
        cwd,
        encoding: 'utf8',
        env: gitEnv,
        shell: false,
    });
}

function git(cwd: string, args: string[]): string {
    const result = gitResult(cwd, args);
    if (result.status !== 0) {
        const detail = `${result.stderr || ''}${result.stdout || ''}`.trim();
        throw new Error(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
    }
    return (result.stdout || '').trim();
}

function gitStatus(cwd: string, args: string[]): number {
    const result = gitResult(cwd, args);
    return result.status ?? 1;
}

function toFileUrl(directory: string): string {
    const resolved = path.resolve(directory).replace(/\\/g, '/');
    return resolved.startsWith('/') ? `file://${resolved}` : `file:///${resolved}`;
}

function commitFile(work: string, message: string, contents: string): void {
    writeFileSync(path.join(work, 'README'), contents);
    git(work, ['add', 'README']);
    git(work, ['commit', '-m', message]);
}

function withPublishedBase(run: (repo: { dir: string; remoteUrl: string; work: string }) => void): void {
    const dir = mkdtempSync(path.join(tmpdir(), 'release-candidate-'));
    try {
        const remote = path.join(dir, 'origin.git');
        const work = path.join(dir, 'work');
        git(dir, ['init', '--bare', '-b', 'main', remote]);
        git(dir, ['init', '-b', 'main', work]);
        git(work, ['config', 'user.email', 'release-candidate-test@example.com']);
        git(work, ['config', 'user.name', 'Release Candidate Test']);
        git(work, ['config', 'commit.gpgsign', 'false']);
        commitFile(work, 'base', 'base\n');
        const remoteUrl = toFileUrl(remote);
        git(work, ['remote', 'add', 'origin', remoteUrl]);
        git(work, ['push', '-u', 'origin', 'HEAD:main']);
        run({ dir, remoteUrl, work });
    } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
}

test('tip of origin/main passes the release-candidate check', () => {
    withPublishedBase(({ work }) => {
        const publication = assertHeadPublished(work);
        assert.equal(publication.relationship, 'tip');
        assert.equal(publication.head, git(work, ['rev-parse', 'HEAD']));
        assert.ok(publication.refs.includes('refs/heads/main'));
    });
});

test('ancestor of origin/main passes the release-candidate check', () => {
    withPublishedBase(({ work }) => {
        const ancestor = git(work, ['rev-parse', 'HEAD']);
        commitFile(work, 'later', 'later\n');
        git(work, ['push', 'origin', 'HEAD:main']);
        git(work, ['checkout', '--detach', ancestor]);

        const publication = assertHeadPublished(work);
        assert.equal(publication.relationship, 'ancestor');
        assert.equal(publication.head, ancestor);
        assert.ok(publication.refs.includes('refs/remotes/origin/main'));
    });
});

test('unpushed local commit fails the release-candidate check', () => {
    withPublishedBase(({ work }) => {
        commitFile(work, 'local-only', 'local-only\n');
        assert.throws(
            () => assertHeadPublished(work),
            /HEAD [0-9a-f]{40} is not present on origin; push the reviewed commit before release preflight\./,
        );
    });
});

test('ancestor of a non-main tracking branch passes the release-candidate check', () => {
    withPublishedBase(({ work }) => {
        git(work, ['checkout', '-b', 'release']);
        commitFile(work, 'release-1', 'release-1\n');
        git(work, ['push', '-u', 'origin', 'release']);
        commitFile(work, 'release-2', 'release-2\n');
        git(work, ['push', 'origin', 'release']);
        git(work, ['reset', '--hard', 'HEAD~1']);

        const publication = assertHeadPublished(work);
        assert.equal(publication.relationship, 'ancestor');
        assert.ok(publication.refs.includes('refs/remotes/origin/release'));
        assert.equal(publication.refs.includes('refs/remotes/origin/main'), false);
    });
});

test('depth-1 checkout of an origin/main ancestor passes after main moves', () => {
    withPublishedBase(({ dir, remoteUrl, work }) => {
        const ancestor = git(work, ['rev-parse', 'HEAD']);
        const shallow = path.join(dir, 'shallow');
        git(dir, ['init', '-b', 'main', shallow]);
        git(shallow, ['remote', 'add', 'origin', remoteUrl]);
        git(shallow, ['fetch', '--no-tags', '--prune', '--depth=1', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
        git(shallow, ['checkout', '--detach', ancestor]);
        commitFile(work, 'later', 'later\n');
        git(work, ['push', 'origin', 'HEAD:main']);

        const publication = assertHeadPublished(shallow);
        assert.equal(publication.relationship, 'ancestor');
        assert.equal(publication.head, ancestor);
        assert.ok(publication.refs.includes('refs/remotes/origin/main'));
        assert.equal(git(shallow, ['rev-parse', '--is-shallow-repository']), 'true');
    });
});

test('depth-truncated origin/main still accepts an ancestor after history is deepened', () => {
    withPublishedBase(({ dir, remoteUrl, work }) => {
        const ancestor = git(work, ['rev-parse', 'HEAD']);
        for (let index = 1; index <= 5; index += 1) {
            commitFile(work, `c${index}`, `c${index}\n`);
        }
        git(work, ['push', 'origin', 'HEAD:main']);

        const shallow = path.join(dir, 'truncated');
        git(dir, ['init', '-b', 'main', shallow]);
        git(shallow, ['remote', 'add', 'origin', remoteUrl]);
        git(shallow, ['fetch', '--depth', '1', 'origin', ancestor]);
        git(shallow, ['checkout', '--detach', 'FETCH_HEAD']);
        git(shallow, ['fetch', '--depth', '1', 'origin', '+refs/heads/*:refs/remotes/origin/*']);
        assert.equal(gitStatus(shallow, ['merge-base', '--is-ancestor', 'HEAD', 'refs/remotes/origin/main']), 1);

        const publication = assertHeadPublished(shallow);
        assert.equal(publication.relationship, 'ancestor');
        assert.equal(publication.head, ancestor);
        assert.ok(publication.refs.includes('refs/remotes/origin/main'));
    });
});

test('upstream outside refs/remotes/origin does not publish an unpushed commit', () => {
    withPublishedBase(({ work }) => {
        commitFile(work, 'local-only', 'local-only\n');
        git(work, ['branch', 'feat', 'HEAD']);
        git(work, ['branch', '--set-upstream-to=feat']);
        assert.equal(git(work, ['rev-parse', '--symbolic-full-name', '@{upstream}']), 'refs/heads/feat');
        assert.throws(
            () => assertHeadPublished(work),
            /HEAD [0-9a-f]{40} is not present on origin; push the reviewed commit before release preflight\./,
        );
    });

    withPublishedBase(({ dir, work }) => {
        commitFile(work, 'fork-only', 'fork-only\n');
        const fork = path.join(dir, 'fork.git');
        git(dir, ['init', '--bare', '-b', 'main', fork]);
        git(work, ['remote', 'add', 'fork', toFileUrl(fork)]);
        git(work, ['push', '-u', 'fork', 'HEAD:main']);
        assert.equal(git(work, ['rev-parse', '--symbolic-full-name', '@{upstream}']), 'refs/remotes/fork/main');
        assert.throws(
            () => assertHeadPublished(work),
            /HEAD [0-9a-f]{40} is not present on origin; push the reviewed commit before release preflight\./,
        );
    });
});

test('a local branch named origin/main does not publish an unpushed commit', () => {
    withPublishedBase(({ work }) => {
        commitFile(work, 'local-only', 'local-only\n');
        git(work, ['branch', 'origin/main', 'HEAD']);
        assert.equal(gitStatus(work, ['merge-base', '--is-ancestor', 'HEAD', 'origin/main']), 0);
        assert.equal(gitStatus(work, ['merge-base', '--is-ancestor', 'HEAD', 'refs/remotes/origin/main']), 1);
        assert.throws(
            () => assertHeadPublished(work),
            /HEAD [0-9a-f]{40} is not present on origin; push the reviewed commit before release preflight\./,
        );
    });
});
