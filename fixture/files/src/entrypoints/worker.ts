/**
 * Worker entrypoint, bundled to .output/entrypoints/worker.js and run as
 * `bun entrypoints/worker.js` by a worker Service. It logs its version and
 * a heartbeat each minute, and with DATABASE_URL works pg-boss queue
 * `fixture` (filled by /enqueue), one `job-done <id>` line per job. Its pool
 * has CLOUD_DATABASE_POOL_SIZE connections, 1 when unset.
 */
import { createSqlClient, pgSettingsFromEnv } from "@viktorbarzin/pg";

import { startWorkerBoss, workerPoolSize } from "#/fixture/boss";
import { startPgBusy } from "#/fixture/pg-busy";

const env: Record<string, string | undefined> = process.env;
const version = env.SERVICE_VERSION ?? "dev";
const log = (line: string) => console.log(line);

const poolSize = workerPoolSize(env.CLOUD_DATABASE_POOL_SIZE);
log(JSON.stringify({ msg: "worker-started", version, poolSize }));
setInterval(() => {
	log(JSON.stringify({ msg: "worker-heartbeat", version }));
}, 60_000);

const sql = env.DATABASE_URL?.trim()
	? createSqlClient(pgSettingsFromEnv(env), { max: poolSize })
	: null;
const boss = sql ? await startWorkerBoss(sql, version, log) : null;
if (!boss) log(JSON.stringify({ msg: "worker-no-database", version }));
// P49: with FIXTURE_PG_BUSY set, every connection of this same pool stays busy.
const busy = sql
	? startPgBusy({
			query: (text) => sql.unsafe(text),
			connections: poolSize,
			env,
			log,
			role: "worker",
		})
	: null;

let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const)
	process.on(signal, async () => {
		if (stopping) return;
		stopping = true;
		busy?.stop();
		try {
			await boss?.stop({ graceful: true, timeout: 10_000 });
			await sql?.close();
		} finally {
			log(JSON.stringify({ msg: "worker-stopped", version }));
			process.exit(0);
		}
	});
