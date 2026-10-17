import { describe, expect, test } from "bun:test";

import { safeReturnPath } from "./index.js";

describe("safeReturnPath", () => {
	test.each([
		["/view/today", "/view/today"],
		["/list/work?x=1", "/list/work?x=1"],
		["/a/../list/b", "/list/b"],
		["/", "/"],
	])("keeps the same-origin path %p", (raw, expected) => {
		expect(safeReturnPath(raw)).toBe(expected);
	});

	test.each([
		null,
		undefined,
		"",
		"view",
		"https://evil.example/",
		"//evil.example/",
		"/\\evil",
		// Dot segments collapse into a protocol-relative path once normalised.
		"/.//evil.example/x",
		"/..//evil.example",
		"/a/..//evil.example",
		"/%2e//evil.example",
		"/%2E%2E//evil.example",
		"/./\\evil.example",
		"/.\\/evil.example",
		"/a/../\\evil.example",
	])("refuses %p", (raw) => {
		expect(safeReturnPath(raw)).toBe("/");
	});

	test("never returns a protocol-relative path", () => {
		const parts = ["/", ".", "..", "%2e", "\\", "a", "evil.example"];
		for (const a of parts)
			for (const b of parts)
				for (const c of parts)
					for (const d of parts) {
						const result = safeReturnPath(`/${a}${b}${c}${d}`);
						expect(result.startsWith("/")).toBe(true);
						expect(result.startsWith("//")).toBe(false);
						expect(result.startsWith("/\\")).toBe(false);
					}
	});
});
