/**
 * createCloudAuth: identity from the platform edge's headers, trusted only
 * with the edge secret; the owner's email is the admin; sign-in and sign-out
 * are links to the edge's oauth2-proxy; no bearer tokens.
 */
import { describe, expect, test } from "bun:test";
import { getLogger } from "@viktorbarzin/log";
import { ApiError } from "@viktorbarzin/runtime";
import { Registry } from "prom-client";

import {
	type AuthUser,
	CLOUD_HEADERS,
	type CloudAuthConfig,
	createCloudAuth,
} from "./index.js";

const SECRET = "edge-secret-0123456789abcdefghijklmnopqrstuv";
const PUBLIC_URL = "https://recipes.example";

function config(
	overrides: Partial<CloudAuthConfig<Record<string, unknown>>> = {},
): CloudAuthConfig<Record<string, unknown>> {
	return {
		appSlug: "recipes",
		edgeSecret: SECRET,
		ownerEmail: "owner@example.com",
		publicUrl: PUBLIC_URL,
		metrics: { registry: new Registry() },
		logger: getLogger("cloud.test"),
		...overrides,
	};
}

function auth(
	overrides: Partial<CloudAuthConfig<Record<string, unknown>>> = {},
) {
	const cfg = config(overrides);
	return createCloudAuth(() => cfg);
}

interface Who {
	id?: string;
	email?: string;
	username?: string;
	secret?: string | null;
}

/** A request as the edge forwards it: identity headers plus the edge secret. */
function req(
	path = "/api/items",
	who: Who | null = null,
	init: { method?: string; headers?: Record<string, string> } = {},
): Request {
	const headers = new Headers(init.headers);
	if (who) {
		if (who.id !== undefined) headers.set(CLOUD_HEADERS.userId, who.id);
		if (who.email !== undefined) headers.set(CLOUD_HEADERS.email, who.email);
		if (who.username !== undefined)
			headers.set(CLOUD_HEADERS.username, who.username);
	}
	const secret = who?.secret === undefined ? SECRET : who.secret;
	if (secret !== null) headers.set(CLOUD_HEADERS.edgeSecret, secret);
	return new Request(`http://10.1.2.3:3000${path}`, {
		method: init.method ?? "GET",
		headers,
	});
}

const ALICE: Who = {
	id: "a1b2c3",
	email: "alice@example.com",
	username: "alice",
};
const OWNER: Who = {
	id: "o0o0o0",
	email: "owner@example.com",
	username: "owner",
};

async function apiErrorOf(promise: Promise<unknown>): Promise<ApiError> {
	try {
		await promise;
	} catch (err) {
		if (err instanceof ApiError) return err;
		throw err;
	}
	throw new Error("expected an ApiError");
}

describe("the header names", () => {
	test("are the platform contract's", () => {
		expect(CLOUD_HEADERS).toEqual({
			userId: "x-cloud-user-id",
			email: "x-cloud-user-email",
			username: "x-cloud-user-username",
			edgeSecret: "x-cloud-edge-secret",
		});
	});
});

