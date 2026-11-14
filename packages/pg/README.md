# @viktorbarzin/pg

Drizzle on Bun's built-in SQL client for an app on a shared Postgres:

- a pool of at most 4 by default (`APP_POOL_MAX`; with the realtime LISTEN
  connection, 5 per pod), or the size you pass, that reads the password from
  a mounted file on every new connection, so a rotated password does not
  break new connections;
- the per-pod connection budget for a role with a connection limit: half the
  limit (a rollout overlaps two pods), and realtime only when that leaves at
  least 2;
- migrations under a session `pg_advisory_lock` (drizzle's migrator takes
  none), a migrate CLI for an init container, and throwaway test databases.

<!-- typecheck-preamble
import { pgTable, text } from "drizzle-orm/pg-core";
const items = pgTable("items", { title: text("title") });
const schema = { items };
-->
```ts
import { createPool, migrationLockKey, pgSettingsFromEnv, runMigrateCli } from "@viktorbarzin/pg";

export const pool = createPool({ settings: () => pgSettingsFromEnv(), schema });
await pool.getDb().select().from(items);

// entrypoints/migrate.ts, bundled with `bun build --target bun`
process.exitCode = await runMigrateCli({ lockKey: migrationLockKey("myapp") });
```

On a platform that limits the role's connections
(`CLOUD_DATABASE_CONNECTION_LIMIT`), size the pool from the budget and keep
realtime off when it says so:

<!-- typecheck-preamble
import { pgTable, text } from "drizzle-orm/pg-core";
const items = pgTable("items", { title: text("title") });
const schema = { items };
-->
```ts
import { connectionBudgetFromEnv, createPool, pgSettingsFromEnv } from "@viktorbarzin/pg";

const budget = connectionBudgetFromEnv(); // limit 2: { perPod: 1, poolMax: 1, realtime: false }
export const pool = createPool({ settings: () => pgSettingsFromEnv(), schema, max: budget.poolMax });
export const realtimeOn = budget.realtime;
```

| Limit (Cloud Size) | Per pod | Pool | Realtime LISTEN |
|---|---|---|---|
| none | 5 | 4 | 1 |
| 2 (nano) | 1 | 1 | off |
| 4 (small) | 2 | 1 | 1 |
| 8 (medium) | 4 | 3 | 1 |

| Export | |
|---|---|
| `pgSettingsFromEnv(env?)` | `DATABASE_URL` (required) and `DATABASE_PASSWORD_FILE` |
| `createSqlClient(settings, { max?, idleTimeout? })` | a Bun `SQL` client; idle connections kept by default |
| `createPool({ settings, schema, key?, max? })` | lazy, once per process: `getDb()`, `getClient()`, `close()`; `max` (a number or a function, default `APP_POOL_MAX`) is read when the pool opens |
| `connectionBudget(limit)` | `{ perPod, poolMax, realtime }`: `floor(limit / 2)` per pod, realtime when that is at least 2; `null` gives the default 4 + 1; a limit under 2 throws |
| `connectionBudgetFromEnv(env?)` | the same for `CLOUD_DATABASE_CONNECTION_LIMIT` (unset: no limit; not a whole number: throws) |
| `migrationLockKey(appName)` | the first 8 bytes of sha256(`migrate:<app>`) as a signed int64 |
| `runMigrations(client, opts)` | `{ applied }`; the client must have `max: 1`; `beforeMigrate` runs under the lock |
| `runMigrateCli({ lockKey, beforeMigrate?, env? })` | reads `DATABASE_URL`, `DATABASE_PASSWORD_FILE`, `MIGRATIONS_DIR` (default `./drizzle`); returns the exit code |
| `@viktorbarzin/pg/testing`: `createTestDatabase`, `migratedTestDatabase` | a randomly named database on `adminUrl`, dropped by `drop()` |

Requires Bun >= 1.4.3. Peers: `drizzle-orm` ^0.45, `@viktorbarzin/log`, `@viktorbarzin/runtime`.
