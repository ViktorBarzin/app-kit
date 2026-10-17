/**
 * Sign-in, sessions, bearer tokens and CSRF over HTTP, against an in-process
 * router wired to AppAuth, a real Postgres (TEST_DATABASE_URL) and the mock
 * Authentik. The template's HTTP test covers the same flow in a built app.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { adminUrl, type Harness, startHarness } from "./testdata/harness.js";
import { CookieJar, follow } from "./testing/index.js";

let h: Harness<{ team: string }>;
const enriched: Array<{ sub: string | null; username: string }> = [];

beforeAll(async () => {
	if (!adminUrl) return;
	h = await startHarness<{ team: string }>({
		enrich: async (_db, who) => {
			enriched.push(who);
			return { team: `team-of-${who.username}` };
		},
	});
}, 30_000);

afterAll(async () => {
	await h?.stop();
});

describe.skipIf(!adminUrl)("browser sign-in", () => {
	test("starts the OAuth flow with PKCE, a nonce and no offline_access", async () => {
		h.mock.addUser({ username: "first@example.com", groups: ["App Users"] });
		const { hops } = await h.signIn("first@example.com");
		expect(hops[0]?.status).toBe(302);
		const authorize = new URL(hops[1]?.url ?? "");
		expect(authorize.origin).toBe(h.mock.apiUrl);
		expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
		expect(authorize.searchParams.get("code_challenge")).toBeTruthy();
		expect(authorize.searchParams.get("nonce")).toBeTruthy();
		expect(authorize.searchParams.get("prompt")).toBeNull();
		expect(authorize.searchParams.get("scope")?.split(" ").sort()).toEqual([
			"email",
			"openid",
			"profile",
		]);
		expect(authorize.searchParams.get("redirect_uri")).toBe(
			`${h.origin}/api/auth/callback/authentik`,
		);
	});

	test("a member gets a host-only __Host- session cookie and is resolved with enrich's fields", async () => {
		const user = h.mock.addUser({
			username: "member@example.com",
			groups: ["App Users"],
		});
		const { jar, hops, response } = await h.signIn(
			"member@example.com",
			"/api/auth/start?return=%2Flist%3Fx%3D1",
		);
		expect(hops.at(-1)?.url).toBe(`${h.origin}/list?x=1`);
		expect(response.status).toBe(200);
		const session = jar.raw.find((c) =>
			c.startsWith("__Host-app.session_token="),
		);
		expect(session).toBeDefined();
		const attributes = (session ?? "").toLowerCase();
		expect(attributes).toContain("secure");
		expect(attributes).toContain("httponly");
		expect(attributes).toContain("path=/");
		expect(attributes).toContain("samesite=lax");
		expect(attributes).not.toContain("domain=");
		expect(
			h.mock.tokenRequests.every((t) => t.grantType === "authorization_code"),
		).toBe(true);

		const me = await h.get("/api/me", jar);
		expect(me.status).toBe(200);
		expect(await me.json()).toEqual({
			team: "team-of-member@example.com",
			sub: user.uid,
			username: "member@example.com",
			via: "session",
			member: true,
			admin: false,
		});
		expect(enriched).toContainEqual({
			sub: user.uid,
			username: "member@example.com",
		});
	});

	test("sessions are capped at 7 days and never extended", async () => {
		h.mock.addUser({ username: "cap@example.com", groups: ["App Users"] });
		const { jar } = await h.signIn("cap@example.com");
		const seconds = async () => {
			const [row] = await h.sql`
				select extract(epoch from (s.expires_at - s.created_at))::int as seconds
				from auth_session s join auth_account a on a.user_id = s.user_id
				join member_checks m on m.sub = a.account_id where m.username = 'cap@example.com'`;
			return (row as { seconds: number }).seconds;
		};
		expect(await seconds()).toBe(7 * 24 * 3600);
		await h.get("/api/me", jar);
		expect(await seconds()).toBe(7 * 24 * 3600);
	});

	test("a subject without an email gets a placeholder under the app slug", async () => {
		const user = h.mock.addUser({
			username: "noemail",
			email: null,
			groups: ["App Users"],
		});
		await h.signIn("noemail");
		const rows =
			await h.sql`select email from auth_user where name = 'noemail'`;
		expect(rows).toEqual([{ email: `${user.uid}@users.app.invalid` }]);
	});

	test("the anonymous guest is sent back with prompt=login", async () => {
		h.mock.addUser({ username: "real@example.com", groups: ["App Users"] });
		h.mock.session = "guest";
		h.mock.loginAs = "real@example.com";
		h.mock.authorizations.length = 0;
		const jar = new CookieJar();
		const { hops } = await follow(
			`${h.origin}/api/auth/start?return=%2F`,
			jar,
			h.origin,
		);
		expect(h.mock.authorizations.map((a) => [a.prompt, a.user])).toEqual([
			[null, "guest"],
			["login", "real@example.com"],
		]);
		expect(
			hops.some((hop) =>
				hop.url.includes("/api/auth/start?return=%2F&login=1"),
			),
		).toBe(true);
		expect(hops.at(-1)?.url).toBe(`${h.origin}/`);
		expect((await h.get("/api/me", jar)).status).toBe(200);
		const guests =
			await h.sql`select count(*)::int as n from auth_user where name = 'guest'`;
		expect((guests[0] as { n: number }).n).toBe(0);
	});

	test("a guest again after prompt=login stops on the error page, not a loop", async () => {
		h.mock.session = "guest";
		h.mock.loginAs = "guest";
		const jar = new CookieJar();
		const { hops } = await follow(
			`${h.origin}/api/auth/start?return=%2F`,
			jar,
			h.origin,
		);
		expect(hops.at(-1)?.url).toBe(
			`${h.origin}/api/auth/error?error=guest_session`,
		);
		expect(jar.cookies.has("__Host-app.session_token")).toBe(false);
	});

	test("an absolute return URL is not followed (no open redirect)", async () => {
		h.mock.addUser({ username: "redir@example.com", groups: ["App Users"] });
		const { hops } = await h.signIn(
			"redir@example.com",
			"/api/auth/start?return=https%3A%2F%2Fevil.example%2F",
		);
		expect(hops.at(-1)?.url).toBe(`${h.origin}/`);
		for (const evil of [
			"/.//evil.example/x",
			"/..//evil.example",
			"/./\\evil",
		]) {
			const res = await h.get(
				`/api/auth/finish?return=${encodeURIComponent(evil)}`,
				null,
			);
			expect(res.status).toBe(302);
			expect(res.headers.get("location")).toBe("/");
		}
	});

	test("sign-out ends the session", async () => {
		h.mock.addUser({ username: "bye@example.com", groups: ["App Users"] });
		const { jar } = await h.signIn("bye@example.com");
		const out = await fetch(`${h.origin}/api/auth/sign-out`, {
			method: "POST",
			headers: {
				cookie: jar.header(),
				origin: h.origin,
				"content-type": "application/json",
			},
			body: "{}",
		});
		expect(out.status).toBe(200);
		jar.store(out);
		expect((await h.get("/api/me", jar)).status).toBe(401);
	});

	test("Better Auth endpoints the app does not use are refused", async () => {
		const res = await fetch(`${h.origin}/api/auth/sign-in/social`, {
			method: "POST",
			headers: { origin: h.origin, "content-type": "application/json" },
			body: JSON.stringify({ provider: "authentik" }),
		});
		expect(res.status).toBe(404);
	});

	test("sign-ins are counted under the configured metric prefix", async () => {
		const text = await h.registry.metrics();
		expect(text).toMatch(/^app_sign_ins_total\{outcome="member"\} [1-9]/m);
		expect(text).toMatch(/^app_sign_ins_total\{outcome="guest"\} [1-9]/m);
	});
});

describe.skipIf(!adminUrl)("membership", () => {
	test("a signed-in non-member gets 403 access_pending and an access request", async () => {
		const user = h.mock.addUser({
			username: "stranger@example.com",
			groups: [],
		});
		const { jar } = await h.signIn("stranger@example.com");
		const me = await h.get("/api/me", jar);
		expect(me.status).toBe(403);
		expect((await me.json()).error.code).toBe("access_pending");
		const rows =
			await h.sql`select status, username from access_requests where sub = ${user.uid}`;
		expect(rows).toEqual([
			{ status: "pending", username: "stranger@example.com" },
		]);
	});

	test("in open sign-up mode a non-member files no request", async () => {
		h.override({ signup: "open" });
		try {
			const user = h.mock.addUser({ username: "open@example.com", groups: [] });
			const { jar } = await h.signIn("open@example.com");
			expect((await h.get("/api/me", jar)).status).toBe(403);
			const rows =
				await h.sql`select 1 from access_requests where sub = ${user.uid}`;
			expect(rows).toHaveLength(0);
		} finally {
			h.override({});
		}
	});

	test("removal at the provider takes effect at the next re-check", async () => {
		const user = h.mock.addUser({
			username: "leaver@example.com",
			groups: ["App Users"],
		});
		const { jar } = await h.signIn("leaver@example.com");
		expect((await h.get("/api/me", jar)).status).toBe(200);
		user.groups = [];
		expect((await h.get("/api/me", jar)).status).toBe(200);
		await h.sql`update member_checks set checked_at = now() - interval '16 minutes' where sub = ${user.uid}`;
		h.mock.apiCalls.length = 0;
		expect((await h.get("/api/me", jar)).status).toBe(403);
		expect(h.mock.apiCalls).toEqual([
			{ method: "GET", path: "/core/users/", token: h.mock.readerToken },
		]);
	});

	test("a shorter membershipMaxAgeMs re-checks sooner", async () => {
		const user = h.mock.addUser({
			username: "short@example.com",
			groups: ["App Users"],
		});
		const { jar } = await h.signIn("short@example.com");
		user.groups = [];
		h.override({ membershipMaxAgeMs: 1 });
		try {
			await Bun.sleep(5);
			expect((await h.get("/api/me", jar)).status).toBe(403);
		} finally {
			h.override({});
		}
	});

	test("when the provider cannot answer, the last answer stands", async () => {
		const user = h.mock.addUser({
			username: "steady@example.com",
			groups: ["App Users"],
		});
		const { jar } = await h.signIn("steady@example.com");
		await h.sql`update member_checks set checked_at = now() - interval '16 minutes' where sub = ${user.uid}`;
		h.mock.apiFailure = 503;
		try {
			expect((await h.get("/api/me", jar)).status).toBe(200);
		} finally {
			h.mock.apiFailure = null;
		}
	});
});

describe.skipIf(!adminUrl)("CSRF origin check", () => {
	let jar: CookieJar;
	beforeAll(async () => {
		h.mock.addUser({ username: "csrf@example.com", groups: ["App Users"] });
		jar = (await h.signIn("csrf@example.com")).jar;
	});

	const post = (headers: Record<string, string>) =>
		fetch(`${h.origin}/api/write`, {
			method: "POST",
			headers: {
				cookie: jar.header(),
				"content-type": "application/json",
				...headers,
			},
			body: "{}",
		});

	test("a cookie POST from another origin is refused with the envelope", async () => {
		const res = await post({ origin: "https://pages.example.test" });
		expect(res.status).toBe(403);
		expect((await res.json()).error.code).toBe("forbidden");
	});

	test("Sec-Fetch-Site other than same-origin, or no header at all, is refused", async () => {
		expect((await post({ "sec-fetch-site": "same-site" })).status).toBe(403);
		expect((await post({})).status).toBe(403);
	});

	test("the public origin passes", async () => {
		expect((await post({ origin: h.origin })).status).toBe(200);
	});

	test("the stream path is covered, and rejections are counted", async () => {
		expect(
			(await h.get("/api/events", jar, { "sec-fetch-site": "cross-site" }))
				.status,
		).toBe(403);
		expect(await h.registry.metrics()).toMatch(
			/^app_csrf_rejections_total [1-9]/m,
		);
	});
});

describe.skipIf(!adminUrl)("API bearer tokens", () => {
	const bearer = (token: string, extra: Record<string, string> = {}) =>
		fetch(`${h.origin}/api/me`, {
			headers: { authorization: `Bearer ${token}`, ...extra },
		});

	test("a valid JWT is accepted, for any of the app's client IDs", async () => {
		const user = h.mock.addUser({
			username: "cli@example.com",
			groups: ["App Users"],
		});
		const claims = {
			sub: user.uid,
			preferred_username: user.username,
			groups: user.groups,
		};
		const web = await bearer(await h.mock.mintAccessToken(claims));
		expect(web.status).toBe(200);
		expect(await web.json()).toMatchObject({
			username: "cli@example.com",
			via: "token",
		});
		expect(
			(
				await bearer(
					await h.mock.mintAccessToken(claims, { audience: "app-cli" }),
				)
			).status,
		).toBe(200);
	});

	test("a service account in the agents group is a member", async () => {
		const agent = h.mock.addUser({
			username: "ha-agent",
			groups: ["App Agents"],
		});
		const token = await h.mock.mintAccessToken({
			sub: agent.uid,
			preferred_username: agent.username,
			groups: agent.groups,
		});
		expect((await bearer(token)).status).toBe(200);
	});

	test("with no agents group configured, an agent is not a member", async () => {
		h.override({
			groups: { users: "App Users", admins: "App Admins", agents: null },
		});
		try {
			const agent = h.mock.addUser({
				username: "orphan-agent",
				groups: ["App Agents"],
			});
			const token = await h.mock.mintAccessToken({
				sub: agent.uid,
				preferred_username: agent.username,
				groups: agent.groups,
			});
			expect((await bearer(token)).status).toBe(403);
		} finally {
			h.override({});
		}
	});

	test.each([
		["another app's audience", { audience: "grafana" }],
		["an expired token", { expiresIn: Math.floor(Date.now() / 1000) - 60 }],
		["HS256 instead of RS256", { alg: "HS256" }],
	] as const)("refuses %s", async (_name, options) => {
		const user = h.mock.addUser({
			username: `bad-${crypto.randomUUID()}`,
			groups: ["App Users"],
		});
		const token = await h.mock.mintAccessToken(
			{ sub: user.uid, preferred_username: user.username, groups: user.groups },
			options,
		);
		const res = await bearer(token);
		expect(res.status).toBe(401);
		expect((await res.json()).error.code).toBe("unauthorized");
	});

	test("a bad bearer token does not fall back to the session cookie", async () => {
		h.mock.addUser({ username: "both@example.com", groups: ["App Users"] });
		const { jar } = await h.signIn("both@example.com");
		expect((await bearer("not-a-jwt", { cookie: jar.header() })).status).toBe(
			401,
		);
	});

	test("verifications are counted under the configured prefix", async () => {
		const text = await h.registry.metrics();
		expect(text).toMatch(
			/^app_api_token_verifications_total\{outcome="ok"\} [1-9]/m,
		);
		expect(text).toMatch(
			/^app_api_token_verifications_total\{outcome="bad_aud"\} [1-9]/m,
		);
	});
});

describe.skipIf(!adminUrl)("without sign-in configured", () => {
	test("start is 503, the auth handler 404, and the dev user stands in", async () => {
		h.override({ oidc: null, devUser: "dev" });
		try {
			const start = await h.get("/api/auth/start?return=%2F", null);
			expect(start.status).toBe(503);
			expect((await start.json()).error.code).toBe("auth_unavailable");
			expect((await h.get("/api/auth/get-session", null)).status).toBe(404);
			expect(h.appAuth.signInRedirect("/")).toBeNull();
			const me = await h.get("/api/me", null);
			expect(await me.json()).toEqual({
				team: "team-of-dev",
				sub: null,
				username: "dev",
				via: "dev",
				member: true,
				admin: true,
			});
		} finally {
			h.override({});
		}
	});

	test("the start URL and redirect follow basePath", () => {
		expect(h.appAuth.startUrl("/x", true)).toBe(
			"/api/auth/start?return=%2Fx&login=1",
		);
		h.override({ basePath: "/auth" });
		try {
			expect(h.appAuth.startUrl("//evil", false)).toBe(
				"/auth/start?return=%2F",
			);
			expect(h.appAuth.signInRedirect("/x")?.headers.get("location")).toBe(
				"/auth/start?return=%2Fx",
			);
		} finally {
			h.override({});
		}
	});
});
