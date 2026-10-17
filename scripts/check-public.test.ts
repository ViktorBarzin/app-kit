import { describe, expect, test } from "bun:test";

import { findViolations } from "./check-public.js";

const file = (text: string, path = "packages/x/src/a.ts") => ({ path, text });

describe("findViolations", () => {
	test("clean code passes", () => {
		expect(
			findViolations([
				file(
					'const issuer = "https://idp.example/application/o/app/";\nconst v = "10.0.3";',
				),
				file('// Authentik. Users are keyed on sub.\nparams.get("client_id")'),
			]),
		).toEqual([]);
	});

	test.each([
		[
			"the homelab domain",
			'const u = "https://tasks.viktorbarzin.me";',
			"viktorbarzin.me",
		],
		[
			"a forgejo hostname",
			"git push https://forgejo.example.org/x",
			"forgejo hostname",
		],
		["an internal address", 'const lb = "10.0.20.203";', "10.0.x.x address"],
		[
			"an authentik hostname",
			"fetch('https://authentik.example.org/api/v3')",
			"authentik hostname",
		],
		[
			"a client_id literal",
			'body: { client_id: "tasks-web" }',
			"client_id literal",
		],
		["a client_id assignment", "client_id='abc'", "client_id literal"],
	])("flags %s", (_name, text, rule) => {
		const found = findViolations([file(text, "packages/auth/dist/index.js")]);
		expect(found).toHaveLength(1);
		expect(found[0]).toMatchObject({
			path: "packages/auth/dist/index.js",
			line: 1,
			rule,
		});
	});

	test("reports the line number", () => {
		expect(
			findViolations([file("ok\nok\nhttps://viktorbarzin.me\n")])[0]?.line,
		).toBe(3);
	});
});
