import { afterAll, describe, expect, test } from "bun:test";
import {
	createLocalJWKSet,
	exportJWK,
	generateKeyPair,
	type JWTPayload,
	SignJWT,
	UnsecuredJWT,
} from "jose";

import {
	bearerToken,
	createDiscoveredVerifier,
	createTokenVerifier,
	fetchDiscovery,
	PINNED_ALGORITHMS,
	type TokenOutcome,
} from "./index.js";

const ISSUER = "https://idp.example/application/o/app/";
const { privateKey, publicKey } = await generateKeyPair("RS256");
const publicJwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
const jwks = createLocalJWKSet({ keys: [publicJwk] });
const outcomes: TokenOutcome[] = [];
const verify = createTokenVerifier(
	{
		issuer: ISSUER,
		jwksUrl: "https://unused.example/jwks",
		audiences: ["app-web", "app-cli"],
	},
	{ keys: jwks, onOutcome: (o) => outcomes.push(o) },
);
const claims = {
	sub: "abc123",
	preferred_username: "someone@example.com",
	groups: ["App Users"],
};

function sign(payload: JWTPayload, edit: (jwt: SignJWT) => SignJWT = (j) => j) {
	return edit(
		new SignJWT(payload)
			.setProtectedHeader({ alg: "RS256", kid: "k1" })
			.setIssuer(ISSUER)
			.setAudience("app-web")
			.setIssuedAt()
			.setExpirationTime("15m"),
	).sign(privateKey);
}

async function outcomeOf(token: string): Promise<TokenOutcome | undefined> {
	outcomes.length = 0;
	await verify(token);
	return outcomes.at(-1);
}

describe("createTokenVerifier", () => {
	test("pins RS256", () => {
		expect(PINNED_ALGORITHMS).toEqual(["RS256"]);
	});

	test("accepts an RS256 token for the app and returns its claims", async () => {
		const verified = await verify(await sign(claims));
		expect(verified).toMatchObject({
			sub: "abc123",
			preferredUsername: "someone@example.com",
			groups: ["App Users"],
		});
		expect(verified?.claims.iss).toBe(ISSUER);
		expect(outcomes.at(-1)).toBe("ok");
	});

	test("accepts any of the app's client IDs as aud", async () => {
		expect(
			await verify(await sign(claims, (j) => j.setAudience("app-cli"))),
		).not.toBeNull();
	});

	test.each([
		["another audience", (j: SignJWT) => j.setAudience("grafana"), "bad_aud"],
		[
			"another issuer",
			(j: SignJWT) => j.setIssuer("https://evil.example/"),
			"bad_iss",
		],
		[
			"an expired token",
			(j: SignJWT) => j.setExpirationTime(Math.floor(Date.now() / 1000) - 120),
			"expired",
		],
	])("refuses %s", async (_name, edit, outcome) => {
		const token = await sign(claims, edit);
		expect(await verify(token)).toBeNull();
		expect(await outcomeOf(token)).toBe(outcome as TokenOutcome);
	});

	test("refuses a token without exp", async () => {
		const token = await new SignJWT(claims)
			.setProtectedHeader({ alg: "RS256", kid: "k1" })
			.setIssuer(ISSUER)
			.setAudience("app-web")
			.sign(privateKey);
		expect(await verify(token)).toBeNull();
		expect(await outcomeOf(token)).toBe("missing_claims");
	});

	test("refuses alg none", async () => {
		const token = new UnsecuredJWT(claims)
			.setIssuer(ISSUER)
			.setAudience("app-web")
			.setExpirationTime("15m")
			.encode();
		expect(await verify(token)).toBeNull();
		expect(await outcomeOf(token)).toBe("bad_alg");
	});

	test("refuses HS256 even when signed with the public key's bytes", async () => {
		const secret = new TextEncoder().encode(JSON.stringify(publicJwk));
		const token = await new SignJWT(claims)
			.setProtectedHeader({ alg: "HS256", kid: "k1" })
			.setIssuer(ISSUER)
			.setAudience("app-web")
			.setExpirationTime("15m")
			.sign(secret);
		expect(await verify(token)).toBeNull();
		expect(await outcomeOf(token)).toBe("bad_alg");
	});

	test("refuses a token without preferred_username", async () => {
		const token = await sign({ sub: "abc123" });
		expect(await verify(token)).toBeNull();
		expect(await outcomeOf(token)).toBe("missing_claims");
	});

	test("refuses a token signed by an unknown key", async () => {
		const other = await generateKeyPair("RS256");
		const token = await new SignJWT(claims)
			.setProtectedHeader({ alg: "RS256", kid: "k1" })
			.setIssuer(ISSUER)
			.setAudience("app-web")
			.setExpirationTime("15m")
			.sign(other.privateKey);
		expect(await verify(token)).toBeNull();
		expect(await outcomeOf(token)).toBe("invalid");
	});

	test("refuses junk", async () => {
		expect(await outcomeOf("not-a-jwt")).toBe("invalid");
	});

	test("algorithms can be configured", async () => {
		const strict = createTokenVerifier(
			{
				issuer: ISSUER,
				jwksUrl: "https://unused.example/jwks",
				audiences: ["app-web"],
				algorithms: ["ES256"],
			},
			{ keys: jwks },
		);
		expect(await strict(await sign(claims))).toBeNull();
	});
});

