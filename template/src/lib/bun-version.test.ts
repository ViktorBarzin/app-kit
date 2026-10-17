import { describe, expect, test } from "bun:test";

import {
	assertBunVersion,
	bunVersionAtLeast,
	MIN_BUN_VERSION,
} from "./bun-version";

describe("bunVersionAtLeast", () => {
	test.each([
		["1.4.3", "1.4.3", true],
		["1.4.10", "1.4.3", true],
		["1.5.0", "1.4.3", true],
		["2.0.0", "1.4.3", true],
		["1.4.2", "1.4.3", false],
		["1.3.11", "1.4.3", false],
		["0.9.99", "1.4.3", false],
		["1.4.3-canary.1+abc", "1.4.3", true],
	])("%p >= %p is %p", (version, min, expected) => {
		expect(bunVersionAtLeast(version, min)).toBe(expected);
	});
});

describe("assertBunVersion", () => {
	test("names the version found and the one needed", () => {
		expect(() => assertBunVersion("1.3.11")).toThrow(
			`Bun ${MIN_BUN_VERSION} or newer is required (this is Bun 1.3.11)`,
		);
		expect(() => assertBunVersion(MIN_BUN_VERSION)).not.toThrow();
	});
});
