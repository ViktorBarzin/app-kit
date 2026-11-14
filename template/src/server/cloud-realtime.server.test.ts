/**
 * The built server in cloud mode on a small database (connection limit 4,
 * `bun run build` first, TEST_DATABASE_URL): realtime is on, so the pod's
 * two connections are the LISTEN connection, opened at boot, and a pool of
 * one. Also: a connection limit that leaves no connection keeps /healthz
 * failing, so the pod never becomes ready. cloud.server.test.ts covers the
 * nano database and the identity checks.
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
const adminUrl = process.env.TEST_DATABASE_URL;
const ready = Boolean(adminUrl) && existsSync(ENTRY);

const SECRET = "cloud-edge-secret-0123456789abcdefghijklmnop";
const PUBLIC_URL = "https://starter.example";

let database: Awaited<ReturnType<typeof migratedTestDatabase>>;
let server: BuiltServer;
/** One connection of the test's own, for pg_stat_activity. */
let probe: SQL;

function cloudEnv(limit: string): Record<string, string> {
	return {
		DATABASE_URL: database.url,
		CLOUD_EDGE_SECRET: SECRET,
		CLOUD_OWNER_EMAIL: "owner@example.com",
		CLOUD_PUBLIC_URL: PUBLIC_URL,
		CLOUD_ACCESS: "private",
		CLOUD_DATABASE_CONNECTION_LIMIT: limit,
	};
}

beforeAll(async () => {
	if (!ready) return;
	database = await migratedTestDatabase({
		adminUrl: adminUrl as string,
		migrationsFolder: resolve(APP_DIR, "drizzle"),
		lockKey: app.migrationLockKey,
		prefix: "cloud_rt_test",
	});
	probe = new SQL({ url: database.url, max: 1 });
	server = await startBuiltServer({
		entry: ENTRY,
		cwd: APP_DIR,
		env: cloudEnv("4"),
	});
}, 60_000);

afterAll(async () => {
	if (!ready) return;
	await server?.stop();
	await probe?.close();
	await database?.drop();
});

const USER = {
	"x-cloud-user-id": "user-sub",
	"x-cloud-user-email": "user@example.com",
	"x-cloud-edge-secret": SECRET,
};

/** The app's connections: everything on the database but the probe. */
async function appConnections(): Promise<{ total: number; listen: number }> {
	const rows = (await probe`
		select query from pg_stat_activity
		where datname = current_database() and pid <> pg_backend_pid()`) as {
		query: string;
	}[];
	return {
		total: rows.length,
		listen: rows.filter((r) =>
			new RegExp(`^listen.*${app.realtimeChannel}`, "i").test(r.query),
		).length,
	};
}

describe.skipIf(!ready)("the built server in cloud mode, realtime on", () => {
	test("the LISTEN connection opens at boot", async () => {
		const deadline = Date.now() + 5_000;
		while ((await appConnections()).listen !== 1 && Date.now() < deadline)
			await Bun.sleep(100);
		expect((await appConnections()).listen).toBe(1);
	});

	test("/api/events streams to a user the edge identified", async () => {
		const controller = new AbortController();
		const res = await fetch(`${server.origin}/api/events`, {
			signal: controller.signal,
			headers: {
				...USER,
				accept: "text/event-stream",
				"sec-fetch-site": "same-origin",
			},
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		controller.abort();
	});

	test("the pod holds at most two connections under concurrent requests", async () => {
		const results = await Promise.all(
			Array.from({ length: 8 }, () =>
				fetch(`${server.origin}/api/items`, { headers: USER }),
			),
		);
		expect(results.map((r) => r.status)).toEqual(Array(8).fill(200));
		const connections = await appConnections();
		expect(connections.listen).toBe(1);
		expect(connections.total).toBeLessThanOrEqual(2);
	});

	test("a connection limit of 1 keeps /healthz failing", async () => {
		await expect(
			startBuiltServer({
				entry: ENTRY,
				cwd: APP_DIR,
				env: cloudEnv("1"),
				startTimeoutMs: 3_000,
			}),
		).rejects.toThrow("server did not start");
	}, 10_000);
});
