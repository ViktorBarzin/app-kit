/**
 * Migrate entrypoint, bundled with `bun build --target bun` into
 * .output/entrypoints/migrate.js and run as the Deployment's init container:
 *
 *   bun .output/entrypoints/migrate.js
 *
 * Env: DATABASE_URL, DATABASE_PASSWORD_FILE, MIGRATIONS_DIR (default ./drizzle).
 */
import { runMigrateCli } from "@viktorbarzin/pg";

import { app } from "#/app.config";

process.exitCode = await runMigrateCli({ lockKey: app.migrationLockKey });
