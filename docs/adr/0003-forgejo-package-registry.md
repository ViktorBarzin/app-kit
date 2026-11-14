---
status: accepted
date: 2026-11-12
---

# ADR-0003: Apps install @viktorbarzin packages from Forgejo; npm is a mirror

Supersedes, in [ADR-0001](0001-default-app-stack.md), Delivery, Shared
code, the registry the packages are published to and the clause "Builds
therefore work with the homelab down". The review panel's rejection of
Forgejo npm (2026-10-16) is reversed here. The rest of that row stands:
public source, a gitleaks scan before each release, no hostnames, client IDs
or secrets in the packages, and `@viktorbarzin` as the only scope.

## Context

ADR-0001 put the packages on public npm and published them from GitHub
Actions through trusted publishing. Forgejo's npm registry was rejected
because it ties the GitHub Actions builds of every app to the homelab being
reachable.

In November 2026 the npm path stalled:

- `@viktorbarzin/telemetry` has never been on npm. npm adds a trusted
  publisher only to a package that already exists, so its first version needs
  Viktor's security key.
- The 1.0.0 release of the other seven packages failed with E404 in the
  publish job.
- On 2026-11-09 an agent signed in to npm with a 2FA recovery code, and npm
  locked the account for 72 hours. On 2026-11-12 the account was still
  restricted.

Meanwhile tasks, alexa-assistant and the server side of three other apps
were waiting for `@viktorbarzin/telemetry` and `@viktorbarzin/log` 1.0.

## Decision

1. **Forgejo's npm registry is the one the apps install from.** It is at
   `https://forgejo.viktorbarzin.me/api/packages/viktor/npm/`, and the
   packages are readable without a token because the `viktor` account is
   public. Apps map the scope in `bunfig.toml`:

   ```toml
   [install.scopes]
   "@viktorbarzin" = "https://forgejo.viktorbarzin.me/api/packages/viktor/npm/"
   ```

   `bun.lock` records the Forgejo tarball URLs.
2. **npm is a public mirror.** `release.yml` packs every version that is
   missing from either registry. `publish-forgejo` publishes to Forgejo with
   the `FORGEJO_PACKAGE_TOKEN` secret and tags the release. `publish-npm`
   publishes the same tarballs to npm through trusted publishing, with
   provenance, while `NPM_PUBLISH_ENABLED` is `true`. A failure on npm leaves
   the apps unaffected.
3. **Forgejo copies have no provenance statement.** Forgejo's registry does
   not take one. The npm copies keep theirs.
4. **Apps stay on Forgejo when the npm mirror works again.** Moving them back
   would change each app's `bunfig.toml` and `bun.lock` a second time for no
   gain.

## Consequences

- An app's build on GitHub Actions now needs `forgejo.viktorbarzin.me` to be
  reachable during `bun install`. Its deploy already did, so a homelab
  outage now also stops builds.
- Publishing no longer needs Viktor's security key. Only the npm mirror
  does: the first npm publish of a new package, and npm trust and settings
  changes.
- The first Forgejo versions were published by hand on 2026-11-12, from
  app-kit master `107816e`: log, runtime, metrics, oidc-token, auth, pg and
  realtime at 1.0.0, and telemetry at 0.2.0.
- npm still serves 0.1.0 of the seven older packages until the mirror job
  runs.
- On 2026-11-13 Viktor created a granular npm token (2FA bypass, write on
  all packages, expires 2027-02-11). It is the `NPM_TOKEN` secret of the
  `npm-publish` environment. `publish-npm` uses it when the
  trusted-publishing exchange fails and for the first npm version of a new
  package, so the mirror no longer needs Viktor's security key until the
  token expires.
- The first run with the token, on 2026-11-13, published oidc-token, auth
  and realtime 1.0.0 and telemetry 0.2.1 to npm, with provenance. log,
  runtime, metrics and pg returned E403: their npm publishing access is set
  to require 2FA and disallow tokens. That setting changes only on
  npmjs.com, with Viktor's security key.
- On 2026-11-14 Viktor changed the publishing access of those four on
  npmjs.com, and the next run published log, runtime, metrics and pg 1.0.0.
  npm answered each upload with 202 and served the version about a minute
  later. Every Forgejo version is now on npm, each with a provenance
  statement.

## Open questions

- Trusted publishing does not work yet. With `NPM_CONFIG_LOGLEVEL=verbose`
  the publish job shows npm's exchange answering
  `OIDC token exchange error - package not found` for every package. npm
  gives that answer when no trusted publisher on the package matches the
  job (repository `ViktorBarzin/app-kit`, workflow `release.yml`,
  environment `npm-publish`). So the publishers ADR-0001 describes either
  were never saved or name something else. The token does every npm publish
  until they are re-added, which needs Viktor's security key (`npm trust
  list`, then `npm trust github ... --allow-publish`). The token expires on
  2027-02-11.
