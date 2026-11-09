import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
	checkEvent,
	EVENT_NAME_PATTERN,
	isProductionHost,
	MAX_PROPERTIES_LENGTH,
	PROPERTY_KEY_PATTERN,
} from "./index.js";

const word = fc.stringMatching(/^[a-z][a-z0-9_]{0,11}$/);
const label = fc.stringMatching(/^[a-z0-9]([a-z0-9-]{0,10}[a-z0-9])?$/);

describe("checkEvent", () => {
	test("noun.past_verb names with snake_case keys pass unchanged (property)", () => {
		fc.assert(
			fc.property(
				word,
				word,
				fc.dictionary(word, fc.oneof(fc.integer(), fc.boolean()), {
					maxKeys: 5,
				}),
				(noun, verb, properties) => {
					const result = checkEvent(`${noun}.${verb}`, properties);
					expect(result.problems).toEqual([]);
					expect(result.accepted).toEqual({
						event: `${noun}.${verb}`,
						properties,
					});
				},
			),
		);
	});

	test.each([
		"Recording.started",
		"recording",
		"recording.started.twice",
		"recording.Started",
		"recording-started",
		"1recording.started",
		".started",
		"",
	])("the name %p is refused", (name) => {
		const result = checkEvent(name, {});
		expect(result.accepted).toBeNull();
		expect(result.problems[0]).toContain("noun.past_verb");
	});

	test("a name the pattern refuses is always refused (property)", () => {
		fc.assert(
			fc.property(fc.string(), (name) => {
				fc.pre(!EVENT_NAME_PATTERN.test(name));
				expect(checkEvent(name).accepted).toBeNull();
			}),
		);
	});

	test("keys that are not snake_case are dropped and reported; the rest is kept", () => {
		const result = checkEvent("trip.created", {
			trip_id: 1,
			tripName: "x",
			"Bad Key": 2,
		});
		expect(result.accepted).toEqual({
			event: "trip.created",
			properties: { trip_id: 1 },
		});
		expect(result.problems).toEqual([
			'property key is not snake_case: "tripName"',
			'property key is not snake_case: "Bad Key"',
		]);
	});

	test("accepted keys always match the pipeline's pattern (property)", () => {
		fc.assert(
			fc.property(fc.dictionary(fc.string(), fc.integer()), (properties) => {
				const result = checkEvent("a.b", properties);
				for (const key of Object.keys(result.accepted?.properties ?? {}))
					expect(PROPERTY_KEY_PATTERN.test(key)).toBe(true);
			}),
		);
	});

	test("properties longer than the limit as JSON refuse the event", () => {
		const fits = "x".repeat(MAX_PROPERTIES_LENGTH - '{"note":""}'.length);
		expect(checkEvent("a.b", { note: fits }).accepted).not.toBeNull();
		const result = checkEvent("a.b", { note: `${fits}x` });
		expect(result.accepted).toBeNull();
		expect(result.problems[0]).toContain("2048");
	});
});

describe("isProductionHost", () => {
	const hosts = ["example.com"];

	test("the domain itself and any subdomain are production (property)", () => {
		fc.assert(
			fc.property(fc.array(label, { maxLength: 3 }), (labels) => {
				const host = [...labels, "example.com"].join(".");
				expect(isProductionHost(host, hosts)).toBe(true);
				expect(isProductionHost(host.toUpperCase(), hosts)).toBe(true);
			}),
		);
	});

	test("lookalikes are not production (property)", () => {
		fc.assert(
			fc.property(label, (prefix) => {
				expect(isProductionHost(`${prefix}example.com`, hosts)).toBe(false);
				expect(isProductionHost(`example.com.${prefix}`, hosts)).toBe(false);
			}),
		);
	});

	test.each([
		["localhost", false],
		["127.0.0.1", false],
		["", false],
		["app.example.com.", true],
	] as const)("%p -> %p", (host, expected) => {
		expect(isProductionHost(host, hosts)).toBe(expected);
	});

	test("no production hosts means nothing is production", () => {
		expect(isProductionHost("example.com", [])).toBe(false);
	});
});
