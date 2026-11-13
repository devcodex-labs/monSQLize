# Performance evidence and claim policy

Performance depends on workload shape, MongoDB topology, indexes, network latency, cache backend, document size, concurrency, and hardware. monSQLize therefore does not promise fixed speedup multipliers or universal overhead percentages.

## Evidence contract

Any numeric performance claim must record all of the following before it is presented as a project result:

| Field | Required evidence |
|---|---|
| Workload | Operation, options, warm/cold state, concurrency, and comparison baseline |
| Environment | Node, MongoDB/driver, CPU, memory, operating system, and network topology |
| Dataset | Document count, shape, indexes, and cache population state |
| Command | A repository command or script that another maintainer can run |
| Artifact | Raw samples plus summary statistics, with commit and timestamp |
| Budget | A regression threshold tied to that workload, not a product-wide guarantee |

## Current verified scope

- `npm run test:performance` is a controlled FunctionCache regression guard. It validates hot-path/coalescing behavior under its fixture; it does not prove a fixed production speedup.
- `npm --prefix website run check:budgets` enforces built asset budgets and required-language search-index presence. It reports individual and combined search-index sizes without fixed search-index byte limits. Asset transfer budgets do not measure page-load latency.
- Batch writes, query caching, populate, `findPage`, DataTask, SSH, and slow-query logging are documented qualitatively until each has a reproducible workload and stored artifact.

Benchmark your own workload before selecting batch size, cache policy, pool size, or operational timeout.
