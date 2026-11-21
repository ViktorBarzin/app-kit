import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
	mkdtemp,
	readdir,
	readFile,
	readlink,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TemplateVariant } from "../fixture/variant.js";
import {
	applyVariant,
	copyTemplate,
	exportTemplate,
	parseExportArgs,
	remoteFor,
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
		const authVersion = (await Bun.file("packages/auth/package.json").json())
			.version as string;
		expect(JSON.parse(manifest).dependencies["@viktorbarzin/auth"]).toBe(
			`^${authVersion}`,
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

	test("keeps CLAUDE.md a relative link to AGENTS.md (round 7)", async () => {
		const target = await mkdtemp(join(tmpdir(), "export-"));
		dirs.push(target);
		await copyTemplate(target);
		// Not the absolute path of app-kit's own template/AGENTS.md.
		expect(await readlink(join(target, "CLAUDE.md"))).toBe("AGENTS.md");
	});
});

describe("parseExportArgs", () => {
	test("defaults: temporary clone, install, no push", () => {
		expect(parseExportArgs([])).toEqual({
			target: null,
			push: false,
			install: true,
			keep: false,
			variant: null,
		});
	});

	test("--no-install skips bun install, for an export before the packages are on npm", () => {
		expect(
			parseExportArgs(["--target", "/tmp/x", "--push", "--no-install"]),
		).toEqual({
			target: "/tmp/x",
			push: true,
			install: false,
			keep: false,
			variant: null,
		});
	});

	test("--keep keeps the temporary clone after a push", () => {
		expect(parseExportArgs(["--push", "--keep"]).keep).toBe(true);
	});

	test("--target needs a directory", () => {
		expect(() => parseExportArgs(["--target"])).toThrow("--target");
	});

	test("--variant fixture picks the fixture variant", () => {
		expect(parseExportArgs(["--variant", "fixture"]).variant).toBe("fixture");
	});

	test("--variant refuses a name it does not know", () => {
		expect(() => parseExportArgs(["--variant", "other"])).toThrow("fixture");
		expect(() => parseExportArgs(["--variant"])).toThrow("--variant");
	});

	test("an unknown flag is an error", () => {
		expect(() => parseExportArgs(["--frobnicate"])).toThrow("--frobnicate");
	});
});

/** Runs git without the user's or the system's config. */
function git(args: string[], cwd: string): string {
	const proc = Bun.spawnSync(["git", ...args], { cwd, env: GIT_ENV });
	if (proc.exitCode !== 0)
		throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
	return proc.stdout.toString();
}

const GIT_ENV = {
	PATH: process.env.PATH ?? "/usr/bin:/bin",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_AUTHOR_NAME: "Export Test",
	GIT_AUTHOR_EMAIL: "export@app.example",
	GIT_COMMITTER_NAME: "Export Test",
	GIT_COMMITTER_EMAIL: "export@app.example",
};

/** A bare repo standing in for viktor/app-template, with one commit on master. */
async function bareRemote(): Promise<string> {
	const base = await mkdtemp(join(tmpdir(), "export-remote-"));
	dirs.push(base);
	const seed = join(base, "seed");
	const bare = join(base, "app-template.git");
	git(["init", "--quiet", "--initial-branch=master", seed], base);
	await writeFile(join(seed, "README.md"), "# old export\n");
	git(["add", "README.md"], seed);
	git(["commit", "--quiet", "-m", "old export"], seed);
	git(["clone", "--quiet", "--bare", seed, bare], base);
	return bare;
}

