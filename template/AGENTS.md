# starter

> [!WARNING]
> TanStack Start is NOT Next.js. There is no `getServerSideProps`, no
> `"use server"` / `"use client"` directive, no App Router (`app/page.tsx`,
> `layout.tsx`, `route.ts`), no `next/*` import and no React Server Actions.
> Data loads in route `loader`s and server functions (`createServerFn`);
> HTTP endpoints are server routes (`createFileRoute(...)({ server: { handlers } })`).
> If you catch yourself writing a Next.js pattern, load the skills below first.

`starter` is built on the default app stack (ADR-0001, in app-kit at `docs/adr/0001-default-app-stack.md`):
TanStack Start on Bun, Drizzle on the shared CNPG Postgres, Authentik
accounts through app-side OIDC, realtime over Postgres LISTEN/NOTIFY and SSE.
The shared plumbing lives in the `@viktorbarzin/*` packages (table below);
this repo holds only what is specific to the app. Every push to `master`
builds and deploys: on Cloud, Cloud builds and deploys it (see "On Cloud");
elsewhere, this repo's own CI files under `.github/` and `.woodpecker/` do.
So land only verified work there.

## On Cloud

This app may run on Cloud, which builds and deploys it on every push and
sets `CLOUD_EDGE_SECRET`; the app then runs in cloud mode. Cloud handles
sign-in, the database and the deploy, so you write only the business logic:
routes in `src/routes/`, tables in `src/server/db/schema.server.ts`, server
functions in `src/server/*.functions.ts`. Leave `src/server/auth.server.ts`,
`env.server.ts`, `db.server.ts`, `src/start.ts` and the `Dockerfile` as they
are, except where this section says otherwise.

- **Identity.** Cloud's edge signs people in. In a server function, call
  `requireMember(getRequest())` from `auth.server.ts` (it wraps
  `appAuth.requireUser()`): it returns the user (`sub`, `username`, `email`)
  or throws 401. Key a person's own data on `user.sub`; data every member
  shares has no owner column (see "Shared data"). `appAuth.resolveUser()`
  returns null for a signed-out visitor instead of throwing.
- **Admin.** The Project owner (`CLOUD_OWNER_EMAIL`) is the admin:
  `user.admin` is true, and `appAuth.requireAdmin(user)` guards admin
  actions. Put admin tools on `/admin`. To add admins, keep them in your own
  table and pass `isAdmin` in `auth.server.ts`:
  `createCloudAuth(() => ({ ...cloudAuthConfig(), isAdmin: (who) => ... }))`.
- **Public or private.** A public App lets anyone open its pages; signed-out
  visitors have no user, so decide what they see. The home page
  (`src/routes/index.tsx`) shows a signed-out visitor a landing page with a
  "Sign in" link and answers 200; to show such a visitor more, extend that
  page, and keep their data behind `requireMember`. A private App lets in
  only the people on its allow list: its edge sends a signed-out page load
  to sign-in before it reaches the App, so the landing page never shows
  there. Cloud sets this, not the code.
- **Internal.** An internal App has no address outside Cloud and no
  sign-in. Only the Apps of its Project that list it in `connects` reach
  it, at the URL in their `CLOUD_URL_<NAME>`. Their calls carry no user, so
  `requireMember` answers 401: serve what they need on routes that need no
  user. To call an internal App from this one, read its URL from
  `CLOUD_URL_<NAME>` on the server.
- **Dependency updates.** If Renovate is on for the repo (`cloud new`
  turns it on), it opens one pull request a week on `renovate/all` with
  every update, majors too. Cloud builds it without deploying it and sets
  the commit status `cloud/build`; Renovate merges it once every status
  on it is success, and the merge deploys like any push. Leave that branch to
  Renovate. Keep `bun run check`, the typecheck and the build green, since a
  failing build holds every update back. List a package in `ignoreDeps` in
  `renovate.json` to hold it back; `cloud renovate disable <project> <app>`
  turns Renovate off.
- **Two 401s.** A 401 with `sign_in_required` comes from Cloud's edge (a
  private App and no sign-in); a 401 with `unauthorized` comes from this
  app's own code (`requireMember` with no user).
