---
"@viktorbarzin/telemetry": minor
---

Server events join the browser's person. The browser client sets Segment's anonymousId to the Rybbit visitor id, adds `visitorHeaders()` (`X-Visitor-Id`) for same-origin API calls, and identifies a `personId` on every init. The server client adds `withRequestContext(request, fn)`, which reads `X-Visitor-Id`, the client IP (`X-Real-Ip`, then `X-Forwarded-For`, then the peer) and the User-Agent; events inside it default their anonymousId to the visitor id and carry `context.ip` and `context.userAgent`. `track` no longer needs an id: with a userId it sends no anonymousId, without one it sends a stable `defaultAnonymousId` (`server:<service>`).
