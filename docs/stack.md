# App stack

This is the setup every new first-party app uses. An app is one TypeScript
codebase for the UI and the backend, deployed as one pod. It signs people in
through Authentik and stores its data in its own database on the shared
Postgres cluster.

```mermaid
flowchart TD
  B[Browser] -- "HTTPS: pages, server functions, SSE" --> ING[Traefik ingress]
  X["CLI, agent, Home Assistant"] -- "HTTPS /api with an Authentik JWT" --> ING
  ING --> APP
  subgraph pod["App pod"]
    APP["TanStack Start on Bun<br/>React UI, server functions, /api routes"]
    RT["realtime package<br/>one LISTEN connection, SSE hub"]
  end
  APP -- "OIDC sign-in, membership re-check" --> AK[Authentik]
  APP -- "Drizzle, bun-sql" --> PG[("Shared CNPG Postgres<br/>one database per app")]
  RT -- LISTEN --> PG
  JOBS["pg-boss workers and CronJobs<br/>same image"] --> PG
  VAULT["Vault static role, through ESO"] -- "rotated password file" --> APP
```

## Components

| Layer | What we use |
|---|---|
| Language | TypeScript for the UI and the backend |
| Framework | TanStack Start, React, shadcn/ui, TanStack Query |
| Runtime | Bun 1.4.3, pinned in `packageManager`. Nitro's `bun` preset builds the server |
| Database | Drizzle with the `bun-sql` driver, on the shared CloudNativePG cluster |
| Background work | pg-boss workers and Kubernetes CronJobs, bundled into the app image |
| Accounts | Authentik, through OIDC. Better Auth keeps the sessions in the app's database |
| Realtime | Postgres `LISTEN`/`NOTIFY`, relayed to the browser over Server-Sent Events |
| Tests | `bun test` with happy-dom and Testing Library, Playwright for end-to-end |
| Lint and format | Biome |
| Image | built on `oven/bun:1.4.3`, runs on `oven/bun:1.4.3-distroless` as user `10001` |
| Build | GitHub Actions, image pushed to ghcr.io |
| Deploy | Woodpecker sets the image tag. Terraform owns everything else |

TanStack Start is not Next.js. It has no `getServerSideProps`, no
`"use server"` and no App Router. Each app's `AGENTS.md` loads the TanStack
agent skills that ship inside the installed npm packages, so agents read the
docs for the version in `bun.lock`.

Numeric and ML work stays in Python. Convex is allowed for a small, highly
collaborative app that needs no SQL access.

## Repositories