describe("resolveUser", () => {
	test("no identity headers: anonymous", async () => {
		expect(await auth().resolveUser(req("/", null))).toBeNull();
		expect(await auth().resolveUser(req("/", {}))).toBeNull();
	});

	test("the edge's headers with the right secret give a member", async () => {
		expect(await auth().resolveUser(req("/", ALICE))).toEqual({
			sub: "a1b2c3",
			username: "alice",
			email: "alice@example.com",
			via: "cloud",
			member: true,
			admin: false,
		});
	});

	test("without a username header the username is the email", async () => {
		const user = await auth().resolveUser(
			req("/", { id: "a1b2c3", email: "alice@example.com" }),
		);
		expect(user?.username).toBe("alice@example.com");
	});

	test("forged identity headers without the edge secret are ignored", async () => {
		expect(
			await auth().resolveUser(req("/", { ...OWNER, secret: null })),
		).toBeNull();
	});

	test.each([
		["a wrong secret of the same length", `${SECRET.slice(0, -1)}x`],
		["a shorter secret", SECRET.slice(0, 10)],
		["a longer secret", `${SECRET}x`],
		["the secret in another case", SECRET.toUpperCase()],
		["an empty secret", ""],
	])("%s is refused", async (_label, secret) => {
		expect(await auth().resolveUser(req("/", { ...OWNER, secret }))).toBeNull();
	});

	test("a refused secret is counted", async () => {
		const registry = new Registry();
		const a = auth({ metrics: { registry, prefix: "t" } });
		await a.resolveUser(req("/", { ...ALICE, secret: "wrong" }));
		await a.resolveUser(req("/", { ...ALICE, secret: null }));
		// No identity headers: nothing was forged, nothing to count.
		await a.resolveUser(req("/", { secret: "wrong" }));
		const metric = await registry
			.getSingleMetric("t_cloud_edge_refusals_total")
			?.get();
		expect(metric?.values[0]?.value).toBe(2);
	});

	test.each<[string, Who]>([
		["an id without an email", { id: "a1b2c3" }],
		["an email without an id", { email: "alice@example.com" }],
		["an empty id", { id: " ", email: "alice@example.com" }],
		["an email without an @", { id: "a1b2c3", email: "alice" }],
		[
			"an id over 255 characters",
			{ id: "x".repeat(256), email: "a@b.example" },
		],
		[
			"an email over 320 characters",
			{ id: "a1b2c3", email: `${"x".repeat(320)}@b.example` },
		],
	])("%s is anonymous", async (_label, who) => {
		expect(await auth().resolveUser(req("/", who))).toBeNull();
	});

	test("a bearer token adds nothing and takes nothing away", async () => {
		const bearer = { authorization: "Bearer eyJhbGciOiJSUzI1NiJ9.x.y" };
		expect(
			await auth().resolveUser(req("/", null, { headers: bearer })),
		).toBeNull();
		expect(
			(await auth().resolveUser(req("/", ALICE, { headers: bearer })))?.sub,
		).toBe("a1b2c3");
	});

	test("enrich adds the app's fields", async () => {
		const a = createCloudAuth(() => ({
			...config(),
			enrich: async (who) => ({ greeting: `hi ${who.username}` }),
		}));
		expect((await a.resolveUser(req("/", ALICE)))?.greeting).toBe("hi alice");
	});
});

describe("admins", () => {
	test.each([
		"owner@example.com",
		"Owner@Example.COM",
		"OWNER@EXAMPLE.COM",
	])("the owner's email %p is an admin", async (email) => {
		const user = await auth().resolveUser(req("/", { ...OWNER, email }));
		expect(user?.admin).toBe(true);
	});

	test("the configured owner email is matched without case or spaces", async () => {
		const user = await auth({ ownerEmail: "  Owner@EXAMPLE.com " }).resolveUser(
			req("/", OWNER),
		);
		expect(user?.admin).toBe(true);
	});

	test("anyone else is not, even with the owner's username", async () => {
		const user = await auth().resolveUser(
			req("/", { ...ALICE, username: "owner" }),
		);
		expect(user?.admin).toBe(false);
	});

	test("isAdmin adds admins from the app's own table", async () => {
		const asked: string[] = [];
		const a = auth({
			isAdmin: async (who) => {
				asked.push(who.email);
				return who.email === "alice@example.com";
			},
		});
		expect((await a.resolveUser(req("/", ALICE)))?.admin).toBe(true);
		expect(
			(
				await a.resolveUser(
					req("/", { id: "b", email: "bob@example.com", username: "bob" }),
				)
			)?.admin,
		).toBe(false);
		// The owner is an admin without asking.
		expect((await a.resolveUser(req("/", OWNER)))?.admin).toBe(true);
		expect(asked).toEqual(["alice@example.com", "bob@example.com"]);
	});

	test("requireAdmin passes the owner and refuses anyone else with 403", async () => {
		const a = auth();
		const owner = await a.resolveUser(req("/", OWNER));
		const alice = await a.resolveUser(req("/", ALICE));
		if (!owner || !alice) throw new Error("expected users");
		await a.requireAdmin(owner);
		const err = await apiErrorOf(a.requireAdmin(alice));
		expect([err.status, err.code]).toEqual([403, "forbidden"]);
	});

	test("requireAdmin asks again: a forged admin flag does not count", async () => {
		const a = auth();
		const alice = await a.resolveUser(req("/", ALICE));
		if (!alice) throw new Error("expected a user");
		const err = await apiErrorOf(a.requireAdmin({ ...alice, admin: true }));
		expect(err.status).toBe(403);
	});

	test("requireAdmin refuses a user that did not come from the edge", async () => {
		const dev: AuthUser = {
			sub: null,
			username: "dev",
			via: "dev",
			member: true,
			admin: true,
		};
		expect((await apiErrorOf(auth().requireAdmin(dev))).status).toBe(403);
	});
});