- **Invites.** The owner lets someone into a private App with `cloud invite
  <project> <app> <email>`. Each run makes a new single-use code for 7 days;
  older codes stay valid until used or expired, since Cloud cannot revoke
  them. A redeemed old code only makes a Cloud App Guests account, which
  opens no App unless its email is on that App's allow list.
- **Secrets.** Keep keys and passwords out of the repo and the Project
  File. Set one from stdin, never as an argument:
  `printf %s "$VALUE" | cloud secrets set <project> <app> STRIPE_KEY`, or
  a whole file with `cloud secrets import <project> <app> < .env` (one
  change, one restart). Over MCP, use `set_secret`. It arrives as an env
  variable after the App restarts, in about a minute; `cloud secrets list`
  shows names and status, never values. For a value no person needs, such
  as a session or signing key, write `SESSION_SECRET: {generate: true}` in
  the App's `env` in the Project File: Cloud makes 32 random bytes once,
  keeps them on every apply and never shows them. Read it in
  `env.server.ts` like any other variable.
- **Access Tokens for CI.** `cloud tokens create --expires 30d` (after
  `cloud login`) prints a token for `CLOUD_TOKEN`. Every token expires, 90
  days at most, and nothing extends it.
- **No access requests and no bearer tokens.** `/pending` and
  `/admin/requests` redirect. `/api` routes work from the signed-in browser
  only.
- **Env at build time.** Plain env reaches the build; secrets never do.
  The App's `env` in the Project File is set on the pod and passed to the
  build, so `vite build` inlines `import.meta.env.VITE_*` values into the
  page's JS (for example `env: {VITE_GREETING: hi}`). Anyone who opens the
  page can read those, so never put a secret in a `VITE_*` name. Secrets
  (`cloud secrets`, and `{generate: true}` values) reach the running App
  only. The `Dockerfile` reads the
  build env from `CLOUD_BUILD_ENV`; keep that line. A Dockerfile of your
  own gets each plain value where it declares `ARG NAME`. Cloud leaves
  these names out of the build, though the App still gets them at run
  time: `PATH`, `LD_*`, `DOCKER_*`, `BUILDX_*`, `BUILDKIT_*`, the proxy
  names (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `ALL_PROXY`),
  `NODE_OPTIONS`, `BUN_*` and `RAILPACK_CONFIG_FILE`, in any case.
- **Build logs.** `cloud deploys <project> <app>` shows why a Deploy
  failed and the last 20 lines of its build; `cloud deploys log <project>
  <app> <deploy-id>` prints the whole build.
- **Migrations.** `bun run db:generate` writes them to `drizzle/`; commit
  them. Once per Deploy, before the new version starts, Cloud runs
  `entrypoints/migrate.js` from the image as a Job, which applies them. If
  it fails, the Deploy fails, the version before keeps serving, and
  `cloud deploys log <project> <app> <deploy-id>` ends with its output.
  Keep them additive (see Database).
- **One-off jobs.** `cloud run <project> <app> -- <command>` runs a
  command once with the live version's image, env and secrets, prints its
  output and exits with its exit code; `cloud jobs <project> <app>` lists
  them. The command runs with no shell and at most 1 hour, one at a time
  per Project, and cannot call an internal App. Bundle a script as
  `migrate.ts` is (`build:entrypoints`), and it runs as
  `cloud run <project> <app> -- bun entrypoints/<name>.js`. It
  opens 1 database connection that the Plan does not count.
- **Shell and SQL.** `cloud shell <project> <app>` opens `sh` in a running
  instance (the image's busybox gives `env`, `ls`, `cat`, `grep`, `ps`, `cut`,
  `head`, `tail`),
  and `cloud psql <project> <postgres>` opens psql as the Postgres's own
  role; `-c '<sql>'` runs one SQL text. Piped stdin runs as a script and
  the command exits with its exit code; `--json` prints one document. Only
  the owner opens one, at most 1 hour, closed after 15 minutes idle; each
  is a `shell` or `psql` change. Changes made in a shell are lost when the
  instance is replaced: put them in code and deploy.
