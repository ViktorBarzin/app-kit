/**
 * Every request may stay idle for Bun's maximum, 255 s, longer than the
 * 125 s Cloud gives a request to start its answer, so Bun never cuts a
 * slow answer that the edge still waits for.
 */
import { describe, expect, test } from "bun:test";

import { REQUEST_IDLE_S, raiseIdleTimeout } from "./request-idle.server";

function bunRequest(calls: [Request, number][]): Request {
	const request = new Request("http://app.invalid/api/items");
	Object.defineProperty(request, "runtime", {
		value: {
			bun: {
				server: { timeout: (r: Request, s: number) => calls.push([r, s]) },
			},
		},
	});
	return request;
}

describe("request idle timeout", () => {
	test("is Bun's maximum, above Cloud's 125 s request timeout", () => {
		expect(REQUEST_IDLE_S).toBe(255);
		expect(REQUEST_IDLE_S).toBeGreaterThan(125);
	});

	test("raiseIdleTimeout sets it on the request through Bun's server", () => {
		const calls: [Request, number][] = [];
		const request = bunRequest(calls);
		expect(raiseIdleTimeout(request)).toBe(true);
		expect(calls).toEqual([[request, 255]]);
		// Off Bun (tests, vite dev) there is nothing to raise.
		expect(raiseIdleTimeout(new Request("http://app.invalid/"))).toBe(false);
	});
});
