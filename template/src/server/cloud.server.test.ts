/**
 * The built server in cloud mode (`bun run build` first) with a real Postgres
 * (TEST_DATABASE_URL), on a nano database (connection limit 2): identity
 * from the edge's headers only with the edge secret, sign-in through the
 * edge's links, no access-request pages, realtime off and a pool of one.
 * e2e/cloud.spec.ts drives the same mode in a browser through a fake edge.
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

beforeAll(async () => {
	if (!ready) return;
	database = await migratedTestDatabase({
		adminUrl: adminUrl as string,
		migrationsFolder: resolve(APP_DIR, "drizzle"),
		lockKey: app.migrationLockKey,
		prefix: "cloud_test",
	});
	probe = new SQL({ url: database.url, max: 1 });
	server = await startBuiltServer({
		entry: ENTRY,
		cwd: APP_DIR,
		env: {
			DATABASE_URL: database.url,
			CLOUD_EDGE_SECRET: SECRET,
			CLOUD_OWNER_EMAIL: "Owner@Example.com",
			CLOUD_PUBLIC_URL: PUBLIC_URL,
			CLOUD_ACCESS: "public",
			CLOUD_DATABASE_CONNECTION_LIMIT: "2",
			// Must not matter in cloud mode.
			DEV_USER: "dev",
		},
	});
}, 60_000);

afterAll(async () => {
	if (!ready) return;
	await server?.stop();
	await probe?.close();
	await database?.drop();
});

const OWNER = {
	"x-cloud-user-id": "owner-sub",
	"x-cloud-user-email": "owner@example.com",
	"x-cloud-user-username": "owner",
};
const GUEST = {
	"x-cloud-user-id": "guest-sub",
	"x-cloud-user-email": "guest@example.com",
};
const EDGE = { "x-cloud-edge-secret": SECRET };

function get(path: string, headers: Record<string, string> = {}) {
	return fetch(`${server.origin}${path}`, { redirect: "manual", headers });
}

async function errorCode(res: Response): Promise<string> {
	return ((await res.json()) as { error: { code: string } }).error.code;
}

/** The app's connections: everything on the database but the probe. */
async function appConnections(): Promise<{ total: number; listen: number }> {
	const rows = (await probe`
		select query from pg_stat_activity
		where datname = current_database() and pid <> pg_backend_pid()`) as {
		query: string;
	}[];
	return {
		total: rows.length,
		listen: rows.filter((r) => /^listen/i.test(r.query)).length,
	};
}

describe.skipIf(!ready)("the built server in cloud mode", () => {
	test("/api/items: 401 anonymous, 200 with the edge's headers", async () => {
		const anonymous = await get("/api/items", EDGE);
		expect(anonymous.status).toBe(401);
		expect(await errorCode(anonymous)).toBe("unauthorized");
		const signedIn = await get("/api/items", { ...OWNER, ...EDGE });
		expect(signedIn.status).toBe(200);
		expect(await signedIn.json()).toEqual({ items: [] });
	});

	test("identity headers without the edge secret, or with a wrong one, are anonymous", async () => {
		for (const headers of [
			OWNER,
			{ ...OWNER, "x-cloud-edge-secret": `${SECRET.slice(0, -1)}x` },
			{ ...OWNER, "x-cloud-edge-secret": "short" },
		]) {
			const res = await get("/api/items", headers);
			expect(res.status).toBe(401);
		}
	});

	test("a bearer token is refused, and the error says Cloud takes none", async () => {
		const res = await get("/api/items", {
			...EDGE,
			authorization: "Bearer eyJ.x.y",
		});
		expect(res.status).toBe(401);
		const body = (await res.json()) as { error: { message: string } };
		expect(body.error.message).toContain("bearer tokens");
	});

	test("the home page sends a signed-out visitor to the edge's sign-in", async () => {
		const res = await get("/", EDGE);
		expect([302, 307]).toContain(res.status);
		expect(res.headers.get("location")).toBe("/oauth2/start?rd=%2F");
	});

	test("the app's own sign-in route forwards to the edge too", async () => {
		const res = await get("/api/auth/start?return=%2Fadmin", EDGE);
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/oauth2/start?rd=%2Fadmin");
	});

	test("a signed-in visitor sees the home page with a sign-out link", async () => {
		const res = await get("/", { ...GUEST, ...EDGE });
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain("guest@example.com");
		expect(html).toContain("/oauth2/sign_out?rd=%2F");
	});

	test("the pending and access-request pages redirect away", async () => {
		const pending = await get("/pending", { ...GUEST, ...EDGE });
		expect([302, 307]).toContain(pending.status);
		expect(pending.headers.get("location")).toMatch(/\/$/);
		const requests = await get("/admin/requests", { ...OWNER, ...EDGE });
		expect([302, 307]).toContain(requests.status);
		expect(requests.headers.get("location")).toMatch(/\/admin$/);
	});

	test("the admin page is the owner's, matched without case", async () => {
		const owner = await get("/admin", { ...OWNER, ...EDGE });
		expect(owner.status).toBe(200);
		expect(await owner.text()).toContain('data-testid="admin-home"');
		const guest = await get("/admin", { ...GUEST, ...EDGE });
		expect(await guest.text()).toContain("admins only");
	});

	test("a cross-origin POST with identity headers is refused", async () => {
		const attempts: Record<string, string>[] = [
			{ origin: "https://evil.example" },
			{ "sec-fetch-site": "cross-site" },
			{ origin: "https://evil.example", authorization: "Bearer eyJ.x.y" },
			{},
		];
		for (const headers of attempts) {
			const res = await fetch(`${server.origin}/_serverFn/anything`, {
				method: "POST",
				headers: { ...OWNER, ...EDGE, ...headers },
			});
			expect(res.status).toBe(403);
			expect(await errorCode(res)).toBe("forbidden");
		}
	});

	test("a same-origin POST from the public URL gets past the CSRF check", async () => {
		const res = await fetch(`${server.origin}/_serverFn/anything`, {
			method: "POST",
			headers: { ...OWNER, ...EDGE, origin: PUBLIC_URL },
		});
		expect(res.status).not.toBe(403);
	});

	test("realtime is off on a nano database: no LISTEN, /api/events is 404", async () => {
		const res = await get("/api/events", {
			...OWNER,
			...EDGE,
			"sec-fetch-site": "same-origin",
		});
		expect(res.status).toBe(404);
		await Bun.sleep(300);
		expect((await appConnections()).listen).toBe(0);
	});

	test("the pool holds one connection under concurrent requests", async () => {
		const results = await Promise.all(
			Array.from({ length: 8 }, () => get("/api/items", { ...OWNER, ...EDGE })),
		);
		expect(results.map((r) => r.status)).toEqual(Array(8).fill(200));
		expect((await appConnections()).total).toBeLessThanOrEqual(1);
	});
});
