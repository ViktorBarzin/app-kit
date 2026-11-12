# @viktorbarzin/telemetry

## 0.2.1

### Patch Changes

- A new visitor's first Segment calls (identify, track) wait for the Rybbit visitor id, at most 5 seconds or until the script fails to load, so they no longer go out under a random anonymousId. The Sentry SDKs are no longer declared as peers; apps install the one they pass in. Forgejo's npm registry drops `peerDependenciesMeta`, which made npm install `@sentry/bun` and `@sentry/browser` in every app.

## 0.2.0

### Minor Changes

- 91e9238: Server events join the browser's person. The browser client sets Segment's anonymousId to the Rybbit visitor id, adds `visitorHeaders()` (`X-Visitor-Id`) for same-origin API calls, and identifies a `personId` on every init. The server client adds `withRequestContext(request, fn)`, which reads `X-Visitor-Id`, the client IP (`X-Real-Ip`, then `X-Forwarded-For`, then the peer) and the User-Agent; events inside it default their anonymousId to the visitor id and carry `context.ip` and `context.userAgent`. `track` no longer needs an id: with a userId it sends no anonymousId, without one it sends a stable `defaultAnonymousId` (`server:<service>`).

## 0.1.0

- First release: the browser client (Rybbit script, Segment with inline settings, optional Sentry), the server client (Segment Node SDK, optional Sentry), and the shared event checks (ADR-0002, infra ADR-0041).
