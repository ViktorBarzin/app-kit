/**
 * Keeps a process's Postgres connections busy, for Cloud's connection test
 * (P49): with FIXTURE_PG_BUSY=<seconds> set, each of the process's pool
 * connections runs `select pg_sleep(<seconds>)` again and again, so the
 * App, its worker and its cron each hold every connection Cloud gives them,
 * with a short pause between queries so their own work still runs.
 * A query that fails is logged with Postgres's own message (so `too many
 * connections` shows in `cloud logs --grep`), and that loop waits 5 s.
 * Unset, nothing runs.
 */

/** The longest pg_sleep FIXTURE_PG_BUSY may ask for, in seconds. */
export const PG_BUSY_MAX_S = 60;

/** How long a loop waits after a failed query. */
export const PG_BUSY_RETRY_MS = 5_000;

/**
 * How long a loop waits between two queries. The pool keeps the connection
 * open meanwhile, so Postgres still counts it; the pause lets the process's
 * own queries (/items, /enqueue, pg-boss) take a turn on the pool.
 */
export const PG_BUSY_PAUSE_MS = 200;

/** The seconds each busy query sleeps, or null when FIXTURE_PG_BUSY is unset or not 1-60. */
export function pgBusySeconds(
	env: Record<string, string | undefined>,
): number | null {
	const raw = env.FIXTURE_PG_BUSY?.trim() ?? "";
	if (!/^\d+$/.test(raw)) return null;
	const seconds = Number(raw);
	return seconds >= 1 && seconds <= PG_BUSY_MAX_S ? seconds : null;
}

export interface PgBusyOptions {
	/** Runs one SQL text on the process's own pool. */
	query: (sql: string) => Promise<unknown>;
	/** The pool's size: one loop per connection. */
	connections: number;
	env: Record<string, string | undefined>;
	/** Writes one line to the process's log. */
	log: (line: string) => void;
	/** Who holds them, in the log lines: app, worker or cron. */
	role: string;
	/** Stop after this long (a cron run); forever when unset. */
	forMs?: number;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}

export interface PgBusy {
	/** The loops stop after their current query. */
	stop(): void;
	/** Settles when every loop has stopped. */
	done: Promise<void>;
}

const messageOf = (err: unknown) =>
	err instanceof Error ? err.message : String(err);

/** Starts the loops; null (and nothing runs) when FIXTURE_PG_BUSY is unset. */
export function startPgBusy(options: PgBusyOptions): PgBusy | null {
	const seconds = pgBusySeconds(options.env);
	if (seconds === null) return null;
	const sleep =
		options.sleep ??
		((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const now = options.now ?? (() => Date.now());
	const until =
		options.forMs === undefined
			? Number.POSITIVE_INFINITY
			: now() + options.forMs;
	const connections = Math.max(1, Math.floor(options.connections));
	let stopped = false;
	const line = (msg: string, extra: Record<string, unknown> = {}) =>
		options.log(
			JSON.stringify({
				msg,
				role: options.role,
				connections,
				seconds,
				...extra,
			}),
		);
	line("pg-busy-started");
	const loop = async (n: number) => {
		while (!stopped && now() < until) {
			try {
				await options.query(`select pg_sleep(${seconds})`);
				await sleep(PG_BUSY_PAUSE_MS);
			} catch (err) {
				line("pg-busy-error", { connection: n, error: messageOf(err) });
				await sleep(PG_BUSY_RETRY_MS);
			}
		}
	};
	const done = Promise.all(
		Array.from({ length: connections }, (_, i) => loop(i + 1)),
	).then(() => line("pg-busy-stopped"));
	return {
		stop() {
			stopped = true;
		},
		done,
	};
}
