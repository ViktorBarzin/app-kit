/**
 * App-side sign-in against Authentik (ADR-0001, Identity and access):
 * Better Auth's generic OAuth with PKCE and a verified id_token, sessions in
 * the app's database (Drizzle adapter), host-only `__Host-` cookies, exact
 * trustedOrigins, sessions capped at 7 days and never extended, and no
 * `offline_access`. Plus bearer tokens for non-browser clients, the 15-minute
 * membership re-check, request + approve, and the CSRF origin check.
 *
 * Sign-in goes through `<basePath>/start` and `<basePath>/finish`, not Better
 * Auth's own /sign-in/social over HTTP. Everything here takes a Request and
 * returns a Response or data; the app wires it into its framework's routes
 * and middleware.
 */
import { getLogger, type Logger } from "@viktorbarzin/log";
import {
	createDiscoveredVerifier,
	type DiscoveredVerifier,
	type VerifiedToken,
} from "@viktorbarzin/oidc-token";
import {
	ApiError,
	createErrorResponder,
	errorResponse,
} from "@viktorbarzin/runtime";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, getOAuthState } from "better-auth/api";
import {
	type GenericOAuthUserInfo,
	genericOAuth,
} from "better-auth/plugins/generic-oauth";
import { and, asc, eq } from "drizzle-orm";

import { AuthentikUnavailable, createAuthentikClient } from "./authentik.js";
import {
	type AccessStatus,
	type AppAuthConfig,
	type AuthDb,
	type AuthUser,
	DEFAULTS,
	type PendingRequestView,
} from "./config.js";
import { isSameOriginRequest } from "./csrf.js";
import {
	createMembershipChecker,
	fileAccessRequest,
	getAccessRequest,
	type Membership,
	type MembershipOptions,
	readMemberCheck,
	recordClaimedGroups,
	saveMemberCheck,
} from "./membership.js";
import { type AuthMetrics, authMetrics } from "./metrics.js";
import {
	LOGIN_PARAM,
	pathWithReturn,
	safeReturnPath,
	signInPaths,
} from "./return-path.js";
import { accessRequests, authAccount, betterAuthModels } from "./schema.js";

/** Better Auth endpoints an app does not use; refused over HTTP (404). */
export const DISABLED_PATHS: readonly string[] = [
	"/sign-in/social",
	"/sign-in/oauth2",
	"/sign-in/email",
	"/sign-up/email",
	"/update-user",
	"/delete-user",
	"/change-email",
	"/change-password",
	"/set-password",
	"/request-password-reset",
	"/reset-password",
	"/link-social",
	"/unlink-account",
	"/list-accounts",
	"/account-info",
	"/get-access-token",
	"/refresh-token",
	"/update-session",
];

/** How often a missing provider (discovery failed at init) may trigger a rebuild. */
const REBUILD_INTERVAL_MS = 10_000;

/** The config with every default filled in. */
function resolve<TExtra extends object>(config: AppAuthConfig<TExtra>) {
	const publicOrigins = config.publicOrigins.map(
		(origin) => new URL(origin).origin,
	);
	return {
		...config,
		publicOrigins,
		providerId: config.providerId ?? DEFAULTS.providerId,
		basePath: config.basePath ?? DEFAULTS.basePath,
		scopes: config.scopes ?? [...DEFAULTS.scopes],
		sessionMaxAgeSeconds:
			config.sessionMaxAgeSeconds ?? DEFAULTS.sessionMaxAgeSeconds,
		cookiePrefix: config.cookiePrefix ?? `__Host-${config.appSlug}`,
		clientIpHeader: config.clientIpHeader ?? DEFAULTS.clientIpHeader,
		apiTokenAudiences:
			config.apiTokenAudiences ?? (config.oidc ? [config.oidc.clientId] : []),
		guestUsername: config.guestUsername ?? DEFAULTS.guestUsername,
		membershipMaxAgeMs:
			config.membershipMaxAgeMs ?? DEFAULTS.membershipMaxAgeMs,
		adminRecheckMaxAgeMs:
			config.adminRecheckMaxAgeMs ?? DEFAULTS.adminRecheckMaxAgeMs,
		devUser: config.devUser ?? null,
		streamPaths: config.streamPaths ?? [...DEFAULTS.streamPaths],
		loggerPrefix: config.loggerPrefix ?? config.appSlug,
	};
}
type Resolved<TExtra extends object> = ReturnType<typeof resolve<TExtra>>;

