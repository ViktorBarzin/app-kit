import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
	BucketError,
	FETCH_TIMEOUT_MS,
	FILL_DEFAULT_MAX_MIB,
	type FillDb,
	type FixtureBucket,
	type FixtureDeps,
	fixtureHealthy,
	fixtureState,
	genericError,
	handleFixture,
	LOG_MAX_LINES,
	NOT_IN_THIS_BATCH,
	serviceUrls,
	UPLOAD_MAX_BYTES,
} from "./routes";
import { SinkStore } from "./sink";

/** A /fill database that starts at `startMib` and grows by what it writes. */
function fakeFill(startMib = 0): FillDb {
	let size = startMib;
	return {
		write: async (mib) => {
			size += mib;
		},
		clear: async () => {
			size = startMib;
		},
		databaseMib: async () => size,
	};
}

interface Stored {
	bytes: Uint8Array<ArrayBuffer>;
	contentType: string | null;
}

/** A Bucket in memory; `fail` makes every put throw it after reading the body. */
function fakeBucket(
	options: { fail?: BucketError; probe?: Record<string, BucketError> } = {},
): FixtureBucket & { stored: Map<string, Stored>; reads: number[] } {
	const stored = new Map<string, Stored>();
	const reads: number[] = [];
	return {
		stored,
		reads,
		async put(key, body, contentType) {
			const bytes = new Uint8Array(await new Response(body).arrayBuffer());
			reads.push(bytes.length);
			if (options.fail) throw options.fail;
			stored.set(key, { bytes, contentType });
		},
		async get(key) {
			const found = stored.get(key);
			if (!found) return null;
			return {
				body: new Response(found.bytes).body ?? new ReadableStream(),
				contentType: found.contentType,
				bytes: found.bytes.length,
			};
		},
		async probe(bucket) {
			const failure = options.probe?.[bucket];
			return failure
				? { ok: false, code: failure.code, message: failure.message }
				: { ok: true };
		},
	};
}

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
		fill: fakeFill(),
		sink: new SinkStore(),
		bucket: fakeBucket(),
		probePg: async () => ({ ok: true }),
		exits,
		slept,
		deleted,
		logged,
		...overrides,
	};
}

