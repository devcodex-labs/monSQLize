# Failure Recovery Examples

These examples show what monSQLize does when common runtime paths fail and recover. Use them when you want to see rollback, retry, fallback, and timeout behavior before applying the same pattern in your application.

## Example Summary

| Scenario | Example | Focus |
|------|------|--------|
| Transaction rollback | [transaction-rollback.ts](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/transaction-rollback.ts) | Data remains in the rolled-back state after an error inside a transaction |
| Sync target failure recovery | [sync-target-failure.ts](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/sync-target-failure.ts) | `errorCount`, `syncedCount`, and target stats show failure and recovery |
| Lock competition/timeout | [lock-timeout.ts](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/lock-timeout.ts) | `tryAcquireLock()` returns `null`, `acquireLock()` times out, then the lock can be acquired after release |
| Pool fallback / recovery | [pool-fallback.ts](https://github.com/devcodex-labs/monSQLize/blob/main/examples/docs/pool-fallback.ts) | An unavailable analytics pool falls back to primary and resumes analytics traffic after recovery |

## Run The Examples

```bash
npm run test:examples
```

`npm run test:examples` builds the package, compiles the TypeScript examples, starts the required local MongoDB memory servers, and runs the executable example list.

After the examples have been compiled, you can run one recovery example directly:

```bash
node .generated/examples-dist/examples/docs/transaction-rollback.js
node .generated/examples-dist/examples/docs/sync-target-failure.js
node .generated/examples-dist/examples/docs/lock-timeout.js
node .generated/examples-dist/examples/docs/pool-fallback.js
```

## What To Check

- **Rollback**: Failed transaction work is not visible after rollback.
- **Sync recovery**: Failure counters increase, then successful sync resumes and target stats update.
- **Lock timeout**: A busy lock fails predictably, and a later attempt succeeds after release.
- **Pool fallback**: Reads move to the fallback pool while analytics is unavailable, then return when the pool recovers.
