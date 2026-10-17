# app-kit

Shared `@viktorbarzin/*` packages and the app template for the default app
stack (ADR-0001, in Viktor's `~/code/docs/adr/0001-default-app-stack.md`). The
reference app the code was extracted from is `~/code/tasks`. Read
[README.md](README.md) for the layout and the release flow.

## Layout

```
packages/<name>/   one npm package each: src/, dist/ (tsc -b), README.md, CHANGELOG.md
template/          the app template's source of truth (a workspace member); see template/AGENTS.md
scripts/           check-public.ts, release.ts, export-template.ts (+ tests)
.github/workflows/ ci.yml (every push), release.yml (master)
```

Canonical repo: Forgejo `viktor/app-kit`. GitHub `ViktorBarzin/app-kit` is a
one-way push mirror where Actions run; never commit there.

## Rules for the packages

- Public packages: no hostnames of ours, internal addresses, client IDs or
  secrets in `src/` or `dist/`. Tests use `*.example` / `*.invalid` names and
  127.0.0.1. `bun scripts/check-public.ts` and gitleaks enforce it before
  every release.
- Nothing instance-specific is hard-coded. Names, URLs, groups, ports and
  timings are config inputs with defaults; the app's `env.server.ts` maps its
  environment onto them. Only `@viktorbarzin/log` reads an env var
  (`LOG_LEVEL`), and `@viktorbarzin/pg`'s `pgSettingsFromEnv`/`runMigrateCli`
  read the platform contract when the app asks them to.
- No package imports `@tanstack/react-start` or `@tanstack/react-router`.
  Start ships breaking changes in minor releases; the packages take a
  `Request` and return a `Response` or data, and the app wires them in.
- Process state (pools, LISTEN, registries, log sink) lives on
  `globalThis[Symbol.for("@viktorbarzin:<key>")]` (`processSingleton` in
  runtime). A Start server built by Nitro bundles the server twice, and
  module-level state would give two pools and two LISTEN connections.
- `@viktorbarzin/*` packages depend on each other as peers (`^0.x.y` ranges)
  plus a `workspace:^` dev dependency, so an app has one copy of each. When
  a package's minor version moves while it is 0.x, raise the peer ranges that
  name it.
- ESM only, `exports` with `types` and `default` per subpath, `files: ["dist"]`,
  `engines.bun >= 1.4.3`, `publishConfig.provenance`, and a `repository`
  field with `directory` (npm provenance checks it).
- Test-first for behaviour. Port a test from tasks when the code came from
  there; add one for every new config input.
- Changing a table in `@viktorbarzin/auth/schema` is a breaking change: apps
  regenerate migrations.

## Commands

Use `/usr/local/bin/bun` (1.4.3); `~/.bun/bin/bun` is older and may come first
on PATH.

```sh
bun install && bun run build && bun run check && bun run test
bun run typecheck                       # packages, then tests and scripts
cd template && bun run build && bun run test && bun run test:e2e
bun scripts/check-public.ts --require-gitleaks
bun scripts/release.ts --dry-run        # or --pack-only .packs
```

DB, LISTEN and HTTP tests need `TEST_DATABASE_URL` (see README.md).
