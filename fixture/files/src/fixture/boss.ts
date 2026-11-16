/**
 * pg-boss for /enqueue (the App) and entrypoints/worker.ts (a worker
 * Service), both on Bun SQL through pg-boss's fromBunSql adapter.
 *
 * - The App queues jobs on the template's own pool (db.server.ts), so it
 *   opens no second pool and stays inside its connection budget. Its
 *   pg-boss only sends: no maintenance, no schedules.
 * - The worker opens its own pool of CLOUD_DATABASE_POOL_SIZE connections
 *   (1 when unset, as Cloud sets it for a worker), works queue `fixture` and logs `job-done <id>` per job.
 * - Each side creates the queue; createQueue leaves an existing queue as it is.
 */
import { processSingleton } from "@viktorbarzin/runtime";
import type { SQL } from "bun";
import { fromBunSql, PgBoss } from "pg-boss";

/** The queue /enqueue sends to and the worker works. */
export const FIXTURE_QUEUE = "fixture";

/** The worker's pool when CLOUD_DATABASE_POOL_SIZE is unset. */
export const WORKER_POOL_DEFAULT = 1;

/**
 * CLOUD_DATABASE_POOL_SIZE: how many Postgres connections this process may
 * open. Unset or empty gives the default. Any other value that is not a
 * whole number >= 1 throws, so a wrong platform value stops the worker
 * at start instead of opening more connections than its share.
 */
export function workerPoolSize(raw: string | undefined): number {
	const value = (raw ?? "").trim();
	if (value === "") return WORKER_POOL_DEFAULT;
	if (!/^[0-9]+$/.test(value) || Number(value) < 1)
		throw new Error(
			`CLOUD_DATABASE_POOL_SIZE must be a whole number >= 1 (got "${value}")`,
		);
	return Number(value);
}

/** The worker's handler: one `job-done <id>` line per job. */
export function jobHandler(
	version: string,
	log: (line: string) => void,
): (jobs: readonly { id: string }[]) => Promise<void> {
	return async (jobs) => {
		for (const job of jobs)
			log(JSON.stringify({ msg: `job-done ${job.id}`, id: job.id, version }));
	};
}

function errorLine(err: unknown): string {
	return JSON.stringify({
		msg: "pg-boss-error",
		error: err instanceof Error ? err.message : String(err),
	});
}

/**
 * Starts pg-boss on the worker's pool, creates the queue and works it.
 * The caller stops it with `stop()` and then closes `sql`.
 */
export async function startWorkerBoss(
	sql: SQL,
	version: string,
	log: (line: string) => void,
): Promise<PgBoss> {
	const boss = new PgBoss({ db: fromBunSql(sql) });
	boss.on("error", (err) => log(errorLine(err)));
	await boss.start();
	await boss.createQueue(FIXTURE_QUEUE);
	await boss.work<object>(FIXTURE_QUEUE, jobHandler(version, log));
	return boss;
}

/**
 * The App's pg-boss, once per process: Nitro bundles the server twice, and
 * each copy of this module must reach the same one.
 */
const appBoss = processSingleton("app-template-fixture:boss", () => ({
	started: null as Promise<PgBoss> | null,
}));

async function startAppBoss(sql: SQL): Promise<PgBoss> {
	const boss = new PgBoss({
		db: fromBunSql(sql),
		supervise: false,
		schedule: false,
	});
	boss.on("error", (err) => console.error(errorLine(err)));
	await boss.start();
	await boss.createQueue(FIXTURE_QUEUE);
	return boss;
}

/**
 * Queues one job on queue `fixture` with no data and returns its id, a
 * fresh UUID. `client` is the App's pool; it is called on the first job only.
 */
export async function enqueueFixtureJob(client: () => SQL): Promise<string> {
	appBoss.started ??= startAppBoss(client()).catch((err: unknown) => {
		appBoss.started = null;
		throw err;
	});
	const boss = await appBoss.started;
	const id = await boss.send(FIXTURE_QUEUE, {});
	if (id === null) throw new Error(`pg-boss queued no job on ${FIXTURE_QUEUE}`);
	return id;
}

/** Stops the App's pg-boss, for tests; the pool stays open. */
export async function stopFixtureBoss(): Promise<void> {
	const started = appBoss.started;
	appBoss.started = null;
	if (started) await (await started).stop({ close: false, graceful: false });
}