/** deps() with FIXTURE_UPLOAD=on, the switch /upload and /upload-form need. */
function upDeps(overrides: Partial<FixtureDeps> = {}) {
	const base = deps();
	return deps({
		...overrides,
		env: { ...base.env, FIXTURE_UPLOAD: "on", ...(overrides.env ?? {}) },
	});
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
		for (const path of ["/kv-selftest", "/probe/kv?key=x"]) {
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
	const on = (db: FillDb = fakeFill(), extra: Record<string, string> = {}) =>
		deps({ env: { FIXTURE_FILL: "on", ...extra }, fill: db });

	test("is 404 unless FIXTURE_FILL=on", async () => {
		expect((await get("/fill?mb=1", deps())).status).toBe(404);
	});

	test("writes N MiB and answers the database's size", async () => {
		const db = fakeFill(100);
		const d = on(db);
		const response = await get("/fill?mb=100", d);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			wroteMib: 100,
			databaseMib: 200,
			maxMib: FILL_DEFAULT_MAX_MIB,
		});
		expect(d.logged).toEqual(["fixture-fill 100 MiB, database 200 MiB"]);
	});

	test("refuses a write past the stop size, which FIXTURE_FILL_MAX_MIB moves", async () => {
		const full = await get("/fill?mb=200", on(fakeFill(800)));
		expect(full.status).toBe(409);
		expect(
			((await full.json()) as { error: { code: string } }).error.code,
		).toBe("fill_limit");
		expect(
			(
				await get(
					"/fill?mb=200",
					on(fakeFill(800), { FIXTURE_FILL_MAX_MIB: "5000" }),
				)
			).status,
		).toBe(200);
	});

	test("status=1 answers the size, the stop and whether a fill runs", async () => {
		const response = await get("/fill?status=1", on(fakeFill(300)));
		expect(await response.json()).toEqual({
			databaseMib: 300,
			maxMib: FILL_DEFAULT_MAX_MIB,
			busy: false,
		});
	});

	test("a write lifts the idle timeout; a refusal at the stop says the size", async () => {
		let kept = 0;
		const ok = await get(
			"/fill?mb=10",
			deps({
				env: { FIXTURE_FILL: "on" },
				fill: fakeFill(),
				keepOpen: () => {
					kept += 1;
				},
			}),
		);
		expect(ok.status).toBe(200);
		expect(kept).toBe(1);
		const full = await get("/fill?mb=200", on(fakeFill(800)));
		expect(full.status).toBe(409);
		expect(await full.json()).toMatchObject({
			error: { code: "fill_limit" },
			databaseMib: 800,
			maxMib: FILL_DEFAULT_MAX_MIB,
		});
	});

	test("one fill at a time", async () => {
		let release = () => {};
		const slow: FillDb = {
			...fakeFill(),
			write: () =>
				new Promise<void>((done) => {
					release = done;
				}),
		};
		const first = get("/fill?mb=1", on(slow));
		await Bun.sleep(10);
		const second = await get("/fill?mb=1", on(slow));
		expect(second.status).toBe(409);
		release();
		expect((await first).status).toBe(200);
	});

	test("refuses 0, too much and junk", async () => {
		for (const q of ["mb=0", "mb=257", "mb=x", ""])
			expect((await get(`/fill?${q}`, on())).status).toBe(400);
	});

	test("clear=1 drops the table", async () => {
		let cleared = 0;
		const response = await get(
			"/fill?clear=1",
			on({
				...fakeFill(),
				clear: async () => {
					cleared += 1;
				},
			}),
		);
		expect(await response.json()).toEqual({ cleared: true });
		expect(cleared).toBe(1);
	});

	test("503 without a database", async () => {
		expect(
			(
				await get(
					"/fill?mb=1",
					deps({ env: { FIXTURE_FILL: "on" }, fill: null }),
				)
			).status,
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

	test("refuses a body over 64 KiB with 413 and keeps nothing", async () => {
		const d = on();
		const answer = await post(`/sink/${NAME}`, d, "x".repeat(64 * 1024 + 1));
		expect(answer.status).toBe(413);
		const inbox = (await (await get(`/sink/${NAME}/inbox`, d)).json()) as {
			deliveries: unknown[];
		};
		expect(inbox.deliveries).toEqual([]);
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

	test("the level reaches the log writer, so the JSON console records it", async () => {
		const seen: [string, string | undefined][] = [];
		await get(
			"/log?n=1&tag=p63-lvl&level=error",
			deps({ log: (line, level) => seen.push([line, level]) }),
		);
		await get(
			"/log?n=1&tag=plain",
			deps({ log: (line, level) => seen.push([line, level]) }),
		);
		expect(seen).toEqual([
			["ERROR fixture-log p63-lvl 1", "error"],
			["fixture-log plain 1", undefined],
		]);
	});

	test("an unknown level is refused", async () => {
		expect((await get("/log?n=1&tag=x&level=debug", deps())).status).toBe(400);
	});
});

describe("/fetch stays open", () => {
	test("it lifts the idle timeout, and gives up before the server's 10 s", async () => {
		let kept = 0;
		const response = await get(
			"/fetch?url=https%3A%2F%2Ffx.example%2Finfo",
			deps({
				keepOpen: () => {
					kept += 1;
				},
			}),
		);
		expect(response.status).toBe(200);
		expect(kept).toBe(1);
		expect(FETCH_TIMEOUT_MS).toBeLessThan(10_000);
	});
});

const shaBytes = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");

const post = (path: string, d: FixtureDeps, init: RequestInit) =>
	handleFixture(
		new Request(`http://fx.test${path}`, { method: "POST", ...init }),
		d,
	);

/** `n` bytes that are not all the same. */
function bytesOf(n: number): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(n);
	for (let i = 0; i < n; i++) out[i] = (i * 31 + 7) % 251;
	return out;
}

describe("/upload", () => {
	test("is off unless FIXTURE_UPLOAD=on, and so is /upload-form", async () => {
		const bucket = fakeBucket();
		const off = await post("/upload?key=a", deps({ bucket }), { body: "x" });
		expect(off.status).toBe(404);
		expect(await off.text()).toContain("FIXTURE_UPLOAD=on");
		expect(bucket.stored.size).toBe(0);
		expect((await get("/upload-form", deps())).status).toBe(404);
	});

	test("a raw body goes to the bucket under ?key, answered with its SHA-256 and size", async () => {
		const bucket = fakeBucket();
		const body = bytesOf(70_000);
		const response = await post("/upload?key=docs/a.bin", upDeps({ bucket }), {
			body,
			headers: { "content-type": "application/pdf" },
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			key: "docs/a.bin",
			sha256: shaBytes(body),
			bytes: 70_000,
		});
		expect(bucket.stored.get("docs/a.bin")?.bytes).toEqual(body);
		expect(bucket.stored.get("docs/a.bin")?.contentType).toBe(
			"application/pdf",
		);
	});

	test("without ?key the fixture makes one", async () => {
		const bucket = fakeBucket();
		const response = await post("/upload", upDeps({ bucket }), {
			body: "hello",
		});
		const answer = (await response.json()) as { key: string; bytes: number };
		expect(answer.key).toMatch(/^[0-9a-f-]{36}$/);
		expect(answer.bytes).toBe(5);
		expect(bucket.stored.has(answer.key)).toBe(true);
	});

	test("a multipart form's field `file` is streamed, the other fields left out", async () => {
		const bucket = fakeBucket();
		const body = bytesOf(200_000);
		const form = new FormData();
		form.append("note", "not stored");
		// Bun's Blob: the tests' happy-dom replaces the global one.
		const blob = await new Response(body, {
			headers: { "content-type": "image/png" },
		}).blob();
		form.append("file", blob, "../../etc/passwd");
		const response = await post("/upload", upDeps({ bucket }), { body: form });
		expect(response.status).toBe(200);
		const answer = (await response.json()) as {
			key: string;
			sha256: string;
			bytes: number;
		};
		expect(answer.sha256).toBe(shaBytes(body));
		expect(answer.bytes).toBe(200_000);
		// The file name is the client's: never the key.
		expect(answer.key).toMatch(/^[0-9a-f-]{36}$/);
		expect(bucket.stored.get(answer.key)?.contentType).toBe("image/png");
		expect(bucket.stored.get(answer.key)?.bytes).toEqual(body);
	});

	test("a multipart form without a field `file` is refused", async () => {
		const form = new FormData();
		form.append("other", await new Response("x").blob(), "x.txt");
		const response = await post("/upload", upDeps(), { body: form });
		expect(response.status).toBe(400);
		expect(
			((await response.json()) as { error: { code: string } }).error.code,
		).toBe("no_file");
	});

	test("an S3 failure answers its status, code and message: the quota error as Garage sends it", async () => {
		const message =
			"Forbidden: Bucket size quota is reached, maximum total size of objects for this bucket: 1024.";
		const bucket = fakeBucket({
			fail: new BucketError("AccessDenied", 403, message),
		});
		const response = await post("/upload?key=big", upDeps({ bucket }), {
			body: bytesOf(2048),
		});
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: { code: "AccessDenied", message },
		});
	});

	test("a failure with no HTTP status, such as a dropped connection, answers 502", async () => {
		const bucket = fakeBucket({
			fail: new BucketError("s3_error", null, "socket hang up"),
		});
		const response = await post("/upload?key=k", upDeps({ bucket }), {
			body: "x",
		});
		expect(response.status).toBe(502);
	});

	test("a body past the edge's 100 MiB is refused with 413 and not stored", async () => {
		const bucket = fakeBucket();
		const chunk = new Uint8Array(1024 * 1024);
		let sent = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent > UPLOAD_MAX_BYTES) controller.close();
				else {
					sent += chunk.length;
					controller.enqueue(chunk);
				}
			},
		});
		const response = await post("/upload?key=huge", upDeps({ bucket }), {
			body,
		});
		expect(response.status).toBe(413);
		expect(bucket.stored.has("huge")).toBe(false);
	});

	test("lifts the idle timeout, since a large upload outlasts it", async () => {
		const kept: string[] = [];
		await post(
			"/upload?key=k",
			upDeps({ keepOpen: (r) => kept.push(new URL(r.url).pathname) }),
			{ body: "x" },
		);
		expect(kept).toEqual(["/upload"]);
	});

	test.each([
		["", "an empty key"],
		["a".repeat(513), "a key over 512 bytes"],
		["a\u0000b", "a control character"],
		["a/../b", "a .. segment"],
		["/abs", "an empty segment"],
	])("refuses %p (%s)", async (key) => {
		const bucket = fakeBucket();
		const response = await post(
			`/upload?key=${encodeURIComponent(key)}`,
			upDeps({ bucket }),
			{ body: "x" },
		);
		expect(response.status).toBe(400);
		expect(bucket.stored.size).toBe(0);
	});

	test("only POST", async () => {
		expect((await get("/upload", upDeps())).status).toBe(405);
	});

	test("503 without a Bucket", async () => {
		const response = await post("/upload", upDeps({ bucket: null }), {
			body: "x",
		});
		expect(response.status).toBe(503);
	});
});

