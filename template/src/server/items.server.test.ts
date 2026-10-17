/**
 * The items domain against a real Postgres (TEST_DATABASE_URL), migrated with
 * the app's own migrations.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { migratedTestDatabase } from "@viktorbarzin/pg/testing";
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";

import { app } from "#/app.config";
import * as schema from "./db/schema.server";
import { addItem, listItems } from "./items.server";

const adminUrl = process.env.TEST_DATABASE_URL;
let database: Awaited<ReturnType<typeof migratedTestDatabase>>;
let listen: SQL;
const seen: string[] = [];

beforeAll(async () => {
	if (!adminUrl) return;
	database = await migratedTestDatabase({
		adminUrl,
		migrationsFolder: resolve(import.meta.dir, "../../drizzle"),
		lockKey: app.migrationLockKey,
		prefix: "items_test",
	});
	listen = new SQL({ url: database.url, max: 1, idleTimeout: 0 });
	await listen.listen(app.realtimeChannel, (payload) => seen.push(payload));
});

afterAll(async () => {
	if (!adminUrl) return;
	await listen.close();
	await database.drop();
});

async function waitFor(pred: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!pred()) {
		if (Date.now() > deadline)
			throw new Error(`timed out; seen ${JSON.stringify(seen)}`);
		await Bun.sleep(20);
	}
}

describe.skipIf(!adminUrl)("items", () => {
	test("items are per owner, newest first", async () => {
		const db = drizzle({ client: database.client, schema });
		await addItem(db, "owner-a", "first", null);
		await Bun.sleep(5);
		await addItem(db, "owner-a", "second", null);
		await addItem(db, "owner-b", "theirs", null);
		expect((await listItems(db, "owner-a")).map((i) => i.title)).toEqual([
			"second",
			"first",
		]);
		expect((await listItems(db, "owner-b")).map((i) => i.title)).toEqual([
			"theirs",
		]);
	});

	test("addItem publishes an invalidate for the owner, only once the write commits", async () => {
		const db = drizzle({ client: database.client, schema });
		seen.length = 0;
		await db.transaction(async (outer) => {
			const item = await addItem(outer, "owner-c", "inside", "tab-1");
			expect(item.title).toBe("inside");
			await Bun.sleep(300);
			// Still inside the outer transaction: nothing has been delivered.
			expect(seen).toEqual([]);
		});
		await waitFor(() => seen.length > 0);
		expect(JSON.parse(seen[0] ?? "{}")).toEqual({
			to: "owner-c",
			event: { type: "invalidate", keys: [["items"]], source: "tab-1" },
		});
	});

	test("a rolled-back write publishes nothing", async () => {
		const db = drizzle({ client: database.client, schema });
		seen.length = 0;
		await expect(
			db.transaction(async (outer) => {
				await addItem(outer, "owner-d", "doomed", null);
				throw new Error("rollback");
			}),
		).rejects.toThrow("rollback");
		await addItem(db, "owner-d", "kept", null);
		await waitFor(() => seen.length > 0);
		await Bun.sleep(200);
		expect(seen.map((p) => JSON.parse(p).to)).toEqual(["owner-d"]);
		expect((await listItems(db, "owner-d")).map((i) => i.title)).toEqual([
			"kept",
		]);
	});
});