describe("exportTemplate without --target (round 9)", () => {
	const saved: Record<string, string | undefined> = {};
	beforeAll(() => {
		for (const [key, value] of Object.entries(GIT_ENV))
			if (key !== "PATH") {
				saved[key] = process.env[key];
				process.env[key] = value;
			}
	});
	afterAll(() => {
		for (const [key, value] of Object.entries(saved))
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
	});

	/** A directory of its own for the temporary clones, to see what is left. */
	async function tmpRoot(): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), "export-tmp-"));
		dirs.push(dir);
		return dir;
	}

	test("pushes the export and removes the temporary clone it made", async () => {
		const remote = await bareRemote();
		const root = await tmpRoot();
		const lines: string[] = [];
		const result = await exportTemplate(
			{ target: null, push: true, install: false, keep: false, variant: null },
			{ remote, tmpRoot: root, log: (line) => lines.push(line) },
		);
		expect(result.kept).toBe(false);
		expect(result.target.startsWith(join(root, "app-template-"))).toBe(true);
		expect(await readdir(root)).toEqual([]);
		expect(git(["log", "--format=%s", "master"], remote)).toStartWith(
			"Export template from app-kit ",
		);
		expect(git(["show", "master:package.json"], remote)).not.toContain(
			"workspace:",
		);
		expect(lines.join("\n")).toContain("removed the temporary clone");
	}, 60_000);

	test("removes the temporary clone when the push fails", async () => {
		const remote = await bareRemote();
		await writeFile(
			join(remote, "hooks", "pre-receive"),
			"#!/bin/sh\necho refused by the test >&2\nexit 1\n",
			{ mode: 0o755 },
		);
		const root = await tmpRoot();
		await expect(
			exportTemplate(
				{
					target: null,
					push: true,
					install: false,
					keep: false,
					variant: null,
				},
				{ remote, tmpRoot: root, log: () => {} },
			),
		).rejects.toThrow("git push");
		expect(await readdir(root)).toEqual([]);
		expect(git(["log", "--format=%s", "master"], remote).trim()).toBe(
			"old export",
		);
	}, 60_000);

	test("removes the temporary clone when the clone fails", async () => {
		const root = await tmpRoot();
		await expect(
			exportTemplate(
				{
					target: null,
					push: true,
					install: false,
					keep: false,
					variant: null,
				},
				{ remote: join(root, "missing.git"), tmpRoot: root, log: () => {} },
			),
		).rejects.toThrow("git clone");
		expect(await readdir(root)).toEqual([]);
	}, 60_000);

	test("--keep keeps the pushed clone and says where it is", async () => {
		const remote = await bareRemote();
		const root = await tmpRoot();
		const lines: string[] = [];
		const result = await exportTemplate(
			{ target: null, push: true, install: false, keep: true, variant: null },
			{ remote, tmpRoot: root, log: (line) => lines.push(line) },
		);
		expect(result.kept).toBe(true);
		expect(existsSync(join(result.target, "package.json"))).toBe(true);
		expect(lines.join("\n")).toContain(result.target);
	}, 60_000);

	test("without --push the clone is the output: kept, and named temporary", async () => {
		const remote = await bareRemote();
		const root = await tmpRoot();
		const lines: string[] = [];
		const result = await exportTemplate(
			{ target: null, push: false, install: false, keep: false, variant: null },
			{ remote, tmpRoot: root, log: (line) => lines.push(line) },
		);
		expect(result.kept).toBe(true);
		expect(existsSync(join(result.target, "package.json"))).toBe(true);
		const said = lines.join("\n");
		expect(said).toContain(result.target);
		expect(said).toContain("temporary");
		expect(said).toContain(`rm -rf ${result.target}`);
	}, 60_000);
});

describe("remoteFor", () => {
	test("the base template's repo, or the variant's", () => {
		expect(remoteFor(null, "tok")).toBe(
			"https://viktor:tok@forgejo.viktorbarzin.me/viktor/app-template.git",
		);
		expect(remoteFor("fixture", undefined)).toBe(
			"git@git.viktorbarzin.me:viktor/app-template-fixture.git",
		);
	});
});