| Piece | Where |
|---|---|
| Shared packages and the template source | [`viktor/app-kit`](https://forgejo.viktorbarzin.me/viktor/app-kit) |
| Template that new apps are created from | `viktor/app-template`, generated from `app-kit/template` |
| Kubernetes, Authentik and ingress for one app | infra `modules/kubernetes/tanstack_app` |
| Database and password rotation | infra `stacks/dbaas` and `stacks/vault`, one map entry each |

Forgejo is the canonical host for each repo. It push-mirrors to GitHub, where
CI runs.

```mermaid
flowchart TD
  K["app-kit: packages and the template source"] -->|export| T["app-template"]
  T -->|use template, rename| A[new app repo]
  A --> M["tanstack_app module"]
  M --> D["dbaas and vault maps"]
```

The shared packages are public under `@viktorbarzin`. Apps install them from
Forgejo's npm registry, mapped in `bunfig.toml`, and npm carries a mirror
([ADR-0003](adr/0003-forgejo-package-registry.md)):

| Package | What it does |
|---|---|
| `@viktorbarzin/log` | JSON-lines logs with OpenTelemetry field names, per-request log context |
| `@viktorbarzin/runtime` | graceful shutdown, Bun idle timeouts, the `/api` error envelope, zod validation, `/healthz` |
| `@viktorbarzin/metrics` | a prom-client registry, HTTP request metrics, `/metrics` on its own port |
| `@viktorbarzin/pg` | Drizzle on Bun SQL with a rotating password file, migrations under an advisory lock, test databases |
| `@viktorbarzin/oidc-token` | bearer token verification: RS256, issuer, audience, expiry |
| `@viktorbarzin/auth` | Better Auth sign-in against Authentik, sessions, membership re-checks, request and approve, CSRF |
| `@viktorbarzin/realtime` | the `LISTEN` connection, the SSE hub, a reconnecting browser client, a TanStack Query hook |
| `@viktorbarzin/telemetry` | the Rybbit script, product events, Sentry init for GlitchTip |

The packages do not depend on TanStack Start. They take a `Request` and return
a `Response` or data, and the app wires them into its middleware and routes.

## Starting a new app

1. On Forgejo, create the repo from `viktor/app-template` under `viktor`,
   named after the app's slug. Keep it public so the cluster can pull its
   ghcr image without credentials.
2. In a clone, run `bun run rename <slug> "<Display Name>"`, then
   `bun install`, and commit.
3. Seed Vault KV `secret/<slug>` with `better_auth_secret`, `oidc_client_id`
   and `oidc_client_secret`.
4. In infra, add the database to `local.app_databases` in
   `stacks/dbaas/modules/dbaas/app_databases.tf`, and its rotating role to
   `pg_app_roles` in `stacks/vault/app_db_roles.tf`.
5. Create `infra/stacks/<slug>/` with one `module "app"` call to
   `modules/kubernetes/tanstack_app`. Apply dbaas, vault, then the new stack.
6. Run `scripts/offinfra-onboard` from infra to set up the GitHub mirror and
   the CI secrets.
7. Push to `master`. The build publishes the image and the deploy rolls it
   out.

The full checklist with every value is `template/docs/new-app.md`, and the
infra half is infra `docs/agents/new-app.md`. `stacks/tasks` is the reference
caller of the module, and `stacks/reels` adds a file volume and a worker.

## Run locally

```sh
docker run -d -e POSTGRES_PASSWORD=dev -p 127.0.0.1:5433:5432 postgres:18
bun install
export DATABASE_URL=postgres://postgres:dev@127.0.0.1:5433/postgres
bun run build && bun run migrate
DEV_USER=me PORT=3100 bun run dev        # http://127.0.0.1:3100, signed in as "me"
```

`DEV_USER` replaces sign-in only in development or test, with no OIDC client
configured. Tests run with `TEST_DATABASE_URL=<admin url> bun run test`, where
each test creates and drops its own database, then `bun run test:e2e`.

## Code layout

- Code that touches the database, secrets or Bun built-ins lives in
  `src/server/*.server.ts`. Import it only from server functions, server
  routes, other `*.server.ts` files, `src/start.ts` middleware and
  `src/entrypoints/*`. If a component imports it, the Postgres driver lands in
  the browser bundle. The build and `tsc` still pass, and the page breaks on
  hydration with `Buffer is not defined`. Run `bun run test:e2e` after adding
  server code.
- Server functions (`createServerFn` in `src/server/*.functions.ts`) are RPC
  for the app's own UI only.
- Anything a CLI, agent or Home Assistant calls is a server route under `/api`
  with a zod schema and `appAuth.handleApi` for identity. Bearer tokens work
  there.
- Only `src/server/env.server.ts` reads `process.env`.
- Query keys come from `src/lib/query-keys.ts`. Biome has no TanStack Query
  lint, so a hand-typed key that doesn't match never gets invalidated.

## Database

Each app gets its own database and role on the shared CloudNativePG cluster.
No app runs its own database pod.

- **Connections.** Each pod uses 5: a pool of 4 and 1 `LISTEN` connection
  (on Cloud, half the role's connection limit; see "Running on Cloud").
  The `migrate` init container uses 1 more while it runs. A CronJob uses at
  most 2. The primary allows 200 in total, so more replicas need a check of
  the budget first.
- **Migrations.** `bun run db:generate` writes them to `drizzle/`. The
  `migrate` init container applies them from the same image, under
  `pg_advisory_lock`. Keep them additive: expand in one release and contract
  in a later one, so the previous image still works as a rollback.
- **Backups.** A daily `pg_dump` per database, kept for 14 days. There is no
  point-in-time recovery.
- **Passwords.** Vault rotates each app's password weekly. The app reads it
  from a mounted file on every new connection, so rotation needs no restart.

```mermaid
flowchart TD
  V["Vault static role<br/>rotates in its weekly slot"] --> E["ESO ExternalSecret<br/>force-synced within seconds by db-rotation-watcher,<br/>15 min poll as fallback"]
  E --> S[Kubernetes Secret]
  S --> F[password file mounted in the pod]
  F --> C["each new Postgres connection reads the file<br/>no restart"]
```

## Realtime

A write that other tabs should see publishes an event in its own transaction:

```ts
await db.transaction(async (tx) => {
	await tx.insert(items).values(...);
	await realtime.publishInTx(tx, ownerSub, { type: "invalidate", keys: [itemKeys.all], source });
});
```

Postgres sends the `NOTIFY` at commit, so a rolled-back write sends nothing.
Each pod holds one `LISTEN` connection and relays events to its open SSE
streams. The `useRealtimeInvalidation` hook invalidates those keys in that
user's other tabs and devices, and TanStack Query refetches them. Events
carry query keys, never data, and stay under 7,900 bytes.

```mermaid
sequenceDiagram
  participant B1 as Tab A
  participant P as App pod
  participant PG as Postgres
  participant B2 as Tab B, same user
  P->>PG: LISTEN, once at pod start
  B2->>P: open the SSE stream, kept open
  B1->>P: mutation through a server function
  P->>PG: write rows and NOTIFY with the query keys, then commit
  PG-->>P: notification
  P-->>B2: SSE event invalidate with the keys
  B2->>P: refetch the matching TanStack Queries
  Note over P,B2: heartbeat every 25 s
  Note over P,B2: after a reconnect, refetch all (resync)
```

`NOTIFY` is not durable, so the package covers lost events:

- After every `LISTEN` reconnect the server sends `resync`, and after every
  SSE reconnect the client refetches all active queries.
- The server runs `SELECT 1` on the `LISTEN` connection every 30 seconds and
  reconnects on a timeout.
- The SSE stream sends a comment every 25 seconds. The Cloudflare tunnel
  closes idle responses after about 100 seconds.

Apps that use realtime do not use Sablier scale-to-zero yet.

## Sign-in and access

The infra module creates an Authentik OIDC application per app, with a
`<App> Users` group, a `<App> Admins` group and optionally `<App> Agents`.
The app keys users on the OIDC `sub` and never authorizes by email.

```mermaid
sequenceDiagram
  autonumber
  actor U as Browser
  participant A as App, Better Auth
  participant K as Authentik
  participant D as App database
  U->>A: open the app with no session
  A-->>U: redirect to Authentik
  U->>K: sign in
  K-->>U: redirect back with an authorization code
  U->>A: callback with the code
  A->>K: exchange the code for tokens
  A->>A: verify the RS256 id_token, read its groups claim
  A->>D: store the session and the membership answer
  A-->>U: __Host- session cookie, 7 day cap
  Note over A,K: on a request whose stored answer is older than 15 min
  A->>K: look up the user's groups with a reader token
  K-->>A: groups
  A->>D: update membership. Not in the app's Users group means no access
```

- **Removing someone** from the users group takes effect within 15 minutes.
  If Authentik can't be reached, the last answer stands.
- **Sign-up** is set per app with `signup_mode` in the module. `request`, the
  default, makes new people wait for an admin to approve them at
  `/admin/requests`. `open` adds them to the users group at once.
- **Admin** checks run inside each admin server function against the app's
  admins group.
- **Browser security.** Cookies are host-only `__Host-` cookies. A CSRF check
  against the app's public origin covers server functions, cookie-based
  `/api` calls and the SSE endpoint.
- **API clients.** CLIs, agents and Home Assistant call `/api` with an
  Authentik JWT. The verifier pins RS256, the issuer, the audience and the
  expiry. Agents and Home Assistant use service accounts in `<App> Agents`.
- **Secrets.** `BETTER_AUTH_SECRET` and the OIDC client secret live in Vault
  KV and reach the pod through ESO.

## Logs, metrics and telemetry

- **Logs** are JSON lines on stdout with OpenTelemetry field names:
  `timestamp`, `severity_text`, `body`, `service.name`, `enduser.id`,
  `exception.*`. `requireMember` in `auth.server.ts` adds the person's `sub`
  to every log line of the request.
- **Metrics** are served on port 9090 at `/metrics` for in-cluster scraping
  and are not routed through the ingress. Prometheus keeps only allowlisted
  metric names, so add the app's prefix to `metric_relabel_configs` in infra
  `stacks/monitoring/modules/monitoring/prometheus_chart_values.tpl`, or its
  own metrics are dropped.
- **Telemetry** is on by default and starts once `TELEMETRY_WRITE_KEY` is
  set. Pageviews and session replay go to Rybbit, product events such as
  `track("item.created", { item_id })` go to the event pipeline, and errors go
  to GlitchTip through `SENTRY_DSN`. Local runs send nothing. Set
  `telemetry.enabled: false` in `src/app.config.ts` to opt out.

## Build and deploy

```mermaid
flowchart TD
  P[push to master on Forgejo] --> GH[GitHub mirror]
  GH --> T["GitHub Actions: Biome, typecheck,<br/>bun test, Playwright e2e"]
  T --> I["image build, pushed to ghcr.io<br/>tagged with the commit SHA and latest"]
  I -- "Woodpecker API, manual event with IMAGE_TAG" --> W[Woodpecker deploy.yml]
  W -- "kubectl set image" --> D[Deployment]
  D --> M["init container migrate<br/>Drizzle migrations under an advisory lock"]
  M --> R[app container starts]
```

- The Deployment uses `Recreate` and 1 replica, so one pod holds the
  `LISTEN` connection and writes at a time. A deploy takes about 17 seconds
  of downtime.
- Renovate commits dependency updates straight to `master`. It waits 3 days
  before it takes a new npm release.
- TanStack Start and Router are pinned to exact versions and upgraded
  together, because Start ships breaking changes in minor and patch releases.
  The app's tests run before the deploy job and stop a breaking bump.
- The Bun version in `packageManager`, the `oven/bun` base image and CI's
  `setup-bun` move together in one commit.

## Running on Cloud

The same template runs on Cloud (`viktor/cloud`) with no infra steps. Cloud
sets `CLOUD_EDGE_SECRET`, and the app then runs in cloud mode:

```mermaid
flowchart LR
  B[Browser] --> E["App's edge, Caddy"]
  E -- "/oauth2/auth subrequest" --> O[oauth2-proxy]
  E -- "/oauth2/*" --> O
  E -- "X-Cloud-User-* + X-Cloud-Edge-Secret" --> A["App, createCloudAuth"]
  A --> PG[("Project Postgres<br/>connection limit 2, 4 or 8")]
```

- **Identity.** The edge signs people in and sends `X-Cloud-User-Id`,
  `-Email` and `-Username`. `createCloudAuth` in `@viktorbarzin/auth` reads
  them only with the correct edge secret; else the request is anonymous. The
  `CLOUD_OWNER_EMAIL` is the admin. There are no access requests, so the
  `/pending` and `/admin/requests` pages redirect. The edge decides who may
  use a private app. Sign-in and sign-out links are `/oauth2/start?rd=` and
  `/oauth2/sign_out?rd=`. Bearer tokens are not accepted.
- **Connections.** A pod uses `floor(CLOUD_DATABASE_CONNECTION_LIMIT / 2)`,
  because a rollout overlaps two pods. Realtime needs 2 of them; on a nano
  database (limit 2) it is off, and lists refetch every `app.pollMs`.

| Size | Limit | Pool | LISTEN |
|---|---|---|---|
| nano | 2 | 1 | off |
| small | 4 | 1 | 1 |
| medium | 8 | 3 | 1 |

- **Migrations** run from `drizzle/` before each deploy, in an init
  container with the args `["entrypoints/migrate.js"]`.
- **Telemetry and Sentry** stay off, because Cloud sets no write key or DSN.

The env contract is `CLOUD_EDGE_SECRET`, `CLOUD_OWNER_EMAIL`,
`CLOUD_PUBLIC_URL`, `CLOUD_DATABASE_CONNECTION_LIMIT` and `CLOUD_ACCESS`
(`public` or `private`). `src/server/env.server.ts` reads the first four;
`CLOUD_ACCESS` is the edge's setting, and the app does not read it.
