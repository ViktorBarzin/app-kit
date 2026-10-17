# @viktorbarzin/pg

Drizzle on Bun's built-in SQL client for an app on a shared Postgres:

- a pool of at most 4 (`APP_POOL_MAX`; with the realtime LISTEN connection,
  5 per pod) that reads the password from a mounted file on every new
  connection, so a rotated password does not break new connections;
- migrations under a session `pg_advisory_lock` (drizzle's migrator takes
  none), a migrate CLI for an init container, and throwaway test databases.

```ts
import { createPool, migrationLockKey, pgSettingsFromEnv, runMigrateCli } from "@viktorbarzin/pg";

export const pool = createPool({ settings: () => pgSettingsFromEnv(), schema });
await pool.getDb().select().from(items);

// entrypoints/migrate.ts, bundled with `bun build --target bun`
process.exitCode = await runMigrateCli({ lockKey: migrationLockKey("myapp") });
```

| Export | |
|---|---|
| `pgSettingsFromEnv(env?)` | `DATABASE_URL` (required) and `DATABASE_PASSWORD_FILE` |
| `createSqlClient(settings, { max?, idleTimeout? })` | a Bun `SQL` client; idle connections kept by default |
| `createPool({ settings, schema, key? })` | lazy, once per process: `getDb()`, `getClient()`, `close()` |
| `migrationLockKey(appName)` | the first 8 bytes of sha256(`migrate:<app>`) as a signed int64 |
| `runMigrations(client, opts)` | `{ applied }`; the client must have `max: 1`; `beforeMigrate` runs under the lock |
| `runMigrateCli({ lockKey, beforeMigrate?, env? })` | reads `DATABASE_URL`, `DATABASE_PASSWORD_FILE`, `MIGRATIONS_DIR` (default `./drizzle`); returns the exit code |
| `@viktorbarzin/pg/testing`: `createTestDatabase`, `migratedTestDatabase` | a randomly named database on `adminUrl`, dropped by `drop()` |

Requires Bun >= 1.4.3. Peers: `drizzle-orm` ^0.45, `@viktorbarzin/log`, `@viktorbarzin/runtime`.
