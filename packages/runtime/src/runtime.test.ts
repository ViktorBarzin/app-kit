import { afterEach, describe, expect, test } from "bun:test";
import { setLogLevel, setLogSink } from "@viktorbarzin/log";
import { z } from "zod";

import {
	ApiError,
	createErrorResponder,
	errorResponse,
	extendIdleTimeout,
	FRAME_DENY_HEADERS,
	healthResponse,
	keepRequestOpen,
	noContent,
	processSingleton,
	REQUEST_IDLE_TIMEOUT_S,
	readJson,
	readQuery,
	requestsInFlight,
	shutdown,
	trackRequest,
	validationMessage,
	waitForDrain,
	withFrameDenial,
} from "./index.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const fn of cleanups.splice(0)) fn();
	setLogLevel("WARNING");
});

function captureLogs(): Record<string, unknown>[] {
	const records: Record<string, unknown>[] = [];
	cleanups.push(setLogSink((line) => records.push(JSON.parse(line))));
	setLogLevel("DEBUG");
	return records;
}

function bunRequest(url: string, calls: [Request, number][]): Request {
	const request = new Request(url);
	Object.defineProperty(request, "runtime", {
		value: {
			bun: {
				server: { timeout: (r: Request, s: number) => calls.push([r, s]) },
			},
		},
	});
	return request;
}

describe("processSingleton", () => {
	test("the first value created for a key is the one every caller gets", () => {
		const key = `test-${crypto.randomUUID()}`;
		let made = 0;
		const a = processSingleton(key, () => ({ n: ++made }));
		const b = processSingleton(key, () => ({ n: ++made }));
		expect(b).toBe(a);
		expect(made).toBe(1);
		// A second bundled copy of the module sees the same globalThis slot.
		const slot = Symbol.for(`@viktorbarzin:${key}`);
		expect((globalThis as unknown as Record<symbol, unknown>)[slot]).toBe(a);
	});
});

describe("idle timeout", () => {
	test("extendIdleTimeout raises the request's idle timeout through Bun's server", () => {
		const calls: [Request, number][] = [];
		const request = bunRequest("http://app.invalid/api/x", calls);
		expect(extendIdleTimeout(request)).toBe(true);
		expect(extendIdleTimeout(request, 30)).toBe(true);
		expect(calls).toEqual([
			[request, REQUEST_IDLE_TIMEOUT_S],
			[request, 30],
		]);
		expect(REQUEST_IDLE_TIMEOUT_S).toBe(120);
		expect(extendIdleTimeout(new Request("http://app.invalid/"))).toBe(false);
	});

	test("keepRequestOpen lifts the limit (timeout 0) for a stream", () => {
		const calls: [Request, number][] = [];
		const request = bunRequest("http://app.invalid/api/events", calls);
		expect(keepRequestOpen(request)).toBe(true);
		expect(calls).toEqual([[request, 0]]);
		expect(keepRequestOpen(new Request("http://app.invalid/"))).toBe(false);
	});
});

describe("graceful shutdown", () => {
	test("beforeDrain, then in-flight requests, then afterDrain, then exit 0", async () => {
		const order: string[] = [];
		const done = trackRequest();
		expect(requestsInFlight()).toBe(1);
		setTimeout(() => {
			order.push("request answered");
			done();
		}, 30);
		await shutdown("SIGTERM", {
			beforeDrain: [
				{ name: "realtime", run: async () => void order.push("realtime") },
			],
			afterDrain: [
				{ name: "metrics", run: () => void order.push("metrics") },
				{ name: "pool", run: async () => void order.push("pool") },
			],
			drainMs: 2_000,
			exit: (code) => order.push(`exit ${code}`),
		});
		expect(order).toEqual([
			"realtime",
			"request answered",
			"metrics",
			"pool",
			"exit 0",
		]);
		expect(requestsInFlight()).toBe(0);
	});

	test("a request that never finishes delays shutdown only by drainMs", async () => {
		const done = trackRequest();
		const started = Date.now();
		await waitForDrain(50);
		expect(Date.now() - started).toBeLessThan(1_000);
		done();
		done(); // idempotent
		expect(requestsInFlight()).toBe(0);
	});

	test("a failing step is logged and the rest still run", async () => {
		const records = captureLogs();
		const order: string[] = [];
		await shutdown("SIGTERM", {
			beforeDrain: [
				{
					name: "listen",
					run: async () => {
						throw new Error("LISTEN already gone");
					},
				},
				{ name: "streams", run: () => void order.push("streams") },
			],
			afterDrain: [{ name: "pool", run: () => void order.push("pool") }],
			drainMs: 0,
			exit: (code) => order.push(`exit ${code}`),
		});
		expect(order).toEqual(["streams", "pool", "exit 0"]);
		const failed = records.find((r) => r.msg === "shutdown step failed");
		expect(failed).toMatchObject({ level: "ERROR", step: "listen" });
		expect(String(failed?.exc)).toContain("LISTEN already gone");
	});
});

