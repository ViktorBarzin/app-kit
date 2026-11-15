---
---

Template only, no package release (round 8 of Cloud's end-to-end test):
AGENTS.md says how to replace the `items` example without losing the
plumbing tests, runs the build before typecheck (a new route needs the
route tree `vite build` writes), and says access log lines cover only
`/api/*` routes. docs/stack.md says a private repo needs Cloud's reader
account `cloud-bot` as a Read collaborator, which `cloud new` adds.
