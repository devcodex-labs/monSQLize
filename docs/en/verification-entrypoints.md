# Verification entry layer description

> Goal: Explain clearly "what should be run during normal code changes, what should be run before release, and which checks depend on the private environment".

## Three-layer verification entrance

| Entry | Command | Default environment | Purpose |
|------|------|----------|------|
| Fast | `npm run verify:fast` | Local/CI | Daily changes, hot spot reconstruction, fast guard before PR |
| Full | `npm run verify:full` | Local/CI | Full functional regression, sample regression, memory-server matrix; not concatenated coverage governance access control |
| Release | `npm run verify:release` | Before local private release | Add opt-in real environment check based on `full` |

## Supplementary entrance

| Command | Description |
|------|------|
| `npm test` | Default unified access control: smoke + compatibility + unit + integration; no longer implicitly run legacy compat runner or migration-specific runner |
| `npm run check:docs-examples` | Documentation/example parity gate: verifies the current bilingual slug matrix, runner coverage, shared-example targets, doc-check targets, and visible path text |
| `npm run check:lint-contract` | Proves that the flat ESLint configuration parses and checks representative JavaScript, TypeScript, declaration, test, example, and TSX files |
| `npm run check:doc-claims` / `check:error-contract` / `check:current-version` | Guards numeric performance evidence, Data Task error-code documentation, and current v3 / MongoDB 7.x-8.x terminology |
| `npm run test:coverage` | Independent `c8 --all` coverage governance gate: global lines/statements/functions/branches stay at or above 90%, six risk modules meet local floors, and the per-run temporary directory is cleaned |
| `npm run test:refactor-guard` | Hot spot reconstruction triple regression: exports + runtime/model + sync |
| `npm run test:server-matrix` | Strict Node 20/22 × Driver 6/7 × MongoDB 7/8 memory-server matrix; the current Node runtime is reused, Volta fills only a missing Node 20/22 runtime, and database integration files start serially to avoid automatic-port races |
| `npm run test:real-env:private` | Private real environment check; do not enter regular verify / CI by default |
| `npm run release:preflight` | Node 22 strict single-source release gate: clean pushed candidate + release metadata + `verify:fast` + default tests + coverage + examples + server matrix + dataTasks/CLI integration + license/audit + temporary package install + Chromium website verify + final pack boundary |
| `npm run test:pack-install` | Build and pack the candidate, install the tarball in a temporary consumer, and verify CJS, ESM, dataTasks, schema-dsl, TypeScript, MIGRATION/SECURITY, bin, help, and version |
| `npm --prefix website run verify` | Verify types, Rspress build, internal links, asset budgets, required search indexes and size reporting, Chromium keyboard/mobile/language behavior, axe WCAG A/AA, and dependency audit using the website lockfile |

The memory-server related entries uniformly use `.cache/mongodb-memory-server/binaries` as the binary cache and `.cache/mongodb-memory-server/db` as the temporary data directory within the project; the dbPath automatically created by the project will be cleared when the script exits or runtime close to avoid the accumulation of default system temporary directories.

The release matrix pins MongoDB `7.0.37` and `8.0.26`. `probe:server-matrix` and `test:server-matrix` exit nonzero when any required server, topology, driver, or test combination is unavailable or failed. When Volta is available, `test:server-matrix` adds whichever of Node 20/22 is missing from the current environment instead of repeating the current major.

## Run strategy


## 1. Daily development/small-scale refactoring

```bash
npm run verify:fast
```

Note: Currently `verify:fast` no longer has a dedicated runner for serial migration; it covers lint, type-check, size strict, runtime smoke, compatibility, runtime/model/sync refactor guard and cache refactor guard. The full unit/integration default gate is overridden by `npm test`, and release preflight continues `npm test` after `verify:fast`.

`verify:fast` includes `npm run check:docs-examples`, so documentation/example drift is caught before regular type and runtime checks.

Suitable for:

- Hotspot file splitting
- Internal helper refactoring
- Type and export surface adjustments


## 2. Complete delivery / extensive changes

```bash
npm run verify:full
```

Suitable for:

- Linked updates of documents and examples
- Behavior changes or cross-module refactoring
- Return of the complete repository before release

`verify:full` also includes `npm run test:examples`, so all runnable examples are compiled and executed after the matrix gate has checked the current bilingual document coverage.


## 3. Private real environment verification

```bash
npm run test:real-env:private
```

Description:

- Only executed when conditions such as private Mongo/SSH are met
- Not used as default CI stage
- Mainly used to verify the real deployment path that cannot be covered by memory-server

Required environment variables:

- `MONSQLIZE_REAL_SSH_HOST`
- `MONSQLIZE_REAL_SSH_PORT`
- `MONSQLIZE_REAL_SSH_USERNAME`
- `MONSQLIZE_REAL_SSH_PASSWORD`
- `MONSQLIZE_REAL_MONGO_URI`

## Default boundary

- **Default verification chain**: `npm test` / `check:docs-examples` / `verify:fast` / `verify:full` / `test:server-matrix`
- **Coverage gate**: `npm run test:coverage` remains independently runnable; `verify:full` does not include it, while public CI's release-gate and `release:preflight` require it
- **Explicit opt-in**: `test:real-env:private`
- **Public pre-release gate**: `release:preflight`, which only accepts a clean candidate with a valid dependency tree and a `HEAD` present on `origin`
- **Local private pre-release supplement**: `verify:release`

## Why doesn’t CI run `verify:release` directly?

- `verify:release` relies on private SSH/Mongo environment variables, suitable for operators to trigger explicitly locally or in a private runner.
- The default verification chain of public CI and warehouse only promises reproducible assets in memory-server + warehouse.
- So GitHub Actions' `Release Preflight` workflow intentionally only runs `release:preflight`, without assuming a private environment exists.

> The warehouse also provides GitHub Actions `Release Preflight` workflow, which supports manual triggering and reusing the same set of pre-release access control when pushing `v*` tag.

> Note: `test:server-matrix` only retains **stable and repeatable compatibility surfaces** across Driver/Server combinations. Deep assertions like sync target fan-out statistics, which rely more on change-stream timing, continue to be covered by regular integration, `test:refactor-guard` and `release:preflight`.
