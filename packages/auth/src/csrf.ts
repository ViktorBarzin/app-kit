/**
 * CSRF protection: an explicit check of where a request comes from, for
 * server functions, cookie-authenticated server routes and SSE streams.
 *
 * A request is checked when it can change state (any method but GET, HEAD,
 * OPTIONS) or opens a stream path. Sibling sites on one registrable domain
 * share SameSite=Lax cookies, so SameSite alone does not stop them. A checked
 * request passes when:
 * - it carries a bearer token (no ambient credential; identity then comes
 *   from the token only), or
 * - the browser says `Sec-Fetch-Site: same-origin`, or
 * - its `Origin` is one of the allowed origins exactly (scheme, host, port), or
 * - it carries neither header nor a cookie (a non-browser client with nothing
 *   ambient to abuse).
 * Everything else is refused, including `Origin: null`.
 */
import { bearerToken } from "@viktorbarzin/oidc-token";

import { DEFAULTS } from "./config.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** True for requests the origin check applies to. */
export function needsOriginCheck(
	request: Request,
	streamPaths: readonly string[] = DEFAULTS.streamPaths,
): boolean {
	if (!SAFE_METHODS.has(request.method.toUpperCase())) return true;
	return streamPaths.includes(new URL(request.url).pathname);
}

/**
 * True when the request may proceed. `allowed` empty means the request URL's
 * own origin (dev, tests).
 */
export function isSameOriginRequest(
	request: Request,
	allowed: string[],
	streamPaths?: string[],
): boolean {
	if (!needsOriginCheck(request, streamPaths)) return true;
	if (bearerToken(request) !== null) return true;
	const headers = request.headers;
	const fetchSite = headers.get("sec-fetch-site");
	if (fetchSite !== null) return fetchSite === "same-origin";
	const origin = headers.get("origin");
	if (origin !== null) {
		const origins =
			allowed.length > 0 ? allowed : [new URL(request.url).origin];
		return origins.includes(origin);
	}
	return headers.get("cookie") === null;
}
