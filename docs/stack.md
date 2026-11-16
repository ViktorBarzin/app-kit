# App stack

This is the setup every new first-party app uses. An app is one TypeScript
codebase for the UI and the backend, deployed as one pod, with its data in
its own Postgres database.

There are two ways to run it. On Cloud you ship it with the `cloud` CLI and
no infra steps; start with "Running on Cloud" below. The infra path, in
"Starting a new app" and "Build and deploy", is for infra admins. The
template, its packages and its code rules are the same on both.

## Running on Cloud

The template runs on Cloud (`viktor/cloud`) with no infra steps. You need a
Cloud account: an Operator makes one in one step with `cloud users add`.
The `cloud` CLI is on the devvm for every user.

```sh
cloud login                                  # once, with a device code
cloud new <app> --access private --yes       # or --access public
```

`cloud new` copies `viktor/app-template` into your own Forgejo account,
creates a Project with the app and its own nano Postgres, pushes the first
commit, applies it and waits until the apply ends. A failed apply exits 7
with its reason; `--no-wait` returns at once. It uses the Forgejo login git
holds: an access token with the `write:repository` and `write:user` scopes
in git's credentials.

Each later push to `master` builds and deploys. `cloud new` adds a Forgejo
push webhook to the repo, so a push deploys within seconds; `cloud webhook
<project> <app>` adds it to an older App.

- `cloud deploys <project> <app>` lists the Deploys with what started each
  one and how long it took, and says what holds one up ("Build logs"
  below).
- `cloud logs <project> <app> [-f]` prints the App's newest log lines.
  `--grep <text>` (plain text, case-sensitive), `--level
  debug|info|warn|error|fatal`, `--instance <pod>`, `--deploy <version>`
  and `--since <time>` filter them, with `-f` too.
- `cloud events <project> <app>` lists the App's history in time order:
  its Deploys (started, live, failed), restarts, suspends, skipped commits,
  applies and secret changes that touched it, and when it started crashing,
  failed its health check or recovered.
- `cloud notifications` lists what Cloud told you: a Deploy failed or went
  live, an App turned unhealthy or recovered, a cron run failed, a Postgres
  reached 80% of its disk. `cloud notifications channels add email
  <address>` or `add webhook <url>` sends them on by email or as a
  Standard Webhooks POST signed with a `whsec_` secret shown once
  (`cloud help notifications`).
- A commit message with `[skip cloud]` makes no Deploy, and
  `autoDeploy: false` in the Project File stops push Deploys.
- `cloud deploy <project> <app> [--commit <sha>]` deploys by hand, `cloud
  deploy cancel` stops a build, and `cloud deploy-hook` prints a secret URL
  that deploys on a POST.
- `cloud restart <project> <app>` restarts the running version with no
  build. `cloud suspend` stops the App and takes its CPU and memory out of
  your Budget until `cloud resume`. `cloud maintenance <project> <app> on`
  answers 503 with a maintenance page while the App keeps running.
- A failed apply is retried by applying the Project File again, even
  unchanged, not by deleting the Project: a deleted Project's name is never
  given out again.
- For a private app, `cloud invite <project> <app> <email>` adds a person to
  its allow list and prints a one-time sign-up code for someone with no
  homelab account.

