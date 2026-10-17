/**
 * A mock Authentik for tests: an OIDC provider (discovery, authorize, token,
 * userinfo, JWKS) and the few /api/v3 calls the app makes (user lookup, group
 * lookup, add_user). Runs on 127.0.0.1 with a random port.
 *
 * The provider behaves like Authentik where the app depends on it:
 * - `sub` is the user's `uid` (sub_mode hashed_user_id), id_tokens and access
 *   tokens are RS256 JWTs with `aud` = client_id;
 * - authorization codes require PKCE S256 and the client secret;
 * - a refresh token is issued only when `offline_access` was requested;
 * - the browser's provider session may be the anonymous `guest`, which is
 *   what a silent authorize returns until `prompt=login` makes the user log in.
 *
 * Nothing here is safe outside tests: tokens are fixed strings.
 */
import { createHash, randomUUID } from "node:crypto";
import {
	exportJWK,
	generateKeyPair,
	type JWK,
	type JWTPayload,
	SignJWT,
} from "jose";

export interface MockUser {
	pk: number;
	uid: string;
	username: string;
	email: string | null;
	name: string;
	isActive: boolean;
	groups: string[];
}

export interface AuthorizeRecord {
	clientId: string;
	scope: string;
	prompt: string | null;
	codeChallengeMethod: string | null;
	nonce: string | null;
	user: string;
}

interface IssuedCode {
	clientId: string;
	redirectUri: string;
	challenge: string;
	nonce: string | null;
	scope: string;
	user: MockUser;
}

export interface MockAuthentik {
	/** The provider's issuer, e.g. http://127.0.0.1:1234/application/o/<slug>/ */
	issuer: string;
	discoveryUrl: string;
	apiUrl: string;
	clientId: string;
	clientSecret: string;
	readerToken: string;
	approverToken: string;
	usersGroupPk: string;
	/** The users group's name: the group lookup answers it and add_user adds it. */
	usersGroup: string;
	users: Map<string, MockUser>;
	/** Who the browser is signed in as at the provider: a username, or null (no session). */
	session: string | null;
	/** Who logs in when the provider shows its login form (no session, or prompt=login). */
	loginAs: string | null;
	authorizations: AuthorizeRecord[];
	tokenRequests: Array<{ grantType: string; scope: string }>;
	apiCalls: Array<{ method: string; path: string; token: string | null }>;
	/** Fail every /api/v3 call with this status (simulate an outage). */
	apiFailure: number | null;
	addUser(user: Partial<MockUser> & { username: string }): MockUser;
	/** Sign an access token for bearer tests. */
	mintAccessToken(
		claims: JWTPayload,
		options?: { alg?: string; expiresIn?: string | number; audience?: string },
	): Promise<string>;
	stop(): Promise<void>;
}

function b64url(buffer: Buffer): string {
	return buffer.toString("base64url");
}

export interface MockAuthentikOptions {
	clientId: string;
	clientSecret?: string;
	/** The application slug in the issuer path. Defaults to clientId. */
	slug?: string;
	/** Defaults to "App Users". */
	usersGroup?: string;
	users?: Array<Partial<MockUser> & { username: string }>;
}

