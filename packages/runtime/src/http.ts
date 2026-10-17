/** Request and response helpers for server routes. */
import type { z } from "zod";

import { ApiError, validationMessage } from "./errors.js";

function validated<S extends z.ZodType>(
	schema: S,
	raw: unknown,
	where: string,
): z.infer<S> {
	const result = schema.safeParse(raw);
	if (!result.success) {
		const issues = result.error.issues.map((issue) => ({
			path: [where, ...issue.path],
			message: issue.message,
		}));
		throw new ApiError(422, "validation_error", validationMessage(issues));
	}
	return result.data;
}

/** Parse and validate a JSON body; failures are a 422 `validation_error` that never echoes the input. */
export async function readJson<S extends z.ZodType>(
	request: Request,
	schema: S,
): Promise<z.infer<S>> {
	let raw: unknown;
	try {
		raw = await request.json();
	} catch {
		throw new ApiError(422, "validation_error", "body: invalid JSON");
	}
	return validated(schema, raw, "body");
}

/** Validate query parameters (the first value of each key). */
export function readQuery<S extends z.ZodType>(
	request: Request,
	schema: S,
): z.infer<S> {
	const params: Record<string, string> = {};
	for (const [key, value] of new URL(request.url).searchParams)
		if (!(key in params)) params[key] = value;
	return validated(schema, params, "query");
}

export function noContent(): Response {
	return new Response(null, { status: 204 });
}

/**
 * Anti-framing (clickjacking). Nothing in an app is meant to be framed, and a
 * same-site frame would get the SameSite=Lax session cookie. An ingress CSP
 * middleware replaces the app's Content-Security-Policy, so the ingress must
 * send `frame-ancestors 'none'` as well.
 */
export const FRAME_DENY_HEADERS: Readonly<Record<string, string>> = {
	"content-security-policy": "frame-ancestors 'none'",
	"x-frame-options": "DENY",
};

/** The response with the anti-framing headers set; a copy when its headers are immutable. */
export function withFrameDenial(response: Response): Response {
	try {
		for (const [name, value] of Object.entries(FRAME_DENY_HEADERS))
			if (!response.headers.has(name)) response.headers.set(name, value);
		return response;
	} catch {
		const copy = new Response(response.body, response);
		for (const [name, value] of Object.entries(FRAME_DENY_HEADERS))
			if (!copy.headers.has(name)) copy.headers.set(name, value);
		return copy;
	}
}

/** The liveness and readiness probe body: `{"status":"ok"}`. */
export function healthResponse(): Response {
	return Response.json({ status: "ok" });
}
