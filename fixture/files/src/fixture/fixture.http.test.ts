/**
 * The fixture's routes on the built server (`bun run build` first): Nitro
 * matches them before TanStack Start, /healthz flips, /ws echoes, /crash
 * exits 42, and with TEST_DATABASE_URL /items writes and reads a row.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type BuiltServer, startBuiltServer } from "@viktorbarzin/auth/testing";
import { migratedTestDatabase } from "@viktorbarzin/pg/testing";
import { SQL } from "bun";

import { app } from "#/app.config";

const APP_DIR = resolve(import.meta.dir, "../..");
const ENTRY = resolve(APP_DIR, ".output/server/index.mjs");
const built = existsSync(ENTRY);
const adminUrl = process.env.TEST_DATABASE_URL;

let server: BuiltServer;
let database: Awaited<ReturnType<typeof migratedTestDatabase>> | null = null;

beforeAll(async () => {
	if (!built) return;
	if (adminUrl)
		database = await migratedTestDatabase({
			adminUrl,
			migrationsFolder: resolve(APP_DIR, "drizzle"),
			lockKey: app.migrationLockKey,
			prefix: "fixture_test",
		});
	server = await startBuiltServer({
		entry: ENTRY,
		cwd: APP_DIR,
		metricsPort: false,
		env: {
			SERVICE_VERSION: "v-test",
			FIXTURE_SECRET: "s3cret",
			FIXTURE_SINK: "on",
			FIXTURE_PG_BUSY: "1",
			...(database ? { DATABASE_URL: database.url } : {}),
		},
	});
}, 60_000);

afterAll(async () => {
	await server?.stop();
	await database?.drop();
}, 30_000);

describe.skipIf(!built)("the fixture on the built server", () => {
	test("/info is the fixture's, not a Start page, and carries no value", async () => {
		const response = await fetch(`${server.origin}/info`);
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).not.toContain("s3cret");
		const body = JSON.parse(text) as {
			serviceVersion: string;
			env: Record<string, string | null>;
		};
		// A platform variable shows its name only.
		expect(body.env.PORT).toBeNull();
		expect(body.serviceVersion).toBe("v-test");
		expect(body.env.FIXTURE_SECRET).toBe(
			new Bun.CryptoHasher("sha256").update("s3cret").digest("hex"),
		);
	});

	test("/unhealthy flips /healthz to 500, /healthy back", async () => {
		expect((await fetch(`${server.origin}/healthz`)).status).toBe(200);
		await fetch(`${server.origin}/unhealthy`);
		expect((await fetch(`${server.origin}/healthz`)).status).toBe(500);
		await fetch(`${server.origin}/healthy`);
		expect((await fetch(`${server.origin}/healthz`)).status).toBe(200);
	});

	test("/ws sends each text frame back", async () => {
		const ws = new WebSocket(`${server.origin.replace("http", "ws")}/ws`);
		const echoed = await new Promise<string>((done, fail) => {
			ws.onopen = () => ws.send("ping-1");
			ws.onmessage = (event) => done(String(event.data));
			ws.onerror = () => fail(new Error("websocket error"));
		});
		ws.close();
		expect(echoed).toBe("ping-1");
	});

	test("a route of a later batch answers 501", async () => {
		const response = await fetch(`${server.origin}/kv-selftest`);
		expect(response.status).toBe(501);
	});

	test.skipIf(!adminUrl)("/items writes a row and reads it back", async () => {
		const response = await fetch(`${server.origin}/items`);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			wrote: { id: string };
			read: { id: string };
			deleted: boolean;
		};
		expect(body.read.id).toBe(body.wrote.id);
		expect(body.deleted).toBe(true);
	});

	test.skipIf(!adminUrl)(
		"/enqueue queues a pg-boss job on queue fixture",
		async () => {
			const response = await fetch(`${server.origin}/enqueue`);
			expect(response.status).toBe(200);
			const { id } = (await response.json()) as { id: string };
			const sql = new SQL(database?.url ?? "");
			try {
				const rows = await sql.unsafe(
					"select name from pgboss.job where id = $1",
					[id],
				);
				expect(rows).toEqual([{ name: "fixture" }]);
			} finally {
				await sql.close();
			}
		},
	);

	test("a POST reaches the sink through Nitro and its inbox lists it", async () => {
		const name = "httpTestSink0123456789";
		const sent = await fetch(`${server.origin}/sink/${name}`, {
			method: "POST",
			headers: { "content-type": "application/json", "webhook-id": "msg_h" },
			body: '{"ok":true}',
		});
		expect(sent.status).toBe(200);
		const inbox = (await (
			await fetch(`${server.origin}/sink/${name}/inbox`)
		).json()) as { deliveries: { body: string }[] };
		expect(inbox.deliveries.map((d) => d.body)).toEqual(['{"ok":true}']);
	});

	test.skipIf(!adminUrl)(
		"FIXTURE_PG_BUSY keeps the pool's 4 connections in pg_sleep",
		async () => {
			const admin = new SQL(adminUrl ?? "");
			try {
				const name = new URL(database?.url ?? "").pathname.slice(1);
				let busy = 0;
				for (let i = 0; i < 20 && busy < 4; i++) {
					const [row] =
						await admin`select count(*)::int as n from pg_stat_activity
						where datname = ${name} and query like 'select pg_sleep%'`;
					busy = Number(row?.n ?? 0);
					if (busy < 4) await Bun.sleep(250);
				}
				expect(busy).toBe(4);
			} finally {
				await admin.close();
			}
		},
	);

	test.skipIf(!adminUrl)("/fill writes MiB a table holds", async () => {
		const response = await fetch(`${server.origin}/fill?mb=2`);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { tableMib: number };
		expect(body.tableMib).toBeGreaterThanOrEqual(2);
		const cleared = await fetch(`${server.origin}/fill?clear=1`);
		expect(await cleared.json()).toEqual({ cleared: true });
	});

	// Last: it ends the server.
	test("/crash exits with code 42", async () => {
		expect((await fetch(`${server.origin}/crash`)).status).toBe(202);
		expect(await server.exited).toBe(42);
	});
});
