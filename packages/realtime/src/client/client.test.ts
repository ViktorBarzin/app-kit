import { afterEach, describe, expect, it, mock } from "bun:test";

import { type FakeTimeouts, fakeTimeouts } from "../testdata/test-timers.js";
import {
	clientId,
	type EventSourceLike,
	RESUME_RECONNECT_MS,
	startLiveUpdates,
	startRealtime,
} from "./index.js";

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

class FakeSource implements EventSourceLike {
	readyState = CONNECTING;
	closed = false;
	private listeners = new Map<string, Set<(e: MessageEvent) => void>>();
	constructor(readonly url: string) {}
	addEventListener(type: string, fn: (e: MessageEvent) => void): void {
		const set = this.listeners.get(type) ?? new Set();
		set.add(fn);
		this.listeners.set(type, set);
	}
	close(): void {
		this.closed = true;
		this.readyState = CLOSED;
	}
	emit(type: string, data?: unknown): void {
		if (type === "open") this.readyState = OPEN;
		const event = new MessageEvent(type, {
			data: data === undefined ? "" : JSON.stringify(data),
		});
		for (const fn of this.listeners.get(type) ?? []) fn(event);
	}
	/** The browser gave up (a non-200 answer such as a 401): no auto-retry. */
	fail(): void {
		this.readyState = CLOSED;
		this.emit("error");
	}
	/** A dropped connection the browser retries by itself. */
	drop(): void {
		this.readyState = CONNECTING;
		this.emit("error");
	}
}

let timers: FakeTimeouts | null = null;
afterEach(() => {
	timers?.restore();
	timers = null;
});

function harness(eventTypes = ["invalidate"]) {
	const sources: FakeSource[] = [];
	const onEvent = mock((_type: string, _data: unknown) => {});
	const onResync = mock(() => {});
	const rt = startRealtime({
		url: "/api/stream",
		eventTypes,
		createSource: (url) => {
			const s = new FakeSource(url);
			sources.push(s);
			return s;
		},
		onEvent,
		onResync,
	});
	const last = () => sources[sources.length - 1] as FakeSource;
	return { rt, sources, last, onEvent, onResync };
}

describe("startRealtime", () => {
	it("subscribes to the configured URL", () => {
		expect(harness().sources.map((s) => s.url)).toEqual(["/api/stream"]);
	});

	it("passes the configured event types with their parsed data", () => {
		const { last, onEvent } = harness(["invalidate", "poke"]);
		last().emit("invalidate", {
			type: "invalidate",
			keys: [["a"]],
			source: null,
		});
		last().emit("poke", { type: "poke" });
		last().emit("unlisted", { type: "unlisted" });
		expect(onEvent.mock.calls).toEqual([
			["invalidate", { type: "invalidate", keys: [["a"]], source: null }],
			["poke", { type: "poke" }],
		]);
	});

	it("unparseable data arrives as null", () => {
		const { last, onEvent } = harness();
		last().emit("invalidate");
		expect(onEvent.mock.calls).toEqual([["invalidate", null]]);
	});

	it("resyncs on open and on a server `resync`", () => {
		const { last, onResync } = harness();
		last().emit("open");
		last().emit("resync", { type: "resync" });
		expect(onResync).toHaveBeenCalledTimes(2);
	});

	it("resyncs after every reconnect, since events sent meanwhile are lost", () => {
		const { last, onResync } = harness();
		last().emit("open");
		last().drop();
		last().emit("open");
		expect(onResync).toHaveBeenCalledTimes(2);
	});

	it("reconnects by itself, with backoff, when the browser gives up (e.g. a 401)", async () => {
		timers = fakeTimeouts();
		const { sources, last } = harness();
		last().fail();
		expect(sources).toHaveLength(1);
		await timers.advance(1000);
		expect(sources).toHaveLength(2);
		last().fail();
		await timers.advance(1999);
		expect(sources).toHaveLength(2);
		await timers.advance(1);
		expect(sources).toHaveLength(3);
	});

	it("leaves a dropped connection to the browser's own retry", async () => {
		timers = fakeTimeouts();
		const { sources, last } = harness();
		last().emit("open");
		last().drop();
		await timers.advance(120_000);
		expect(sources).toHaveLength(1);
	});

	it("reconnectNow reopens a given-up connection at once, and leaves a live one alone", () => {
		timers = fakeTimeouts();
		const { rt, sources, last } = harness();
		last().fail();
		rt.reconnectNow();
		expect(sources).toHaveLength(2);
		last().emit("open");
		rt.reconnectNow();
		expect(sources).toHaveLength(2);
	});

	it("resuming after a long time hidden reopens even a connection that looks open", () => {
		const { rt, sources, last, onResync } = harness();
		last().emit("open");
		rt.resume(RESUME_RECONNECT_MS - 1);
		expect(sources).toHaveLength(1);
		rt.resume(RESUME_RECONNECT_MS);
		expect(sources).toHaveLength(2);
		expect(sources[0]?.closed).toBe(true);
		last().emit("open");
		expect(onResync).toHaveBeenCalledTimes(2);
	});

	it("stop closes the connection and cancels any pending reconnect", async () => {
		timers = fakeTimeouts();
		const { rt, sources, last } = harness();
		last().fail();
		rt.stop();
		await timers.advance(120_000);
		expect(sources).toHaveLength(1);
		expect(sources[0]?.closed).toBe(true);
	});
});

describe("page helpers", () => {
	it("clientId is fixed for the page and fits the server's sanitizer", () => {
		expect(clientId()).toBe(clientId());
		expect(clientId()).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
	});

	it("startLiveUpdates is a no-op without a browser", () => {
		expect(
			startLiveUpdates({ onEvent: () => {}, onResync: () => {} }),
		).toBeNull();
	});
});