describe("applyVariant (the fixture)", () => {
	test("overlays fixture/files and applies every edit to the copied template", async () => {
		const target = await mkdtemp(join(tmpdir(), "export-fixture-"));
		dirs.push(target);
		await copyTemplate(target);
		await applyVariant(target, "fixture");
		for (const file of [
			"FIXTURE.md",
			"src/fixture/routes.ts",
			"src/fixture/nitro-handler.ts",
			"src/fixture/ws.ts",
			"src/entrypoints/worker.ts",
			"src/entrypoints/tick.ts",
			"src/entrypoints/seed.ts",
		])
			expect([file, existsSync(join(target, file))]).toEqual([file, true]);
		const vite = await readFile(join(target, "vite.config.ts"), "utf8");
		expect(vite).toContain("...fixtureNitro,");
		expect(vite).toContain("...fixturePlugins,");
		const migrate = await readFile(
			join(target, "src/entrypoints/migrate.ts"),
			"utf8",
		);
		expect(migrate).toContain("runFixtureMigration(");
		expect(migrate).toContain("{ log: MIGRATION_LOG, exit: MIGRATION_EXIT }");
		const docker = await readFile(join(target, "Dockerfile"), "utf8");
		expect(docker).toContain(
			"ARG VITE_GREETING\nARG VITE_KEY\nARG CLOUD_BUILD_ENV=\nRUN eval",
		);
		const manifest = JSON.parse(
			await readFile(join(target, "package.json"), "utf8"),
		);
		expect(manifest.scripts["build:entrypoints"]).toContain(
			"src/entrypoints/seed.ts",
		);
		// The worker and /enqueue use pg-boss; `bun install` locks it in the export.
		expect(manifest.dependencies["pg-boss"]).toStartWith("^12.");
		// /upload streams a multipart form's file part with @fastify/busboy.
		expect(manifest.dependencies["@fastify/busboy"]).toStartWith("^3.");
		expect(Object.keys(manifest.dependencies)).toEqual(
			Object.keys(manifest.dependencies).sort(),
		);
		const root = await readFile(join(target, "src/routes/__root.tsx"), "utf8");
		expect(root).toContain("fixture-build-env");
	});

	test("leaves app-kit's template untouched", async () => {
		const target = await mkdtemp(join(tmpdir(), "export-fixture-"));
		dirs.push(target);
		const before = await readFile("template/vite.config.ts", "utf8");
		await copyTemplate(target);
		await applyVariant(target, "fixture");
		expect(await readFile("template/vite.config.ts", "utf8")).toBe(before);
		expect(existsSync("template/src/fixture")).toBe(false);
	});

	async function withFile(text: string): Promise<string> {
		const target = await mkdtemp(join(tmpdir(), "export-edit-"));
		dirs.push(target);
		await writeFile(join(target, "a.txt"), text);
		return target;
	}
	const variant = (find: string): TemplateVariant => ({
		repo: "viktor/x",
		files: "files",
		edits: [{ path: "a.txt", find, replace: "B" }],
	});

	test("an edit whose text is missing stops the export", async () => {
		const target = await withFile("nothing here");
		await expect(
			applyVariant(target, variant("anchor"), { overlay: false }),
		).rejects.toThrow("a.txt");
	});

	test("an edit whose text is there twice stops the export", async () => {
		const target = await withFile("anchor anchor");
		await expect(
			applyVariant(target, variant("anchor"), { overlay: false }),
		).rejects.toThrow("2 times");
	});
});

describe("exportTemplate --variant fixture", () => {
	const saved: Record<string, string | undefined> = {};
	beforeAll(() => {
		for (const [key, value] of Object.entries(GIT_ENV))
			if (key !== "PATH") {
				saved[key] = process.env[key];
				process.env[key] = value;
			}
	});
	afterAll(() => {
		for (const [key, value] of Object.entries(saved))
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
	});

	test("pushes the template with the fixture on top, and says so in the commit", async () => {
		const remote = await bareRemote();
		const root = await mkdtemp(join(tmpdir(), "export-tmp-"));
		dirs.push(root);
		await exportTemplate(
			{
				target: null,
				push: true,
				install: false,
				keep: false,
				variant: "fixture",
			},
			{ remote, tmpRoot: root, log: () => {} },
		);
		expect(git(["log", "-1", "--format=%s", "master"], remote)).toStartWith(
			"Export template, fixture variant, from app-kit ",
		);
		expect(git(["show", "master:src/fixture/routes.ts"], remote)).toContain(
			"handleFixture",
		);
	}, 60_000);
});
