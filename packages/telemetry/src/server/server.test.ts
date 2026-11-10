import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import fc from "fast-check";

import {
	closeAndFlush,
	createServerTelemetry,
	initServerTelemetry,
	type SentryServerLike,
	type ServerTelemetry,
	track,
	withRequestContext,
} from "./index.js";

interface Received {
	path: string;
	authorization: string | null;
	batch: Record<string, unknown>[];
}

let server: ReturnType<typeof Bun.serve>;
const received: Received[] = [];

beforeAll(() => {
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const body = (await request.json()) as {
				batch: Record<string, unknown>[];
			};
			received.push({
				path: new URL(request.url).pathname,
				authorization: request.headers.get("authorization"),
				batch: body.batch,
			});
			return Response.json({});
		},
	});
});
afterAll(() => server.stop(true));

const open: ServerTelemetry[] = [];
afterEach(async () => {
	for (const t of open.splice(0)) await t.closeAndFlush();
	received.length = 0;
});

function make(
	overrides: Partial<Parameters<typeof createServerTelemetry>[0]> = {},
) {
	const warnings: string[] = [];
	const telemetry = createServerTelemetry({
		writeKey: "wk-test",
		host: `http://127.0.0.1:${server.port}`,
		release: "abc123",
		service: "starter",
		flushAt: 1,
		warn: (message) => void warnings.push(message),
		...overrides,
	});
	open.push(telemetry);
	return { telemetry, warnings };
}

function messages() {
	return received.flatMap((r) => r.batch);
}

describe("createServerTelemetry", () => {
	test("track posts a Segment batch to host + /v1/batch with the write key as Basic auth", async () => {
		const { telemetry } = make();
		telemetry.track({
			event: "item.created",
			properties: { item_id: 7 },
			userId: "sub-1",
		});
		await telemetry.flush();
		expect(received[0]?.path).toBe("/v1/batch");
		expect(received[0]?.authorization).toBe(`Basic ${btoa("wk-test:")}`);
		expect(messages()).toMatchObject([
			{
				type: "track",
				event: "item.created",
				properties: { item_id: 7 },
				userId: "sub-1",
				context: { app: { name: "starter", version: "abc123" } },
			},
		]);
	});

	test("a path prefix goes in path, not host", async () => {
		const { telemetry } = make({ path: "/_t/e/v1/batch" });
		telemetry.track({ event: "item.created", anonymousId: "anon-1" });
		await telemetry.flush();
		expect(received[0]?.path).toBe("/_t/e/v1/batch");
	});

	test("invalid events are dropped or trimmed, with a warning", async () => {
		const { telemetry, warnings } = make();
		telemetry.track({ event: "ItemCreated", userId: "sub-1" });
		telemetry.track({
			event: "item.created",
			properties: { item_id: 1, itemName: "x" },
			userId: "sub-1",
		});
		await telemetry.flush();
		expect(messages().map((m) => [m.event, m.properties])).toEqual([
			["item.created", { item_id: 1 }],
		]);
		expect(warnings).toEqual([
			'telemetry: event name is not noun.past_verb: "ItemCreated"',
			'telemetry: property key is not snake_case: "itemName"',
		]);
	});

	test("identify sends the person and traits", async () => {
		const { telemetry } = make();
		telemetry.identify({ userId: "sub-1", traits: { plan: "free" } });
		await telemetry.flush();
		expect(messages()).toMatchObject([
			{ type: "identify", userId: "sub-1", traits: { plan: "free" } },
		]);
	});

	test("disabled: nothing is sent, but events are still checked", async () => {
		const { telemetry, warnings } = make({ enabled: false });
		telemetry.track({ event: "item.created", userId: "sub-1" });
		telemetry.track({ event: "bad", userId: "sub-1" });
		await telemetry.flush();
		expect(telemetry.active).toBe(false);
		expect(received).toEqual([]);
		expect(warnings).toHaveLength(1);
	});

	test("Sentry is initialised with the DSN, release and environment, and flushed on close", async () => {
		const calls: unknown[][] = [];
		const sentry = {
			init: (options: { dsn: string; release: string; environment: string }) =>
				void calls.push([
					"init",
					options.dsn,
					options.release,
					options.environment,
				]),
			flush: async (timeout?: number) => {
				calls.push(["flush", timeout]);
				return true;
			},
		};
		const { telemetry } = make({
			dsn: "https://k@app.example.com/_t/x/1",
			sentry,
			environment: "dev",
		});
		await telemetry.closeAndFlush(1000);
		expect(calls).toEqual([
			["init", "https://k@app.example.com/_t/x/1", "abc123", "dev"],
			["flush", 1000],
		]);
	});
});

