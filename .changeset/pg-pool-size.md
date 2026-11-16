---
"@viktorbarzin/pg": minor
"@viktorbarzin/auth": patch
---

`connectionBudgetFromEnv()` reads `CLOUD_DATABASE_POOL_SIZE` first: Cloud's
count of the pool each pod may open (a whole number of at least 1), with the
realtime LISTEN connection on top. Without it the budget comes from
`CLOUD_DATABASE_CONNECTION_LIMIT` as before, and with neither it is the
default pool of 4 plus one LISTEN.

`@viktorbarzin/auth/testing` scrubs `CLOUD_DATABASE_POOL_SIZE` from the
shell's env before it starts a built server.
