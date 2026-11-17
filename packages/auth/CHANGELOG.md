# @viktorbarzin/auth

## 1.1.1

### Patch Changes

- 89b3202: `connectionBudgetFromEnv()` reads `CLOUD_DATABASE_POOL_SIZE` first: Cloud's
  count of the pool each pod may open (a whole number of at least 1), with the
  realtime LISTEN connection on top. Without it the budget comes from
  `CLOUD_DATABASE_CONNECTION_LIMIT` as before, and with neither it is the
  default pool of 4 plus one LISTEN.

  `@viktorbarzin/auth/testing` scrubs `CLOUD_DATABASE_POOL_SIZE` from the
  shell's env before it starts a built server.

## 1.1.0

### Minor Changes

- Add `createCloudAuth`, a cloud mode that returns the same `AppAuth` interface for an app behind a platform edge: identity from the `X-Cloud-User-*` headers only with the edge secret (constant-time compare), the owner's email as admin plus an `isAdmin` hook, `/oauth2/start` and `/oauth2/sign_out` links, and no bearer tokens. `AppAuth` gains `signInUrl` and `signOutUrl`; `AuthUser.via` gains `"cloud"` and an optional `email`; `isSameOriginRequest` takes `trustBearer` and `hasAmbientCredential` options; `startBuiltServer` scrubs the `CLOUD_*` variables.

## 1.0.0

### Patch Changes

- Updated dependencies [2f6874a]
  - @viktorbarzin/log@1.0.0
  - @viktorbarzin/metrics@1.0.0
  - @viktorbarzin/oidc-token@1.0.0
  - @viktorbarzin/runtime@1.0.0

## 0.1.0

- First release, extracted from the tasks app (ADR-0001 phase 4).
