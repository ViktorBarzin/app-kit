/**
 * pg-busy.ts for the processes that have no App pool: a cron run (tick.js)
 * and the worker (worker.js). Each opens its own pool with the size the
 * connection budget gives one process. Nothing runs without
 * FIXTURE_PG_BUSY or DATABASE_URL.
 */
import { createSqlClient } from "@viktorbarzin/pg";

import {
	connectionBudget,
	databaseConfigured,
	pgSettings,
} from "#/server/env.server";

import { type PgBusy, pgBusySeconds, startPgBusy } from "./pg-busy";

/** Read through an alias, as env.server.ts does, so no bundler inlines a value. */
const runtimeEnv: Record<string, string | undefined> = process.env;

/** How long a cron run holds its connections before it goes on. */
export const CRON_HOLD_MS = 60_000;

function start(role: string, forMs?: number): PgBusy | null {
	if (pgBusySeconds(runtimeEnv) === null || !databaseConfigured()) return null;
	const connections = connectionBudget().poolMax;
	const client = createSqlClient(pgSettings(), { max: connections });
	const busy = startPgBusy({
		query: (sql) => client.unsafe(sql),
		connections,
		env: runtimeEnv,
		log: (line) => console.log(line),
		role,
		...(forMs === undefined ? {} : { forMs }),
	});
	void busy?.done.finally(() => client.close());
	return busy;
}

/** A cron run: holds its connections for CRON_HOLD_MS, then returns. */
export async function holdDuringCronRun(): Promise<void> {
	await start("cron", CRON_HOLD_MS)?.done;
}

/** The worker: holds its connections until the process stops. */
export function holdInWorker(): PgBusy | null {
	return start("worker");
}
