/**
 * Who sent the request being handled: the browser's Rybbit visitor id (the
 * `X-Visitor-Id` header), the person's IP and their User-Agent. Server
 * events sent inside `withRequestContext` default their anonymousId to the
 * visitor id, so they join the browser's person in Rybbit, and carry the IP
 * and agent as `context.ip` and `context.userAgent`.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { isIP } from "node:net";

import { VISITOR_HEADER } from "../index.js";

/** How much of a User-Agent is kept. */
export const MAX_USER_AGENT_LENGTH = 512;

export interface RequestContext {
	visitorId?: string;
	clientIp?: string;
	userAgent?: string;
}

/** A web `Request`, or anything with its headers (Nitro, Node). */
export interface RequestLike {
	headers: Headers | Record<string, string | string[] | undefined>;
}

export interface RequestContextOptions {
	/** The peer address, used when no proxy header names the client. */
	peer?: string | undefined;
}

const VISITOR_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// Segment SDK agents. Rybbit flags them as bots, so they never stand in for
// a person's agent.
const SDK_AGENT = /^analytics[-_]/i;

function header(request: RequestLike, name: string): string {
	const { headers } = request;
	if (headers instanceof Headers) return headers.get(name) ?? "";
	const lower = name.toLowerCase();
	for (const [key, value] of Object.entries(headers))
		if (key.toLowerCase() === lower)
			return (Array.isArray(value) ? value[0] : value) ?? "";
	return "";
}

function ip(value: string | undefined): string | undefined {
	const v = value?.trim();
	return v && isIP(v) !== 0 ? v : undefined;
}

/**
 * Read the request's sender. The IP is `X-Real-Ip` (set by Traefik's
 * real-ip middleware), else the first `X-Forwarded-For` entry, else
 * `options.peer`; values that are not IP addresses are skipped. A Segment
 * SDK user agent counts as none.
 */
export function requestContextFrom(
	request: RequestLike,
	options: RequestContextOptions = {},
): RequestContext {
	const visitor = header(request, VISITOR_HEADER).trim();
	const clientIp =
		ip(header(request, "x-real-ip")) ??
		ip(header(request, "x-forwarded-for").split(",")[0]) ??
		ip(options.peer);
	const agent = header(request, "user-agent").trim();
	return {
		...(VISITOR_ID.test(visitor) ? { visitorId: visitor } : {}),
		...(clientIp ? { clientIp } : {}),
		...(agent && !SDK_AGENT.test(agent)
			? { userAgent: agent.slice(0, MAX_USER_AGENT_LENGTH) }
			: {}),
	};
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Run `fn` with `request`'s sender as the current request context, through
 * every await inside it. In TanStack Start, a global request middleware:
 * `createMiddleware().server(({ request, next }) => withRequestContext(request, next))`.
 */
export function withRequestContext<T>(
	request: RequestLike,
	fn: () => T,
	options?: RequestContextOptions,
): T {
	return storage.run(requestContextFrom(request, options), fn);
}

/** The current request's sender, or `{}` outside `withRequestContext`. */
export function currentRequestContext(): RequestContext {
	return storage.getStore() ?? {};
}
