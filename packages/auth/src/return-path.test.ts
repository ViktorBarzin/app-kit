import { describe, expect, test } from "bun:test";

import { createAppAuth, safeReturnPath } from "./index.js";

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

describe("createAppAuth links", () => {
	const appAuth = createAppAuth(() => ({
		appName: "App",
		appSlug: "app",
		db: () => {
			throw new Error("no database in this test");
		},
		publicOrigins: ["https://app.example"],
		betterAuthSecret: null,
		oidc: null,
		authentik: {
			apiUrl: null,
			readerToken: null,
			approverToken: null,
			usersGroupPk: null,
		},
		groups: { users: "App Users", admins: "App Admins" },
		signup: "request",
	}));

	test("signInUrl is the start route with a safe return path", () => {
		expect(appAuth.signInUrl("/items")).toBe("/api/auth/start?return=%2Fitems");
		expect(appAuth.signInUrl("//evil.example")).toBe(
			"/api/auth/start?return=%2F",
		);
	});

	test("signOutUrl is null: Better Auth signs out with a POST", () => {
		expect(appAuth.signOutUrl("/")).toBeNull();
	});
});
