# Changesets

Used locally only: `bun run changeset` records a change, `bunx changeset version`
bumps versions and CHANGELOG.md files. Commit the result to master on Forgejo;
release.yml publishes every package whose version is not on npm yet. There are
no GitHub version PRs, because the GitHub repo is a one-way mirror.
