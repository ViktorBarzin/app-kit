/**
 * The error envelope: every non-2xx /api response is
 * `{"error": {"code", "message"}}`, with a stable machine-readable code.
 */
import { getLogger, type Logger } from "@viktorbarzin/log";

/** An expected API failure with a stable machine-readable code. */
export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "ApiError";
	}
}

export interface ErrorEnvelope {
	error: { code: string; message: string };
}

export function errorResponse(
	status: number,
	code: string,
	message: string,
	headers?: HeadersInit,
): Response {
	const body: ErrorEnvelope = { error: { code, message } };
	return Response.json(body, { status, ...(headers ? { headers } : {}) });
}

/**
 * Validation failures name the field and the problem, never the input, which
 * may be a password or a token.
 */
export function validationMessage(
	issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>,
): string {
	const parts = issues.map((issue) => {
		const loc = issue.path.map(String).join(".");
		return loc ? `${loc}: ${issue.message}` : issue.message;
	});
	return parts.join("; ") || "validation error";
}

/** Maps an app-specific error to a response, or returns null to pass it on. */
export type ErrorMapper = (err: unknown, request: Request) => Response | null;

/**
 * An error-to-response function: ApiError becomes its envelope, then each
 * mapper gets a turn, and anything left is logged and answered with a 500
 * `internal_error` that says nothing about the cause.
 */
export function createErrorResponder(
	opts: { mappers?: ErrorMapper[]; logger?: Logger } = {},
): (err: unknown, request: Request) => Response {
	const mappers = opts.mappers ?? [];
	const log = opts.logger ?? getLogger("runtime.errors");
	return (err, request) => {
		if (err instanceof ApiError)
			return errorResponse(err.status, err.code, err.message);
		for (const mapper of mappers) {
			const mapped = mapper(err, request);
			if (mapped) return mapped;
		}
		log.exception("unhandled error", err, {
			path: new URL(request.url).pathname,
			method: request.method,
		});
		return errorResponse(500, "internal_error", "internal server error");
	};
}
