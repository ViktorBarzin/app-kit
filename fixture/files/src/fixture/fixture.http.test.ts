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
			...(database ? { DATABASE_URL: database.url } : {}),
		},
	});
}, 60_000);

afterAll(async () => {
	await server?.stop();
	await database?.drop();
});

describe.skipIf(!built)("the fixture on the built server", () => {
	test("/info is the fixture's, not a Start page, and carries no value", async () => {
		const response = await fetch(`${server.origin}/info`);
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).not.toContain("s3cret");
		const body = JSON.parse(text) as {
			serviceVersion: string;
			env: Record<string, string>;
		};
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
		};
		expect(body.read.id).toBe(body.wrote.id);
	});

	// Last: it ends the server.
	test("/crash exits with code 42", async () => {
		expect((await fetch(`${server.origin}/crash`)).status).toBe(202);
		expect(await server.exited).toBe(42);
	});
});
