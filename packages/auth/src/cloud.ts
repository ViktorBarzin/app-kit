/**
 * Cloud mode: the app runs behind a platform edge that signs people in with
 * its own oauth2-proxy and forwards who they are as request headers.
 *
 * - Identity comes only from the `X-Cloud-User-*` headers, and only when the
 *   request also carries `X-Cloud-Edge-Secret` equal to the configured
 *   secret (compared in constant time). Without it the request is anonymous,
 *   whatever headers it has. The edge deletes client-sent copies of these
 *   headers; the secret covers traffic that reaches the pod another way.
 * - Everyone the edge lets through is a member: the edge enforces who may
 *   use a private app. The owner's email is the admin; `isAdmin` lets the app
 *   add admins from its own table.
 * - Sign-in and sign-out are links to the edge's oauth2-proxy
 *   (`/oauth2/start?rd=<path>`, `/oauth2/sign_out?rd=<path>`).
 * - No bearer tokens: an API call needs the browser's session at the edge.
 *
 * It returns the same AppAuth interface as createAppAuth, so app code is the
 * same in both modes.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { getLogger, type Logger } from "@viktorbarzin/log";
import {
	ApiError,
	createErrorResponder,
	errorResponse,
} from "@viktorbarzin/runtime";
import type { Registry } from "prom-client";

import type { AppAuth } from "./app-auth.js";
import { type AuthUser, DEFAULTS } from "./config.js";
import { isSameOriginRequest } from "./csrf.js";
import { type AuthMetrics, authMetrics } from "./metrics.js";
import { safeReturnPath } from "./return-path.js";

/** The request headers the edge sets (lower case, as `Headers` reports them). */
export const CLOUD_HEADERS = {
	/** The identity provider's user id (OIDC `sub`). */
	userId: "x-cloud-user-id",
	/** The verified email. */
	email: "x-cloud-user-email",
	/** The preferred username, when the provider has one. */
	username: "x-cloud-user-username",
	/** The app's edge secret, on every request the edge forwards. */
	edgeSecret: "x-cloud-edge-secret",
} as const;

export const CLOUD_DEFAULTS = {
	signInPath: "/oauth2/start",
	signOutPath: "/oauth2/sign_out",
	/** The shortest edge secret accepted. */
	minSecretLength: 32,
} as const;

/** Who the edge says the caller is. */
export interface CloudIdentity {
	sub: string;
	email: string;
	username: string;
}

export interface CloudAuthConfig<TExtra extends object = Record<never, never>> {
	/** DNS-label slug: the logger prefix derives from it. */
	appSlug: string;
	/** The secret the edge sends in X-Cloud-Edge-Secret; at least 32 characters. */
	edgeSecret: string;
	/** The owner's email: always an admin. Matched without case. */
	ownerEmail: string;
	/** The app's public URL, e.g. `https://myapp.example`; its origin is the CSRF allow-list. */
	publicUrl: string;
	/** More admins, e.g. from the app's own table; asked for signed-in callers who are not the owner. */
	isAdmin?: (who: CloudIdentity) => boolean | Promise<boolean>;
	/** Extra per-user fields, looked up on every resolved request. */
	enrich?: (who: CloudIdentity) => Promise<TExtra>;
	/** The edge's sign-in path; `?rd=<path>` is appended. */
	signInPath?: string;
	/** The edge's sign-out path; `?rd=<path>` is appended. */
	signOutPath?: string;
	/** GET paths that get the CSRF origin check (SSE streams). */
	streamPaths?: string[];
	metrics?: { registry?: Registry; prefix?: string };
	/** Logger names are `<loggerPrefix>.auth` etc. Defaults to appSlug. */
	loggerPrefix?: string;
	/** Overrides the loggers entirely (tests). */
	logger?: Logger;
}

const MAX_ID_LENGTH = 255;
const MAX_EMAIL_LENGTH = 320;

const NO_BEARER =
	"not signed in; bearer tokens are not supported on Cloud, sign in through the browser";

function normalEmail(email: string): string {
	return email.trim().toLowerCase();
}

function digest(value: string): Buffer {
	return createHash("sha256").update(value).digest();
}

/** The config, checked, with every default filled in. Throws on a bad value: a misconfigured app fails loudly, never open. */
function resolve<TExtra extends object>(config: CloudAuthConfig<TExtra>) {
	if (
		typeof config.edgeSecret !== "string" ||
		config.edgeSecret.length < CLOUD_DEFAULTS.minSecretLength
	)
		throw new Error(
			`edgeSecret must be at least ${CLOUD_DEFAULTS.minSecretLength} characters`,
		);
	const ownerEmail = normalEmail(config.ownerEmail ?? "");
	if (!ownerEmail.includes("@"))
		throw new Error("ownerEmail must be an email address");
	let publicOrigin: string;
	try {
		const url = new URL(config.publicUrl);
		if (url.protocol !== "https:" && url.protocol !== "http:")
			throw new Error("not http(s)");
		publicOrigin = url.origin;
	} catch {
		throw new Error(
			`publicUrl must be an http(s) URL (got "${config.publicUrl}")`,
		);
	}
	return {
		...config,
		ownerEmail,
		publicOrigin,
		secretDigest: digest(config.edgeSecret),
		signInPath: config.signInPath ?? CLOUD_DEFAULTS.signInPath,
		signOutPath: config.signOutPath ?? CLOUD_DEFAULTS.signOutPath,
		streamPaths: config.streamPaths ?? [...DEFAULTS.streamPaths],
	};
}

