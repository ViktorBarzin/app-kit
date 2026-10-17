import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	copyTemplate,
	parseExportArgs,
	rewriteManifest,
} from "./export-template.js";

const dirs: string[] = [];
afterAll(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

describe("rewriteManifest", () => {
	test("workspace ranges become caret ranges of the published versions", () => {
		const out = rewriteManifest(
			{
				name: "starter",
				dependencies: { "@viktorbarzin/log": "workspace:^", react: "^19.2.0" },
				devDependencies: { "@viktorbarzin/pg": "workspace:^" },
			},
			{ "@viktorbarzin/log": "0.1.0", "@viktorbarzin/pg": "0.2.3" },
		);
		expect(out.dependencies).toEqual({
			"@viktorbarzin/log": "^0.1.0",
			react: "^19.2.0",
		});
		expect(out.devDependencies).toEqual({ "@viktorbarzin/pg": "^0.2.3" });
	});

	test("a workspace package without a version is an error", () => {
		expect(() =>
			rewriteManifest(
				{ dependencies: { "@viktorbarzin/x": "workspace:^" } },
				{},
			),
		).toThrow("@viktorbarzin/x");
	});
});

describe("copyTemplate", () => {
	test("copies the template without build output, resolves versions, and writes a root biome config", async () => {
		const target = await mkdtemp(join(tmpdir(), "export-"));
		dirs.push(target);
		await writeFile(join(target, "stale.txt"), "removed by the export");
		await copyTemplate(target);
		const manifest = await readFile(join(target, "package.json"), "utf8");
		expect(manifest).not.toContain("workspace:");
		expect(JSON.parse(manifest).dependencies["@viktorbarzin/auth"]).toBe(
			"^0.1.0",
		);
		expect(existsSync(join(target, "node_modules"))).toBe(false);
		expect(existsSync(join(target, ".output"))).toBe(false);
		expect(existsSync(join(target, "stale.txt"))).toBe(false);
		expect(existsSync(join(target, "src/app.config.ts"))).toBe(true);
		const biome = JSON.parse(
			await readFile(join(target, "biome.json"), "utf8"),
		);
		expect(biome.root).toBeUndefined();
		expect(biome.extends).toBeUndefined();
		expect(biome.linter.enabled).toBe(true);
	});
});

describe("parseExportArgs", () => {
	test("defaults: temporary clone, install, no push", () => {
		expect(parseExportArgs([])).toEqual({
			target: null,
			push: false,
			install: true,
		});
	});

	test("--no-install skips bun install, for an export before the packages are on npm", () => {
		expect(
			parseExportArgs(["--target", "/tmp/x", "--push", "--no-install"]),
		).toEqual({ target: "/tmp/x", push: true, install: false });
	});

	test("--target needs a directory", () => {
		expect(() => parseExportArgs(["--target"])).toThrow("--target");
	});

	test("an unknown flag is an error", () => {
		expect(() => parseExportArgs(["--frobnicate"])).toThrow("--frobnicate");
	});
});