function buildBetterAuth<TExtra extends object>(
	cfg: Resolved<TExtra>,
	oidc: NonNullable<AppAuthConfig["oidc"]>,
	secret: string,
	onVerifiedProfile: (profile: GenericOAuthUserInfo) => Promise<{
		name: string;
		email: string;
		emailVerified: boolean;
		image: undefined;
	}>,
) {
	const baseURL = cfg.publicOrigins[0];
	if (!baseURL)
		throw new Error("publicOrigins must be set when OIDC sign-in is enabled");
	return betterAuth({
		appName: cfg.appName,
		baseURL,
		basePath: cfg.basePath,
		secret,
		trustedOrigins: cfg.publicOrigins,
		database: drizzleAdapter(cfg.db(), {
			provider: "pg",
			schema: betterAuthModels,
		}),
		user: { modelName: "auth_user" },
		session: {
			modelName: "auth_session",
			expiresIn: cfg.sessionMaxAgeSeconds,
			// An absolute cap: the expiry is never pushed out.
			disableSessionRefresh: true,
			cookieCache: { enabled: false },
		},
		account: {
			modelName: "auth_account",
			// Never link accounts by email: users are keyed on sub.
			accountLinking: { enabled: false },
			encryptOAuthTokens: true,
		},
		verification: { modelName: "auth_verification" },
		emailAndPassword: { enabled: false },
		disabledPaths: [...DISABLED_PATHS],
		telemetry: { enabled: false },
		advanced: {
			// The rate limiter (on in production) keys on the client IP. Behind a
			// CDN and Traefik, X-Forwarded-For carries several hops; the ingress's
			// real-ip plugin overwrites this header with the TCP peer's address,
			// so a client cannot spoof it.
			ipAddress: { ipAddressHeaders: [cfg.clientIpHeader] },
			// `__Host-` needs Secure, Path=/ and no Domain; Better Auth would add
			// its own `__Secure-` prefix with useSecureCookies.
			cookiePrefix: cfg.cookiePrefix,
			useSecureCookies: false,
			defaultCookieAttributes: {
				secure: true,
				sameSite: "lax",
				path: "/",
				httpOnly: true,
			},
		},
		plugins: [
			genericOAuth({
				config: [
					{
						providerId: cfg.providerId,
						name: cfg.providerId,
						discoveryUrl: oidc.discoveryUrl,
						requireIdTokenVerification: true,
						clientId: oidc.clientId,
						clientSecret: oidc.clientSecret,
						// No offline_access: web sign-in gets no refresh token.
						scopes: cfg.scopes,
						pkce: true,
						disableProviderLogout: true,
						overrideUserInfo: true,
						mapProfileToUser: onVerifiedProfile,
					},
				],
			}),
		],
	});
}

export type BetterAuthInstance = ReturnType<typeof buildBetterAuth>;

export interface AppAuth<TExtra extends object> {
	/** The Better Auth instance, or null when sign-in is not configured. */
	getAuth(): BetterAuthInstance | null;
	/** GET <basePath>/start?return=<path>[&login=1]: redirect to the provider. 503 auth_unavailable when it cannot. */
	startSignIn(request: Request): Promise<Response>;
	/** GET <basePath>/finish?return=<path>: Better Auth set the session cookie; go back. */
	finishSignIn(request: Request): Response;
	/** Everything else under <basePath>: callback, sign-out, get-session, error page. */
	handleAuthRequest(request: Request): Promise<Response>;
	/** A redirect into sign-in that comes back to `returnTo`; null when sign-in is off. */
	signInRedirect(returnTo: string): Response | null;
	startUrl(returnTo: string, forceLogin: boolean): string;
	/** The caller, or null. A refused bearer token is null even with a cookie. Membership is not enforced. */
	resolveUser(request: Request): Promise<(AuthUser & TExtra) | null>;
	/** The caller, or ApiError 401 unauthorized / 403 access_pending. */
	requireUser(request: Request): Promise<AuthUser & TExtra>;
	/** Resolve the caller, run `fn`, map errors to the envelope. */
	handleApi(
		request: Request,
		fn: (user: AuthUser & TExtra) => Promise<Response>,
		toError?: (err: unknown, request: Request) => Response,
	): Promise<Response>;
	accessStatus(
		request: Request,
		opts?: { recheck?: boolean },
	): Promise<AccessStatus>;
	/** Throws ApiError 403 unless the user is an admin right now (re-checked within adminRecheckMaxAgeMs). */
	requireAdmin(user: AuthUser): Promise<void>;
	listPendingRequests(admin: AuthUser): Promise<PendingRequestView[]>;
	/** 404 not_found / 409 conflict / 502 authentik_unavailable. */
	approveRequest(admin: AuthUser, sub: string): Promise<void>;
	currentMembership(
		sub: string,
		username: string,
		opts?: MembershipOptions,
	): Promise<Membership>;
	/** The 403 envelope for a refused cross-origin request, or null to let it through. */
	csrfRejection(request: Request): Response | null;
}

