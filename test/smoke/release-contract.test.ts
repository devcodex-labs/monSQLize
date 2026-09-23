import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(__dirname, '..', '..', '..', '..');

function read(relativePath: string): string {
    return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('release paths consume the complete single-source preflight gate', () => {
    const packageJson = JSON.parse(read('package.json')) as {
        version: string;
        scripts: Record<string, string>;
        files: string[];
    };
    const preflight = read('scripts/release-preflight.cjs');
    const ci = read('.github/workflows/test.yml');
    const releaseWorkflow = read('.github/workflows/release-preflight.yml');
    const releaseAuthWorkflow = read('.github/workflows/release-auth-check.yml');
    const publishWorkflow = read('.github/workflows/publish.yml');
    const deployDocsWorkflow = read('.github/workflows/deploy-docs.yml');
    const candidateCheck = read('scripts/check-release-candidate.cjs');
    const releaseMetadataCheck = read('scripts/validation/check-release-metadata.cjs');
    const packInstallSmoke = read('scripts/pack-install-smoke.cjs');
    const buildScript = read('scripts/build-p1.cjs');
    const compileTestsScript = read('scripts/compile-tests.cjs');
    const websitePackageJson = JSON.parse(read('website/package.json')) as {
        scripts: Record<string, string>;
    };

    for (const script of [
        'verify:fast',
        'test:coverage',
        'test:examples',
        'test:server-matrix',
        'test:data-tasks:integration',
        'test:data-task-cli',
        'test:audit',
        'test:pack-install',
    ]) {
        assert.match(preflight, new RegExp(`['\"]${script.replaceAll(':', '\\:')}['\"]`));
    }

    assert.match(packageJson.scripts['type-check'], /data-tasks-usage\.test-d\.ts/);
    assert.equal(packageJson.scripts.prepublishOnly, 'npm run release:preflight');
    assert.match(packageJson.scripts['release:publish'], /^npm run release:preflight && /);
    assert.ok(packageJson.files.includes(`changelogs/v${packageJson.version}.md`));
    assert.ok(packageJson.files.includes('MIGRATION.md'));
    assert.ok(packageJson.files.includes('SECURITY.md'));
    assert.ok(packageJson.files.includes('licenses/production-dependencies.json'));
    assert.match(preflight, /Node\.js 22\+/);
    assert.equal(
        preflight.match(/run\('npm', \['run', 'check:release-candidate'\]\);/g)?.length,
        2,
    );
    assert.match(preflight, /\['--prefix', 'website', 'ci'\]/);
    assert.match(preflight, /\['--prefix', 'website', 'audit', '--audit-level=high'\]/);
    assert.match(preflight, /playwright[\s\S]*install[\s\S]*chromium/);
    assert.match(preflight, /\['--prefix', 'website', 'run', 'verify'\]/);
    assert.match(candidateCheck, /git[\s\S]*status[\s\S]*--porcelain=v1/);
    assert.match(candidateCheck, /npm[\s\S]*ls[\s\S]*--all/);
    assert.match(candidateCheck, /git[\s\S]*ls-remote[\s\S]*origin/);
    assert.match(releaseMetadataCheck, /compatibilityMatrix\.packageVersion/);
    assert.match(releaseMetadataCheck, /compatibilityMatrix\.generatedAt/);
    assert.match(packInstallSmoke, /MIGRATION\.md/);
    assert.match(packInstallSmoke, /SECURITY\.md/);
    assert.match(packInstallSmoke, /dataTasks/);
    assert.match(packInstallSmoke, /schema-dsl/);
    for (const generatedDirectoryWriter of [buildScript, compileTestsScript]) {
        assert.match(generatedDirectoryWriter, /maxRetries:\s*10/);
        assert.match(generatedDirectoryWriter, /retryDelay:\s*100/);
    }
    assert.match(websitePackageJson.scripts.verify, /type-check.*build.*check:links.*check:budgets.*check:browser.*check:audit/);
    assert.match(ci, /npm run release:preflight/);
    assert.match(releaseWorkflow, /npm run release:preflight/);
    assert.match(releaseAuthWorkflow, /workflow_dispatch/);
    assert.match(releaseAuthWorkflow, /id-token:\s*write/);
    assert.match(releaseAuthWorkflow, /npm@11\.20\.0/);
    assert.match(releaseAuthWorkflow, /ACTIONS_ID_TOKEN_REQUEST_URL/);
    assert.doesNotMatch(releaseAuthWorkflow, /secrets\.NPM_TOKEN|npm whoami/);
    assert.match(publishWorkflow, /npm run release:preflight/);
    assert.match(publishWorkflow, /id-token:\s*write/);
    assert.match(publishWorkflow, /npm@11\.20\.0/);
    assert.match(publishWorkflow, /ACTIONS_ID_TOKEN_REQUEST_URL/);
    assert.doesNotMatch(publishWorkflow, /secrets\.NPM_TOKEN|npm whoami/);
    assert.match(publishWorkflow, /dist\.integrity/);
    assert.match(publishWorkflow, /dist-tags\.latest/);
    assert.match(publishWorkflow, /id: registry-state/);
    assert.match(publishWorkflow, /REGISTRY_GIT_HEAD/);
    assert.match(publishWorkflow, /if: steps\.registry-state\.outputs\.already_published != 'true'/);
    assert.match(publishWorkflow, /mkdir -p "\$\{CONSUMER_DIR\}"/);
    assert.match(publishWorkflow, /cd "\$\{CONSUMER_DIR\}"/);
    assert.match(publishWorkflow, /require\('monsqlize'\)/);
    assert.match(publishWorkflow, /from 'monsqlize'/);
    assert.match(publishWorkflow, /consumer\.ts/);
    assert.match(publishWorkflow, /"@types\/node@25\.6\.2"/);
    assert.match(publishWorkflow, /\.\/node_modules\/\.bin\/monsqlize/);
    assert.doesNotMatch(publishWorkflow, /CONSUMER_DIR.*dist\/esm\/index\.mjs/);
    assert.match(publishWorkflow, /dataTasks/);
    assert.match(publishWorkflow, /release_tag:/);
    assert.match(publishWorkflow, /ref: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.release_tag \|\| github\.ref \}\}/);
    assert.match(publishWorkflow, /git rev-parse "\$\{RELEASE_TAG\}\^\{commit\}"/);
    assert.match(publishWorkflow, /GITHUB_STEP_SUMMARY/);
    assert.match(publishWorkflow, /releases\/new\?tag=/);
    assert.match(publishWorkflow, /Deploy Docs to GitHub Pages/);
    assert.match(ci, /release-gate[\s\S]*node-version: '22\.x'/);
    assert.match(releaseWorkflow, /node-version: '22\.x'/);
    assert.match(deployDocsWorkflow, /node-version: '22'/);
    assert.match(deployDocsWorkflow, /playwright install --with-deps chromium/);
    for (const workflow of [ci, releaseWorkflow, releaseAuthWorkflow, publishWorkflow, deployDocsWorkflow]) {
        assert.doesNotMatch(workflow, /actions\/setup-node@v4/);
        assert.match(workflow, /actions\/setup-node@v6/);
    }
    for (const workflow of [ci, releaseWorkflow, publishWorkflow, deployDocsWorkflow]) {
        assert.doesNotMatch(workflow, /actions\/checkout@v4/);
        assert.match(workflow, /actions\/checkout@v5/);
    }
    for (const workflow of [ci, releaseWorkflow, publishWorkflow]) {
        assert.doesNotMatch(workflow, /actions\/cache@v4/);
        assert.match(workflow, /actions\/cache@v5/);
    }
    assert.doesNotMatch(deployDocsWorkflow, /actions\/upload-pages-artifact@v3/);
    assert.match(deployDocsWorkflow, /actions\/upload-pages-artifact@v5/);
    assert.doesNotMatch(deployDocsWorkflow, /actions\/deploy-pages@v4/);
    assert.match(deployDocsWorkflow, /actions\/deploy-pages@v5/);
});

