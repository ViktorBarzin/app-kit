import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
	type FixtureDeps,
	fixtureHealthy,
	fixtureState,
	genericError,
	handleFixture,
	LOG_MAX_LINES,
	NOT_IN_THIS_BATCH,
	serviceUrls,
} from "./routes";
import { SinkStore } from "./sink";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

function deps(overrides: Partial<FixtureDeps> = {}): FixtureDeps & {
	exits: number[];
	slept: number[];
	deleted: string[];
	logged: string[];
} {
	const exits: number[] = [];
	const slept: number[] = [];
	const deleted: string[] = [];
	const logged: string[] = [];
	return {
		env: {
			SERVICE_VERSION: "abc123",
			CLOUD_INSTANCE_ID: "web-0",
			CLOUD_PUBLIC_URL: "https://fx.example",
			TOKEN: "s3cret",
			DATABASE_URL: "postgres://u:pw@db.example/x",
			EMPTY_ONE: "",
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
		deleteItem: async (id) => {
			deleted.push(id);
			return true;
		},
		log: (line) => {
			logged.push(line);
		},
		connect: async () => ({ connected: true, error: null }),
		fetch: async () => new Response("ok", { status: 200 }),
		allocate: () => {},
		assets: async () => ["/assets/main-1.js"],
		enqueue: async () => "0b6d3c1e-5f1a-4c55-9a43-3f1b2c4d5e6f",
		fill: async (mib) => ({ tableMib: mib + 1 }),
		clearFill: async () => {},
		sink: new SinkStore(),
		exits,
		slept,
		deleted,
		logged,
		...overrides,
	};
}

const get = (path: string, d: FixtureDeps) =>
	handleFixture(new Request(`http://fx.test${path}`), d);

describe("/info", () => {
	test("every env name; a SHA-256 only of the suite's names and the cells' variables; never a value", async () => {
		const response = await get("/info", deps());
		expect(response.status).toBe(200);
		const body = (await response.json()) as Record<string, unknown>;
		expect(body.bootTime).toBe("2026-11-16T10:00:00.000Z");
		expect(body.serviceVersion).toBe("abc123");
		expect(body.instanceId).toBe("web-0");
		expect(body.env).toEqual({
			CLOUD_INSTANCE_ID: sha("web-0"),
			CLOUD_PUBLIC_URL: sha("https://fx.example"),
			DATABASE_URL: null,
			EMPTY_ONE: null,
			SERVICE_VERSION: sha("abc123"),
			TOKEN: sha("s3cret"),
		});
		expect(body.empty).toEqual(["EMPTY_ONE"]);
		const text = JSON.stringify(body);
		expect(text).not.toContain("s3cret");
		expect(text).not.toContain("pw@db");
		expect(text).not.toContain(sha("postgres://u:pw@db.example/x"));
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
	test("writes a row, reads it back, then deletes it", async () => {
		const d = deps();
		const response = await get("/items", d);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			wrote: { id: string };
			read: { id: string };
			deleted: boolean;
		};
		expect(body.wrote.id).toBe("i-1");
		expect(body.read.id).toBe("i-1");
		expect(body.deleted).toBe(true);
		expect(d.deleted).toEqual(["i-1"]);
	});

	test("503 without a database", async () => {
		const response = await get(
			"/items",
			deps({ writeItem: null, readItem: null, deleteItem: null }),
		);
		expect(response.status).toBe(503);
	});
});

describe("/enqueue", () => {
	test("queues a job and answers its id", async () => {
		const response = await get("/enqueue", deps());
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			id: "0b6d3c1e-5f1a-4c55-9a43-3f1b2c4d5e6f",
		});
	});

	test("503 without a database", async () => {
		const response = await get("/enqueue", deps({ enqueue: null }));
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			error: { code: "no_database" },
		});
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

describe("/log", () => {
	test("writes N marked lines to the log", async () => {
		const d = deps();
		const response = await get("/log?n=3&tag=p76-ab12", d);
		expect(response.status).toBe(200);
		expect(d.logged).toEqual([
			"fixture-log p76-ab12 1",
			"fixture-log p76-ab12 2",
			"fixture-log p76-ab12 3",
		]);
	});

	test("caps N and refuses an odd tag", async () => {
		const d = deps();
		await get("/log?n=5000&tag=x", d);
		expect(d.logged).toHaveLength(LOG_MAX_LINES);
		expect((await get("/log?n=1&tag=a%20b", deps())).status).toBe(400);
		expect((await get("/log?n=x&tag=a", deps())).status).toBe(400);
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

	test("ends after its time limit", async () => {
		const response = await get("/sse?every=1", deps({ sseLimitMs: 30 }));
		const text = await response.text();
		expect(text).toContain("data: ");
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
		expect(seen).toEqual(["smtp.gmail.com:443:4000"]);
		const body = (await response.json()) as { connected: boolean };
		expect(body.connected).toBe(true);
	});

	test("reports a failed connect", async () => {
		const response = await get(
			"/tcp?host=smtp.gmail.com&port=25",
			deps({
				connect: async () => ({
					connected: false,
					error: "no connection within 9000 ms",
				}),
			}),
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
					throw new Error("connect ECONNREFUSED 10.1.2.3:3000");
				},
			}),
		);
		const text = await response.text();
		expect(JSON.parse(text)).toMatchObject({
			connected: false,
			error: "refused",
		});
		expect(text).not.toContain("10.1.2.3");
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

test("genericError keeps only the kind of failure", () => {
	expect(genericError("The operation timed out.")).toBe("timeout");
	expect(genericError("connect ECONNREFUSED 10.0.0.1:25")).toBe("refused");
	expect(genericError("getaddrinfo ENOTFOUND x.internal")).toBe("dns");
	expect(genericError("connect EHOSTUNREACH 10.0.0.1")).toBe("unreachable");
	expect(genericError("read ECONNRESET")).toBe("reset");
	expect(genericError("something about 10.0.0.1")).toBe("error");
});

describe("later batches", () => {
	test("answer 501 not_in_this_batch", async () => {
		for (const path of [
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

describe("/info urls", () => {
	test("shows each CLOUD_URL_<NAME> in clear, and null for one with a credential", async () => {
		const response = await get(
			"/info",
			deps({
				env: {
					CLOUD_URL_P17A_K3X9QA:
						"http://p17a-k3x9qa.p-p17.svc.cluster.local:3000",
					CLOUD_URL_BAD: "http://u:pw@db.example/",
					TOKEN: "s3cret",
				},
			}),
		);
		const body = (await response.json()) as { urls: Record<string, unknown> };
		expect(body.urls).toEqual({
			CLOUD_URL_BAD: null,
			CLOUD_URL_P17A_K3X9QA: "http://p17a-k3x9qa.p-p17.svc.cluster.local:3000",
		});
	});

	test("serviceUrls ignores every other name and a value that is not a URL", () => {
		expect(
			serviceUrls({ DATABASE_URL: "postgres://x", CLOUD_URL_X: "not a url" }),
		).toEqual({ CLOUD_URL_X: null });
	});
});

describe("/fill", () => {
	test("writes N MiB and answers the table's size", async () => {
		const d = deps();
		const response = await get("/fill?mb=100", d);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ wroteMib: 100, tableMib: 101 });
		expect(d.logged).toEqual(["fixture-fill 100 MiB, table 101 MiB"]);
	});

	test("refuses 0, too much and junk", async () => {
		for (const q of ["mb=0", "mb=257", "mb=x", ""])
			expect((await get(`/fill?${q}`, deps())).status).toBe(400);
	});

	test("clear=1 drops the table", async () => {
		let cleared = 0;
		const response = await get(
			"/fill?clear=1",
			deps({
				clearFill: async () => {
					cleared += 1;
				},
			}),
		);
		expect(await response.json()).toEqual({ cleared: true });
		expect(cleared).toBe(1);
	});

	test("503 without a database", async () => {
		expect(
			(await get("/fill?mb=1", deps({ fill: null, clearFill: null }))).status,
		).toBe(503);
	});
});

describe("/sink", () => {
	const NAME = "Zq9xYw8vUt7sRq6p";
	const on = () => deps({ env: { FIXTURE_SINK: "on" }, sink: new SinkStore() });
	const post = (path: string, d: FixtureDeps, body: string) =>
		handleFixture(
			new Request(`http://fx.test${path}`, {
				method: "POST",
				body,
				headers: {
					"content-type": "application/json",
					"webhook-id": "msg_1",
					"x-cloud-edge-secret": "edge-secret-value",
				},
			}),
			d,
		);

	test("is 404 unless FIXTURE_SINK=on", async () => {
		expect((await post(`/sink/${NAME}`, deps(), "{}")).status).toBe(404);
	});

	test("keeps a POST, answers 200, and lists it in the inbox without the edge's header", async () => {
		const d = on();
		const answer = await post(`/sink/${NAME}`, d, '{"type":"deploy.live"}');
		expect(answer.status).toBe(200);
		expect(await answer.json()).toEqual({ stored: 1 });
		const inbox = await get(`/sink/${NAME}/inbox`, d);
		const text = await inbox.text();
		expect(text).not.toContain("edge-secret-value");
		const body = JSON.parse(text) as {
			deliveries: { body: string; headers: Record<string, string> }[];
		};
		expect(body.deliveries).toHaveLength(1);
		expect(body.deliveries[0]?.body).toBe('{"type":"deploy.live"}');
		expect(body.deliveries[0]?.headers["webhook-id"]).toBe("msg_1");
	});

	test("a fail- name answers 500 and still keeps the delivery", async () => {
		const d = on();
		const answer = await post(`/sink/fail-${NAME}`, d, "{}");
		expect(answer.status).toBe(500);
		const inbox = (await (await get(`/sink/fail-${NAME}/inbox`, d)).json()) as {
			deliveries: { answered: number }[];
		};
		expect(inbox.deliveries.map((x) => x.answered)).toEqual([500]);
	});

	test("refuses a short name, a GET on the sink and a POST on the inbox", async () => {
		const d = on();
		expect((await post("/sink/short", d, "{}")).status).toBe(400);
		expect((await get(`/sink/${NAME}`, d)).status).toBe(405);
		expect((await post(`/sink/${NAME}/inbox`, d, "{}")).status).toBe(405);
	});
});

describe("/log level", () => {
	test("level=error starts each line with ERROR, as cloud logs --level reads it", async () => {
		const d = deps();
		const response = await get("/log?n=2&tag=p63-hit&level=error", d);
		expect(await response.json()).toEqual({
			logged: 2,
			tag: "p63-hit",
			level: "error",
		});
		expect(d.logged).toEqual([
			"ERROR fixture-log p63-hit 1",
			"ERROR fixture-log p63-hit 2",
		]);
	});

	test("an unknown level is refused", async () => {
		expect((await get("/log?n=1&tag=x&level=debug", deps())).status).toBe(400);
	});
});