function redirect(location: string, extra?: HeadersInit): Response {
	const headers = new Headers(extra);
	headers.set("location", location);
	headers.set("cache-control", "no-store");
	return new Response(null, { status: 302, headers });
}

/** Copy every Set-Cookie from Better Auth's headers onto a response. */
function withCookies(response: Response, from: Headers): Response {
	for (const cookie of from.getSetCookie())
		response.headers.append("set-cookie", cookie);
	return response;
}

function authKey<TExtra extends object>(cfg: Resolved<TExtra>): string {
	return JSON.stringify([
		cfg.appName,
		cfg.publicOrigins,
		cfg.betterAuthSecret,
		cfg.oidc,
		cfg.providerId,
		cfg.basePath,
		cfg.scopes,
		cfg.sessionMaxAgeSeconds,
		cfg.cookiePrefix,
		cfg.clientIpHeader,
	]);
}

/**
 * The app's identity layer. `config` is re-read on every call (cheap; the app
 * builds it from the environment); the Better Auth instance is rebuilt only
 * when its settings change.
 */
export function createAppAuth<TExtra extends object = Record<never, never>>(
	config: () => AppAuthConfig<TExtra>,
): AppAuth<TExtra> {
	const current = () => resolve(config());
	const loggers = new Map<string, Logger>();
	const logger = (part: string): Logger => {
		const cfg = config();
		if (cfg.logger) return cfg.logger;
		const name = `${cfg.loggerPrefix ?? cfg.appSlug}.${part}`;
		let found = loggers.get(name);
		if (!found) {
			found = getLogger(name);
			loggers.set(name, found);
		}
		return found;
	};
	const metrics = (): AuthMetrics => {
		const m = config().metrics;
		return authMetrics({
			...(m?.registry ? { registry: m.registry } : {}),
			prefix: m?.prefix ?? DEFAULTS.metricsPrefix,
		});
	};
	const authentik = () => {
		const cfg = config();
		return createAuthentikClient({
			...cfg.authentik,
			usersGroup: cfg.groups.users,
			logger: logger("authentik"),
		});
	};
	const membership = createMembershipChecker({
		authentik,
		groups: () => config().groups,
		defaultMaxAgeMs: () => current().membershipMaxAgeMs,
		metrics,
		log: logger("membership"),
	});

	let instance: { auth: BetterAuthInstance; key: string } | null = null;
	let lastRebuild = 0;
	let verifier: { key: string; verifier: DiscoveredVerifier } | null = null;

	async function enrich(
		db: AuthDb,
		sub: string | null,
		username: string,
	): Promise<TExtra> {
		const hook = config().enrich;
		return hook ? hook(db, { sub, username }) : ({} as TExtra);
	}

	/** The anonymous guest came back: retry with prompt=login once, then stop on the error page. */
	async function redirectGuest(cfg: Resolved<TExtra>): Promise<never> {
		metrics().signIns.inc({ outcome: "guest" });
		const paths = signInPaths(cfg.basePath);
		const state = await getOAuthState().catch(() => null);
		const callback = new URL(
			state?.callbackURL ?? paths.finish,
			"http://app.invalid",
		);
		const returnTo = callback.searchParams.get("return") ?? "/";
		const retried = callback.searchParams.has(LOGIN_PARAM);
		const location = retried
			? `${paths.error}?error=guest_session`
			: pathWithReturn(paths.start, returnTo, true);
		logger("auth").info(
			"guest session at the identity provider; asking for a real login",
			{ retried },
		);
		throw new APIError("FOUND", undefined, { location });
	}

	/**
	 * Runs on every sign-in, after Better Auth verified the id_token (issuer,
	 * audience, signature, nonce): records the membership answer the token
	 * carries and, for a non-member in request mode, an access request.
	 */
	async function onVerifiedProfile(profile: GenericOAuthUserInfo) {
		const cfg = current();
		const sub =
			typeof profile.sub === "string" ? profile.sub : String(profile.sub ?? "");
		const username =
			typeof profile.preferred_username === "string"
				? profile.preferred_username
				: "";
		if (!sub || !username) {
			throw new APIError("UNAUTHORIZED", {
				message: "the identity provider sent no sub or username",
			});
		}
		if (username === cfg.guestUsername) await redirectGuest(cfg);
		const email =
			typeof profile.email === "string" && profile.email !== ""
				? profile.email
				: null;
		const name =
			typeof profile.name === "string" && profile.name !== ""
				? profile.name
				: username;
		const db = cfg.db();
		await recordClaimedGroups(
			db,
			sub,
			username,
			profile.groups,
			"id_token",
			cfg.groups,
		);
		await enrich(db, sub, username);
		const answer = await membership.current(db, sub, username);
		if (!answer.member && cfg.signup === "request")
			await fileAccessRequest(db, { sub, username, email, name });
		metrics().signIns.inc({ outcome: answer.member ? "member" : "pending" });
		logger("auth").info("signed in", {
			sub,
			user: username,
			member: answer.member,
		});
		return {
			name,
			// Better Auth needs an email; it is never used to authorize (users are keyed on sub).
			email: email ?? `${sub}@users.${cfg.appSlug}.invalid`,
			emailVerified: profile.email_verified === true,
			image: undefined,
		};
	}

	function getAuth(): BetterAuthInstance | null {
		const cfg = current();
		if (!cfg.oidc || !cfg.betterAuthSecret) return null;
		const key = authKey(cfg);
		if (instance?.key !== key)
			instance = {
				auth: buildBetterAuth(
					cfg,
					cfg.oidc,
					cfg.betterAuthSecret,
					onVerifiedProfile,
				),
				key,
			};
		return instance.auth;
	}

	/**
	 * The instance with the provider registered. Better Auth skips a provider
	 * whose discovery fetch failed at init; rebuild (at most every 10 s) so a
	 * provider blip at pod start does not disable sign-in until a restart.
	 */
	async function getAuthWithProvider(): Promise<BetterAuthInstance | null> {
		const auth = getAuth();
		if (!auth) return null;
		const providerId = current().providerId;
		const registered = async (a: BetterAuthInstance) =>
			(await a.$context).socialProviders.some(
				(provider) => provider.id === providerId,
			);
		if (await registered(auth)) return auth;
		const now = Date.now();
		if (now - lastRebuild >= REBUILD_INTERVAL_MS) {
			lastRebuild = now;
			instance = null;
			const rebuilt = getAuth();
			if (rebuilt && (await registered(rebuilt))) return rebuilt;
		}
		logger("auth").warning(
			"the identity provider is not registered; discovery failed",
		);
		return null;
	}

	function tokenVerifier(): DiscoveredVerifier | null {
		const cfg = current();
		if (!cfg.oidc) return null;
		const key = JSON.stringify([cfg.oidc.discoveryUrl, cfg.apiTokenAudiences]);
		if (verifier?.key !== key) {
			verifier = {
				key,
				verifier: createDiscoveredVerifier({
					discoveryUrl: cfg.oidc.discoveryUrl,
					audiences: cfg.apiTokenAudiences,
					onOutcome: (outcome) => metrics().tokenVerifications.inc({ outcome }),
					logger: logger("tokens"),
				}),
			};
		}
		return verifier.verifier;
	}

	async function userFromToken(
		token: VerifiedToken,
	): Promise<(AuthUser & TExtra) | null> {
		const cfg = current();
		if (token.preferredUsername === cfg.guestUsername) return null;
		const db = cfg.db();
		if (!(await readMemberCheck(db, token.sub)))
			await recordClaimedGroups(
				db,
				token.sub,
				token.preferredUsername,
				token.groups,
				"token",
				cfg.groups,
			);
		const answer = await membership.current(
			db,
			token.sub,
			token.preferredUsername,
		);
		const extra = await enrich(db, token.sub, token.preferredUsername);
		return {
			...extra,
			sub: token.sub,
			username: token.preferredUsername,
			via: "token",
			...answer,
		};
	}

	async function sessionUser(
		request: Request,
	): Promise<(AuthUser & TExtra) | null> {
		if (!request.headers.get("cookie")) return null;
		const auth = getAuth();
		if (!auth) return null;
		const found = await auth.api.getSession({
			headers: request.headers,
			query: { disableCookieCache: true, disableRefresh: true },
		});
		if (!found) return null;
		const cfg = current();
		const db = cfg.db();
		const [account] = await db
			.select({ sub: authAccount.accountId })
			.from(authAccount)
			.where(
				and(
					eq(authAccount.userId, found.user.id),
					eq(authAccount.providerId, cfg.providerId),
				),
			)
			.limit(1);
		if (!account) return null;
		const sub = account.sub;
		// The username the verified id_token carried at the last sign-in.
		const username =
			(await readMemberCheck(db, sub))?.username ?? found.user.name;
		if (username === cfg.guestUsername) return null;
		const answer = await membership.current(db, sub, username);
		const extra = await enrich(db, sub, username);
		return { ...extra, sub, username, via: "session", ...answer };
	}

	async function resolveUser(
		request: Request,
	): Promise<(AuthUser & TExtra) | null> {
		if (request.headers.has("authorization")) {
			const check = tokenVerifier();
			if (!check) {
				metrics().tokenVerifications.inc({ outcome: "not_configured" });
				return null;
			}
			const token = await check.verifyRequest(request);
			return token ? userFromToken(token) : null;
		}
		const fromSession = await sessionUser(request);
		if (fromSession) return fromSession;
		const cfg = current();
		if (cfg.devUser) {
			const extra = await enrich(cfg.db(), null, cfg.devUser);
			return {
				...extra,
				sub: null,
				username: cfg.devUser,
				via: "dev",
				member: true,
				admin: true,
			};
		}
		return null;
	}

	async function requireUser(request: Request): Promise<AuthUser & TExtra> {
		const user = await resolveUser(request);
		if (!user) throw new ApiError(401, "unauthorized", "not signed in");
		if (!user.member)
			throw new ApiError(403, "access_pending", "waiting for approval");
		return user;
	}

	async function requireAdmin(user: AuthUser): Promise<void> {
		if (user.via === "dev") return;
		if (!user.sub) throw new ApiError(403, "forbidden", "admins only");
		const cfg = current();
		// A fresh answer for an admin action; when the provider cannot say, the
		// last answer stands, as for every other check.
		const answer = await membership.current(cfg.db(), user.sub, user.username, {
			maxAgeMs: cfg.adminRecheckMaxAgeMs,
		});
		if (!answer.admin) throw new ApiError(403, "forbidden", "admins only");
	}

	return {
		getAuth,
		async startSignIn(request) {
			const cfg = current();
			const url = new URL(request.url);
			const returnTo = safeReturnPath(url.searchParams.get("return"));
			const forceLogin = url.searchParams.has(LOGIN_PARAM);
			const auth = await getAuthWithProvider();
			if (!auth)
				return errorResponse(
					503,
					"auth_unavailable",
					"sign-in is not available right now",
				);
			const paths = signInPaths(cfg.basePath);
			const { headers, response } = await auth.api.signInSocial({
				body: {
					provider: cfg.providerId,
					callbackURL: pathWithReturn(paths.finish, returnTo, forceLogin),
					errorCallbackURL: paths.error,
					disableRedirect: true,
					...(forceLogin ? { additionalParams: { prompt: "login" } } : {}),
				},
				headers: request.headers,
				returnHeaders: true,
			});
			if (!response.url)
				throw new Error("Better Auth returned no authorization URL");
			return withCookies(redirect(response.url), headers);
		},
		finishSignIn(request) {
			return redirect(
				safeReturnPath(new URL(request.url).searchParams.get("return")),
			);
		},
		async handleAuthRequest(request) {
			const auth = getAuth();
			if (!auth)
				return errorResponse(404, "not_found", "sign-in is not configured");
			const response = await auth.handler(request);
			if (response.status >= 500) {
				logger("auth").warning("auth endpoint failed", {
					path: new URL(request.url).pathname,
					status: response.status,
				});
			}
			return response;
		},
		signInRedirect(returnTo) {
			if (!getAuth()) return null;
			return redirect(
				pathWithReturn(signInPaths(current().basePath).start, returnTo, false),
			);
		},
		startUrl(returnTo, forceLogin) {
			return pathWithReturn(
				signInPaths(current().basePath).start,
				returnTo,
				forceLogin,
			);
		},
		resolveUser,
		requireUser,
		async handleApi(request, fn, toError) {
			const respond =
				toError ?? createErrorResponder({ logger: logger("api") });
			try {
				return await fn(await requireUser(request));
			} catch (err) {
				return respond(err, request);
			}
		},
		async accessStatus(request, opts = {}) {
			let user = await resolveUser(request);
			if (!user)
				return {
					signedIn: false,
					username: null,
					member: false,
					admin: false,
					requestedAt: null,
				};
			const cfg = current();
			const db = cfg.db();
			if (opts.recheck && user.sub) {
				const answer = await membership.current(db, user.sub, user.username, {
					maxAgeMs: 0,
				});
				user = { ...user, ...answer };
			}
			const pending =
				user.sub && !user.member ? await getAccessRequest(db, user.sub) : null;
			return {
				signedIn: true,
				username: user.username,
				member: user.member,
				admin: user.admin,
				requestedAt:
					pending?.status === "pending"
						? pending.requestedAt.toISOString()
						: null,
			};
		},
		requireAdmin,
		async listPendingRequests(admin) {
			await requireAdmin(admin);
			const rows = await current()
				.db()
				.select()
				.from(accessRequests)
				.where(eq(accessRequests.status, "pending"))
				.orderBy(asc(accessRequests.requestedAt));
			return rows.map((row) => ({
				sub: row.sub,
				username: row.username,
				email: row.email,
				name: row.name,
				requestedAt: row.requestedAt.toISOString(),
			}));
		},
		async approveRequest(admin, sub) {
			await requireAdmin(admin);
			const cfg = current();
			const db = cfg.db();
			const request = await getAccessRequest(db, sub);
			if (!request || request.status !== "pending")
				throw new ApiError(
					404,
					"not_found",
					"no pending request for that person",
				);
			try {
				const client = authentik();
				const user = await client.findUser(request.sub, request.username);
				if (!user || !user.isActive)
					throw new ApiError(
						409,
						"conflict",
						"that Authentik account no longer exists",
					);
				await client.addToUsersGroup(user.pk);
				await saveMemberCheck(
					db,
					request.sub,
					request.username,
					{ member: true, admin: user.groups.includes(cfg.groups.admins) },
					"api",
				);
			} catch (err) {
				if (err instanceof AuthentikUnavailable) {
					logger("access").warning(
						"approval failed: Authentik did not answer",
						{ sub, error: err.message },
					);
					throw new ApiError(
						502,
						"authentik_unavailable",
						"Authentik did not accept the change; try again",
					);
				}
				throw err;
			}
			await db
				.update(accessRequests)
				.set({
					status: "approved",
					decidedBy: admin.username,
					decidedAt: new Date(),
				})
				.where(
					and(
						eq(accessRequests.sub, sub),
						eq(accessRequests.status, "pending"),
					),
				);
			logger("access").info("access request approved", {
				sub,
				user: request.username,
				by: admin.username,
			});
		},
		currentMembership(sub, username, opts) {
			return membership.current(current().db(), sub, username, opts);
		},
		csrfRejection(request) {
			const cfg = current();
			if (isSameOriginRequest(request, cfg.publicOrigins, cfg.streamPaths))
				return null;
			metrics().csrfRejections.inc();
			return errorResponse(403, "forbidden", "cross-origin request refused");
		},
	};
}