function header(request: Request, name: string, max: number): string | null {
	const value = request.headers.get(name)?.trim() ?? "";
	return value === "" || value.length > max ? null : value;
}

function hasIdentityHeaders(request: Request): boolean {
	return (
		request.headers.has(CLOUD_HEADERS.userId) ||
		request.headers.has(CLOUD_HEADERS.email) ||
		request.headers.has(CLOUD_HEADERS.username)
	);
}

function redirect(location: string): Response {
	return new Response(null, {
		status: 302,
		headers: { location, "cache-control": "no-store" },
	});
}

function withReturn(path: string, returnTo: string): string {
	return `${path}?${new URLSearchParams({ rd: safeReturnPath(returnTo) })}`;
}

/**
 * The app's identity layer in cloud mode. `config` is re-read on every call
 * (cheap; the app builds it from the environment).
 */
export function createCloudAuth<TExtra extends object = Record<never, never>>(
	config: () => CloudAuthConfig<TExtra>,
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
	let refusalLogged = false;

	function fromEdge(
		request: Request,
		cfg: ReturnType<typeof resolve<TExtra>>,
	): boolean {
		const given = request.headers.get(CLOUD_HEADERS.edgeSecret);
		return given !== null && timingSafeEqual(digest(given), cfg.secretDigest);
	}

	async function isAdmin(
		cfg: ReturnType<typeof resolve<TExtra>>,
		who: CloudIdentity,
	): Promise<boolean> {
		if (normalEmail(who.email) === cfg.ownerEmail) return true;
		return cfg.isAdmin ? (await cfg.isAdmin(who)) === true : false;
	}

	async function resolveUser(
		request: Request,
	): Promise<(AuthUser & TExtra) | null> {
		const cfg = current();
		if (!fromEdge(request, cfg)) {
			if (hasIdentityHeaders(request)) {
				metrics().edgeRefusals.inc();
				if (!refusalLogged) {
					refusalLogged = true;
					logger("auth").warning(
						"identity headers without the edge secret; treated as anonymous",
					);
				}
			}
			return null;
		}
		const sub = header(request, CLOUD_HEADERS.userId, MAX_ID_LENGTH);
		const email = header(request, CLOUD_HEADERS.email, MAX_EMAIL_LENGTH);
		if (sub === null || email === null || !email.includes("@")) return null;
		const username =
			header(request, CLOUD_HEADERS.username, MAX_ID_LENGTH) ?? email;
		const who: CloudIdentity = { sub, email, username };
		const admin = await isAdmin(cfg, who);
		const extra = cfg.enrich ? await cfg.enrich(who) : ({} as TExtra);
		return {
			...extra,
			sub,
			username,
			email,
			via: "cloud",
			member: true,
			admin,
		};
	}

	async function requireUser(request: Request): Promise<AuthUser & TExtra> {
		const user = await resolveUser(request);
		if (user) return user;
		throw new ApiError(
			401,
			"unauthorized",
			request.headers.has("authorization") ? NO_BEARER : "not signed in",
		);
	}

	/** Re-asks from the user's email; the `admin` flag on the object is not trusted. */
	async function requireAdmin(user: AuthUser): Promise<void> {
		const cfg = current();
		if (user.via !== "cloud" || !user.sub || !user.email)
			throw new ApiError(403, "forbidden", "admins only");
		const admin = await isAdmin(cfg, {
			sub: user.sub,
			email: user.email,
			username: user.username,
		});
		if (!admin) throw new ApiError(403, "forbidden", "admins only");
	}

	return {
		getAuth: () => null,
		async startSignIn(request) {
			const returnTo = new URL(request.url).searchParams.get("return");
			return redirect(withReturn(current().signInPath, returnTo ?? "/"));
		},
		finishSignIn(request) {
			return redirect(
				safeReturnPath(new URL(request.url).searchParams.get("return")),
			);
		},
		async handleAuthRequest() {
			return errorResponse(
				404,
				"not_found",
				"sign-in is handled by the platform edge",
			);
		},
		signInRedirect(returnTo) {
			return redirect(withReturn(current().signInPath, returnTo));
		},
		startUrl(returnTo) {
			return withReturn(current().signInPath, returnTo);
		},
		signInUrl(returnTo) {
			return withReturn(current().signInPath, returnTo);
		},
		signOutUrl(returnTo) {
			return withReturn(current().signOutPath, returnTo);
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
		async accessStatus(request) {
			const user = await resolveUser(request);
			return {
				signedIn: user !== null,
				username: user?.username ?? null,
				member: user !== null,
				admin: user?.admin ?? false,
				requestedAt: null,
			};
		},
		requireAdmin,
		async listPendingRequests(admin) {
			await requireAdmin(admin);
			return [];
		},
		async approveRequest(admin) {
			await requireAdmin(admin);
			throw new ApiError(
				404,
				"not_found",
				"there are no access requests on Cloud; the owner manages access there",
			);
		},
		async currentMembership() {
			throw new Error(
				"membership is decided by the platform edge in cloud mode; use resolveUser",
			);
		},
		csrfRejection(request) {
			const cfg = current();
			const allowed = isSameOriginRequest(
				request,
				[cfg.publicOrigin],
				cfg.streamPaths,
				{
					trustBearer: false,
					hasAmbientCredential: (r) =>
						r.headers.has("cookie") || hasIdentityHeaders(r),
				},
			);
			if (allowed) return null;
			metrics().csrfRejections.inc();
			return errorResponse(403, "forbidden", "cross-origin request refused");
		},
	};
}
