/**
 * The built server over HTTP (`bun run build` first) with a real Postgres
 * (TEST_DATABASE_URL) and the mock Authentik from @viktorbarzin/auth/testing:
 * health and metrics ports, the auth wall, CSRF, the sign-in flow, request +
 * approve, the guest retry, and a prompt exit on SIGTERM. The full approval
 * through the admin page runs in e2e/auth.spec.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
	type BuiltServer,
	CookieJar,
	follow,
	type MockAuthentik,
	startBuiltServer,
	startMockAuthentik,
} from "@viktorbarzin/auth/testing";
import { migratedTestDatabase } from "@viktorbarzin/pg/testing";

import { app } from "#/app.config";

const APP_DIR = resolve(import.meta.dir, "../..");
const ENTRY = resolve(APP_DIR, ".output/server/index.mjs");
const adminUrl = process.env.TEST_DATABASE_URL;
const ready = Boolean(adminUrl) && existsSync(ENTRY);

let database: Awaited<ReturnType<typeof migratedTestDatabase>>;
let mock: MockAuthentik;
let server: BuiltServer;

beforeAll(async () => {
	if (!ready) return;
	database = await migratedTestDatabase({
		adminUrl: adminUrl as string,
		migrationsFolder: resolve(APP_DIR, "drizzle"),
		lockKey: app.migrationLockKey,
		prefix: "http_test",
	});
	mock = await startMockAuthentik({
		clientId: app.slug,
		usersGroup: app.usersGroup,
	});
	mock.addUser({ username: "guest", email: null, groups: ["Public Guests"] });
	server = await startBuiltServer({
		entry: ENTRY,
		cwd: APP_DIR,
		env: {
			DATABASE_URL: database.url,
			OIDC_DISCOVERY_URL: mock.discoveryUrl,
			OIDC_CLIENT_ID: mock.clientId,
			OIDC_CLIENT_SECRET: mock.clientSecret,
			BETTER_AUTH_SECRET: "test-secret-0123456789abcdef0123456789abcdef",
			AUTHENTIK_API_URL: mock.apiUrl,
			AUTHENTIK_READER_TOKEN: mock.readerToken,
			AUTHENTIK_APPROVER_TOKEN: mock.approverToken,
		},
		origin: (port) => ({ PUBLIC_ORIGINS: `http://127.0.0.1:${port}` }),
	});
}, 60_000);

afterAll(async () => {
	if (!ready) return;
	await server?.stop();
	await mock?.stop();
	await database?.drop();
});

async function signIn(username: string, path = "/api/auth/start?return=%2F") {
	mock.session = null;
	mock.loginAs = username;
	const jar = new CookieJar();
	const result = await follow(`${server.origin}${path}`, jar, server.origin);
	return { jar, ...result };
}

function get(
	path: string,
	jar: CookieJar | null,
	headers: Record<string, string> = {},
) {
	return fetch(`${server.origin}${path}`, {
		redirect: "manual",
		headers: { ...(jar ? { cookie: jar.header() } : {}), ...headers },
	});
}

describe.skipIf(!ready)("the built server", () => {
	test("/healthz answers ok", async () => {
		const res = await get("/healthz", null);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: "ok" });
	});

	test("/metrics is served on METRICS_PORT only", async () => {
		await get("/healthz", null);
		const metrics = await fetch(`${server.metricsOrigin}/metrics`);
		expect(metrics.status).toBe(200);
		const text = await metrics.text();
		expect(text).toContain("process_cpu_user_seconds_total");
		expect(text).toMatch(
			/^http_requests_total\{method="GET",handler="\/healthz",status="2xx"\} [1-9]/m,
		);
		const publicRes = await get("/metrics", null);
		expect(publicRes.status).toBe(404);
		expect(await publicRes.text()).not.toContain(
			"process_cpu_user_seconds_total",
		);
	});

	test("the LISTEN connection opens at boot", async () => {
		const deadline = Date.now() + 10_000;
		for (;;) {
			const rows = await database.client`
				select pid from pg_stat_activity
				where datname = current_database() and query ilike ${`listen%${app.realtimeChannel}%`}`;
			const text = await (
				await fetch(`${server.metricsOrigin}/metrics`)
			).text();
			if (rows.length === 1 && /^realtime_listen_connected 1$/m.test(text))
				break;
			if (Date.now() > deadline) throw new Error("no LISTEN at boot");
			await Bun.sleep(100);
		}
	});

	test("/api/items is 401 without a session, and a forged forward-auth header changes nothing", async () => {
		for (const headers of [{}, { "x-authentik-username": "admin" }] as Record<
			string,
			string
		>[]) {
			const res = await get("/api/items", null, headers);
			expect(res.status).toBe(401);
			expect((await res.json()).error.code).toBe("unauthorized");
		}
	});

	test("the home page sends a signed-out visitor to sign-in", async () => {
		const res = await get("/", null);
		expect([302, 307]).toContain(res.status);
		expect(res.headers.get("location")).toContain("/api/auth/start?return=%2F");
	});

	test("pages and redirects refuse to be framed", async () => {
		for (const path of [
			"/pending",
			"/healthz",
			"/api/items",
			"/api/auth/finish?return=/",
		]) {
			const res = await get(path, null);
			expect(res.headers.get("content-security-policy")).toBe(
				"frame-ancestors 'none'",
			);
			expect(res.headers.get("x-frame-options")).toBe("DENY");
		}
	});

	test("a cross-origin POST is refused before it reaches a handler", async () => {
		for (const path of ["/_serverFn/anything", "/api/items"]) {
			const res = await fetch(`${server.origin}${path}`, {
				method: "POST",
				headers: {
					origin: "https://evil.example",
					cookie: `__Host-${app.slug}.session_token=x`,
				},
			});
			expect(res.status).toBe(403);
			expect((await res.json()).error.code).toBe("forbidden");
		}
	});

	test("a member signs in and gets a __Host- session cookie", async () => {
		mock.addUser({ username: "member@example.com", groups: [app.usersGroup] });
		const { jar, hops, response } = await signIn("member@example.com");
		expect(hops.at(-1)?.url).toBe(`${server.origin}/`);
		expect(response.status).toBe(200);
		const session = jar.raw.find((c) =>
			c.startsWith(`__Host-${app.slug}.session_token=`),
		);
		expect(session?.toLowerCase()).toContain("httponly");
		expect(session?.toLowerCase()).not.toContain("domain=");
		expect(await response.text()).toContain("member@example.com");
		const items = await get("/api/items", jar);
		expect(items.status).toBe(200);
		expect(await items.json()).toEqual({ items: [] });
	});

	test("a non-member gets 403 access_pending and an access request; approval lets them in", async () => {
		const user = mock.addUser({ username: "stranger@example.com", groups: [] });
		const { jar, hops } = await signIn("stranger@example.com");
		expect(hops.at(-1)?.url).toBe(`${server.origin}/pending`);
		const res = await get("/api/items", jar);
		expect(res.status).toBe(403);
		expect((await res.json()).error.code).toBe("access_pending");
		const rows =
			await database.client`select status from access_requests where sub = ${user.uid}`;
		expect(rows).toEqual([{ status: "pending" }]);

		// An admin approves (here at the provider; e2e/auth.spec.ts goes through
		// the admin page). The next re-check lets the person in.
		user.groups.push(app.usersGroup);
		await database.client`update member_checks set checked_at = now() - interval '16 minutes' where sub = ${user.uid}`;
		expect((await get("/api/items", jar)).status).toBe(200);
	});

	test("bearer tokens work for /api/items, and a bad one does not fall back to the cookie", async () => {
		const user = mock.addUser({
			username: "cli@example.com",
			groups: [app.usersGroup],
		});
		const token = await mock.mintAccessToken({
			sub: user.uid,
			preferred_username: user.username,
			groups: user.groups,
		});
		const ok = await get("/api/items?limit=5", null, {
			authorization: `Bearer ${token}`,
		});
		expect(ok.status).toBe(200);
		const bad = await get("/api/items?limit=0", null, {
			authorization: `Bearer ${token}`,
		});
		expect(bad.status).toBe(422);
		const { jar } = await signIn("cli@example.com");
		expect(
			(await get("/api/items", jar, { authorization: "Bearer not-a-jwt" }))
				.status,
		).toBe(401);
	});

	test("the anonymous guest gets prompt=login once", async () => {
		mock.addUser({ username: "real@example.com", groups: [app.usersGroup] });
		mock.session = "guest";
		mock.loginAs = "real@example.com";
		mock.authorizations.length = 0;
		const jar = new CookieJar();
		const { hops } = await follow(
			`${server.origin}/api/auth/start?return=%2F`,
			jar,
			server.origin,
		);
		expect(mock.authorizations.map((a) => [a.prompt, a.user])).toEqual([
			[null, "guest"],
			["login", "real@example.com"],
		]);
		expect(hops.at(-1)?.url).toBe(`${server.origin}/`);
	});

	test("every log line is JSON", async () => {
		await fetch(`${server.origin}/_serverFn/garbage`, {
			method: "POST",
			headers: { origin: server.origin, "content-type": "application/json" },
			body: "{}",
		});
		await Bun.sleep(200);
		const notJson = server.logs.filter((line) => {
			try {
				const record = JSON.parse(line) as Record<string, unknown>;
				return !(record.ts && record.level && record.logger && "msg" in record);
			} catch {
				return true;
			}
		});
		expect(notJson).toEqual([]);
	});

	test("SIGTERM exits 0 within the drain window, even with an SSE stream open", async () => {
		mock.addUser({
			username: "streamer@example.com",
			groups: [app.usersGroup],
		});
		const { jar } = await signIn("streamer@example.com");
		const controller = new AbortController();
		const events = await fetch(`${server.origin}/api/events`, {
			signal: controller.signal,
			headers: {
				cookie: jar.header(),
				accept: "text/event-stream",
				"sec-fetch-site": "same-origin",
			},
		});
		expect(events.status).toBe(200);
		await events.body?.getReader().read();
		const started = Date.now();
		server.kill("SIGTERM");
		const code = await Promise.race([
			server.exited,
			Bun.sleep(8_000).then(() => "still running"),
		]);
		expect(code).toBe(0);
		expect(Date.now() - started).toBeLessThan(6_000);
		controller.abort();
	}, 15_000);
});
