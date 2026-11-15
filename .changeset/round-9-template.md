---
---

Template only, no package release (round 9 of Cloud's end-to-end test):
the README opens with an "On Cloud" paragraph (no infra steps there) and
the off-Cloud checklist moved into docs/new-app.md. AGENTS.md says to
generate the new table's migration before the drop (drizzle-kit's rename
prompt crashes without a terminal), how to share data across members
(publish to `null`, and wait for the list to load in the plumbing tests),
that server function names, inputs and return shapes follow the
expand-then-contract rule because open tabs keep the old client, and what
to do when the Playwright install hits `ENOSPC`. `export-template` removes
its temporary clone after a push or a failure (`--keep` keeps it), and a
realtime test shows an event published to `null` reaching another user's
stream.
