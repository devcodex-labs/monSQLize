# Dependence on release boundary management

The current root package adopts the **precise version dependency strategy**:

| Dependencies | Strategy | Reasons |
|------|------|------|
| `cache-hub` | Exact version `2.2.4` | The root direct dependency and schema-dsl integration share the verified cache runtime baseline |
| `schema-dsl` | Exact stable version `3.0.4` | Node 18-compatible v3 runtime with a side-effect-free root entry and the isolated `schema-dsl/runtime` entry |
| `ioredis` | Exact version `5.11.1` | Runtime Redis dependency; enabled only when Redis-backed features are configured |
| `mongodb-memory-server` | Dev exact version `10.4.3` | Test tooling remains compatible with Node `>=16.20.1`, preserving the package's Node 18 CI contract |

> The current monSQLize line is pinned to verified registry `schema-dsl@3.0.4`. Local `file:` or workspace resolutions are prohibited from the release lockfile. Historical npm `schema-dsl@2.3.x` artifacts are not accepted as substitutes.

## Current Risk

1. **Upstream version drift**: `cache-hub` / `schema-dsl` have been fixed to the exact version, and upgrades must undergo explicit version adjustment.
2. **Risk of incorrectly released version**: npm `2.3.x` of `schema-dsl` has been marked as incorrectly released and must not be upgraded.
3. **Linked regression blind spot**: After upgrading any upstream dependency, the key regression surface must be re-covered.

## Current governance rules


## Development status

- The root direct `cache-hub` dependency is fixed to `2.2.4`; no workspace override is required.
- `schema-dsl` is fixed to registry `3.0.4`, `ioredis` to `5.11.1`, and test tooling `mongodb-memory-server` to `10.4.3`.
- Local sibling `../schema-dsl` is only used for debugging the upstream library itself and is no longer a prerequisite for monSQLize root package installation.


## Release status

- The root package release state must not depend on the workspace `file:` / `workspace:` path.
- The current dependency strategy has met the basic premise of "resolvable external installation"; subsequent releases still need to pass the standard verification chain.

```bash
npm run release:preflight
```

## schema-dsl v3 upgrade verification

The v3 consumer migration used an identity-bound local tarball for rehearsal and uses the registry GA for release. The verification standard is as follows:

1. Rehearsal evidence records version, source manifest hash, tarball SHA256, lock hash, and validation run identity; release evidence must resolve the exact registry GA without local paths.
2. Install the exact GA and run `npm run type-check`, Model unit/integration tests, root String prototype probes, examples, and packed-consumer verification.
3. All model-related unit tests/integration tests passed (covered with `npm run test:unit` and `npm run test:integration`).
4. `npm run test:examples` all passed.
5. `npm run release:preflight` remains the final gate; it must reject local `file:` resolution and require registry `schema-dsl@3.0.4` for GA.
6. This file, Profile, CHANGELOG, package manifest, and lockfile must share the same candidate or GA identity.

## cache-hub 2.2.4 upgrade verification

The dependency governance baseline has upgraded and fixed `cache-hub` from `1.0.0` to `2.2.4`. The verification standard is as follows:

1. The upstream npm `latest` is `2.2.4`, and the Node.js engine requirement remains `>=18`, matching the current monSQLize baseline.
2. The root direct dependency resolves to `2.2.4`; no local workspace override is present.
3. `npm run type-check`, targeted cache / function-cache tests, website build, and memory probe must pass.
4. This file, Profile, CHANGELOG, package manifest, and lockfile must be synchronized with the root direct dependency `2.2.4` baseline.

## Linkage verification suggestions

| Scenario | Must do verification |
|------|----------|
| Adjust `cache-hub` related capabilities | `npm run type-check` + `test/unit/cache/cache.test.ts` + exports / smoke |
| Adjust `schema-dsl` related capabilities | `npm run type-check` + model related single test/integration test + `npm run test:examples` |
| Preparing for release | `npm run release:preflight` |

## Long-term direction

1. `schema-dsl` will not automatically follow npm `latest`; the upgrade must explicitly confirm the target version and continue to exclude deprecated mistakenly released versions.
2. The release state maintains zero dependence on the workspace path; all upstream dependencies must be resolvable by the public semver.
