# Starter

A new app on the default app stack (ADR-0001): TanStack Start on Bun, Drizzle
on the shared Postgres, Authentik sign-in through app-side OIDC, realtime over
LISTEN/NOTIFY and SSE. The example domain is a per-user list of items.

This repository is generated. Its source of truth is `template/` in
[viktor/app-kit](https://forgejo.viktorbarzin.me/viktor/app-kit), where it
builds and its HTTP and Playwright tests run against the `@viktorbarzin/*`
packages in the same commit. `scripts/export-template.ts` there refreshes this
repository after the packages are published.

## Starting an app from it

1. "Use this template" on Forgejo, named after the app's slug.
2. `bun run rename <slug> "<Display Name>"`, then `bun install`.
3. Follow [docs/new-app.md](docs/new-app.md) for the infrastructure.

Agent and code conventions are in [AGENTS.md](AGENTS.md).