describe("/files/<key>", () => {
	test("streams the object back as a download, never as a page", async () => {
		const bucket = fakeBucket();
		const body = bytesOf(4096);
		bucket.stored.set("docs/a b.bin", { bytes: body, contentType: null });
		const response = await get(
			`/files/${encodeURIComponent("docs/a b.bin")}`,
			deps({ bucket }),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe(
			"application/octet-stream",
		);
		expect(response.headers.get("content-disposition")).toBe("attachment");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(response.headers.get("content-length")).toBe("4096");
		expect(Buffer.from(await response.arrayBuffer())).toEqual(
			Buffer.from(body),
		);
	});

	test("a slash in the key may come plain", async () => {
		const bucket = fakeBucket();
		bucket.stored.set("docs/x.txt", {
			bytes: new TextEncoder().encode("<script>x</script>"),
			contentType: "text/html",
		});
		const response = await get("/files/docs/x.txt", deps({ bucket }));
		// The uploader's type is never served: a stored page cannot run here.
		expect(response.headers.get("content-type")).toBe(
			"application/octet-stream",
		);
		expect(response.headers.get("content-disposition")).toBe("attachment");
		expect(await response.text()).toBe("<script>x</script>");
	});

	test("404 JSON for a key that is not there", async () => {
		const response = await get("/files/missing", deps());
		expect(response.status).toBe(404);
		expect(
			((await response.json()) as { error: { code: string } }).error.code,
		).toBe("NoSuchKey");
	});

	test("400 for a key that is not valid", async () => {
		expect((await get("/files/%E0%A4%A", deps())).status).toBe(400);
		expect((await get("/files/a%00b", deps())).status).toBe(400);
	});

	test("503 without a Bucket", async () => {
		expect((await get("/files/a", deps({ bucket: null }))).status).toBe(503);
	});
});

describe("/probe/s3", () => {
	test("ok on a bucket the App's keys may read", async () => {
		const response = await get(
			"/probe/s3?bucket=p-own-files-0123456789",
			deps(),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			bucket: "p-own-files-0123456789",
			ok: true,
		});
	});

	test("another Project's bucket: the S3 error code as the SDK reports it", async () => {
		const bucket = fakeBucket({
			probe: {
				"p-other-files-abcdef0123": new BucketError(
					"AccessDenied",
					403,
					"Forbidden: Operation is not allowed for this key.",
				),
			},
		});
		const response = await get(
			"/probe/s3?bucket=p-other-files-abcdef0123",
			deps({ bucket }),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			bucket: "p-other-files-abcdef0123",
			ok: false,
			code: "AccessDenied",
			message: "Forbidden: Operation is not allowed for this key.",
		});
	});

	test("refuses a name S3 would not take", async () => {
		for (const name of ["", "A", "ab", "UPPER-case", "a_b_c", "x".repeat(64)])
			expect(
				(await get(`/probe/s3?bucket=${encodeURIComponent(name)}`, deps()))
					.status,
			).toBe(400);
	});

	test("503 without a Bucket: no keys to try", async () => {
		expect(
			(await get("/probe/s3?bucket=abc", deps({ bucket: null }))).status,
		).toBe(503);
	});
});

