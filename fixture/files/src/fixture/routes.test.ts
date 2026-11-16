import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
	type FixtureDeps,
	fixtureHealthy,
	fixtureState,
	handleFixture,
	NOT_IN_THIS_BATCH,
} from "./routes";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

function deps(overrides: Partial<FixtureDeps> = {}): FixtureDeps & {
	exits: number[];
	slept: number[];
} {
	const exits: number[] = [];
	const slept: number[] = [];
	return {
		env: {
			SERVICE_VERSION: "abc123",
			CLOUD_INSTANCE_ID: "web-0",
			CLOUD_PUBLIC_URL: "https://fx.example",
			TOKEN: "s3cret",
		},
		bootTime: new Date("2026-11-16T10:00:00.000Z"),
		exit: (code) => {
			exits.push(code);
		},
		later: (run) => run(),
		sleep: async (ms) => {
			slept.push(ms);
		},
		keepOpen: () => {},
		writeItem: async (title) => ({
			id: "i-1",
			title,
			createdAt: "2026-11-16T10:00:01.000Z",
		}),
		readItem: async (id) =>
			id === "i-1"
				? { id, title: "t", createdAt: "2026-11-16T10:00:01.000Z" }
				: null,
		connect: async () => ({ connected: true, error: null }),
		fetch: async () => new Response("ok", { status: 200 }),
		allocate: () => {},
		assets: async () => ["/assets/main-1.js"],
		exits,
		slept,
		...overrides,
	};
}

const get = (path: string, d: FixtureDeps) =>
	handleFixture(new Request(`http://fx.test${path}`), d);

describe("/info", () => {
	test("boot time, version, instance id, and a SHA-256 of every env value, never a value", async () => {
		const response = await get("/info", deps());
		expect(response.status).toBe(200);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body.bootTime).toBe("2026-11-16T10:00:00.000Z");
		expect(body.serviceVersion).toBe("abc123");
		expect(body.instanceId).toBe("web-0");
		expect(body.env).toEqual({
			CLOUD_INSTANCE_ID: sha("web-0"),
			CLOUD_PUBLIC_URL: sha("https://fx.example"),
			SERVICE_VERSION: sha("abc123"),
			TOKEN: sha("s3cret"),
		});
		expect(JSON.stringify(body)).not.toContain("s3cret");
	});

	test("instanceId is null without CLOUD_INSTANCE_ID", async () => {
		const body = (await (await get("/info", deps({ env: {} }))).json()) as {
			instanceId: unknown;
			serviceVersion: unknown;
		};
		expect(body.instanceId).toBeNull();
		expect(body.serviceVersion).toBeNull();
	});
});

describe("/items", () => {
	test("writes a row and reads it back", async () => {
		const response = await get("/items", deps());
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			wrote: { id: string };
			read: { id: string };
		};
		expect(body.wrote.id).toBe("i-1");
		expect(body.read.id).toBe("i-1");
	});

	test("503 without a database", async () => {
		const response = await get(
			"/items",
			deps({ writeItem: null, readItem: null }),
		);
		expect(response.status).toBe(503);
	});
});

describe("faults", () => {
	test("/crash answers, then exits 42", async () => {
		const d = deps();
		const response = await get("/crash", d);
		expect(response.status).toBe(202);
		expect(d.exits).toEqual([42]);
	});

	test("/oom answers, then allocates", async () => {
		let allocated = false;
		const response = await get(
			"/oom",
			deps({
				allocate: () => {
					allocated = true;
				},
			}),
		);
		expect(response.status).toBe(202);
		expect(allocated).toBe(true);
	});

	test("/unhealthy and /healthy flip what /healthz answers", async () => {
		const d = deps();
		fixtureState().healthy = true;
		expect(fixtureHealthy(false)).toBe(true);
		expect((await get("/unhealthy", d)).status).toBe(200);
		expect(fixtureHealthy(false)).toBe(false);
		expect((await get("/healthy", d)).status).toBe(200);
		expect(fixtureHealthy(false)).toBe(true);
	});

	test("the knob makes /healthz fail from boot", () => {
		fixtureState().healthy = true;
		expect(fixtureHealthy(true)).toBe(false);
	});
});