describe("requireUser and handleApi", () => {
	test("anonymous is 401 unauthorized", async () => {
		const err = await apiErrorOf(auth().requireUser(req("/api/items")));
		expect([err.status, err.code]).toEqual([401, "unauthorized"]);
	});

	test("a signed-in caller is let through", async () => {
		expect((await auth().requireUser(req("/api/items", ALICE))).sub).toBe(
			"a1b2c3",
		);
	});

	test("a bearer token alone is 401, and the message says Cloud takes none", async () => {
		const res = await auth().handleApi(
			req("/api/items", null, {
				headers: { authorization: "Bearer eyJ.x.y" },
			}),
			async () => Response.json({ ok: true }),
		);
		expect(res.status).toBe(401);
		const body = (await res.json()) as {
			error: { code: string; message: string };
		};
		expect(body.error.code).toBe("unauthorized");
		expect(body.error.message).toContain("bearer tokens");
	});

	test("handleApi runs the handler for a signed-in caller", async () => {
		const res = await auth().handleApi(req("/api/items", ALICE), async (user) =>
			Response.json({ who: user.username }),
		);
		expect(await res.json()).toEqual({ who: "alice" });
	});

	test("handleApi maps anonymous to the 401 envelope", async () => {
		const res = await auth().handleApi(req("/api/items"), async () =>
			Response.json({ ok: true }),
		);
		expect(res.status).toBe(401);
		expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
			"unauthorized",
		);
	});
});

describe("accessStatus", () => {
	test("anonymous", async () => {
		expect(await auth().accessStatus(req("/"))).toEqual({
			signedIn: false,
			username: null,
			member: false,
			admin: false,
			requestedAt: null,
		});
	});

	test("signed in is a member; there are no access requests", async () => {
		expect(
			await auth().accessStatus(req("/", OWNER), { recheck: true }),
		).toEqual({
			signedIn: true,
			username: "owner",
			member: true,
			admin: true,
			requestedAt: null,
		});
	});
});

describe("access requests", () => {
	test("the owner sees none; approving is not a Cloud thing (404)", async () => {
		const a = auth();
		const owner = await a.resolveUser(req("/", OWNER));
		if (!owner) throw new Error("expected a user");
		expect(await a.listPendingRequests(owner)).toEqual([]);
		const err = await apiErrorOf(a.approveRequest(owner, "someone"));
		expect([err.status, err.code]).toEqual([404, "not_found"]);
	});

	test("anyone else gets 403 for both", async () => {
		const a = auth();
		const alice = await a.resolveUser(req("/", ALICE));
		if (!alice) throw new Error("expected a user");
		expect((await apiErrorOf(a.listPendingRequests(alice))).status).toBe(403);
		expect((await apiErrorOf(a.approveRequest(alice, "x"))).status).toBe(403);
	});
});

describe("sign-in and sign-out links", () => {
	test.each([
		["/", "/oauth2/start?rd=%2F"],
		["/items?tab=2", "/oauth2/start?rd=%2Fitems%3Ftab%3D2"],
		["//evil.example/x", "/oauth2/start?rd=%2F"],
		["https://evil.example/", "/oauth2/start?rd=%2F"],
		["/\\evil.example", "/oauth2/start?rd=%2F"],
		["/.//evil.example", "/oauth2/start?rd=%2F"],
	])("signInUrl(%p) is %p", (returnTo, expected) => {
		expect(auth().signInUrl(returnTo)).toBe(expected);
		expect(auth().startUrl(returnTo, true)).toBe(expected);
	});

	test("signOutUrl goes through the edge's sign-out", () => {
		expect(auth().signOutUrl("/")).toBe("/oauth2/sign_out?rd=%2F");
		expect(auth().signOutUrl("https://evil.example")).toBe(
			"/oauth2/sign_out?rd=%2F",
		);
	});

	test("the paths are config inputs", () => {
		const a = auth({ signInPath: "/auth/in", signOutPath: "/auth/out" });
		expect(a.signInUrl("/x")).toBe("/auth/in?rd=%2Fx");
		expect(a.signOutUrl("/x")).toBe("/auth/out?rd=%2Fx");
	});

	test("signInRedirect is a 302 to the sign-in link", () => {
		const res = auth().signInRedirect("/items");
		expect(res?.status).toBe(302);
		expect(res?.headers.get("location")).toBe("/oauth2/start?rd=%2Fitems");
		expect(res?.headers.get("cache-control")).toBe("no-store");
	});

	test("the app's own start route forwards to the edge", async () => {
		const res = await auth().startSignIn(
			req("/api/auth/start?return=%2Fitems"),
		);
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/oauth2/start?rd=%2Fitems");
		const evil = await auth().startSignIn(
			req("/api/auth/start?return=https%3A%2F%2Fevil.example"),
		);
		expect(evil.headers.get("location")).toBe("/oauth2/start?rd=%2F");
	});

	test("finishSignIn goes back to a same-origin path only", () => {
		expect(
			auth()
				.finishSignIn(req("/api/auth/finish?return=%2F%2Fevil.example"))
				.headers.get("location"),
		).toBe("/");
		expect(
			auth()
				.finishSignIn(req("/api/auth/finish?return=%2Fitems"))
				.headers.get("location"),
		).toBe("/items");
	});

	test("there is no Better Auth: getAuth is null, its endpoints are 404", async () => {
		const a = auth();
		expect(a.getAuth()).toBeNull();
		const res = await a.handleAuthRequest(req("/api/auth/get-session"));
		expect(res.status).toBe(404);
	});
});

