import { describe, expect, test } from "bun:test";

import { bodyReader, readUntil } from "../testdata/sse.js";
import {
	createSseHub,
	formatSseEvent,
	MAX_PAYLOAD_BYTES,
	parseMessage,
	parseRealtimeEvent,
	sanitizeClientId,
} from "./index.js";

describe("SSE hub", () => {
	test("a stream opens with the SSE headers and a retry hint", async () => {
		const hub = createSseHub({ retryMs: 3000 });
		const controller = new AbortController();
		const res = hub.subscribe("user-a", controller.signal);
		expect(res.headers.get("content-type")).toStartWith("text/event-stream");
		expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
		expect(res.headers.get("x-accel-buffering")).toBe("no");
		expect(
			await readUntil(bodyReader(res), (t) => t.includes("\n\n")),
		).toStartWith("retry: 3000\n");
		controller.abort();
	});

	test("events reach only the topic's streams; to null reaches everyone", async () => {
		const hub = createSseHub();
		const a = new AbortController();
		const b = new AbortController();
		const first = bodyReader(hub.subscribe("user-a", a.signal));
		const second = bodyReader(hub.subscribe("user-b", b.signal));
		await readUntil(first, (t) => t.includes("connected"));
		await readUntil(second, (t) => t.includes("connected"));

		hub.dispatch({
			to: "user-a",
			event: { type: "invalidate", keys: [["items"]], source: "tab-1" },
		});
		hub.dispatch({ to: null, event: { type: "resync" } });
		const forA = await readUntil(first, (t) => t.includes("event: resync"));
		const forB = await readUntil(second, (t) => t.includes("event: resync"));
		expect(forA).toContain(
			'event: invalidate\ndata: {"type":"invalidate","keys":[["items"]],"source":"tab-1"}\n\n',
		);
		expect(forB).not.toContain("invalidate");
		a.abort();
		b.abort();
	});

	test("a comment heartbeat is sent on the interval", async () => {
		const hub = createSseHub({ heartbeatMs: 50 });
		const controller = new AbortController();
		const text = await readUntil(
			bodyReader(hub.subscribe("user-a", controller.signal)),
			(t) => (t.match(/: ping\n\n/g) ?? []).length >= 2,
		);
		expect(text).toContain(": ping\n\n");
		controller.abort();
	});

	test("aborting the request closes the stream and forgets it", async () => {
		const hub = createSseHub();
		const controller = new AbortController();
		const reader = bodyReader(hub.subscribe("user-a", controller.signal));
		expect(hub.size()).toBe(1);
		controller.abort();
		expect(hub.size()).toBe(0);
		await readUntil(reader, () => false, 200).catch(() => "");
		expect((await reader.read()).done).toBe(true);
	});

	test("closeAll ends every stream", async () => {
		const hub = createSseHub();
		hub.subscribe("a", new AbortController().signal);
		hub.subscribe("b", new AbortController().signal);
		hub.closeAll();
		expect(hub.size()).toBe(0);
	});
});

describe("events", () => {
	test("formatSseEvent", () => {
		expect(formatSseEvent({ type: "resync" })).toBe(
			'event: resync\ndata: {"type":"resync"}\n\n',
		);
	});

	test("client ids are limited to 64 plain characters", () => {
		expect(sanitizeClientId("abc-DEF_123")).toBe("abc-DEF_123");
		expect(sanitizeClientId("x".repeat(65))).toBeNull();
		expect(sanitizeClientId("a\nb")).toBeNull();
		expect(sanitizeClientId(null)).toBeNull();
	});

	test("the default parser accepts the two event shapes only", () => {
		expect(
			parseRealtimeEvent({
				type: "invalidate",
				keys: [["items", 3]],
				source: "t1",
			}),
		).toEqual({
			type: "invalidate",
			keys: [["items", 3]],
			source: "t1",
		});
		expect(
			parseRealtimeEvent({
				type: "invalidate",
				keys: [["a"]],
				source: "bad id!",
			}),
		).toEqual({
			type: "invalidate",
			keys: [["a"]],
			source: null,
		});
		expect(parseRealtimeEvent({ type: "resync", extra: 1 })).toEqual({
			type: "resync",
		});
		expect(
			parseRealtimeEvent({ type: "invalidate", keys: "items" }),
		).toBeNull();
		expect(parseRealtimeEvent({ type: "invalidate", keys: [[]] })).toBeNull();
		expect(
			parseRealtimeEvent({ type: "invalidate", keys: [[{ a: 1 }]] }),
		).toBeNull();
		expect(parseRealtimeEvent({ type: "drop_tables" })).toBeNull();
		expect(parseRealtimeEvent(null)).toBeNull();
	});

	test("parseMessage checks `to` and hands the event to the parser", () => {
		const custom = (raw: unknown) =>
			(raw as { type?: unknown })?.type === "poke"
				? { type: "poke" as const }
				: null;
		expect(parseMessage('{"to":"u","event":{"type":"poke"}}', custom)).toEqual({
			to: "u",
			event: { type: "poke" },
		});
		expect(
			parseMessage('{"to":null,"event":{"type":"poke"}}', custom)?.to,
		).toBeNull();
		expect(parseMessage('{"to":1,"event":{"type":"poke"}}', custom)).toBeNull();
		expect(
			parseMessage('{"to":"u","event":{"type":"other"}}', custom),
		).toBeNull();
		expect(parseMessage("not json", custom)).toBeNull();
	});

	test("the payload cap stays under Postgres' 8000 bytes", () => {
		expect(MAX_PAYLOAD_BYTES).toBeLessThan(8000);
	});
});
