# Starting a new app

The ordered steps after "Use this template" and `bun run rename <slug> "<Display Name>"`.
Below, `starter` is the app's slug and `Starter` its display name (`bun run
rename` sets both). Database names use underscores where the slug has dashes
(`my-app` becomes `my_app`), and the rename writes them that way.

1. **Vault.** Seed `secret/starter` with:
   - `better_auth_secret`: 32+ random bytes, e.g. `openssl rand -base64 48`
   - `oidc_client_id`: `starter`
   - `oidc_client_secret`: 64+ random characters

2. **Database.** In infra, add one entry to each map:
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

3. **Stack.** Create `infra/stacks/starter/` with `terragrunt.hcl` and
   `authentik.tf` copied from `stacks/tasks` (the `authentik` provider block
   with the token from `secret/authentik` `tf_api_token`, and the
   `data "authentik_user" "viktor"` lookup), and a `main.tf`:

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

     # The owner is a member and the admin who approves everyone else.
     initial_user_pks = [data.authentik_user.viktor.id]
     admin_user_pks   = [data.authentik_user.viktor.id]
   }
   ```

   Its `terragrunt.hcl` depends on `platform`, `vault` and `external-secrets`.
   The stack can be applied before the first image exists; the pod waits in
   `ImagePullBackOff` until step 5.

4. **Off-infra CI.** From the infra checkout:

   ```sh
   scripts/offinfra-onboard starter --clone <path-to-clone> --visibility public \
     --namespace starter --deploy "starter=migrate,starter" --keep-workflows
   ```

   It creates the GitHub mirror, sets the `WOODPECKER_TOKEN`,
   `FORGEJO_GIT_TOKEN` and `SLACK_WEBHOOK` secrets, registers the Woodpecker
   repo and sets the `WOODPECKER_REPO_ID` variable that `build.yml` reads,
   without replacing this repo's workflows.

5. **Push** to `master`. The build pushes `ghcr.io/viktorbarzin/starter`, and
   the deploy sets the image on both the `migrate` init container and the app
   container.

6. **Check it live**: `homelab deploy wait starter/starter`, then sign in at
   `https://starter.viktorbarzin.me`. As the seeded member and admin you see
   the list straight away; other people request access and you approve them
   at `/admin/requests`.
