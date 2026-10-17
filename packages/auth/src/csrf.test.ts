import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { isSameOriginRequest, needsOriginCheck } from "./index.js";

const PUBLIC = "https://app.example.test";

function req(
	method: string,
	path: string,
	headers: Record<string, string> = {},
): Request {
	return new Request(`http://10.1.2.3:3000${path}`, { method, headers });
}

describe("needsOriginCheck", () => {
	test.each(["POST", "PUT", "PATCH", "DELETE"])("%s is checked", (method) => {
		expect(needsOriginCheck(req(method, "/api/items"))).toBe(true);
	});

	test("safe methods are not, except the stream paths", () => {
		expect(needsOriginCheck(req("GET", "/api/items"))).toBe(false);
		expect(needsOriginCheck(req("HEAD", "/"))).toBe(false);
		expect(needsOriginCheck(req("GET", "/api/events"))).toBe(true);
	});

	test("stream paths are configurable", () => {
		expect(needsOriginCheck(req("GET", "/api/events"), ["/api/live"])).toBe(
			false,
		);
		expect(needsOriginCheck(req("GET", "/api/live"), ["/api/live"])).toBe(true);
	});
});

describe("isSameOriginRequest", () => {
	const cookie = { cookie: "__Host-app.session_token=abc" };

	test("the public origin passes", () => {
		expect(
			isSameOriginRequest(
				req("POST", "/api/items", { ...cookie, origin: PUBLIC }),
				[PUBLIC],
			),
		).toBe(true);
	});

	test("Sec-Fetch-Site same-origin passes and decides before Origin", () => {
		expect(
			isSameOriginRequest(
				req("POST", "/_serverFn/x", {
					...cookie,
					"sec-fetch-site": "same-origin",
				}),
				[PUBLIC],
			),
		).toBe(true);
		expect(
			isSameOriginRequest(
				req("POST", "/_serverFn/x", {
					...cookie,
					"sec-fetch-site": "same-site",
					origin: PUBLIC,
				}),
				[PUBLIC],
			),
		).toBe(false);
	});

	test.each([
		["a sibling subdomain", "https://pages.example.test"],
		["http instead of https", "http://app.example.test"],
		["another port", "https://app.example.test:8443"],
		["a suffix trick", "https://app.example.test.evil.example"],
		["an opaque origin", "null"],
	])("refuses %s", (_name, origin) => {
		expect(
			isSameOriginRequest(req("POST", "/api/items", { ...cookie, origin }), [
				PUBLIC,
			]),
		).toBe(false);
	});

	test("a stream path needs the check too, including a configured one", () => {
		expect(
			isSameOriginRequest(
				req("GET", "/api/events", {
					...cookie,
					"sec-fetch-site": "cross-site",
				}),
				[PUBLIC],
			),
		).toBe(false);
		expect(
			isSameOriginRequest(
				req("GET", "/api/live", { ...cookie, "sec-fetch-site": "cross-site" }),
				[PUBLIC],
				["/api/live"],
			),
		).toBe(false);
		expect(
			isSameOriginRequest(
				req("GET", "/api/events", {
					...cookie,
					"sec-fetch-site": "same-origin",
				}),
				[PUBLIC],
			),
		).toBe(true);
	});

	test("a bearer token carries no ambient credential and passes", () => {
		expect(
			isSameOriginRequest(
				req("POST", "/api/items", {
					authorization: "Bearer eyJ.a.b",
					origin: "https://evil.example",
				}),
				[PUBLIC],
			),
		).toBe(true);
	});

	test("no browser headers: passes without a cookie, refused with one", () => {
		expect(isSameOriginRequest(req("POST", "/api/items"), [PUBLIC])).toBe(true);
		expect(
			isSameOriginRequest(req("POST", "/api/items", cookie), [PUBLIC]),
		).toBe(false);
	});

	test("with no origins configured, the request's own origin is the allow-list", () => {
		expect(
			isSameOriginRequest(
				req("POST", "/api/items", {
					...cookie,
					origin: "http://10.1.2.3:3000",
				}),
				[],
			),
		).toBe(true);
	});

	test("property: any origin outside the list is refused for a cookie POST", () => {
		fc.assert(
			fc.property(fc.webUrl(), (url) => {
				const origin = new URL(url).origin;
				fc.pre(origin !== PUBLIC);
				return !isSameOriginRequest(
					req("POST", "/api/items", { ...cookie, origin }),
					[PUBLIC],
				);
			}),
		);
	});
});
