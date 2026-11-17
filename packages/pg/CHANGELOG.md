# @viktorbarzin/pg

## 1.2.0

### Minor Changes

- 89b3202: `connectionBudgetFromEnv()` reads `CLOUD_DATABASE_POOL_SIZE` first: Cloud's
  count of the pool each pod may open (a whole number of at least 1), with the
  realtime LISTEN connection on top. Without it the budget comes from
  `CLOUD_DATABASE_CONNECTION_LIMIT` as before, and with neither it is the
  default pool of 4 plus one LISTEN.

  `@viktorbarzin/auth/testing` scrubs `CLOUD_DATABASE_POOL_SIZE` from the
  shell's env before it starts a built server.

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
