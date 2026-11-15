# Starter

A new app on the default app stack (ADR-0001): TanStack Start on Bun, Drizzle
on the shared Postgres, Authentik sign-in through app-side OIDC, realtime over
LISTEN/NOTIFY and SSE. The example domain is a list of items, each person's
own; AGENTS.md, "Replacing the example", says how to swap in your own data.

## On Cloud

On Cloud there are no infra steps: Cloud builds and deploys every push to
`master`, signs people in and runs the database. [AGENTS.md](AGENTS.md) has
the agent and code conventions; its "On Cloud" section covers working on
this app there, and "Test locally first" lists the checks to run before a
push.

## Requirements

Bun 1.4.3 or newer (`packageManager` in `package.json`). On the devvm,
`~/.bun/bin/bun` is 1.3.11 and comes first on PATH, so run
`/usr/local/bin/bun` or put `/usr/local/bin` first; `bun run` scripts call
whichever `bun` is first on PATH, and the server and `rename` refuse to start
on an older one.

## Run locally

With a Postgres you can reach (a throwaway `docker run -e
POSTGRES_PASSWORD=dev -p 127.0.0.1:5433:5432 postgres:18` works):

```sh
bun install
export DATABASE_URL=postgres://postgres:dev@127.0.0.1:5433/postgres
bun run build && bun run migrate          # applies drizzle/ to that database
DEV_USER=me PORT=3100 bun run dev         # http://127.0.0.1:3100, signed in as "me"
```

`DEV_USER` stands in for sign-in only while `NODE_ENV` is `development` or
`test` and no OIDC client is configured; `bun run dev` sets
`NODE_ENV=development`. Tests: `TEST_DATABASE_URL=<admin url> bun run test`
(each test makes and drops its own database), then `bun run test:e2e`. The
end-to-end tests need Playwright's browser, which a fresh home directory
lacks; install it once with `bunx playwright install chromium-headless-shell`.
If that install fails with `ENOSPC`, the temp directory is full: set `TMPDIR`
to a directory under `$HOME` and run it again (AGENTS.md, "Test locally
first").

## Off Cloud

To run the app on the homelab cluster without Cloud, follow
[docs/new-app.md](docs/new-app.md): the rename, the infra steps, the GitHub
mirror and CI, in order.

This template is generated. Its source of truth is `template/` in
[viktor/app-kit](https://forgejo.viktorbarzin.me/viktor/app-kit), where it
builds and its HTTP and Playwright tests run against the `@viktorbarzin/*`
packages in the same commit. `scripts/export-template.ts` there refreshes
`viktor/app-template` after the packages are published, replacing each
`workspace:^` range with `^<published version>` and writing `bun.lock`.
Change the template in app-kit, not in `viktor/app-template`. Until those
packages are on Forgejo's npm registry and the export has written
`bun.lock`, the template's own build fails at its first step with "publish
@viktorbarzin packages first". `bunfig.toml` points the `@viktorbarzin` scope
at that registry.
