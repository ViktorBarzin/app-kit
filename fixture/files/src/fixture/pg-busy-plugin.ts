/**
 * Nitro runtime plugin (the variant adds it to vite.config.ts): with
 * FIXTURE_PG_BUSY set, the App keeps every connection of its own pool busy
 * (pg-busy.ts) from boot until SIGTERM.
 */
import { definePlugin } from "nitro";

import { pool } from "#/server/db.server";
import { connectionBudget, databaseConfigured } from "#/server/env.server";

import { startPgBusy } from "./pg-busy";

/** Read through an alias, as env.server.ts does, so no bundler inlines a value. */
const runtimeEnv: Record<string, string | undefined> = process.env;

export default definePlugin(() => {
	if (!databaseConfigured()) return;
	const busy = startPgBusy({
		query: (sql) => pool.getClient().unsafe(sql),
		connections: connectionBudget().poolMax,
		env: runtimeEnv,
		log: (line) => console.log(line),
		role: "app",
	});
	if (busy) process.once("SIGTERM", () => busy.stop());
});
