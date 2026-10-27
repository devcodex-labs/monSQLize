# Release preflight and recovery

## Command

```bash
# Release and docs tooling require Node.js 22; package consumers remain on Node.js >=18.
npm run release:preflight
```

You can also trigger the **Release Preflight** workflow through GitHub Actions. A `v*` tag and the npm publish workflow must pass the same gate. Preflight never creates a tag, publishes a package, or deploys documentation.

## What will it do

1. Reject a candidate with uncommitted files, an invalid installed dependency tree, or a current commit that has not been pushed to `origin`. A commit is pushed when it is the tip of an `origin` ref or an ancestor of an `origin` branch, including `origin/main` and the upstream tracking branch. A newer tip on `main` does not make that ancestor look unpublished. Shallow clones fetch, then deepen or unshallow until the ancestry check can be decided. Commits that were never pushed still fail.
2. Check whether `package-lock.json` is consistent with the current `package.json` version and does not contain `file:` / `workspace:` / sibling local path residue.
3. Check whether the changelog for the current version and packaged `MIGRATION.md` / `SECURITY.md` files exist.
4. Check whether the necessary documents for project management exist:
   - `docs/en/support-matrix.md`
   - `docs/en/file-dependency-governance.md`
   - `docs/en/verification-entrypoints.md`
   - `docs/zh/support-matrix.md`
   - `docs/zh/file-dependency-governance.md`
   - `docs/zh/verification-entrypoints.md`
5. Run the fast static/runtime gate and the complete public verification chain.
6. Require source coverage, runnable examples, the MongoDB server matrix, real dataTasks integration, the CLI matrix, and package-install smoke tests.
7. Use a clean install and Chromium to verify docs-site types, build output, internal links, asset/search budgets, keyboard and mobile navigation, language switching, axe WCAG A/AA checks, and dependency audit.
8. Run `npm pack --dry-run` and verify the packaged file boundary.
9. Keep `prepublishOnly` and repository publishing on the same `release:preflight` source so a direct publish cannot bypass the gate.
10. Keep `verify:release` as an explicit supplementary private-environment check; it is not a substitute for the public gate. Record a `skipReason` when that private environment is not configured instead of reporting a pass.

## Why not publish directly?

The goal of this script is to close the version information, public verification chain, dependency release boundary, and package consumability first, and then enter the release/tag/publish stage of manual confirmation.

## Recommended order

```bash
git status
git commit
git push origin HEAD
# Wait for remote CI on this commit, then run on the same clean commit:
npm run release:preflight
# Run the manual Release Authentication Check workflow to verify GitHub OIDC readiness.
# Confirm the npm package trusts devcodex-labs/monSQLize / publish.yml for npm publish.
# Optional private real-environment review: npm run verify:release
VERSION=$(node -p "require('./package.json').version")
git tag "v${VERSION}"
git push origin "v${VERSION}"
```

`release:preflight` verifies that the current `HEAD` exists on `origin`, so it cannot run against an uncommitted or local-only candidate. Before creating the tag, manually confirm remote CI, preflight evidence, a successful **Release Authentication Check** run, and the npm-side trusted publisher configuration. In the `monsqlize` package settings, select GitHub Actions with organization `devcodex-labs`, repository `monSQLize`, workflow filename `publish.yml`, no environment, and `npm publish` allowed. The check verifies that the runner can request OIDC credentials; npm validates the trusted publisher only during `npm publish`. The check and preflight do not create or push a tag or publish.

The tag starts the repository preflight and publish workflows. Do not deploy Pages yet. After registry acceptance succeeds, manually run **Deploy Docs to GitHub Pages** with `release_tag=vX.Y.Z`; that workflow checks out the tag and refuses deployment unless tag, `package.json`, and npm registry versions match.