describe("identity", () => {
	const BROWSER = "Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0 Safari/537.36";
	const browserRequest = () =>
		new Request("http://app.example.com/api/x", {
			headers: {
				"X-Visitor-Id": "v-1",
				"X-Real-Ip": "81.2.69.142",
				"User-Agent": BROWSER,
			},
		});

	test("anonymous events with no visitor share one stable id (property)", async () => {
		await fc.assert(
			fc.asyncProperty(fc.integer({ min: 2, max: 6 }), async (n) => {
				received.length = 0;
				const { telemetry } = make();
				for (let i = 0; i < n; i++) telemetry.track({ event: "item.created" });
				await telemetry.flush();
				const ids = new Set(messages().map((m) => m.anonymousId));
				return (
					messages().length === n && ids.size === 1 && ids.has("server:starter")
				);
			}),
			{ numRuns: 10 },
		);
	});

	test("a caller-supplied default anonymous id is used", async () => {
		const { telemetry } = make({ defaultAnonymousId: "worker-7" });
		telemetry.track({ event: "item.created" });
		await telemetry.flush();
		expect(messages()[0]?.anonymousId).toBe("worker-7");
	});

	test("a known person without a visitor sends no anonymous id", async () => {
		const { telemetry } = make();
		telemetry.track({ event: "item.created", userId: "sub-1" });
		telemetry.identify({ userId: "sub-1" });
		await telemetry.flush();
		for (const m of messages()) {
			expect(m.userId).toBe("sub-1");
			expect(m.anonymousId).toBeUndefined();
		}
	});

	test.each([
		[undefined, undefined, "v-1"],
		[undefined, "sub-1", "v-1"],
		["anon-x", undefined, "anon-x"],
		["anon-x", "sub-1", "anon-x"],
	] as const)("in a request, explicit %p with user %p sends anonymousId %p", async (explicit, user, expected) => {
		const { telemetry } = make();
		await withRequestContext(browserRequest(), async () => {
			telemetry.track({
				event: "item.created",
				...(explicit ? { anonymousId: explicit } : {}),
				...(user ? { userId: user } : {}),
			});
			telemetry.identify({
				userId: "sub-1",
				...(explicit ? { anonymousId: explicit } : {}),
			});
		});
		await telemetry.flush();
		expect(messages().map((m) => m.anonymousId)).toEqual([expected, expected]);
	});

	test("in a request, the person's ip and agent go in the context", async () => {
		const { telemetry } = make();
		await withRequestContext(browserRequest(), async () => {
			telemetry.track({ event: "item.created", userId: "sub-1" });
			telemetry.identify({ userId: "sub-1" });
		});
		telemetry.track({ event: "item.created", userId: "sub-1" });
		await telemetry.flush();
		const [tracked, identified, outside] = messages();
		for (const m of [tracked, identified])
			expect(m?.context).toMatchObject({
				app: { name: "starter", version: "abc123" },
				ip: "81.2.69.142",
				userAgent: BROWSER,
			});
		expect(outside?.context).not.toHaveProperty("ip");
		expect(outside?.context).not.toHaveProperty("userAgent");
	});
});

describe("module functions", () => {
	test("initServerTelemetry returns the first instance; track and closeAndFlush use it", async () => {
		const config = {
			writeKey: "wk-test",
			host: `http://127.0.0.1:${server.port}`,
			release: "abc123",
			flushAt: 1,
		};
		const first = initServerTelemetry(config);
		expect(initServerTelemetry({ ...config, writeKey: "other" })).toBe(first);
		track({ event: "item.created", anonymousId: "anon-1" });
		await closeAndFlush();
		expect(messages()).toMatchObject([{ event: "item.created" }]);
		expect(received[0]?.authorization).toBe(`Basic ${btoa("wk-test:")}`);
	});
});

test("the @sentry/bun module fits SentryServerLike (typecheck)", () => {
	const fits = (module: typeof import("@sentry/bun")): SentryServerLike =>
		module;
	expect(typeof fits).toBe("function");
});
