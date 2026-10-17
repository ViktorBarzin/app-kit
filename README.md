# app-kit

Shared packages and the app template for the default app stack (ADR-0001):
TanStack Start on Bun, Drizzle on Postgres, Authentik sign-in through
app-side OIDC, and realtime over Postgres LISTEN/NOTIFY and Server-Sent
Events. The packages hold the plumbing every such app needs, so a new app
carries only its own domain code.

| Package | What it does |
|---|---|
| [`@viktorbarzin/log`](packages/log) | JSON-lines logger (`ts`, `level`, `logger`, `msg`, extras, `exc`) and console redirection |
| [`@viktorbarzin/runtime`](packages/runtime) | process singletons, Bun idle timeouts, request drain, graceful shutdown, the `/api` error envelope, zod validation, anti-framing headers |
| [`@viktorbarzin/metrics`](packages/metrics) | one prom-client registry per process, HTTP request metrics, `/metrics` on its own port |
| [`@viktorbarzin/pg`](packages/pg) | Drizzle on Bun SQL with a rotating password file, migrations under an advisory lock, a migrate CLI, test databases |
| [`@viktorbarzin/oidc-token`](packages/oidc-token) | OIDC bearer-token verification (RS256, issuer, audience, exp) |
| [`@viktorbarzin/auth`](packages/auth) | Better Auth sign-in against Authentik, sessions, membership re-checks, request and approve, CSRF checks |
| [`@viktorbarzin/realtime`](packages/realtime) | one LISTEN connection per pod, an SSE hub, a reconnecting browser client, a TanStack Query hook |

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

1. Record changes with `bun run changeset`, then `bunx changeset version` to
   bump versions and changelogs. Commit to `master` on Forgejo.
2. `.github/workflows/release.yml` runs on every push to `master`: package
   tests, gitleaks over the history, `scripts/check-public.ts` (no homelab
   hostnames, internal addresses, client IDs or secrets in `src/` or `dist/`),
   then `scripts/release.ts`, which publishes each package whose version is
   not on npm yet (`bun pm pack`, then `npm publish --provenance`) and tags
   `<name>@<version>` on Forgejo.
3. After a publish, `bun scripts/export-template.ts --push` refreshes
   `viktor/app-template` with the published versions.

## One-time npm setup

Publishing is off until these steps are done; until then release.yml runs a
dry run. Trusted publishing needs each package to exist on npm before a
trusted publisher can be added to it, so the first version is published by
hand once.

1. Create the free npm organisation `viktorbarzin` on npmjs.com.
2. Publish the first version of each package by hand, from a clean checkout of
   master: `bun install && bun run build && bun scripts/release.ts --pack-only .packs`,
   then `npm publish .packs/<tarball> --access public` for each of the seven
   tarballs (log, runtime, metrics, pg, oidc-token, auth, realtime, in that
   order). This first version has no provenance statement.
3. For each package on npmjs.com, Settings, Trusted Publisher, GitHub Actions:
   organisation or user `ViktorBarzin`, repository `app-kit`, workflow
   filename `release.yml`, no environment. Publishers created after
   2026-09-03 allow only `npm stage publish` by default; also allow
   `npm publish`.
4. On GitHub `ViktorBarzin/app-kit`, set the repository variable
   `NPM_PUBLISH_ENABLED` to `true` and the secret `FORGEJO_GIT_TOKEN` (a
   Forgejo token with write access to `viktor/app-kit`, for the release tags).
5. Optionally, in each package's npm settings, require trusted publishing and
   disallow tokens.

Only the `@viktorbarzin` scope is used. The `@homelab` scope belongs to
another npm user.
