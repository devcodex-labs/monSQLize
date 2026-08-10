# Unreleased

## Changes after v3.2.0

- Fixed Pool logger propagation so PoolSelector and HealthChecker use the manager logger; omitted loggers are now silent instead of writing to `console`.