describe("bearerToken", () => {
	const with_ = (value: string) =>
		new Request("http://x/api/me", { headers: { authorization: value } });

	test("reads a bearer token", () => {
		expect(bearerToken(with_("Bearer a.b.c"))).toBe("a.b.c");
		expect(bearerToken(with_("bearer a.b.c"))).toBe("a.b.c");
	});

	test("ignores other schemes and junk", () => {
		expect(bearerToken(with_("Basic dXNlcjpwYXNz"))).toBeNull();
		expect(bearerToken(with_("Bearer a b"))).toBeNull();
		expect(bearerToken(new Request("http://x/"))).toBeNull();
	});
});

describe("discovery", () => {
	let discoveryHits = 0;
	let failDiscovery = false;
	const idp = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request: Request): Response {
			const { pathname } = new URL(request.url);
			if (pathname === "/o/app/.well-known/openid-configuration") {
				discoveryHits += 1;
				if (failDiscovery) return new Response("down", { status: 503 });
				return Response.json({
					issuer: `http://127.0.0.1:${idp.port}/o/app/`,
					jwks_uri: "/o/app/jwks/",
				});
			}
			if (pathname === "/o/app/jwks/")
				return Response.json({ keys: [publicJwk] });
			return new Response("not found", { status: 404 });
		},
	});
	afterAll(() => idp.stop(true));
	const base = `http://127.0.0.1:${idp.port}`;
	const discoveryUrl = `${base}/o/app/.well-known/openid-configuration`;

	test("fetchDiscovery resolves jwks_uri against the discovery URL", async () => {
		expect(await fetchDiscovery(discoveryUrl)).toEqual({
			issuer: `${base}/o/app/`,
			jwks_uri: `${base}/o/app/jwks/`,
		});
		await expect(fetchDiscovery(`${base}/nope`)).rejects.toThrow("404");
	});

	test("fetchDiscovery refuses a document without issuer or jwks_uri", async () => {
		const fake = (async () =>
			Response.json({ issuer: "x" })) as unknown as typeof fetch;
		await expect(fetchDiscovery("http://x/", { fetch: fake })).rejects.toThrow(
			"no issuer or jwks_uri",
		);
	});

	test("verifyRequest: discovery once, retried after a failure", async () => {
		const seen: TokenOutcome[] = [];
		const verifier = createDiscoveredVerifier({
			discoveryUrl,
			audiences: ["app-web"],
			onOutcome: (o) => seen.push(o),
		});
		const token = await new SignJWT(claims)
			.setProtectedHeader({ alg: "RS256", kid: "k1" })
			.setIssuer(`${base}/o/app/`)
			.setAudience("app-web")
			.setExpirationTime("15m")
			.sign(privateKey);
		const request = () =>
			new Request("http://app/api/x", {
				headers: { authorization: `Bearer ${token}` },
			});

		failDiscovery = true;
		discoveryHits = 0;
		expect(await verifier.verifyRequest(request())).toBeNull();
		expect(seen).toEqual(["no_discovery"]);

		failDiscovery = false;
		expect((await verifier.verifyRequest(request()))?.sub).toBe("abc123");
		expect((await verifier.verify(token))?.sub).toBe("abc123");
		expect(discoveryHits).toBe(2);
		expect(seen).toEqual(["no_discovery", "ok", "ok"]);
		expect(await verifier.verifyRequest(new Request("http://app/"))).toBeNull();
	});

	test("no audiences means not configured", async () => {
		const seen: TokenOutcome[] = [];
		const verifier = createDiscoveredVerifier({
			discoveryUrl,
			audiences: [],
			onOutcome: (o) => seen.push(o),
		});
		expect(await verifier.verify("a.b.c")).toBeNull();
		expect(seen).toEqual(["not_configured"]);
	});
});