export async function startMockAuthentik(
	options: MockAuthentikOptions,
): Promise<MockAuthentik> {
	const { privateKey, publicKey } = await generateKeyPair("RS256", {
		extractable: true,
	});
	const jwk: JWK = {
		...(await exportJWK(publicKey)),
		kid: "mock-rs256",
		alg: "RS256",
		use: "sig",
	};
	const codes = new Map<string, IssuedCode>();
	const accessTokens = new Map<string, MockUser>();
	let pkSeq = 100;

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (request) => handle(request),
	});
	const origin = `http://127.0.0.1:${server.port}`;
	const slug = options.slug ?? options.clientId;
	const appPath = `/application/o/${slug}/`;
	const issuer = `${origin}${appPath}`;

	const mock: MockAuthentik = {
		issuer,
		discoveryUrl: `${issuer}.well-known/openid-configuration`,
		apiUrl: origin,
		clientId: options.clientId,
		clientSecret: options.clientSecret ?? `${options.clientId}-secret`,
		readerToken: "reader-token",
		approverToken: "approver-token",
		usersGroupPk: "0b6c8f0e-4c1e-4a43-9d39-6f0c1d2a7e11",
		usersGroup: options.usersGroup ?? "App Users",
		users: new Map(),
		session: null,
		loginAs: null,
		authorizations: [],
		tokenRequests: [],
		apiCalls: [],
		apiFailure: null,
		addUser(partial) {
			pkSeq += 1;
			const user: MockUser = {
				pk: partial.pk ?? pkSeq,
				uid:
					partial.uid ??
					createHash("sha256").update(`${pkSeq}-mock`).digest("hex"),
				username: partial.username,
				email: partial.email === undefined ? partial.username : partial.email,
				name: partial.name ?? partial.username,
				isActive: partial.isActive ?? true,
				groups: partial.groups ?? [],
			};
			mock.users.set(user.username, user);
			return user;
		},
		async mintAccessToken(claims, opts = {}) {
			const alg = opts.alg ?? "RS256";
			if (alg !== "RS256") {
				// A symmetric token signed with a key the verifier does not hold.
				return new SignJWT(claims)
					.setProtectedHeader({ alg })
					.setIssuer(issuer)
					.setAudience(opts.audience ?? mock.clientId)
					.setIssuedAt()
					.setExpirationTime(opts.expiresIn ?? "15m")
					.sign(new TextEncoder().encode("x".repeat(64)));
			}
			return new SignJWT(claims)
				.setProtectedHeader({ alg, kid: jwk.kid })
				.setIssuer(issuer)
				.setAudience(opts.audience ?? mock.clientId)
				.setIssuedAt()
				.setExpirationTime(opts.expiresIn ?? "15m")
				.sign(privateKey);
		},
		async stop() {
			await server.stop(true);
		},
	};

	function claimsFor(user: MockUser): JWTPayload {
		return {
			sub: user.uid,
			preferred_username: user.username,
			name: user.name,
			...(user.email ? { email: user.email, email_verified: true } : {}),
			groups: user.groups,
		};
	}

	async function handle(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;
		if (path === `${appPath}.well-known/openid-configuration`) {
			return Response.json({
				issuer,
				authorization_endpoint: `${origin}/application/o/authorize/`,
				token_endpoint: `${origin}/application/o/token/`,
				userinfo_endpoint: `${origin}/application/o/userinfo/`,
				end_session_endpoint: `${origin}${appPath}end-session/`,
				jwks_uri: `${origin}${appPath}jwks/`,
				response_types_supported: ["code"],
				id_token_signing_alg_values_supported: ["RS256"],
				code_challenge_methods_supported: ["S256", "plain"],
				scopes_supported: ["openid", "profile", "email", "offline_access"],
			});
		}
		if (path === `${appPath}jwks/`) return Response.json({ keys: [jwk] });
		if (path === "/application/o/authorize/") return authorize(url);
		if (path === "/application/o/token/" && request.method === "POST") {
			return token(request);
		}
		if (path === "/application/o/userinfo/") {
			const bearer = request.headers
				.get("authorization")
				?.replace(/^Bearer /, "");
			const user = bearer ? accessTokens.get(bearer) : undefined;
			if (!user) return new Response("unauthorized", { status: 401 });
			return Response.json(claimsFor(user));
		}
		if (path.startsWith("/api/v3/")) return api(request, url);
		return new Response("not found", { status: 404 });
	}

	function authorize(url: URL): Response {
		const params = url.searchParams;
		const clientId = params.get("client_id") ?? "";
		const redirectUri = params.get("redirect_uri") ?? "";
		const prompt = params.get("prompt");
		if (clientId !== mock.clientId)
			return new Response("bad client", { status: 400 });
		// A session at the provider answers silently; prompt=login (or no
		// session) shows the login form, and `loginAs` logs in.
		let username = mock.session;
		if (prompt === "login" || username === null) {
			username = mock.loginAs;
			if (username) mock.session = username;
		}
		mock.authorizations.push({
			clientId,
			scope: params.get("scope") ?? "",
			prompt,
			codeChallengeMethod: params.get("code_challenge_method"),
			nonce: params.get("nonce"),
			user: username ?? "",
		});
		const user = username ? mock.users.get(username) : undefined;
		if (!user) return new Response("login form", { status: 200 });
		const code = randomUUID();
		codes.set(code, {
			clientId,
			redirectUri,
			challenge: params.get("code_challenge") ?? "",
			nonce: params.get("nonce"),
			scope: params.get("scope") ?? "",
			user,
		});
		const back = new URL(redirectUri);
		back.searchParams.set("code", code);
		back.searchParams.set("state", params.get("state") ?? "");
		back.searchParams.set("iss", issuer);
		return new Response(null, {
			status: 302,
			headers: { location: back.toString() },
		});
	}

	async function token(request: Request): Promise<Response> {
		const form = new URLSearchParams(await request.text());
		let clientId = form.get("client_id");
		let clientSecret = form.get("client_secret");
		const basic = request.headers.get("authorization");
		if (basic?.startsWith("Basic ")) {
			const [id, secret] = Buffer.from(basic.slice(6), "base64")
				.toString()
				.split(":");
			clientId = decodeURIComponent(id ?? "");
			clientSecret = decodeURIComponent(secret ?? "");
		}
		mock.tokenRequests.push({
			grantType: form.get("grant_type") ?? "",
			scope: form.get("scope") ?? "",
		});
		if (clientId !== mock.clientId || clientSecret !== mock.clientSecret) {
			return Response.json({ error: "invalid_client" }, { status: 401 });
		}
		if (form.get("grant_type") !== "authorization_code") {
			return Response.json(
				{ error: "unsupported_grant_type" },
				{ status: 400 },
			);
		}
		const issued = codes.get(form.get("code") ?? "");
		codes.delete(form.get("code") ?? "");
		if (!issued || issued.redirectUri !== form.get("redirect_uri")) {
			return Response.json({ error: "invalid_grant" }, { status: 400 });
		}
		const verifier = form.get("code_verifier") ?? "";
		const challenge = b64url(createHash("sha256").update(verifier).digest());
		if (!issued.challenge || challenge !== issued.challenge) {
			return Response.json(
				{ error: "invalid_grant", error_description: "pkce" },
				{ status: 400 },
			);
		}
		const claims = claimsFor(issued.user);
		const idToken = await new SignJWT({
			...claims,
			...(issued.nonce ? { nonce: issued.nonce } : {}),
		})
			.setProtectedHeader({ alg: "RS256", kid: jwk.kid })
			.setIssuer(issuer)
			.setAudience(mock.clientId)
			.setIssuedAt()
			.setExpirationTime("15m")
			.sign(privateKey);
		const accessToken = await mock.mintAccessToken(claims);
		accessTokens.set(accessToken, issued.user);
		const scopes = issued.scope.split(" ");
		return Response.json({
			access_token: accessToken,
			token_type: "Bearer",
			expires_in: 900,
			id_token: idToken,
			scope: issued.scope,
			...(scopes.includes("offline_access")
				? { refresh_token: randomUUID() }
				: {}),
		});
	}

	async function api(request: Request, url: URL): Promise<Response> {
		const token =
			request.headers.get("authorization")?.replace(/^Bearer /, "") ?? null;
		const path = url.pathname.slice("/api/v3".length);
		mock.apiCalls.push({ method: request.method, path, token });
		if (mock.apiFailure !== null)
			return new Response("down", { status: mock.apiFailure });
		const reader = token === mock.readerToken;
		const approver = token === mock.approverToken;
		if (path === "/core/users/" && request.method === "GET") {
			if (!reader) return new Response("forbidden", { status: 403 });
			const username = url.searchParams.get("username");
			const results = [...mock.users.values()]
				.filter((user) => username === null || user.username === username)
				.map((user) => ({
					pk: user.pk,
					uid: user.uid,
					username: user.username,
					is_active: user.isActive,
					groups_obj: url.searchParams.get("include_groups")
						? user.groups.map((name) => ({ name, pk: randomUUID() }))
						: undefined,
				}));
			return Response.json({ pagination: { count: results.length }, results });
		}
		if (path === "/core/groups/" && request.method === "GET") {
			if (!reader) return new Response("forbidden", { status: 403 });
			const name = url.searchParams.get("name");
			const results =
				name === mock.usersGroup
					? [{ pk: mock.usersGroupPk, name: mock.usersGroup }]
					: [];
			return Response.json({ pagination: { count: results.length }, results });
		}
		const add = /^\/core\/groups\/([^/]+)\/add_user\/$/.exec(path);
		if (add && request.method === "POST") {
			// The approver token may only add users to the users group.
			if (!approver || add[1] !== mock.usersGroupPk) {
				return new Response("forbidden", { status: 403 });
			}
			const body = (await request.json()) as { pk?: number };
			const user = [...mock.users.values()].find((u) => u.pk === body.pk);
			if (!user) return Response.json({ detail: "not found" }, { status: 400 });
			if (!user.groups.includes(mock.usersGroup))
				user.groups.push(mock.usersGroup);
			return new Response(null, { status: 204 });
		}
		return new Response("not found", { status: 404 });
	}

	for (const user of options.users ?? []) mock.addUser(user);
	return mock;
}
