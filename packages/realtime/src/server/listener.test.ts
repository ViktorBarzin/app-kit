/** The LISTEN connection against a real Postgres (TEST_DATABASE_URL). */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	createTestDatabase,
	type TestDatabase,
} from "@viktorbarzin/pg/testing";
import { SQL } from "bun";
import client from "prom-client";

import {
	createListener,
	type RealtimeEvent,
	type RealtimeMessage,
} from "./index.js";

const adminUrl = process.env.TEST_DATABASE_URL;
let database: TestDatabase;
let admin: SQL;

beforeAll(async () => {
	if (!adminUrl) return;
	database = await createTestDatabase({ adminUrl, prefix: "rtlisten" });
	admin = new SQL({ url: database.url, max: 2 });
});

afterAll(async () => {
	if (!adminUrl) return;
	await admin.close();
	await database.drop();
});

async function gauge(registry: client.Registry, name: string): Promise<number> {
	const metric = await registry.getSingleMetric(name)?.get();
	return metric?.values[0]?.value ?? Number.NaN;
}

function collector<
	E extends { type: string } = RealtimeEvent | { type: "poke"; n: number },
>() {
	const seen: RealtimeMessage<E>[] = [];
	const waitFor = async (
		pred: (m: RealtimeMessage<E>) => boolean,
		timeoutMs = 10_000,
	) => {
		const deadline = Date.now() + timeoutMs;
		while (!seen.some(pred)) {
			if (Date.now() > deadline)
				throw new Error(`not seen; got ${JSON.stringify(seen)}`);
			await Bun.sleep(20);
		}
	};
	return { seen, waitFor };
}

async function listenPid(channel: string): Promise<number> {
	const deadline = Date.now() + 10_000;
	for (;;) {
		const rows = await admin`
			select pid from pg_stat_activity
			where datname = current_database() and query ilike ${`listen%${channel}%`}`;
		if (rows.length > 0) return (rows[0] as { pid: number }).pid;
		if (Date.now() > deadline) throw new Error("no LISTEN backend");
		await Bun.sleep(50);
	}
}

const listenClient =
	(extra: Record<string, unknown> = {}) =>
	() =>
		new SQL({ url: database.url, max: 1, idleTimeout: 0, ...extra });