describe("csrfRejection", () => {
	const post = (headers: Record<string, string>, who: Who | null = ALICE) =>
		req("/_serverFn/x", who, { method: "POST", headers });

	test("the public URL's origin passes, whatever its path", () => {
		const a = auth({ publicUrl: `${PUBLIC_URL}/some/path/` });
		expect(a.csrfRejection(post({ origin: PUBLIC_URL }))).toBeNull();
	});

	test("same-origin fetch metadata passes", () => {
		expect(
			auth().csrfRejection(post({ "sec-fetch-site": "same-origin" })),
		).toBeNull();
	});

	test.each<[string, Record<string, string>]>([
		["another origin", { origin: "https://evil.example" }],
		["another port", { origin: `${PUBLIC_URL}:8443` }],
		["http instead of https", { origin: "http://recipes.example" }],
		["Origin null", { origin: "null" }],
		["a cross-site fetch", { "sec-fetch-site": "cross-site" }],
		["a same-site sibling", { "sec-fetch-site": "same-site" }],
		[
			"a bearer token from another origin",
			{ origin: "https://evil.example", authorization: "Bearer eyJ.x.y" },
		],
		["identity headers with no Origin or fetch metadata", {}],
	])("%s is refused with 403", async (_label, headers) => {
		const res = auth().csrfRejection(post(headers));
		expect(res?.status).toBe(403);
		expect(
			((await res?.json()) as { error: { code: string } }).error.code,
		).toBe("forbidden");
	});

	test("a client with no Origin, no fetch metadata and nothing ambient passes", () => {
		expect(auth().csrfRejection(post({}, null))).toBeNull();
	});

	test("an app cookie counts as ambient", () => {
		expect(
			auth().csrfRejection(post({ cookie: "theme=dark" }, null))?.status,
		).toBe(403);
	});

	test("GETs pass, except the stream paths", () => {
		const a = auth();
		expect(
			a.csrfRejection(
				req("/api/items", ALICE, {
					headers: { "sec-fetch-site": "cross-site" },
				}),
			),
		).toBeNull();
		expect(
			a.csrfRejection(
				req("/api/events", ALICE, {
					headers: { "sec-fetch-site": "cross-site" },
				}),
			)?.status,
		).toBe(403);
	});
});

describe("configuration", () => {
	test.each<
		[string, Partial<CloudAuthConfig<Record<string, unknown>>>, string]
	>([
		["a short edge secret", { edgeSecret: "short" }, "edgeSecret"],
		["no owner email", { ownerEmail: " " }, "ownerEmail"],
		["an owner email without an @", { ownerEmail: "owner" }, "ownerEmail"],
		["a public URL that is not a URL", { publicUrl: "recipes" }, "publicUrl"],
		[
			"a public URL that is not http(s)",
			{ publicUrl: "ftp://x.example" },
			"publicUrl",
		],
	])("%s is an error, never an open door", async (_label, overrides, name) => {
		await expect(auth(overrides).resolveUser(req("/", OWNER))).rejects.toThrow(
			name,
		);
	});
});
