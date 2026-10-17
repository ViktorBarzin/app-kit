/**
 * API tokens for non-browser clients (CLIs, agents, Home Assistant): JWTs an
 * OIDC provider issued, checked against its JWKS. The verifier pins RS256,
 * the provider's issuer, `aud` equal to one of the app's client IDs
 * (Authentik sets `aud` to `client_id`), and requires `exp` and `sub`.
 *
 * The issuer and jwks_uri come from the discovery document, fetched once per
 * process; a failed fetch is retried on the next call.
 */
import type { Logger } from "@viktorbarzin/log";
import {
	createRemoteJWKSet,
	type JWTPayload,
	type JWTVerifyGetKey,
	errors as joseErrors,
	jwtVerify,
} from "jose";

export const PINNED_ALGORITHMS = ["RS256"] as const;

export interface TokenVerifierConfig {
	issuer: string;
	jwksUrl: string;
	audiences: string[];
	/** Defaults to PINNED_ALGORITHMS. */
	algorithms?: string[];
}

/** The claims an app reads from a verified token. */
export interface VerifiedToken {
	sub: string;
	preferredUsername: string;
	/** The `groups` claim when the token carries one. */
	groups: unknown;
	claims: JWTPayload;
}

export type TokenOutcome =
	| "ok"
	| "expired"
	| `bad_${string}`
	| "bad_alg"
	| "invalid"
	| "missing_claims"
	| "not_configured"
	| "no_discovery";

export type TokenVerifier = (token: string) => Promise<VerifiedToken | null>;

interface VerifierOptions {
	keys?: JWTVerifyGetKey;
	onOutcome?: (outcome: TokenOutcome) => void;
	logger?: Logger;
}

function refusalOutcome(err: unknown): TokenOutcome {
	if (err instanceof joseErrors.JWTExpired) return "expired";
	if (err instanceof joseErrors.JWTClaimValidationFailed)
		return err.reason === "missing" ? "missing_claims" : `bad_${err.claim}`;
	if (err instanceof joseErrors.JOSEAlgNotAllowed) return "bad_alg";
	return "invalid";
}

/** A verifier for one issuer. Returns null for any token it refuses. */
export function createTokenVerifier(
	config: TokenVerifierConfig,
	opts: VerifierOptions = {},
): TokenVerifier {
	const keys = opts.keys ?? createRemoteJWKSet(new URL(config.jwksUrl));
	const algorithms = config.algorithms ?? [...PINNED_ALGORITHMS];
	const report = (outcome: TokenOutcome) => opts.onOutcome?.(outcome);
	return async (token) => {
		let payload: JWTPayload;
		try {
			({ payload } = await jwtVerify(token, keys, {
				algorithms,
				issuer: config.issuer,
				audience: config.audiences,
				requiredClaims: ["exp", "sub"],
			}));
		} catch (err) {
			const outcome = refusalOutcome(err);
			report(outcome);
			opts.logger?.info("bearer token refused", { reason: outcome });
			return null;
		}
		const sub = payload.sub;
		const preferredUsername = payload.preferred_username;
		if (
			typeof sub !== "string" ||
			sub === "" ||
			typeof preferredUsername !== "string" ||
			preferredUsername === ""
		) {
			report("missing_claims");
			return null;
		}
		report("ok");
		return { sub, preferredUsername, groups: payload.groups, claims: payload };
	};
}

export interface Discovery {
	issuer: string;
	jwks_uri: string;
}

/** Fetch and check a provider's discovery document. */
export async function fetchDiscovery(
	discoveryUrl: string,
	opts: { timeoutMs?: number; fetch?: typeof fetch } = {},
): Promise<Discovery> {
	const doFetch = opts.fetch ?? fetch;
	const response = await doFetch(discoveryUrl, {
		headers: { accept: "application/json" },
		signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000),
	});
	if (!response.ok) throw new Error(`discovery answered ${response.status}`);
	const body = (await response.json()) as Partial<Discovery>;
	if (typeof body.issuer !== "string" || typeof body.jwks_uri !== "string") {
		throw new Error("discovery has no issuer or jwks_uri");
	}
	return {
		issuer: body.issuer,
		jwks_uri: new URL(body.jwks_uri, discoveryUrl).toString(),
	};
}

/** The bearer token in `Authorization`, or null when there is none. */
export function bearerToken(request: Request): string | null {
	const header = request.headers.get("authorization");
	if (!header) return null;
	const match = /^Bearer[ ]+([A-Za-z0-9._~+/=-]+)$/i.exec(header.trim());
	return match ? (match[1] as string) : null;
}

export interface DiscoveredVerifier {
	verify(token: string): Promise<VerifiedToken | null>;
	/** The verified claims behind `Authorization: Bearer <jwt>`; null when absent or refused. */
	verifyRequest(request: Request): Promise<VerifiedToken | null>;
}

type Cache = Map<string, Promise<TokenVerifier>>;

/** Discovery results, once per process (a server bundled twice shares them). */
function discoveryCache(): Cache {
	const store = globalThis as unknown as Record<symbol, Cache | undefined>;
	const slot = Symbol.for("@viktorbarzin:oidc-token.discovery");
	store[slot] ??= new Map();
	return store[slot];
}

/** A verifier whose issuer and JWKS come from the provider's discovery document. */
export function createDiscoveredVerifier(opts: {
	discoveryUrl: string;
	audiences: string[];
	onOutcome?: (outcome: TokenOutcome) => void;
	logger?: Logger;
}): DiscoveredVerifier {
	const report = (outcome: TokenOutcome) => opts.onOutcome?.(outcome);
	const key = `${opts.discoveryUrl}|${opts.audiences.join(",")}`;

	function verifier(): Promise<TokenVerifier> {
		const cache = discoveryCache();
		const cached = cache.get(key);
		if (cached) return cached;
		const created = fetchDiscovery(opts.discoveryUrl).then((found) =>
			createTokenVerifier(
				{
					issuer: found.issuer,
					jwksUrl: found.jwks_uri,
					audiences: opts.audiences,
				},
				{
					...(opts.onOutcome ? { onOutcome: opts.onOutcome } : {}),
					...(opts.logger ? { logger: opts.logger } : {}),
				},
			),
		);
		created.catch((err) => {
			opts.logger?.warning("cannot read the OIDC discovery document", {
				error: String(err),
			});
			if (cache.get(key) === created) cache.delete(key);
		});
		cache.set(key, created);
		return created;
	}

	async function verify(token: string): Promise<VerifiedToken | null> {
		if (opts.audiences.length === 0) {
			report("not_configured");
			return null;
		}
		let check: TokenVerifier;
		try {
			check = await verifier();
		} catch {
			report("no_discovery");
			return null;
		}
		return check(token);
	}

	return {
		verify,
		async verifyRequest(request) {
			const token = bearerToken(request);
			return token ? verify(token) : null;
		},
	};
}