- **Health check.** `cloud new` sets `healthCheckPath: /healthz` in the
  Project File, and `src/routes/healthz.ts` answers it. Cloud asks it on
  PORT every 10 s: a Deploy goes live only once it answers 2xx, and an
  instance that fails it for 60 s is restarted. Keep `/healthz` fast and
  free of database calls, so a slow database never restarts a working
  App. `cloud events <project> <app>` lists when the App crashed (with its
  exit code, or `OOMKilled`), failed the check, or recovered;
  `cloud projects` names an App that is crashing now. To hear about it by
  email or signed webhook, add a channel:
  `cloud notifications channels add email <address>` or
  `... add webhook <url>` (`cloud help notifications`).
- **Instances.** `instances: 2` (or 3) on the App in the Project File
  runs that many copies, each counted against the Budget at the App's
  Size. Each request goes to one of them, so keep state in Postgres,
  never in memory. Each reads its id in `CLOUD_INSTANCE_ID`, and
  `cloud logs` shows its last 5 characters on each line.
- **Network and limits.** No email from the app: Cloud blocks TCP 25,
  465, 587 and 2525. The app reaches the internet over IPv4 only, from one
  shared address (`cloud help apps`). A request has 125 seconds to start
  its answer and a body of at most 100 MiB; a stream needs a message every
  30 seconds (`cloud help limits`).
- **Files.** Nothing on disk lasts: `/tmp` (512 MiB) is wiped at every
  Deploy and restart, and each instance has its own. Keep files in a
  Bucket: add `files: {kind: bucket, size: small}` to the Project File's
  services and `files` to the App's `connects`. Cloud sets `S3_ENDPOINT`,
  `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`
  (and `CLOUD_S3_*_<NAME>` for each Bucket when there are several).
  `bucket()` in `src/server/bucket.server.ts` gives the S3 client, or null
  without a Bucket. The store has no public address: the App takes every
  upload and serves every download, as streams (`putStream`,
  `getStream`), never a whole file in memory. A request body is at most
  100 MiB. A write past the Size's quota fails with S3 code
  `AccessDenied`. app-kit's `docs/stack.md` ("Files on Cloud") has a
  streaming upload and download route.
- **Background work.** A pg-boss worker or a cron job runs from this
  App's image as a `worker` or `cron` Service in the Project File, with an
  argv `command` such as `[bun, entrypoints/worker.js]` and its pool sized
  to `CLOUD_DATABASE_POOL_SIZE`. Read "Workers and cron jobs on Cloud" in
  app-kit's `docs/stack.md` before you add one.
- **Connections.** The pod's pool is `CLOUD_DATABASE_POOL_SIZE`, plus one
  LISTEN connection for realtime. A nano Postgres (5 connections) holds
  this App and one worker or cron at pool 1; with both, or with 2
  instances, give the Postgres `size: small` (`cloud help limits`). Where
  realtime is off (no pool size and a connection limit below 4), lists
  refetch every `app.pollMs`; invalidate the query after a write, as
  `routes/index.tsx` does.
- **Backups.** Cloud dumps the Postgres every night and keeps the dumps
  14 days. `cloud pg backup` takes one now and `cloud pg backups` lists
  them; `cloud pg restore ... --backup <id> --into <new>` restores one
  into a new Postgres, never into this one; `cloud pg export ... -o
  db.dump` writes a `pg_dump` to a file. `cloud pg rotate` gives the
  Postgres a new password and restarts the App with it. The template
  reads `DATABASE_URL` at start, so it needs no change (`cloud help
  postgres`).
- **Deleting.** `cloud projects delete <project>` stops the Project; for
  7 days `cloud projects restore <project>` brings it back with its
  database, then Cloud deletes it for good (`--purge` does that at once).
  Never delete a Project to retry a failed apply: apply the file again.