Site ownership verification is independent of the documentation version. The Pages workflow copies only `google4524eb8336ad041b.html` from its own commit into the tagged site's static assets, validates the verification text, and compares the built file byte for byte before upload. Its source commit and SHA-256 appear in the build summary. To deploy this file with the current stable documentation, run `gh workflow run deploy-docs.yml --repo devcodex-labs/monSQLize --ref main -f release_tag=v3.3.1`. Other documentation still comes from the selected release tag; this command does not publish an npm package or change an existing tag.

If a tag-triggered publish fails for a recoverable reason such as authentication or registry availability, the publish workflow can be started manually with that exact existing `release_tag`. The workflow checks out and verifies the tag commit; it cannot publish the default branch as an untagged release.

## Post-publish acceptance

Run these checks against the exact version before creating or finalizing the GitHub Release:

```bash
VERSION=$(node -p "require('./package.json').version")
npm view "monsqlize@${VERSION}" version dist.integrity dist.tarball --registry=https://registry.npmjs.org/
npm view monsqlize dist-tags --json --registry=https://registry.npmjs.org/

TEMP_DIR=$(mktemp -d)
SOURCE_DIR=$(pwd -P)
(
  set -eu
  trap 'cd "${SOURCE_DIR}" && rm -rf -- "${TEMP_DIR}"' EXIT
  cd "${TEMP_DIR}"
  test "$(pwd -P)" != "${SOURCE_DIR}"
  npm init -y
  test -f package.json
  npm install "monsqlize@${VERSION}" --registry=https://registry.npmjs.org/
  test "$(node -p "require('monsqlize/package.json').version")" = "${VERSION}"
  node -e "const M=require('monsqlize'); if (!M) process.exit(1)"
  node --input-type=module -e "import M from 'monsqlize'; if (!M) process.exit(1)"
  ./node_modules/.bin/monsqlize --version
)
```

Run initialization, installation and bare-package imports inside that independent directory. `npm --prefix <directory> init -y` does not establish the consumer working directory and can write to the source directory. The subshell stops on failure and removes its temporary consumer; its exit code is the acceptance result.

Acceptance requires the requested version, integrity and tarball metadata to exist; `latest` to point to the intended stable version; CJS, ESM and CLI loading to pass; the Git tag to resolve to the release commit; and the GitHub Release plus Pages deployment to reference that same tag.

## Half-release recovery

Capture `VERSION`, the previous stable version, release commit, and registry evidence before changing anything:

```bash
VERSION=$(node -p "require('./package.json').version")
PREVIOUS_STABLE=3.3.1 # Verify the previous stable version in npm before recovery.
RELEASE_COMMIT=$(git rev-parse HEAD)
npm view "monsqlize@${VERSION}" version dist.integrity --json --registry=https://registry.npmjs.org/ || true
npm view monsqlize dist-tags --json --registry=https://registry.npmjs.org/
git ls-remote --tags origin "refs/tags/v${VERSION}"
```

- **Tag exists, npm version is absent:** keep the immutable tag on the reviewed release commit, fix authentication or workflow failure, rerun preflight, and rerun publish for the same tag. Do not deploy docs.
- **npm version exists, tag or GitHub Release is missing:** verify registry integrity first, then create/push `v${VERSION}` at `RELEASE_COMMIT` and create the GitHub Release from that exact tag. Never move a tag that consumers may already have fetched.
- **A defective package became `latest`:** restore the previous stable dist-tag, keep the defective version available for audit, mark it deprecated, publish a new corrective version, and only then move `latest` forward.

```bash
npm dist-tag add "monsqlize@${PREVIOUS_STABLE}" latest
npm dist-tag add "monsqlize@${VERSION}" next
npm deprecate "monsqlize@${VERSION}" "Superseded; use ${PREVIOUS_STABLE} until the corrective release is available"
```

- **Docs do not match npm:** run the Pages workflow with the last npm-verified stable tag. The workflow will reject unpublished or mismatched versions.
- **Registry integrity differs from the reviewed package:** stop. npm versions are immutable; do not retag or republish over the version. Preserve the evidence and issue a new version after investigation.
