import { describe, expect, test } from "bun:test";

import {
	PG_BUSY_PAUSE_MS,
	PG_BUSY_RETRY_MS,
	pgBusySeconds,
	startPgBusy,
} from "./pg-busy";

describe("pgBusySeconds", () => {
	test("1 to 60 whole seconds; anything else is off", () => {
		expect(pgBusySeconds({ FIXTURE_PG_BUSY: "2" })).toBe(2);
		expect(pgBusySeconds({ FIXTURE_PG_BUSY: " 60 " })).toBe(60);
		expect(pgBusySeconds({})).toBeNull();
		expect(pgBusySeconds({ FIXTURE_PG_BUSY: "0" })).toBeNull();
		expect(pgBusySeconds({ FIXTURE_PG_BUSY: "61" })).toBeNull();
		expect(pgBusySeconds({ FIXTURE_PG_BUSY: "on" })).toBeNull();
	});
});

describe("startPgBusy", () => {
	test("unset, it runs nothing", () => {
		let queries = 0;
		const busy = startPgBusy({
			query: async () => {
				queries += 1;
			},
			connections: 3,
			env: {},
			log: () => {},
			role: "app",
		});
		expect(busy).toBeNull();
		expect(queries).toBe(0);
	});

	test("one loop per connection, each sleeping in Postgres, until the time is up", async () => {
		let clock = 0;
		let inFlight = 0;
		let most = 0;
		const sql: string[] = [];
		const logged: string[] = [];
		const paused: number[] = [];
		const busy = startPgBusy({
			query: async (text) => {
				sql.push(text);
				inFlight += 1;
				most = Math.max(most, inFlight);
				await Promise.resolve();
				clock += 1000;
				inFlight -= 1;
			},
			connections: 3,
			env: { FIXTURE_PG_BUSY: "2" },
			log: (l) => logged.push(l),
			role: "cron",
			forMs: 9_000,
			now: () => clock,
			sleep: async (ms) => {
				paused.push(ms);
			},
		});
		await busy?.done;
		expect(new Set(paused)).toEqual(new Set([PG_BUSY_PAUSE_MS]));
		expect(most).toBe(3);
		expect(new Set(sql)).toEqual(new Set(["select pg_sleep(2)"]));
		expect(JSON.parse(logged[0] ?? "{}")).toMatchObject({
			msg: "pg-busy-started",
			role: "cron",
			connections: 3,
			seconds: 2,
		});
		expect(logged.at(-1)).toContain("pg-busy-stopped");
	});

	test("a failed query logs Postgres's message and waits before it tries again", async () => {
		let clock = 0;
		const waits: number[] = [];
		const logged: string[] = [];
		const busy = startPgBusy({
			query: async () => {
				throw new Error('too many connections for role "p_x"');
			},
			connections: 1,
			env: { FIXTURE_PG_BUSY: "1" },
			log: (l) => logged.push(l),
			role: "worker",
			forMs: 10_000,
			now: () => clock,
			sleep: async (ms) => {
				waits.push(ms);
				clock += ms;
			},
		});
		await busy?.done;
		expect(waits).toEqual([PG_BUSY_RETRY_MS, PG_BUSY_RETRY_MS]);
		expect(
			logged.filter((l) => l.includes("too many connections")),
		).toHaveLength(2);
	});

	test("stop() ends the loops after their current query", async () => {
		let stopIt = () => {};
		const busy = startPgBusy({
			query: async () => {
				stopIt();
			},
			connections: 2,
			env: { FIXTURE_PG_BUSY: "1" },
			log: () => {},
			role: "app",
		});
		stopIt = () => busy?.stop();
		await busy?.done;
		expect(busy).not.toBeNull();
	});
});