- **Deploys.** Cloud deploys each push to `master` within seconds (a
  Forgejo push webhook, which `cloud new` adds). To push without a
  Deploy, put `[skip cloud]` in the commit message. `cloud deploy
  <project> <app>` deploys the branch head by hand, `--commit <sha>` one
  commit; `autoDeploy: false` on the App in the Project File stops push
  Deploys. `cloud deploy cancel <project> <app> <id>` stops a build, and
  `cloud deploy-hook <project> <app>` prints a secret URL a POST to which
  deploys. Keep that URL out of the repo.
- **Project File in the repo.** After `cloud sync enable <project> --repo
  <this repo's URL>`, `cloud.yaml` at the repo root is the Project File:
  each commit that changes it is applied within 2 minutes, `cloud apply`
  is refused, and a Service you remove from it keeps running until `cloud
  changes confirm <id>`. A commit that changes only `cloud.yaml` still
  deploys the App, unless its message holds `[skip cloud]`. `cloud sync
  status <project>` shows the last commit applied and any error.
- **Test locally first.** Each push costs build minutes. Before you push,
  start a throwaway Postgres (README, "Run locally"), install the test
  browser once with `bunx playwright install chromium-headless-shell`, and
  run
  `bun run check && bun run build && bun run typecheck && TEST_DATABASE_URL=<admin url> bun run test && TEST_DATABASE_URL=<admin url> bun run test:e2e`.
  Build before typecheck: `vite build` writes `src/routeTree.gen.ts`, and
  `tsc` fails on a new route file until it does. The cloud-mode tests need
  the build and the database; without them they are skipped. A run with
  skipped tests is not done. If the browser install or a test fails with
  `ENOSPC`, the temp directory is full: set `TMPDIR` to a directory under
  `$HOME` (`mkdir -p ~/.cache/tmp && export TMPDIR=~/.cache/tmp`) and run it
  again.

<!-- cloud:begin -->
<!-- Cloud replaces this block with this App's facts. -->
<!-- cloud:end -->

## Replacing the example

The template ships an example, `items`: each person's own list on the home
page, with its "New item" field, `src/server/items.functions.ts` and `items.server.ts`, the
`/api/items` route, the `items` table and `itemKeys` in
`src/lib/query-keys.ts`. Replace it with the app's own data, but keep the
tests that check the plumbing passing, pointed at the new code:

- `e2e/auth.spec.ts` (sign-in, access requests), `e2e/realtime.spec.ts`
  (fan-out to another tab, the resync after a missed event) and
  `e2e/cloud.spec.ts` (cloud mode) drive the home page through the "New
  item" label and the `items` and `no-items` test ids. Give the new main
  page a label and test ids of its own and use them there. These tests
  expect a fresh user to see an empty list; for shared data, wait for the
  list to finish loading instead (a test id on the list's container, which
  is there whether it is empty or not), since other tests' rows are there.
- `/silent-item` in `e2e/stack.ts` writes a row behind the app's back for
  the resync test. Make it insert into the new table.
- `src/server/http.server.test.ts`, `cloud.server.test.ts` and
  `cloud-realtime.server.test.ts` call `/api/items` to check the 401 and
  403 paths, CSRF, framing, bearer tokens and the connection pool. Point
  them at an `/api` route of the new app, and change `known` in
  `src/start.ts` to list it.
- Then delete `/api/items`, `items.functions.ts`, `items.server.ts`,
  `items.server.test.ts` and `itemKeys`, so no dead example is left.
