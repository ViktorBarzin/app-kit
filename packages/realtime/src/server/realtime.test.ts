/** createRealtime end to end against a real Postgres (TEST_DATABASE_URL). */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { setLogLevel, setLogSink } from "@viktorbarzin/log";
import {
	createTestDatabase,
	type TestDatabase,
} from "@viktorbarzin/pg/testing";
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import client from "prom-client";

import { bodyReader, readUntil } from "../testdata/sse.js";
import {
	createRealtime,
	MAX_PAYLOAD_BYTES,
	poolNotify,
	type RealtimeEvent,
} from "./index.js";

const adminUrl = process.env.TEST_DATABASE_URL;
let database: TestDatabase;
let pool: SQL;

beforeAll(async () => {
	if (!adminUrl) return;
	database = await createTestDatabase({ adminUrl, prefix: "rtcore" });
	pool = new SQL({ url: database.url, max: 2 });
});

afterAll(async () => {
	if (!adminUrl) return;
	await pool.close();
	await database.drop();
});

function realtimeOn(channel: string) {
	return createRealtime<RealtimeEvent>(() => ({
		channel,
		createListenClient: () =>
			new SQL({ url: database.url, max: 1, idleTimeout: 0 }),
		notify: poolNotify(() => pool),
		registry: new client.Registry(),
	}));
}

function subscribe(rt: ReturnType<typeof realtimeOn>, topic: string) {
	const controller = new AbortController();
	const request = new Request("http://app.invalid/api/events", {
		signal: controller.signal,
	});
	const reader = bodyReader(rt.subscribe(request, topic));
	return { reader, abort: () => controller.abort() };
}

const invalidate = (source: string | null = null): RealtimeEvent => ({
	type: "invalidate",
	keys: [["items"]],
	source,
});

describe.skipIf(!adminUrl)("createRealtime", () => {
	test("publish reaches the topic's streams on every pod, through NOTIFY", async () => {
		const rt = realtimeOn("rt_events_a");
		await rt.start();
		const mine = subscribe(rt, "user-1");
		const other = subscribe(rt, "user-2");
		await readUntil(mine.reader, (t) => t.includes("connected"));
		await rt.publish("user-1", invalidate("tab-9"));
		await rt.publish(null, { type: "resync" });
		const text = await readUntil(
			mine.reader,
			(t) => t.includes("event: resync"),
			5_000,
		);
		expect(text).toContain(
			'data: {"type":"invalidate","keys":[["items"]],"source":"tab-9"}',
		);
		const otherText = await readUntil(
			other.reader,
			(t) => t.includes("event: resync"),
			5_000,
		);
		expect(otherText).not.toContain("invalidate");
		expect(rt.size()).toBe(2);
		mine.abort();
		other.abort();
		await rt.stop();
		expect(rt.size()).toBe(0);
	}, 15_000);

	test("publishInTx fires at COMMIT, and not at all on rollback", async () => {
		const rt = realtimeOn("rt_events_b");
		await rt.start();
		const sub = subscribe(rt, "user-1");
		await readUntil(sub.reader, (t) => t.includes("connected"));
		const db = drizzle({ client: pool });
		let streamed = "";
		const pump = (async () => {
			try {
				streamed += await readUntil(
					sub.reader,
					(t) => t.includes("committed"),
					8_000,
				);
			} catch {
				// timed out: checked below
			}
		})();
		await expect(
			db.transaction(async (tx) => {
				await rt.publishInTx(tx, "user-1", invalidate("rolled-back"));
				throw new Error("rollback");
			}),
		).rejects.toThrow("rollback");
		await db.transaction(async (tx) => {
			await rt.publishInTx(tx, "user-1", invalidate("committed"));
			await Bun.sleep(300);
			expect(streamed).not.toContain("committed");
		});
		await pump;
		expect(streamed).toContain('"source":"committed"');
		expect(streamed).not.toContain("rolled-back");
		sub.abort();
		await rt.stop();
	}, 15_000);

	test("an oversized event is logged and dropped; publish never throws", async () => {
		const lines: string[] = [];
		const restore = setLogSink((l) => lines.push(l));
		setLogLevel("DEBUG");
		try {
			const rt = realtimeOn("rt_events_c");
			const huge: RealtimeEvent = {
				type: "invalidate",
				keys: [["x".repeat(MAX_PAYLOAD_BYTES)]],
				source: null,
			};
			await rt.publish("u", huge);
			const failing = createRealtime(() => ({
				channel: "rt_events_c",
				createListenClient: () => new SQL({ url: database.url, max: 1 }),
				notify: async () => {
					throw new Error("database down");
				},
				registry: new client.Registry(),
			}));
			await failing.publish("u", invalidate());
		} finally {
			restore();
			setLogLevel("WARNING");
		}
		const messages = lines.map((l) => JSON.parse(l).msg);
		expect(messages).toContain("realtime event too large; dropped");
		expect(messages).toContain("realtime event not sent");
	});

	test("one LISTEN per process and channel, even from two createRealtime calls", async () => {
		const a = realtimeOn("rt_events_d");
		const b = realtimeOn("rt_events_d");
		await a.start();
		await b.start();
		const rows = await pool`
			select count(*)::int as n from pg_stat_activity
			where datname = current_database() and query ilike 'listen%rt_events_d%'`;
		expect((rows[0] as { n: number }).n).toBe(1);
		await a.stop();
	});

	test("subscribe starts the listener when nothing did", async () => {
		const rt = realtimeOn("rt_events_e");
		const sub = subscribe(rt, "user-1");
		await readUntil(sub.reader, (t) => t.includes("connected"));
		const deadline = Date.now() + 5_000;
		for (;;) {
			const rows = await pool`
				select 1 from pg_stat_activity
				where datname = current_database() and query ilike 'listen%rt_events_e%'`;
			if (rows.length > 0) break;
			if (Date.now() > deadline)
				throw new Error("subscribe did not start the LISTEN");
			await Bun.sleep(50);
		}
		await Bun.sleep(200);
		await rt.publish("user-1", invalidate());
		expect(
			await readUntil(sub.reader, (t) => t.includes("invalidate"), 5_000),
		).toContain("event: invalidate");
		sub.abort();
		await rt.stop();
	}, 10_000);
});