describe("error envelope", () => {
	test("errorResponse is the {error: {code, message}} shape", async () => {
		const res = errorResponse(409, "conflict", "nope", { "x-a": "1" });
		expect(res.status).toBe(409);
		expect(res.headers.get("x-a")).toBe("1");
		expect(await res.text()).toBe(
			'{"error":{"code":"conflict","message":"nope"}}',
		);
	});

	test("validationMessage names fields, never values", () => {
		expect(
			validationMessage([
				{ path: ["body", "title"], message: "Required" },
				{ path: [], message: "bad" },
			]),
		).toBe("body.title: Required; bad");
		expect(validationMessage([])).toBe("validation error");
	});

	const request = new Request("http://app.invalid/api/items", {
		method: "POST",
	});

	test("ApiError becomes the envelope", async () => {
		const respond = createErrorResponder();
		const res = respond(new ApiError(404, "not_found", "gone"), request);
		expect(res.status).toBe(404);
		expect((await res.json()).error).toEqual({
			code: "not_found",
			message: "gone",
		});
	});

	test("mappers run in order before the 500 fallback", async () => {
		class Upstream extends Error {}
		const respond = createErrorResponder({
			mappers: [
				() => null,
				(err) =>
					err instanceof Upstream
						? errorResponse(502, "upstream", "upstream refused")
						: null,
			],
		});
		expect(respond(new Upstream("x"), request).status).toBe(502);
	});

	test("anything else is logged and becomes a 500 internal_error", async () => {
		const records = captureLogs();
		const res = createErrorResponder()(new Error("secret detail"), request);
		expect(res.status).toBe(500);
		const body = await res.text();
		expect(body).toBe(
			'{"error":{"code":"internal_error","message":"internal server error"}}',
		);
		expect(records[0]).toMatchObject({
			level: "ERROR",
			msg: "unhandled error",
			path: "/api/items",
			method: "POST",
		});
	});
});

describe("readJson and readQuery", () => {
	const schema = z.object({
		title: z.string().min(1),
		secret: z.string().min(40),
	});
	const post = (body: string) =>
		new Request("http://app.invalid/api/items", { method: "POST", body });

	test("a valid body is parsed", async () => {
		const ok = await readJson(
			post(JSON.stringify({ title: "a", secret: "x".repeat(40) })),
			schema,
		);
		expect(ok.title).toBe("a");
	});

	test("an invalid body is a 422 that names the field but never echoes the input", async () => {
		const value = "s3cret-value";
		const err = await readJson(
			post(JSON.stringify({ title: "", secret: value })),
			schema,
		).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect((err as ApiError).status).toBe(422);
		expect((err as ApiError).code).toBe("validation_error");
		expect((err as ApiError).message).toContain("body.title");
		expect((err as ApiError).message).toContain("body.secret");
		expect((err as ApiError).message).not.toContain(value);
	});

	test("a body that is not JSON is a 422", async () => {
		await expect(readJson(post("{"), schema)).rejects.toMatchObject({
			status: 422,
			message: "body: invalid JSON",
		});
	});

	test("readQuery validates the first value of each parameter", () => {
		const q = z.object({ limit: z.coerce.number().int().max(100) });
		expect(
			readQuery(new Request("http://app.invalid/x?limit=5&limit=7"), q),
		).toEqual({ limit: 5 });
		expect(() =>
			readQuery(new Request("http://app.invalid/x?limit=500"), q),
		).toThrow("query.limit");
	});
});

describe("responses", () => {
	test("noContent is a bodiless 204", async () => {
		const res = noContent();
		expect(res.status).toBe(204);
		expect(await res.text()).toBe("");
	});

	test('healthResponse is {"status":"ok"}', async () => {
		const res = healthResponse();
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('{"status":"ok"}');
	});

	test("withFrameDenial adds frame-ancestors 'none' and X-Frame-Options DENY", () => {
		const res = withFrameDenial(new Response("x"));
		expect(res.headers.get("content-security-policy")).toBe(
			"frame-ancestors 'none'",
		);
		expect(res.headers.get("x-frame-options")).toBe("DENY");
		expect(FRAME_DENY_HEADERS["x-frame-options"]).toBe("DENY");
	});

	test("withFrameDenial keeps a policy the route set itself", () => {
		const res = withFrameDenial(
			new Response("x", {
				headers: { "content-security-policy": "default-src 'self'" },
			}),
		);
		expect(res.headers.get("content-security-policy")).toBe(
			"default-src 'self'",
		);
	});

	test("withFrameDenial copies a response whose headers are immutable", () => {
		const res = withFrameDenial(Response.redirect("http://app.invalid/x", 302));
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("http://app.invalid/x");
		expect(res.headers.get("x-frame-options")).toBe("DENY");
	});
});