- Migrations, in two steps. First add the new table to `schema.server.ts`
  and run `bun run db:generate`: that writes its `CREATE TABLE` migration.
  Only then drop the `items` table and run `bun run db:generate` again for
  the `DROP TABLE` migration. With an add and a drop in one generate,
  drizzle-kit asks whether the new table renames the old one; with no
  terminal (an agent's shell) that prompt crashes, and drizzle-kit has no
  flag to answer it. Under the additive rule (Database), push the drop after
  the new version runs, or with it while the app has no users yet.

**Shared data.** The example is per person: `listItems` filters on
`ownerSub`, and `addItem` publishes to the writer's own topic. For a list
every member sees (a family's shopping list), leave the owner filter out and
publish to `null`, which reaches every open stream (see Realtime). Published
to `user.sub`, other members' tabs never see the write while realtime is
on, because lists then do not poll. "Every member" means everyone who gets
past sign-in: on a private App, the people on its allow list; on a public
App, anyone with a homelab account. Keep family-only data in a private App.

Run the full line in "Test locally first" before the push.

## Load the TanStack skills before you write Start or Router code

TanStack ships agent skills inside its npm packages (TanStack Intent), written
for the installed version. `package.json` → `intent.skills` lists the
packages whose skills we use.

```sh
bun run intent list                                   # what is available
bun run intent load @tanstack/start-client-core#start-core/server-routes
```

Use `bun run intent`, not `bunx intent`: another TanStack package ships an
`intent` binary that shadows Intent's in `node_modules/.bin`.

| Task | Load |
|---|---|
| Any Start work (start here) | `@tanstack/start-client-core#start-core`, `@tanstack/react-start#react-start` |
| What runs where (server vs client vs both) | `@tanstack/start-client-core#start-core/execution-model` |
| /api endpoints | `@tanstack/start-client-core#start-core/server-routes` |
| Server functions (UI RPC) | `@tanstack/start-client-core#start-core/server-functions` |
| Middleware, request context | `@tanstack/start-client-core#start-core/middleware` |
| Sessions, auth guards | `@tanstack/start-client-core#start-core/auth-server-primitives`, `@tanstack/router-core#router-core/auth-and-guards` |
| Routes, loaders, search params, navigation | `@tanstack/router-core#router-core` and its sub-skills |
| Build and deploy | `@tanstack/start-client-core#start-core/deployment` |
| Habits from Next.js | `@tanstack/react-start#lifecycle/migrate-from-nextjs` |

## Server-only code lives in `*.server.ts`

Everything that touches the database, secrets or Bun's built-ins lives under
`src/server/` in files named `*.server.ts`. Import those modules only from
server route handlers, server function handlers, other `*.server.ts` modules,
`src/start.ts` middleware `.server(...)` bodies and `src/entrypoints/*`.

Never import them from a component, a hook or a plain helper module that a
component imports. Start strips server-function and server-route bodies from
the client bundle, but a plain exported helper that touches the database,
sitting in a module the client imports, pulls the Postgres driver into the
browser bundle. `vite build`, `tsc` and `curl` all pass; only a real browser
shows `Buffer is not defined` on hydration, after which no button works.
After adding server code, run `bun run test:e2e` (a real Chromium) before
calling it done.

## Server functions vs server routes

- Server functions (`createServerFn`, `src/server/*.functions.ts`) are
  internal RPC for this app's own UI. They are served at `/_serverFn/<hash>`
  and speak seroval, so CLIs, agents and Home Assistant cannot call them.
- Anything a non-browser client calls is a server route under `/api` with a
  zod schema (`readJson`/`readQuery` from `@viktorbarzin/runtime`) and
  `appAuth.handleApi` for identity. Bearer tokens work there, except on
  Cloud.
- The validator method in Start 1.169 is `.validator()`, not
  `.inputValidator()` (older docs and model memory use the latter).
- `src/routeTree.gen.ts` is generated by `vite build` / `vite dev` and is
  committed. `tsr generate` writes a different file; do not use it.
- Query keys come from `src/lib/query-keys.ts`. Biome has no TanStack Query
  lint, so a hand-typed key that does not match never invalidates.

## Which package owns what

| Package | Owns | Wired in |
|---|---|---|
| `@viktorbarzin/log` | JSON-lines logs with OpenTelemetry field names (app-kit ADR-0002), the per-request log context, console redirection | everywhere, `nitro-plugin.server.ts`, `start.ts`, `auth.server.ts` |
| `@viktorbarzin/runtime` | process singletons, idle timeout, drain and shutdown, error envelope, zod body/query validation, anti-framing headers, `/healthz` | `start.ts`, `nitro-plugin.server.ts`, `/api` routes |
| `@viktorbarzin/metrics` | the process registry, `http_requests_total` and `http_request_duration_seconds`, `/metrics` on METRICS_PORT | `start.ts`, `nitro-plugin.server.ts` |
| `@viktorbarzin/pg` | the pool (password file re-read per connection), the connection budget, migrations under an advisory lock, the migrate CLI, test databases | `db.server.ts`, `env.server.ts`, `entrypoints/migrate.ts` |
| `@viktorbarzin/oidc-token` | bearer JWT verification (RS256, issuer, audience, exp) | through `@viktorbarzin/auth` |
| `@viktorbarzin/auth` | Better Auth sign-in, sessions, membership re-checks, request + approve, CSRF; cloud mode (`createCloudAuth`) | `auth.server.ts`, `routes/api/auth/*`, `start.ts` |
| `@viktorbarzin/realtime` | LISTEN/NOTIFY, the SSE hub, the browser client, the query-invalidation hook | `realtime.server.ts`, `routes/api/events.ts`, `routes/index.tsx` |
| `@viktorbarzin/telemetry` | the Rybbit script (pageviews, replay), product events, Sentry init | `components/telemetry.tsx`, `routes/__root.tsx`, `nitro-plugin.server.ts` |

Only `src/server/env.server.ts` reads `process.env`. It maps the Terraform
app module's env contract, or Cloud's `CLOUD_*` contract, onto the package
configs.

The packages keep TanStack Start out of their dependencies: they take a
`Request` and return a `Response` or data, and this app wires them into
middleware and routes. Start ships breaking changes in minor releases, so it
is pinned to an exact version here and upgraded by hand.

## Telemetry and logs

Telemetry is on by default (app-kit ADR-0002, infra ADR-0041). It starts
whenever `TELEMETRY_WRITE_KEY` (or `TELEMETRY_WRITE_KEY_FILE`) is set, and
stays off in local runs and tests, which have no key.

| Env | Meaning | Default |
|---|---|---|
| `TELEMETRY_WRITE_KEY` | the app's write key, Vault `secret/rybbit` `write_keys` | unset: telemetry off |
| `SENTRY_DSN` | the GlitchTip DSN, `https://<key>@<app host>/_t/x/<project>` | unset: no error reports |
| `TELEMETRY_SITE_ID` | the Rybbit site | `app.telemetry.siteId` (1) |
| `TELEMETRY_EVENTS_URL` | the event pipeline, for server-side events | `http://event-pipeline.rybbit.svc.cluster.local` |
| `SERVICE_VERSION` | the release: on Cloud, the running Deploy's commit; elsewhere, set in the image by this repo's CI build | `dev` |
| `DEPLOYMENT_ENVIRONMENT` | `deployment.environment.name` | `production` when `NODE_ENV=production`, else `dev` |
| `TELEMETRY` | `off` to opt out at run time | on |

To opt out for good, set `telemetry.enabled: false` in `src/app.config.ts`.

- The browser loads the Rybbit script and the Segment client only on the
  production hosts in `app.telemetry.productionHosts`, so local dev sends
  nothing. Pageviews and replay need no code.
- Product events are `noun.past_verb` with snake_case property keys:
  `track("item.created", { item_id })` from `@viktorbarzin/telemetry/browser`
  in components, or `track({ event, properties, userId })` from
  `@viktorbarzin/telemetry/server` in server code (see `items.functions.ts`).
  Both drop events the pipeline would reject; the server logs why.
- Sign-in reloads the page, and `components/telemetry.tsx` then identifies
  the person by their `sub`. Call `reset()` from the browser entry on
  sign-out.
- Use `requireMember` from `auth.server.ts` in server functions: it puts the
  person's `sub` on the request's log lines as `enduser.id`. Extras you pass
  to a logger are snake_case.
- Access lines (`request`, with the path and status) cover only `/api/*`
  routes (`observeRequest` in `src/start.ts`). Server functions and page
  loads log only errors and what the code logs, so `cloud logs` shows no
  line for them. To see a failing server function there, log it yourself
  inside the handler after `requireMember`, whose request context tags the
  line with the person.

## Database

- Connection budget: 5 per pod on a shared primary. The pool takes 4
  (`APP_POOL_MAX`), the realtime LISTEN connection 1; migrations use 1
  more while they run (on Cloud the migrate Job of each Deploy, on the
  infra path the Deployment's init container). On Cloud the pool is
  `CLOUD_DATABASE_POOL_SIZE` plus the LISTEN connection
  (`connectionBudget()` in `env.server.ts`). Cloud counts each instance
  twice (during a rollout the old pods keep their connections until they
  stop), plus each worker and cron on the database, and refuses a Plan
  that does not fit (`cloud help limits`). A nano Postgres holds 1
  instance and one worker or cron at pool 1; a small one holds 2
  instances, a worker and a cron at pool 1. Without it the pod gets half of
  `CLOUD_DATABASE_CONNECTION_LIMIT`. On Cloud, more instances, a worker
  or a cron is self-service: add it to the Project File and run `cloud
  plan`. The Plan checks every process against the Size's connections,
  refuses one that does not fit and names the Size that holds it, so
  there is no one to ask. A worker or cron job opens
  `CLOUD_DATABASE_POOL_SIZE` connections (see On Cloud). Off Cloud, on a
  homelab deploy with a fixed budget of 5 per pod, more replicas or a
  CronJob multiply this, so ask the infra owner before adding either.
- Migrations are additive: expand in one release, contract in a later one, so
  the previous image stays a working rollback.
- The same rule covers server functions. A tab opened before a deploy keeps
  running the old client: it calls the old server function by its name and
  input, and reads the return shape it was built for, until it reloads. A
  renamed or removed function logs `Server function info not found` on the
  server, and a changed return shape breaks the old page (for example
  `data.map is not a function`). Add the new function or field first, and
  remove the old one in a later release. `bun run db:generate` writes
  them to `drizzle/`. On Cloud a migrate Job applies them once per Deploy,
  under `pg_advisory_lock`, before the new version starts (see On Cloud);
  on the infra path the Deployment's init container applies them.
- The identity tables come from `@viktorbarzin/auth/schema`. A change there is
  a major version of that package and needs a regenerated migration here.

## Realtime

A write that other tabs should see publishes inside its own transaction:

```ts
await db.transaction(async (tx) => {
	await tx.insert(items).values(...);
	await realtime.publishInTx(tx, ownerSub, { type: "invalidate", keys: [itemKeys.all], source });
});
```

The NOTIFY fires at COMMIT, so a rolled-back write tells no one. Each tab's
stream (`/api/events`) subscribes to its user's topic, `user.sub`. The
second argument picks who hears the event: `ownerSub` reaches every tab of
that user, and `null` reaches every open stream. Use `null` for shared data
that every member sees; a write published to the writer's topic never
reaches the other members' tabs. The client hook (`useRealtimeInvalidation`)
invalidates those keys in every tab but the one that wrote, and refetches
every active query after a reconnect or `resync`. Payloads name keys, never
data, and stay under 7,900 bytes.

## Commands

This app needs Bun 1.4.3 or newer (`packageManager` in package.json). On the
devvm, `~/.bun/bin/bun` is 1.3.11 and comes first on PATH; run
`/usr/local/bin/bun`, or put `/usr/local/bin` first. `bun run` scripts call
whichever `bun` is first on PATH, and the server refuses to start on an older
one.

After `dev`, in the order CI runs them:

```sh
bun run dev            # vite dev under Bun on 127.0.0.1:${PORT:-3000}
bun run check          # biome
bun run build          # vite build + the migrate entrypoint; writes src/routeTree.gen.ts
bun run typecheck      # after the build: tsc needs the route tree a new route adds
bun run test           # bun test; DB and HTTP tests need TEST_DATABASE_URL and a build
bun run test:e2e       # Playwright against the built server
```

To run it locally against a database (README, "Run locally"):
`DATABASE_URL=... bun run build && bun run migrate`, then
`DATABASE_URL=... DEV_USER=<name> PORT=<free port> bun run dev`. `DEV_USER`
stands in for sign-in only when `NODE_ENV` is `development` or `test` and no
OIDC client is configured.
