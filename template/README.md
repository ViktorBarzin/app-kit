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

## Requirements

Bun 1.4.3 or newer (`packageManager` in `package.json`). On the devvm,
`~/.bun/bin/bun` is 1.3.11 and comes first on PATH, so run
`/usr/local/bin/bun` or put `/usr/local/bin` first; `bun run` scripts call
whichever `bun` is first on PATH, and the server and `rename` refuse to start
on an older one.

## New app checklist

Below, `starter` stands for the new app's slug (a DNS label) and `Starter` for
its display name; step 2 replaces both everywhere, this file included. Where
the slug has dashes, the database name and role use underscores (`my-app`
becomes `my_app`), and step 2 writes those too.

1. **Create** the repository on Forgejo with "Use this template", under
   `viktor`, named after the slug, and keep it **public**. The image is built
   on GitHub Actions and pushed to ghcr, and the package of a public repo is
   public, which the cluster pulls without credentials. A private app needs
   three more things: `--visibility private` in step 5, its namespace in
   infra `ghcr_private_namespaces`
   (`stacks/kyverno/modules/kyverno/ghcr-credentials.tf`), and
   `image_pull_secrets = ["ghcr-credentials"]` in the module call below.
2. **Rename.** In a clone, run `bun run rename <slug> "<Display Name>"`, then
   `bun install`. The rename needs no installed packages, so it runs before
   the first install; the install afterwards refreshes `bun.lock`. The
   display name may not contain quotes, backslashes, backticks, `$` or line
   breaks. It rewrites `package.json` (name), `src/app.config.ts` (slug,
   display name, the three group names, the NOTIFY channel and the migration
   lock key), `.github/workflows/build.yml` (image, cache scope, retention
   package, svu user, Forgejo tag URL), `.woodpecker/deploy.yml` (namespace,
   deployment, containers), `Dockerfile` (a comment), `AGENTS.md`,
   `README.md`, `docs/new-app.md` and `bun.lock`. It runs once: it then
   deletes `scripts/rename.ts`, its test and the `rename` script. Commit the
   result.
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
     `local.app_databases`.
   - `stacks/vault/app_db_roles.tf`: add to `pg_app_roles`
     `starter = { username = "starter", rotation_schedule = "0 10 * * WED", rotation_window = 3600 }`.
   - `stacks/starter/`: `terragrunt.hcl` and `authentik.tf` copied from
     `stacks/tasks` (the provider block and the `data "authentik_user"
     "viktor"` lookup), and a `main.tf` with one call to
     [`modules/kubernetes/tanstack_app`](https://forgejo.viktorbarzin.me/viktor/infra/src/branch/master/modules/kubernetes/tanstack_app):

     ```hcl
     variable "image_tag" {
       type    = string
       default = "latest" # used only when the Deployment is created; CI sets the running tag
     }
     variable "postgresql_host" { type = string } # from config.tfvars
     variable "tls_secret_name" {                 # from config.tfvars
       type      = string
       sensitive = true
     }

     module "app" {
       source          = "../../modules/kubernetes/tanstack_app"
       name            = "starter"
       display_name    = "Starter"
       tier            = local.tiers.aux
       image           = "ghcr.io/viktorbarzin/starter"
       image_tag       = var.image_tag
       postgresql_host = var.postgresql_host
       tls_secret_name = var.tls_secret_name

       # You sign in as a member and approve everyone else. The admins group
       # is authoritative (people added in the Authentik UI are removed on the
       # next apply), and request mode refuses to plan without an admin.
       initial_user_pks = [data.authentik_user.viktor.id]
       admin_user_pks   = [data.authentik_user.viktor.id]
     }
     ```

   CI applies dbaas, vault and then the new stack on push to master. The
   stack may go in before the first image exists: the Deployment waits in
   `ImagePullBackOff` until step 7 builds one.
5. **GitHub mirror and CI.** From the infra checkout, with a clean clone of
   this repo:

   ```sh
   scripts/offinfra-onboard starter --clone <path-to-clone> --visibility public \
     --namespace starter --deploy "starter=migrate,starter" --keep-workflows
   ```

   It creates the public GitHub repo `ViktorBarzin/starter`, the Forgejo push
   mirror to it (`sync_on_commit`), the `WOODPECKER_TOKEN`,
   `FORGEJO_GIT_TOKEN` and `SLACK_WEBHOOK` secrets, the Woodpecker
   registration and the `WOODPECKER_REPO_ID` repo variable, and keeps this
   repo's `build.yml` and `.woodpecker/deploy.yml`.
6. **Renovate.** On Forgejo, add `renovate-bot` as a write collaborator and
   enable pull requests with fast-forward-only merges allowed. With your
   Forgejo token (the `viktor` line of `~/.git-credentials`):

   ```sh
   FJ_TOKEN=$(sed -n 's#^https://viktor:\([^@]*\)@.*#\1#p' ~/.git-credentials | head -1)
   fj() { curl -sf --resolve forgejo.viktorbarzin.me:443:10.0.20.203 \
     -H "Authorization: token $FJ_TOKEN" -H 'Content-Type: application/json' "$@"; }
   fj -X PUT https://forgejo.viktorbarzin.me/api/v1/repos/viktor/starter/collaborators/renovate-bot \
     -d '{"permission":"write"}'
   fj -X PATCH https://forgejo.viktorbarzin.me/api/v1/repos/viktor/starter \
     -d '{"has_pull_requests":true,"allow_fast_forward_only_merge":true}'
   ```

   Then add `{ repository: 'viktor/starter', baseBranchPatterns: ['master'] }`
   to `repositories` in infra `stacks/renovate/files/config-apps.js`.
7. **Push** to `master` on Forgejo. The mirror carries it to GitHub, Actions
   tests and builds `ghcr.io/viktorbarzin/starter`, and Woodpecker sets the
   image on the `migrate` init container and the app container. Check it with
   `homelab deploy wait starter/starter` and sign in at
   `https://starter.viktorbarzin.me`. You land on the list as a member and
   can approve others at `/admin/requests`.

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
(each test makes and drops its own database), then `bun run test:e2e`.
