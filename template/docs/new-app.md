# Starting a new app off Cloud

The ordered steps to run this app on the homelab cluster without Cloud. On
Cloud, `cloud new` does the repo and the deploy, and none of these steps
apply: see AGENTS.md, "On Cloud".

Below, `starter` stands for the new app's slug (a DNS label) and `Starter` for
its display name; step 2 replaces both everywhere, this file included. Where
the slug has dashes, the database name and role use underscores (`my-app`
becomes `my_app`), and step 2 writes those too.

1. **Create** the repository on Forgejo with "Use this template", under
   `viktor`, named after the slug, and keep it **public**. The image is built
   on GitHub Actions and pushed to ghcr, and the package of a public repo is
   public, which the cluster pulls without credentials. A private app needs
   three more things: `--visibility private` in step 6, its namespace in
   infra `ghcr_private_namespaces`
   (`stacks/kyverno/modules/kyverno/ghcr-credentials.tf`), and
   `image_pull_secrets = ["ghcr-credentials"]` in the module call in step 5.

2. **Rename.** In a clone, run `bun run rename <slug> "<Display Name>"`, then
   `bun install`. The rename needs no installed packages, so it runs before
   the first install; the install afterwards refreshes `bun.lock`. The
   display name may not contain quotes, backslashes, backticks, `$` or line
   breaks. It rewrites `package.json` (name), `src/app.config.ts` (slug,
   display name, the three group names, the NOTIFY channel and the migration
   lock key), `.github/workflows/build.yml` (image, cache scope, retention
   package, svu user, Forgejo tag URL), `.woodpecker/deploy.yml` (namespace,
   deployment, containers), `Dockerfile` (a comment), `AGENTS.md`,
   `README.md`, this file and `bun.lock`. It runs once: it then deletes
   `scripts/rename.ts`, its test and the `rename` script. Commit the result.

3. **Vault.** Seed `secret/starter` with:
   - `better_auth_secret`: 32+ random bytes, e.g. `openssl rand -base64 48`
   - `oidc_client_id`: `starter`
   - `oidc_client_secret`: 64+ random characters

   `vault kv put` creates `secret/starter`; `vault kv patch` adds or replaces
   keys in it once it exists:

   ```sh
   vault kv put secret/starter \
     better_auth_secret="$(openssl rand -base64 48)" \
     oidc_client_id=starter \
     oidc_client_secret="$(openssl rand -hex 48)"
   vault kv patch secret/starter oidc_client_secret="$(openssl rand -hex 48)"  # later, to rotate one key
   ```

4. **Database.** In infra (details in its `docs/agents/new-app.md`), add one
   entry to each map:
   - `stacks/dbaas/modules/dbaas/app_databases.tf`: `starter = {}` in
     `local.app_databases` (database and owner role).
   - `stacks/vault/app_db_roles.tf`: in `pg_app_roles`,

     ```hcl
     starter = {
       username          = "starter"
       rotation_schedule = "0 10 * * WED"
       rotation_window   = 3600
     }
     ```

     A new role rotates once when it is created, which is harmless before the
     app has data.

5. **Stack.** Create `infra/stacks/starter/` with `terragrunt.hcl` and
   `authentik.tf` copied from `stacks/tasks` (the `authentik` provider block
   with the token from `secret/authentik` `tf_api_token`, and the
   `data "authentik_user" "viktor"` lookup), and a `main.tf` with one call to
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

   Its `terragrunt.hcl` depends on `platform`, `vault` and `external-secrets`.
   CI applies dbaas, vault and then the new stack on push to master. The
   stack may go in before the first image exists: the Deployment waits in
   `ImagePullBackOff` until step 8 builds one.

6. **GitHub mirror and CI.** From the infra checkout, with a clean clone of
   this repo:

   ```sh
   scripts/offinfra-onboard starter --clone <path-to-clone> --visibility public \
     --namespace starter --deploy "starter=migrate,starter" --keep-workflows
   ```

   It creates the public GitHub repo `ViktorBarzin/starter`, the Forgejo push
   mirror to it (`sync_on_commit`), the `WOODPECKER_TOKEN`,
   `FORGEJO_GIT_TOKEN` and `SLACK_WEBHOOK` secrets, the Woodpecker
   registration and the `WOODPECKER_REPO_ID` repo variable that `build.yml`
   reads, and keeps this repo's `build.yml` and `.woodpecker/deploy.yml`.

7. **Renovate.** On Forgejo, add `renovate-bot` as a write collaborator and
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

8. **Push** to `master` on Forgejo. The mirror carries it to GitHub, Actions
   tests and builds `ghcr.io/viktorbarzin/starter`, and Woodpecker sets the
   image on the `migrate` init container and the app container.

9. **Telemetry** (on by default; skip to opt out, or set
   `telemetry.enabled: false` in `src/app.config.ts`). Follow the infra
   runbook `docs/runbooks/product-analytics.md`, "Add an Instrumented app":
   a write key in `secret/rybbit` `write_keys`, `starter` in
   `local.analytics_apps` of `stacks/rybbit/event_pipeline.tf`, and a
   GlitchTip project with its DSN in `secret/glitchtip` `dsn_starter`. Copy
   both into `secret/starter` as `telemetry_write_key` and `sentry_dsn`, and
   add to the `module "app"` block:

   ```hcl
   app_secret_env = {
     TELEMETRY_WRITE_KEY = "telemetry_write_key"
     SENTRY_DSN          = "sentry_dsn"
   }
   ```

   The other settings have defaults (AGENTS.md, "Telemetry and logs"). Until
   the write key is set the app sends nothing.

10. **Check it live**: `homelab deploy wait starter/starter`, then sign in at
    `https://starter.viktorbarzin.me`. As the seeded member and admin you see
    the list straight away; other people request access and you approve them
    at `/admin/requests`.
