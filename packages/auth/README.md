# @viktorbarzin/auth

App-side sign-in against Authentik, built on Better Auth 1.7:

- generic OAuth with PKCE and a verified id_token, sessions in the app's own
  database (Drizzle adapter), host-only `__Host-` cookies, exact trusted
  origins, a 7-day absolute session cap, no `offline_access`, and a single
  `prompt=login` retry when the provider answers with its anonymous guest;
- caller resolution: a bearer JWT, else the session cookie, else a dev user;
- a membership re-check against the Authentik API every 15 minutes, which
  fails closed when the app cannot ask and keeps the last answer when the
  provider is unreachable;
- request and approve sign-up, the explicit CSRF origin check, and identity
  metrics.

```ts
import { createAppAuth } from "@viktorbarzin/auth";

export const appAuth = createAppAuth(() => ({
	appName: "My App",
	appSlug: "myapp",
	db: () => pool.getDb(),
	publicOrigins: ["https://myapp.example"],
	betterAuthSecret: env.BETTER_AUTH_SECRET,
	oidc: { discoveryUrl, clientId, clientSecret },
	authentik: { apiUrl, readerToken, approverToken, usersGroupPk },
	groups: { users: "My App Users", admins: "My App Admins", agents: "My App Agents" },
	signup: "request",
	devUser: isProduction ? null : env.DEV_USER,
}));

// routes: <basePath>/start → appAuth.startSignIn, <basePath>/finish → appAuth.finishSignIn,
//         <basePath>/$ → appAuth.handleAuthRequest
// middleware: appAuth.csrfRejection(request) ?? next()
// /api routes: appAuth.handleApi(request, async (user) => Response.json(...))
```

The config function is read on every call; the Better Auth instance is
rebuilt only when its settings change. Every name, URL, group, path, cookie
prefix, timing and metric prefix is a config input (see `AppAuthConfig`).

| Export | |
|---|---|
| `createAppAuth(config)` | `startSignIn`, `finishSignIn`, `handleAuthRequest`, `signInRedirect`, `startUrl`, `resolveUser`, `requireUser` (401 `unauthorized`, 403 `access_pending`), `handleApi`, `accessStatus`, `requireAdmin`, `listPendingRequests`, `approveRequest` (404 / 409 / 502), `currentMembership`, `csrfRejection`, `getAuth` |
| `enrich(db, { sub, username })` (config) | extra per-user fields, looked up on each resolved request and once at sign-in |
| `safeReturnPath`, `isSameOriginRequest`, `needsOriginCheck`, `membershipFromGroups` | the pure checks |
| `createAuthentikClient`, `AuthentikUnavailable`, `AuthentikNotConfigured` | the three Authentik API calls |
| metrics (prefix `p`, default `auth`) | `p_membership_checks_total{outcome}`, `p_api_token_verifications_total{outcome}`, `p_csrf_rejections_total`, `p_sign_ins_total{outcome}` |
| `@viktorbarzin/auth/schema` | `auth_user`, `auth_session`, `auth_account`, `auth_verification`, `member_checks`, `access_requests` for the app's Drizzle schema |
| `@viktorbarzin/auth/testing` | `startMockAuthentik` (OIDC provider plus the API calls), `startBuiltServer`, `CookieJar`, `follow` |

A schema change is a major version: apps regenerate their migrations.
Peers: `better-auth` >=1.7.7 <1.8 (the callback path changed in 1.7),
`drizzle-orm` ^0.45, `prom-client` ^15.1 and the other `@viktorbarzin`
packages.
