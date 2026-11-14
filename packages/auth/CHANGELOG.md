# @viktorbarzin/auth

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
