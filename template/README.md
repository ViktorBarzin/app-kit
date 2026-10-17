# Starter

A new app on the default app stack (ADR-0001): TanStack Start on Bun, Drizzle
on the shared Postgres, Authentik sign-in through app-side OIDC, realtime over
LISTEN/NOTIFY and SSE. The example domain is a per-user list of items.

This repository is generated. Its source of truth is `template/` in
[viktor/app-kit](https://forgejo.viktorbarzin.me/viktor/app-kit), where it
builds and its HTTP and Playwright tests run against the `@viktorbarzin/*`
packages in the same commit. `scripts/export-template.ts` there refreshes this
repository after the packages are published, replacing each `workspace:^`
range with `^<published version>` and writing `bun.lock`. Change the template
in app-kit, not here.

The build fails at its first step with "publish @viktorbarzin packages first"
until those packages are on npm and the export has written `bun.lock`.

Agent and code conventions are in [AGENTS.md](AGENTS.md). The longer version
of the infra steps is [docs/new-app.md](docs/new-app.md).

## New app checklist

Below, `starter` stands for the new app's slug (a DNS label) and `Starter` for
its display name; step 2 replaces both everywhere, this file included.

1. **Create** the repository on Forgejo with "Use this template", under
   `viktor`, named after the slug, public or private as the app needs.
2. **Rename.** In a clone, run `bun run rename <slug> "<Display Name>"`, then
   `bun install`. It rewrites `package.json` (name), `src/app.config.ts`
   (slug, display name, the three group names, the NOTIFY channel and the
   migration lock key), `.github/workflows/build.yml` (image, cache scope,
   retention package, svu user, Forgejo tag URL), `.woodpecker/deploy.yml`
   (namespace, deployment, containers), `Dockerfile` (a comment),
   `AGENTS.md`, `README.md`, `docs/new-app.md` and `bun.lock`.
   `scripts/rename.test.ts` checks that no placeholder name is left.
3. **Vault KV.** `vault kv put` creates `secret/starter`; `vault kv patch`
   adds or replaces keys in it once it exists:

   ```sh
   vault kv put secret/starter \
     better_auth_secret="$(openssl rand -base64 48)" \
     oidc_client_id=starter \
     oidc_client_secret="$(openssl rand -hex 48)"
   vault kv patch secret/starter oidc_client_secret="$(openssl rand -hex 48)"  # later, to rotate one key
   ```

4. **Infra** (in `viktor/infra`; details in its `docs/agents/new-app.md`):
   - `stacks/dbaas/modules/dbaas/app_databases.tf`: add `starter = {}` to
     `local.app_databases` (underscores where the slug has dashes).
   - `stacks/vault/app_db_roles.tf`: add to `pg_app_roles`
     `starter = { username = "starter", rotation_schedule = "0 10 * * WED", rotation_window = 3600 }`.
   - `stacks/starter/`: `terragrunt.hcl` and `authentik.tf` copied from
     `stacks/tasks`, and a `main.tf` with one call to
     [`modules/kubernetes/tanstack_app`](https://forgejo.viktorbarzin.me/viktor/infra/src/branch/master/modules/kubernetes/tanstack_app):

     ```hcl
     module "app" {
       source          = "../../modules/kubernetes/tanstack_app"
       name            = "starter"
       display_name    = "Starter"
       image           = "ghcr.io/viktorbarzin/starter"
       image_tag       = var.image_tag
       postgresql_host = var.postgresql_host
       tls_secret_name = var.tls_secret_name
     }
     ```

   CI applies dbaas, vault and then the new stack on push to master.
5. **GitHub mirror and CI.** `infra/scripts/offinfra-onboard starter --keep-workflows ...`
   creates the public GitHub repo `ViktorBarzin/starter`, the Forgejo push
   mirror to it (`sync_on_commit`), the `WOODPECKER_TOKEN`,
   `FORGEJO_GIT_TOKEN` and `SLACK_WEBHOOK` secrets, the Woodpecker
   registration and the `WOODPECKER_REPO_ID` repo variable, and keeps this
   repo's `build.yml` and `.woodpecker/deploy.yml`.
6. **Renovate.** On Forgejo, add `renovate-bot` as a write collaborator and
   enable pull requests with fast-forward-only merges allowed:

   ```sh
   curl -X PUT  .../api/v1/repos/viktor/starter/collaborators/renovate-bot -d '{"permission":"write"}'
   curl -X PATCH .../api/v1/repos/viktor/starter -d '{"has_pull_requests":true,"allow_fast_forward_only_merge":true}'
   ```

   Then add `{ repository: 'viktor/starter', baseBranchPatterns: ['master'] }`
   to `repositories` in infra `stacks/renovate/files/config-apps.js`.
7. **Push** to `master` on Forgejo. The mirror carries it to GitHub, Actions
   tests and builds `ghcr.io/viktorbarzin/starter`, and Woodpecker sets the
   image on the `migrate` init container and the app container. Check it with
   `homelab deploy wait starter/starter` and sign in at
   `https://starter.viktorbarzin.me`.
