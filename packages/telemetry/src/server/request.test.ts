import { describe, expect, test } from "bun:test";
import { isIP } from "node:net";
import fc from "fast-check";

import { VISITOR_HEADER } from "../index.js";
import {
	currentRequestContext,
	requestContextFrom,
	withRequestContext,
} from "./request.js";

const BROWSER =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36";

function req(headers: Record<string, string>): Request {
	return new Request("http://app.example.com/api/x", { headers });
}

describe("requestContextFrom", () => {
	test.each([
		[
			{ "X-Real-Ip": "81.2.69.142", "X-Forwarded-For": "1.1.1.1" },
			"10.0.0.1",
			"81.2.69.142",
		],
		[{ "X-Forwarded-For": "81.2.69.142, 10.0.0.2" }, "10.0.0.1", "81.2.69.142"],
		[{ "x-forwarded-for": " 2001:db8::1 ,10.0.0.2" }, undefined, "2001:db8::1"],
		[{}, "10.0.0.1", "10.0.0.1"],
		[
			{ "X-Real-Ip": "nope", "X-Forwarded-For": "81.2.69.142" },
			undefined,
			"81.2.69.142",
		],
		[{ "X-Forwarded-For": "junk" }, "10.0.0.1", "10.0.0.1"],
		[{}, undefined, undefined],
	] as const)("client ip from %p, peer %p is %p", (headers, peer, expected) => {
		const options = peer === undefined ? {} : { peer };
		expect(requestContextFrom(req(headers), options).clientIp).toBe(expected);
	});

	test("X-Real-Ip always wins (property)", () => {
		fc.assert(
			fc.property(
				fc.oneof(fc.ipV4(), fc.ipV6()),
				fc.array(fc.ipV4(), { maxLength: 4 }),
				(real, forwarded) => {
					const headers = {
						"X-Real-Ip": real,
						"X-Forwarded-For": forwarded.join(", "),
					};
					return requestContextFrom(req(headers)).clientIp === real;
				},
			),
		);
	});

	test("the first X-Forwarded-For entry wins without X-Real-Ip (property)", () => {
		fc.assert(
			fc.property(
				fc.array(fc.ipV4(), { minLength: 1, maxLength: 4 }),
				(ips) => {
					const got = requestContextFrom(
						req({ "X-Forwarded-For": ips.join(",") }),
						{ peer: "10.9.9.9" },
					).clientIp;
					return got === ips[0];
				},
			),
		);
	});

	test("the client ip is an ip or undefined (property)", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 40 }), (value) => {
				const clean = value.replace(/[^\x20-\x7e]/g, "");
				const got = requestContextFrom(
					req({ "X-Real-Ip": clean, "X-Forwarded-For": clean }),
					{ peer: clean },
				).clientIp;
				return got === undefined || isIP(got) !== 0;
			}),
		);
	});

	test.each([
		[BROWSER, BROWSER],
		["analytics-python/2.4.0", undefined],
		["analytics-node-next/1.3.0", undefined],
		["analytics-go (version: 3.4.0)", undefined],
		["", undefined],
	])("user agent %p is %p", (agent, expected) => {
		expect(requestContextFrom(req({ "User-Agent": agent })).userAgent).toBe(
			expected,
		);
	});

	test("a long user agent is cut to 512 characters", () => {
		const got = requestContextFrom(req({ "User-Agent": "M".repeat(2000) }));
		expect(got.userAgent).toHaveLength(512);
	});

	test.each([
		[
			"2a1c7b9e-6a51-4f4a-9a0e-9e0b7c1c2d3f",
			"2a1c7b9e-6a51-4f4a-9a0e-9e0b7c1c2d3f",
		],
		["lib-v020-check", "lib-v020-check"],
		["  lib-v020-check ", "lib-v020-check"],
		["", undefined],
		["has space", undefined],
		["<script>", undefined],
		["x".repeat(129), undefined],
	])("visitor id %p is %p", (value, expected) => {
		expect(requestContextFrom(req({ [VISITOR_HEADER]: value })).visitorId).toBe(
			expected,
		);
	});

	test("a plain headers record works too (Nitro, Node)", () => {
		expect(
			requestContextFrom({
				headers: { "x-visitor-id": "v-1", "user-agent": BROWSER },
			}),
		).toEqual({ visitorId: "v-1", userAgent: BROWSER });
	});
});

describe("withRequestContext", () => {
	test("sets the context for the callback and its awaits, then unwinds", async () => {
		expect(currentRequestContext()).toEqual({});
		const seen = await withRequestContext(
			req({ [VISITOR_HEADER]: "v-1", "X-Real-Ip": "81.2.69.142" }),
			async () => {
				await new Promise((resolve) => setTimeout(resolve, 1));
				return currentRequestContext();
			},
		);
		expect(seen).toEqual({ visitorId: "v-1", clientIp: "81.2.69.142" });
		expect(currentRequestContext()).toEqual({});
	});

	test("concurrent requests keep their own context", async () => {
		const run = (id: string, delay: number) =>
			withRequestContext(req({ [VISITOR_HEADER]: id }), async () => {
				await new Promise((resolve) => setTimeout(resolve, delay));
				return currentRequestContext().visitorId;
			});
		expect(await Promise.all([run("a", 5), run("b", 1)])).toEqual(["a", "b"]);
	});
});
