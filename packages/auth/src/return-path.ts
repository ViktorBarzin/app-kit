/** Where to send a browser after sign-in: same-origin paths only. */

/** True for a value a browser would resolve against another host. */
function leavesOrigin(path: string): boolean {
	return path.startsWith("//") || path.startsWith("/\\");
}

/**
 * A relative path inside the app to return to after sign-in, or "/".
 * Refuses absolute and protocol-relative URLs (no open redirect). The check
 * runs on the normalised result too: dot segments collapse, so `/.//evil`
 * normalises to `//evil`.
 */
export function safeReturnPath(raw: string | null | undefined): string {
	if (!raw || !raw.startsWith("/") || leavesOrigin(raw)) return "/";
	try {
		const url = new URL(raw, "http://app.invalid");
		if (url.origin !== "http://app.invalid") return "/";
		const path = `${url.pathname}${url.search}`;
		return leavesOrigin(path) ? "/" : path;
	} catch {
		return "/";
	}
}

/** Marks a sign-in that already asked the provider for `prompt=login`. */
export const LOGIN_PARAM = "login";

export function signInPaths(basePath: string) {
	return {
		start: `${basePath}/start`,
		finish: `${basePath}/finish`,
		error: `${basePath}/error`,
	};
}

export function pathWithReturn(
	path: string,
	returnTo: string,
	login: boolean,
): string {
	const query = new URLSearchParams({ return: safeReturnPath(returnTo) });
	if (login) query.set(LOGIN_PARAM, "1");
	return `${path}?${query}`;
}
