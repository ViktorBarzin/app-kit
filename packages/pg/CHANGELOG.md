# @viktorbarzin/pg

## 1.1.0

### Minor Changes

- `createPool` takes `max` (a number or a function, default `APP_POOL_MAX`). `connectionBudget(limit)` and `connectionBudgetFromEnv()` derive the per-pod budget from a role's connection limit (`CLOUD_DATABASE_CONNECTION_LIMIT`): half the limit, realtime only when that leaves at least 2.

## 1.0.0

### Patch Changes

- Updated dependencies [2f6874a]
  - @viktorbarzin/log@1.0.0
  - @viktorbarzin/runtime@1.0.0

## 0.1.0

- First release, extracted from the tasks app (ADR-0001 phase 4).