test('stable docs deployment requires an npm-verified release tag', () => {
    const deployDocs = read('.github/workflows/deploy-docs.yml');

    assert.doesNotMatch(deployDocs, /branches:\s*\[main\]/);
    assert.match(deployDocs, /release_tag:/);
    assert.match(deployDocs, /npm view "monsqlize@\$\{PACKAGE_VERSION\}"/);
    assert.match(deployDocs, /DOCS_RELEASE_CHANNEL=stable/);
    assert.match(deployDocs, /path: release/);
    assert.match(deployDocs, /path: tooling/);
    assert.match(deployDocs, /ref: \$\{\{ github\.sha \}\}/);
    assert.match(deployDocs, /Select verified website toolchain/);
    assert.match(deployDocs, /cp tooling\/website\/package-lock\.json release\/website\/package-lock\.json/);
    assert.match(deployDocs, /DOCS_LEGACY_TAG/);
    assert.match(deployDocs, /npm run verify/);
    assert.match(deployDocs, /check-site-links\.cjs --dist/);
    assert.match(deployDocs, /npm audit/);
    assert.match(deployDocs, /GITHUB_STEP_SUMMARY/);
});

test('sync example confines and cleans resume-token artifacts', () => {
    const syncExample = read('examples/docs/sync.ts');

    assert.match(syncExample, /syncManagerTokenPath\s*=\s*path\.join\(os\.tmpdir\(\)/);
    assert.match(syncExample, /resumeToken:\s*\{\s*storage:\s*'file',\s*path:\s*syncManagerTokenPath\s*\}/);
    assert.match(syncExample, /rm\(`\$\{tokenPath\}\.bak`,\s*\{\s*force:\s*true\s*\}\)/);
    assert.match(syncExample, /clearResumeTokenArtifacts\(syncManagerTokenPath\)/);
});