describe("/slow", () => {
	test("waits N seconds, capped at 600", async () => {
		const d = deps();
		const response = await get("/slow?s=9999", d);
		expect(response.status).toBe(200);
		expect(d.slept).toEqual([600_000]);
		expect(await response.json()).toEqual({ slept: 600 });
	});

	test("400 without a whole number", async () => {
		expect((await get("/slow?s=x", deps())).status).toBe(400);
	});
});

describe("/sse", () => {
	test("an event stream, the first event at once", async () => {
		const response = await get("/sse?every=1", deps());
		expect(response.headers.get("content-type")).toStartWith(
			"text/event-stream",
		);
		const reader = response.body?.getReader();
		const first = await reader?.read();
		expect(new TextDecoder().decode(first?.value)).toContain("data: ");
		await reader?.cancel();
	});
});

describe("/tcp", () => {
	test("connects to an allowed host and port", async () => {
		const seen: string[] = [];
		const response = await get(
			"/tcp?host=smtp.gmail.com&port=443",
			deps({
				connect: async (host, port, timeoutMs) => {
					seen.push(`${host}:${port}:${timeoutMs}`);
					return { connected: true, error: null };
				},
			}),
		);
		expect(response.status).toBe(200);
		expect(seen).toEqual(["smtp.gmail.com:443:10000"]);
		const body = (await response.json()) as { connected: boolean };
		expect(body.connected).toBe(true);
	});

	test("reports a failed connect", async () => {
		const response = await get(
			"/tcp?host=smtp.gmail.com&port=25",
			deps({ connect: async () => ({ connected: false, error: "timeout" }) }),
		);
		expect(await response.json()).toMatchObject({
			connected: false,
			error: "timeout",
		});
	});

	test("refuses other hosts and ports without connecting", async () => {
		let called = false;
		const d = deps({
			connect: async () => {
				called = true;
				return { connected: true, error: null };
			},
		});
		expect((await get("/tcp?host=10.0.0.1&port=443", d)).status).toBe(400);
		expect((await get("/tcp?host=smtp.gmail.com&port=22", d)).status).toBe(400);
		expect(called).toBe(false);
	});
});

describe("/fetch", () => {
	test("an own origin: the status only, never the body", async () => {
		const response = await get(
			`/fetch?url=${encodeURIComponent("https://fx.example/info")}`,
			deps({ fetch: async () => new Response("secret page", { status: 200 }) }),
		);
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).not.toContain("secret page");
		expect(JSON.parse(text)).toMatchObject({ status: 200, connected: true });
	});

	test("a connect failure is reported", async () => {
		const response = await get(
			`/fetch?url=${encodeURIComponent("https://fx.example/info")}`,
			deps({
				fetch: async () => {
					throw new Error("ECONNREFUSED");
				},
			}),
		);
		expect(await response.json()).toMatchObject({ connected: false });
	});

	test("refuses other URLs without fetching", async () => {
		let called = false;
		const response = await get(
			`/fetch?url=${encodeURIComponent("http://169.254.169.254/")}`,
			deps({
				fetch: async () => {
					called = true;
					return new Response("");
				},
			}),
		);
		expect(response.status).toBe(400);
		expect(called).toBe(false);
	});
});

describe("later batches", () => {
	test("answer 501 not_in_this_batch", async () => {
		for (const path of [
			"/enqueue",
			"/kv-selftest",
			"/upload",
			"/files/a.txt",
			"/probe/pg?db=x",
			"/probe/kv?key=x",
			"/probe/s3?bucket=x",
		]) {
			const response = await get(path, deps());
			expect([path, response.status]).toEqual([path, 501]);
			expect(await response.json()).toEqual(NOT_IN_THIS_BATCH);
		}
	});
});

test("/build-assets lists the client's JS files", async () => {
	expect(await (await get("/build-assets", deps())).json()).toEqual({
		assets: ["/assets/main-1.js"],
	});
});
