import { describe, expect, test } from "bun:test";

import { extractBlocks, snippetFile } from "./check-readmes.js";

describe("extractBlocks", () => {
	test("takes ts blocks with the typecheck preamble right before them", () => {
		const md = [
			"# pkg",
			"",
			"<!-- typecheck-preamble",
			"declare const request: Request;",
			"-->",
			"```ts",
			"const url = request.url;",
			"```",
			"",
			"```sh",
			"bun add x",
			"```",
			"",
			"```ts",
			'import { x } from "y";',
			"```",
		].join("\n");
		expect(extractBlocks(md)).toEqual([
			{
				preamble: "declare const request: Request;",
				code: "const url = request.url;",
				line: 7,
			},
			{ preamble: "", code: 'import { x } from "y";', line: 15 },
		]);
	});

	test("a preamble separated from its block by prose does not apply", () => {
		const md = [
			"<!-- typecheck-preamble",
			"declare const a: string;",
			"-->",
			"Some prose.",
			"```ts",
			"a;",
			"```",
		].join("\n");
		expect(extractBlocks(md)[0]?.preamble).toBe("");
	});
});

describe("snippetFile", () => {
	test("puts the imports first and makes the file a module", () => {
		const text = snippetFile({
			preamble: "declare const n: number;",
			code: 'const x = n;\nimport { y } from "z";\ny(x);',
			line: 1,
		});
		expect(text.split("\n")[0]).toBe('import { y } from "z";');
		expect(text).toContain("declare const n: number;");
		expect(text.trimEnd().endsWith("export {};")).toBe(true);
	});
});
