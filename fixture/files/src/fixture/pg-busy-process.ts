/**
 * pg-busy.ts for a cron run (tick.js), which has no App pool: it opens one
 * pool of CLOUD_DATABASE_POOL_SIZE connections (boss.ts's rule, 2 when
 * unset), holds them for CRON_HOLD_MS and closes it. The worker runs
 * pg-busy on its own pg-boss pool instead (worker.ts). Nothing runs without
 * FIXTURE_PG_BUSY or DATABASE_URL.
 */
import { createSqlClient } from "@viktorbarzin/pg";

import { databaseConfigured, pgSettings } from "#/server/env.server";

import { workerPoolSize } from "./boss";
import { pgBusySeconds, startPgBusy } from "./pg-busy";

/** Read through an alias, as env.server.ts does, so no bundler inlines a value. */
const runtimeEnv: Record<string, string | undefined> = process.env;

/** How long a cron run holds its connections before it goes on. */
export const CRON_HOLD_MS = 60_000;

/** A cron run: holds its connections for CRON_HOLD_MS, then returns. */
export async function holdDuringCronRun(): Promise<void> {
	if (pgBusySeconds(runtimeEnv) === null || !databaseConfigured()) return;
	const connections = workerPoolSize(runtimeEnv.CLOUD_DATABASE_POOL_SIZE);
	const client = createSqlClient(pgSettings(), { max: connections });
	try {
		await startPgBusy({
			query: (sql) => client.unsafe(sql),
			connections,
			env: runtimeEnv,
			log: (line) => console.log(line),
			role: "cron",
			forMs: CRON_HOLD_MS,
		})?.done;
	} finally {
		await client.close();
	}
}