describe.skipIf(!adminUrl)("realtime listener", () => {
	test("relays valid notifications only, and keeps the gauges", async () => {
		const registry = new client.Registry();
		const channel = "app_events_t1";
		const listener = createListener(channel, {
			createClient: listenClient(),
			notify: (c, p) => admin.notify(c, p),
			registry,
		});
		const { seen, waitFor } = collector();
		listener.onMessage((m) => seen.push(m));
		await listener.start();
		expect(await gauge(registry, "realtime_listen_connected")).toBe(1);

		await admin.notify(channel, "garbage");
		await admin.notify(
			channel,
			JSON.stringify({ to: "u", event: { type: "drop_tables" } }),
		);
		await admin.notify(
			channel,
			JSON.stringify({
				to: "u",
				event: { type: "invalidate", keys: [["items"]], source: null },
			}),
		);
		await waitFor((m) => m.event.type === "invalidate");
		expect(seen).toEqual([
			{
				to: "u",
				event: { type: "invalidate", keys: [["items"]], source: null },
			},
		]);
		expect(
			await gauge(registry, "realtime_last_notify_age_seconds"),
		).toBeLessThan(5);
		await listener.stop();
		expect(await gauge(registry, "realtime_listen_connected")).toBe(0);
	});

	test("a custom parser decides which events pass", async () => {
		const channel = "app_events_t1b";
		const listener = createListener<{ type: "poke"; n: number }>(channel, {
			createClient: listenClient(),
			notify: (c, p) => admin.notify(c, p),
			registry: new client.Registry(),
			parseEvent: (raw) => {
				const e = raw as { type?: unknown; n?: unknown };
				return e?.type === "poke" && typeof e.n === "number"
					? { type: "poke", n: e.n }
					: null;
			},
		});
		const { seen, waitFor } = collector();
		listener.onMessage((m) => seen.push(m));
		await listener.start();
		await admin.notify(
			channel,
			JSON.stringify({
				to: null,
				event: { type: "invalidate", keys: [["x"]], source: null },
			}),
		);
		await admin.notify(
			channel,
			JSON.stringify({ to: "u", event: { type: "poke", n: 2 } }),
		);
		await waitFor((m) => m.event.type === "poke");
		expect(seen).toEqual([{ to: "u", event: { type: "poke", n: 2 } }]);
		await listener.stop();
	});

	test("uses one LISTEN connection", async () => {
		const listener = createListener("app_events_t2", {
			createClient: listenClient({
				connection: { application_name: "listener-t2" },
			}),
			notify: (c, p) => admin.notify(c, p),
			registry: new client.Registry(),
		});
		await listener.start();
		await listener.start();
		const rows =
			await admin`select count(*)::int as n from pg_stat_activity where application_name = 'listener-t2'`;
		expect((rows[0] as { n: number }).n).toBe(1);
		await listener.stop();
	});

	test("a dropped connection is re-established and subscribers are told to resync", async () => {
		const channel = "app_events_t3";
		const listener = createListener(channel, {
			createClient: listenClient(),
			notify: (c, p) => admin.notify(c, p),
			registry: new client.Registry(),
		});
		const { seen, waitFor } = collector();
		listener.onMessage((m) => seen.push(m));
		await listener.start();
		await admin`select pg_terminate_backend(${await listenPid(channel)})`;
		await waitFor((m) => m.event.type === "resync" && m.to === null);
		await admin.notify(
			channel,
			JSON.stringify({ to: "a", event: { type: "resync" } }),
		);
		await waitFor((m) => m.to === "a");
		await listener.stop();
	}, 20_000);

	test("a heartbeat that does not come back forces a reconnect and a resync", async () => {
		const channel = "app_events_t4";
		let clients = 0;
		const listener = createListener(channel, {
			createClient: () => {
				clients += 1;
				return new SQL({ url: database.url, max: 1, idleTimeout: 0 });
			},
			// The ping goes to a channel nobody listens on, as with a half-open socket.
			notify: (_c, p) => admin.notify(`${channel}_void`, p),
			registry: new client.Registry(),
			pingIntervalMs: 100,
			pingTimeoutMs: 100,
			backoffMs: () => 50,
		});
		const seen: string[] = [];
		listener.onMessage((m) => seen.push(m.event.type));
		await listener.start();
		const deadline = Date.now() + 5_000;
		while (!seen.includes("resync") && Date.now() < deadline)
			await Bun.sleep(20);
		expect(seen).toContain("resync");
		expect(clients).toBeGreaterThanOrEqual(2);
		await listener.stop();
	}, 20_000);

	test("a heartbeat that comes back keeps the connection", async () => {
		let clients = 0;
		const listener = createListener("app_events_t5", {
			createClient: () => {
				clients += 1;
				return new SQL({ url: database.url, max: 1, idleTimeout: 0 });
			},
			notify: (c, p) => admin.notify(c, p),
			registry: new client.Registry(),
			pingIntervalMs: 50,
			pingTimeoutMs: 1_000,
		});
		const seen: unknown[] = [];
		listener.onMessage((m) => seen.push(m));
		await listener.start();
		await Bun.sleep(600);
		expect(clients).toBe(1);
		expect(seen).toEqual([]);
		await listener.stop();
	});

	test("start retries until Postgres is reachable", async () => {
		let attempts = 0;
		const listener = createListener("app_events_t6", {
			createClient: () => {
				attempts += 1;
				return attempts < 3
					? new SQL({
							url: "postgres://nobody:x@127.0.0.1:1/none",
							max: 1,
							connectionTimeout: 1,
						})
					: new SQL({ url: database.url, max: 1, idleTimeout: 0 });
			},
			notify: (c, p) => admin.notify(c, p),
			registry: new client.Registry(),
			backoffMs: () => 20,
		});
		await listener.start();
		expect(attempts).toBe(3);
		await listener.stop();
	}, 20_000);
});
