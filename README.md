# app-kit

Shared packages and the app template for the default app stack (ADR-0001):
TanStack Start on Bun, Drizzle on Postgres, Authentik sign-in through
app-side OIDC, and realtime over Postgres LISTEN/NOTIFY and Server-Sent
Events. The packages hold the plumbing every such app needs, so a new app
carries only its own domain code.

[docs/stack.md](docs/stack.md) is the technical guide to the stack, with
diagrams.

| Package | What it does |
|---|---|
| [`@viktorbarzin/log`](packages/log) | JSON-lines logger with OpenTelemetry field names (`timestamp`, `severity_text`, `body`, `service.*`, `enduser.id`, `exception.*`; ADR-0002), per-request log context, console redirection |
| [`@viktorbarzin/runtime`](packages/runtime) | process singletons, Bun idle timeouts, request drain, graceful shutdown, the `/api` error envelope, zod validation, anti-framing headers |
| [`@viktorbarzin/metrics`](packages/metrics) | one prom-client registry per process, HTTP request metrics, `/metrics` on its own port |
| [`@viktorbarzin/pg`](packages/pg) | Drizzle on Bun SQL with a rotating password file, migrations under an advisory lock, a migrate CLI, test databases |
| [`@viktorbarzin/oidc-token`](packages/oidc-token) | OIDC bearer-token verification (RS256, issuer, audience, exp) |
| [`@viktorbarzin/auth`](packages/auth) | Better Auth sign-in against Authentik, sessions, membership re-checks, request and approve, CSRF checks |
| [`@viktorbarzin/realtime`](packages/realtime) | one LISTEN connection per pod, an SSE hub, a reconnecting browser client, a TanStack Query hook |
| [`@viktorbarzin/telemetry`](packages/telemetry) | the Rybbit script, Segment clients (browser and server) pointed at the app's own ingest path, Sentry init, event-name and property checks |

[`template/`](template) is the source of truth for the app template. It is a
workspace member that uses the packages through `workspace:^`, so a package
change and the template that proves it land in one commit. The repository new
apps are made from, `viktor/app-template`, is generated from it by
`scripts/export-template.ts`.

The canonical repository is `viktor/app-kit` on Forgejo. The GitHub repository
`ViktorBarzin/app-kit` is a one-way push mirror where GitHub Actions run CI and
publishing; commits made on GitHub are overwritten by the next sync.

## Develop

```sh
bun install
bun run build                  # tsc -b: packages/*/dist
bun run check                  # biome (packages, scripts, template)
bun run test                   # packages and scripts
cd template && bun run build && bun run test && bun run test:e2e
```

The database, LISTEN and HTTP tests run when `TEST_DATABASE_URL` points at a
Postgres where that role may create databases:

```sh
docker run -d --tmpfs /var/lib/postgresql -e POSTGRES_PASSWORD=ci -p 127.0.0.1::5432 postgres:18
export TEST_DATABASE_URL=postgres://postgres:ci@127.0.0.1:<port>/postgres
```

## Releasing

Apps install the packages from Forgejo's npm registry; npm is a public mirror
([ADR-0003](docs/adr/0003-forgejo-package-registry.md)). An app maps the
scope in `bunfig.toml`:

```toml
[install.scopes]
"@viktorbarzin" = "https://forgejo.viktorbarzin.me/api/packages/viktor/npm/"
```

1. Record changes with `bun run changeset`, then `bunx changeset version` to
   bump versions and changelogs. Commit to `master` on Forgejo.
2. `.github/workflows/release.yml` runs on every push to `master`, in three
   jobs so that dependency code never holds a token:
   - `build` (no tokens): package tests, gitleaks over the history,
     `scripts/check-public.ts` (no homelab hostnames, internal addresses,
     client IDs or secrets in `src/` or `dist/`), then
     `scripts/release.ts --plan release-packs`, which runs `npm view` per
     package on Forgejo and on npm, packs (`bun pm pack`) each version either
     registry lacks and uploads the tarballs with `release-plan.tsv`.
   - `publish-forgejo` (in the `forgejo-publish` environment, master only):
     with npm and git only, publishes each version Forgejo lacks and tags
     `<name>@<version>` on Forgejo.
   - `publish-npm` (the only job with `id-token: write`, in the
     `npm-publish` environment, only when `NPM_PUBLISH_ENABLED` is `true`):
     runs `npm publish --provenance` for each version npm lacks.

   Every action is pinned to a commit SHA and every downloaded binary to a
   sha256; `scripts/workflows.test.ts` checks both, here and in the
   template.
3. After a publish, `bun scripts/export-template.ts --push` refreshes
   `viktor/app-template` with the published versions.

To publish by hand, for example when CI is down: build and pack from a clean
checkout of master (`bun install && bun run build && bun scripts/release.ts --pack-only .packs`),
then for each tarball in release order (log, runtime, metrics, oidc-token,
auth, pg, realtime, telemetry) run
`npm publish .packs/<tarball> --provenance=false --registry https://forgejo.viktorbarzin.me/api/packages/viktor/npm/`
with a Forgejo token that has `write:package` in `.npmrc`.

## GitHub secrets

On `ViktorBarzin/app-kit`, the environment `forgejo-publish` (deployments from
`master` only) holds `FORGEJO_PACKAGE_TOKEN` (a Forgejo token with
`write:package` for the `viktor` account; Vault
`secret/ci/global` `forgejo_push_token`) and `FORGEJO_GIT_TOKEN` (write
access to `viktor/app-kit`, for the release tags).

## One-time npm setup, for the mirror

Trusted publishing needs each package to exist on npm before a trusted
publisher can be added to it, so the first npm version of a new package is
published by hand once, with Viktor's security key.

1. The free npm organisation `viktorbarzin` exists on npmjs.com.
2. Publish the first version of a new package by hand:
   `npm publish .packs/<tarball> --access public`. This first version has no
   provenance statement.
3. For each package on npmjs.com, Settings, Trusted Publisher, GitHub Actions:
   organisation or user `ViktorBarzin`, repository `app-kit`, workflow
   filename `release.yml`, environment `npm-publish`. Publishers created after
   2026-09-03 allow only `npm stage publish` by default; also allow
   `npm publish`.
4. On GitHub `ViktorBarzin/app-kit`, the environment `npm-publish` exists
   (deployments from `master` only), and the repository variable
   `NPM_PUBLISH_ENABLED` is `true`.
5. Optionally, in each package's npm settings, require trusted publishing and
   disallow tokens.

Only the `@viktorbarzin` scope is used. The `@homelab` scope belongs to
another npm user.