The repo is private unless you pass `--public-repo`. Cloud builds a private
repo only for the Forgejo account linked to your sign-in, so `cloud new`
checks that first and stops, with nothing made, when no account is linked.
Cloud reads and builds a private repo as its own Forgejo account
`cloud-bot`, which sees a private repo only as a collaborator: `cloud new`
adds it with Read before the first push, then waits for Cloud's first check
of the branch, which exits 8 with the reason when Cloud cannot read it. A
private repo you make by hand needs `cloud-bot` added as a Read collaborator
(the repo's Settings, Collaborators).

`cloud --help` lists the other commands.

Secrets never go in the repo or the Project File. Set one from stdin, never
as an argument, and the App restarts with it in about a minute:

```sh
printf %s "$STRIPE_KEY" | cloud secrets set <project> <app> STRIPE_KEY
cloud secrets import <project> <app> < .env    # every KEY=value as one change
cloud secrets list <project> <app>             # names and status, never values
```

Agents on MCP use `set_secret`, `list_secrets` and `unset_secret`. For a
value no person needs to know, such as a session or signing key, let Cloud
make it in the App's `env` in the Project File:

```yaml
    env:
      SESSION_SECRET: {generate: true}
```

Cloud makes 32 random bytes (base64url) once and keeps the same value on
every apply; no command, page or export shows it, and removing the line
deletes it. For CI, `cloud tokens create --expires 30d` prints an Access
Token for `CLOUD_TOKEN`; every token expires, 90 days at most.

Cloud sets `CLOUD_EDGE_SECRET`, and the app then runs in cloud mode:

```mermaid
flowchart LR
  B[Browser] --> E["App's edge, Caddy"]
  E -- "/oauth2/auth subrequest" --> O[oauth2-proxy]
  E -- "/oauth2/*" --> O
  E -- "X-Cloud-User-* + X-Cloud-Edge-Secret" --> A["App, createCloudAuth"]
  A --> PG[("Project Postgres<br/>connection limit 4, 10 or 20")]
```

- **Identity.** The edge signs people in and sends `X-Cloud-User-Id`,
  `-Email` and `-Username`. `createCloudAuth` in `@viktorbarzin/auth` reads
  them only with the correct edge secret; else the request is anonymous. The
  `CLOUD_OWNER_EMAIL` is the admin. There are no access requests, so the
  `/pending` and `/admin/requests` pages redirect. The edge decides who may
  use a private app. Sign-in and sign-out links are `/oauth2/start?rd=` and
  `/oauth2/sign_out?rd=`. Bearer tokens are not accepted.
- **Signed-out visitors.** A public App's edge passes anonymous requests
  through, and the template's home page shows them a landing page with a
  "Sign in" link (200). A private App's edge sends a signed-out page load to
  sign-in first, so it never reaches the App.
- **Connections.** Cloud sets `CLOUD_DATABASE_POOL_SIZE`, the pool each
  pod may open, and the pod adds 1 `LISTEN` connection. Cloud counts every
  process on the database at its peak: each App instance twice, since
  during a rollout the old pods keep their connections until they stop;
  `migrate` 1, inside a new pod's share; and when you add them, each
  worker 1 and each cron run 1. The pool takes what is left, split across
  the App pods, at least 1 and at most 4. `cloud plan` refuses a Project
  File whose processes need more than the Size gives and names the Size
  to pick (`cloud help limits`).

| Size | Limit | App, 1 instance | App, 2 instances | App, 1 instance, a worker and a cron | App, 2 instances, a worker and a cron |
|---|---|---|---|---|---|
| nano | 4 | pool 1 | refused: small | refused: small | refused: small |
| small | 10 | pool 4 | pool 1 | pool 3 | pool 1 |
| medium | 20 | pool 4 | pool 4 | pool 4 | pool 3 |

  Each pool is per App pod, with 1 `LISTEN` on top.
  A pod on an older `@viktorbarzin/pg` reads `CLOUD_DATABASE_CONNECTION_LIMIT`
  and uses half of it, which fits only an App with 1 instance.

- **Migrations** run from `drizzle/` once per Deploy, before the new
  version starts, as a Kubernetes Job with the args
  `["entrypoints/migrate.js"]`, the app's image and env, and one database
  connection. A failure fails the Deploy and the version before keeps
  serving; `cloud deploys log <project> <app> <id>` ends with their output.
  On the infra path they run as the Deployment's init container instead
  (see Database).
- **Shutdown delay.** A stopping instance keeps serving for 5 s, plus the
  App's `shutdownDelaySeconds` in the Project File (0 to 300, default 0),
  before it gets `SIGTERM`. Set it to the slowest request the app serves,
  so a Deploy cuts none off. Cloud waits by running `sleep` in the image;
  the template's distroless image carries static busybox, pinned by digest,
  as `/usr/local/bin/busybox` with `sleep` and `sh` linked to it, and an
  image without `sleep` gets `SIGTERM` at once.
- **Health check.** `cloud new` sets `healthCheckPath: /healthz`, which
  the template's `/healthz` answers with a static ok. A Deploy goes live
  only once that path answers 2xx, so a version that cannot serve fails
  its Deploy as `health_check` and the version before keeps serving. On a
  live app, Kubernetes restarts an instance that fails the check for
  60 s, and after that restart the instance has 5 min to answer the first
  time. A new version has 3 min from its start, or its Deploy fails. Keep
  the route free of database calls. An app made before this setting existed adds
  `healthCheckPath: /healthz` to its service in the Project File
  (`cloud file export`, edit, `cloud apply`). `cloud events <project>
  <app>` lists crashes (with the exit code, or `OOMKilled`), failed checks
  and recoveries; `cloud projects` names an app that is crashing now.
- **Env at build time.** Plain env reaches the build; secrets never do.
  Cloud's builder passes the App's plain `env` as one build argument,
  `CLOUD_BUILD_ENV` (base64 of `export NAME='value'` lines), and as
  `--build-arg NAME=value` for each name. The template's Dockerfile runs
  `eval` on it before `bun run build`, so `vite build` inlines
  `import.meta.env.VITE_*` into the page's JS, where anyone can read it. A
  repo with no Dockerfile gets the same names in its Railpack build. App
  secrets, generated ones (`{generate: true}`) too, reach only the running
  pod. Left out of the build, though not out of the pod: `PATH`, `LD_*`,
  `DOCKER_*`, `BUILDX_*`, `BUILDKIT_*`, `HTTP_PROXY`, `HTTPS_PROXY`,
  `NO_PROXY`, `ALL_PROXY`, `NODE_OPTIONS`, `BUN_*` and
  `RAILPACK_CONFIG_FILE`, in any case; they would steer the builder's own
  tools.
- **Build logs.** `cloud deploys <project> <app>` shows a failed Deploy's
  reason and the last 20 lines of its build, and `cloud deploys log
  <project> <app> <deploy-id>` prints the full build output. The builder
  repo is public, so its run log shows step names only; the output is
  sealed to Cloud's key.
- **Background work.** pg-boss workers and cron jobs run from the App's
  image as worker and cron Services ("Workers and cron jobs on Cloud"
  below). Each App runs one web process in one pod.
- **Telemetry and Sentry** stay off, because Cloud sets no write key or DSN.
- **Network.** The app reaches the internet over IPv4 only, from one
  address every App shares (`cloud help apps` prints it after
  `cloud login`). It cannot send email directly: Cloud blocks TCP 25, 465,
  587 and 2525.
- **Limits.** Cloudflare gives a request 125 seconds to start its answer
  and takes a body of at most 100 MiB. A stream needs a message at least
  every 30 seconds (`cloud help limits`).
- **Staging.** `cloud file export <p> --rename <p>-staging > s.yaml`, then
  `cloud apply s.yaml`, makes a copy with renamed Apps (`cloud help
  environments`).

The env contract is `CLOUD_EDGE_SECRET`, `CLOUD_OWNER_EMAIL`,
`CLOUD_PUBLIC_URL`, `CLOUD_DATABASE_POOL_SIZE`,
`CLOUD_DATABASE_CONNECTION_LIMIT` and `CLOUD_ACCESS` (`public` or
`private`). `src/server/env.server.ts` reads all but `CLOUD_ACCESS`;
`CLOUD_ACCESS` is the edge's setting, and the app does not read it.

## Workers and cron jobs on Cloud

Background work runs as two more kinds of Service in the Project File. Each
one runs the image of the App named in `from`, from the same Deploy, with
`command` in place of the web server:

```yaml
services:
  web:
    kind: app
    connects: [db]
    # repo, size and the rest as before
  jobs:
    kind: worker
    from: web
    command: [bun, entrypoints/worker.js]
    size: nano
  tick:
    kind: cron
    from: web
    schedule: "*/5 * * * *"
    command: [bun, entrypoints/tick.js]
    size: nano
```

- **From.** `from` names the App whose image, Deploy and env the Service
  takes, and it cannot change. To move a worker or cron job to another
  App, remove the Service, apply, then add it again with the new `from`.
- **Command.** `command` is an argv list, never a shell string: the
  distroless image has no shell and no `sleep`. Add each entrypoint,
  `src/entrypoints/<name>.ts`, to the `build:entrypoints` script in
  `package.json`, and the image has it as `entrypoints/<name>.js` beside
  `migrate.js`.
- **Env.** The process gets exactly its App's env: the plain `env`, the
  App's secrets, `DATABASE_URL` and `CLOUD_DATABASE_URL_<NAME>` for each
  database the App `connects` to, the `CLOUD_*` names and
  `SERVICE_VERSION`. Cloud adds `CLOUD_DATABASE_POOL_SIZE`, a whole number
  of at least 1: the Postgres connections this process may open. Today a
  worker and a cron run each get 1. Give your pool that `max`; pg-boss runs
  on such a pool through `fromBunSql(createSqlClient(settings, { max }))`.
- **Deploys.** A worker or cron job moves to each new image in the same
  apply as its App's Deploy. It runs nothing until the App has a Deploy,
  and it stops while the App is suspended. On a new Deploy the old worker
  stops before the new one starts, so there is a short gap and never two
  workers at once.
- **Budget.** Its Size counts in the Budget, as an App's does.
- **Worker.** A worker runs all the time, with no address, no port and no
  health check. The App queues pg-boss jobs and the worker works them.
  `cloud logs <project> <worker>` prints its log.
- **Cron.** `schedule` has 5 fields in UTC: numbers, `*`, ranges, steps
  and lists. Names such as `mon` and macros such as `@daily` are refused.
  A scheduled start that comes while a run still runs is skipped and
  recorded as `skipped`, and so is a run by hand asked for while a run
  runs. A scheduled start that comes during a run by hand still starts, so
  those two can run at the same time. A start that Kubernetes cannot make
  within 1 minute of its time is skipped. A run is killed after 12 h. A
  failed run records a `cron_failed` event in `cloud events <project>
  <app>`.

```sh
cloud cron runs <project> <cron>             # start, end, exit code, status, logs command
cloud cron run <project> <cron>              # one run now: starts within 1 min, or skipped if a run still runs
cloud logs <project> <cron> --run <id>       # one run's log
```

## The template and the infra path

Everything below describes the template, which is the same on Cloud, and the
infra path. On the infra path an app signs people in through Authentik and
stores its data on the shared Postgres cluster.

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

These are the infra steps, for infra admins. On Cloud, `cloud new` does all
of them ("Running on Cloud").

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
  (on Cloud, a pool of `CLOUD_DATABASE_POOL_SIZE`; see "Running on Cloud").
  The `migrate` init container uses 1 more while it runs. A CronJob uses at
  most 2. The primary allows 300 in total, so more replicas need a check of
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
  A-->>U: landing page with a Sign in link
  U->>A: follow Sign in, /api/auth/start
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

This is the infra path. On Cloud, Cloud builds each push and rolls it out
("Running on Cloud").

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
