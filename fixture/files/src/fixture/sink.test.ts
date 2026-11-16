import { describe, expect, test } from "bun:test";

import {
	keptHeaders,
	SINK_MAX_BODY,
	SINK_MAX_DELIVERIES,
	SINK_MAX_SINKS,
	SinkStore,
	sinkAnswer,
	sinkEnabled,
} from "./sink";

const at = new Date("2026-11-16T10:00:00.000Z");
const NAME = "abcdefghijklmnop0123";

describe("the sink", () => {
	test("is on only with FIXTURE_SINK=on", () => {
		expect(sinkEnabled({ FIXTURE_SINK: "on" })).toBe(true);
		expect(sinkEnabled({})).toBe(false);
		expect(sinkEnabled({ FIXTURE_SINK: "1" })).toBe(false);
	});

	test("answers 500 for a fail- name", () => {
		expect(sinkAnswer(`fail-${NAME}`)).toBe(500);
		expect(sinkAnswer(NAME)).toBe(200);
	});

	test("keeps the webhook headers, never a cookie, an edge or a proxy header", () => {
		const kept = keptHeaders(
			new Headers({
				"webhook-id": "msg_1",
				"webhook-timestamp": "1",
				"webhook-signature": "v1,abc",
				"content-type": "application/json",
				"user-agent": "Cloud",
				cookie: "s=1",
				authorization: "Bearer x",
				"x-cloud-edge-secret": "edge",
				"x-cloud-user-email": "a@b",
				"cf-connecting-ip": "203.0.113.1",
				"x-forwarded-for": "203.0.113.1",
			}),
		);
		expect(Object.keys(kept).sort()).toEqual([
			"content-type",
			"user-agent",
			"webhook-id",
			"webhook-signature",
			"webhook-timestamp",
		]);
	});

	test("lists a name's deliveries in order, numbered, and no other name's", () => {
		const store = new SinkStore();
		store.record(NAME, {
			method: "POST",
			headers: new Headers(),
			body: "a",
			at,
		});
		store.record(`other-${NAME}`, {
			method: "POST",
			headers: new Headers(),
			body: "x",
			at,
		});
		store.record(NAME, {
			method: "POST",
			headers: new Headers(),
			body: "b",
			at,
		});
		const inbox = store.inbox(NAME);
		expect(inbox.map((d) => [d.n, d.body, d.answered])).toEqual([
			[1, "a", 200],
			[2, "b", 200],
		]);
		expect(store.inbox("nobody-has-this-name")).toEqual([]);
	});

	test("bounds the body, the deliveries and the sinks", () => {
		const store = new SinkStore();
		const big = store.record(NAME, {
			method: "POST",
			headers: new Headers(),
			body: "x".repeat(SINK_MAX_BODY + 5),
			at,
		});
		expect(big.body).toHaveLength(SINK_MAX_BODY);
		expect(big.truncated).toBe(true);
		for (let i = 0; i < SINK_MAX_DELIVERIES + 3; i++)
			store.record(NAME, {
				method: "POST",
				headers: new Headers(),
				body: "",
				at,
			});
		const inbox = store.inbox(NAME);
		expect(inbox).toHaveLength(SINK_MAX_DELIVERIES);
		expect(inbox.at(-1)?.n).toBe(SINK_MAX_DELIVERIES + 4);
		for (let i = 0; i < SINK_MAX_SINKS; i++)
			store.record(`sink-${i}-${NAME}`, {
				method: "POST",
				headers: new Headers(),
				body: "",
				at,
			});
		expect(store.inbox(NAME)).toEqual([]);
	});
});