describe("/probe/pg", () => {
	test("tries the App's own credentials on database D", async () => {
		const tried: string[] = [];
		const response = await get(
			"/probe/pg?db=p_other_db",
			deps({
				probePg: async (db) => {
					tried.push(db);
					return {
						ok: false,
						code: "28P01",
						message: 'password authentication failed for user "p_own"',
					};
				},
			}),
		);
		expect(tried).toEqual(["p_other_db"]);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			db: "p_other_db",
			ok: false,
			code: "28P01",
			message: 'password authentication failed for user "p_own"',
		});
	});

	test("ok on a database the credentials open", async () => {
		expect(await (await get("/probe/pg?db=app", deps())).json()).toEqual({
			db: "app",
			ok: true,
		});
	});

	test("refuses a name that is not an identifier, without connecting", async () => {
		let tried = 0;
		const d = deps({
			probePg: async () => {
				tried += 1;
				return { ok: true };
			},
		});
		for (const name of ["", "1db", "a b", "a;drop", "x".repeat(64), "a/b"])
			expect(
				(await get(`/probe/pg?db=${encodeURIComponent(name)}`, d)).status,
			).toBe(400);
		expect(tried).toBe(0);
	});

	test("503 without a database", async () => {
		expect(
			(await get("/probe/pg?db=app", deps({ probePg: null }))).status,
		).toBe(503);
	});
});

test("/upload-form is a page with a file form posting multipart to /upload", async () => {
	const response = await get("/upload-form", upDeps());
	expect(response.status).toBe(200);
	expect(response.headers.get("content-type")).toContain("text/html");
	const html = await response.text();
	expect(html).toContain(
		'<form action="/upload" method="post" enctype="multipart/form-data">',
	);
	expect(html).toContain('<input type="file" name="file"');
	expect(html).toContain('type="submit"');
});
