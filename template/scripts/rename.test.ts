/**
 * scripts/rename.ts on a copy of this template: every `starter` / `Starter`
 * token is rewritten, outside a short allow-list.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrationLockKey } from "@viktorbarzin/pg";

import { ALLOW_LIST, IGNORED_DIRS, listFiles, lockKey, rename } from "./rename";

const TEMPLATE = resolve(import.meta.dir, "..");
const copies: string[] = [];

afterAll(async () => {
	for (const dir of copies) await rm(dir, { recursive: true, force: true });
});

async function copyTemplate(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "rename-"));
	copies.push(dir);
	await cp(TEMPLATE, dir, {
		recursive: true,
		filter: (src) =>
			!IGNORED_DIRS.some((name) => src.split("/").includes(name)),
	});
	return dir;
}

const read = (dir: string, path: string) => readFile(join(dir, path), "utf8");

describe("rename", () => {
	test("no starter token is left outside the allow-list", async () => {
		const dir = await copyTemplate();
		const changed = await rename(dir, "my-app", "My App");
		expect(changed.length).toBeGreaterThan(5);
		const leftovers: string[] = [];
		for (const file of await listFiles(dir)) {
			if (ALLOW_LIST.includes(file)) continue;
			const text = await read(dir, file);
			if (/starter/i.test(text)) leftovers.push(file);
		}
		expect(leftovers).toEqual([]);
	});

	test("the app's names, channel and lock key follow the slug", async () => {
		const dir = await copyTemplate();
		await rename(dir, "my-app", "My App");
		expect(JSON.parse(await read(dir, "package.json")).name).toBe("my-app");
		const config = await read(dir, "src/app.config.ts");
		expect(config).toContain('slug: "my-app"');
		expect(config).toContain('displayName: "My App"');
		expect(config).toContain('usersGroup: "My App Users"');
		expect(config).toContain('adminsGroup: "My App Admins"');
		expect(config).toContain('agentsGroup: "My App Agents"');
		expect(config).toContain('realtimeChannel: "my_app_events"');
		expect(config).toContain(
			`migrationLockKey: ${migrationLockKey("my-app")}n`,
		);
		const build = await read(dir, ".github/workflows/build.yml");
		expect(build).toMatch(
			/ghcr\.io\/viktorbarzin\/my-app:\$\{\{ steps\.meta\.outputs\.sha \}\}/,
		);
		expect(build).toContain("ghcr.io/viktorbarzin/my-app:latest");
		expect(build).toContain("scope=my-app");
		expect(build).toContain("package-name: my-app");
		expect(build).toContain('git config user.name "my-app-ci"');
		expect(build).toContain("forgejo.viktorbarzin.me/viktor/my-app.git");
		const deploy = await read(dir, ".woodpecker/deploy.yml");
		expect(deploy).toMatch(
			/kubectl -n my-app set image deployment\/my-app migrate=ghcr\.io\/viktorbarzin\/my-app:\$\{IMAGE_TAG\} my-app=ghcr\.io\/viktorbarzin\/my-app:\$\{IMAGE_TAG\}/,
		);
		expect(deploy).toContain(
			"kubectl -n my-app rollout status deployment/my-app --timeout=300s",
		);
		expect(await read(dir, "AGENTS.md")).toStartWith("# my-app");
		expect(await read(dir, "README.md")).toStartWith("# My App");
	});

	test("is one-shot: the script, its test and the npm script are gone afterwards", async () => {
		const dir = await copyTemplate();
		await rename(dir, "my-app", "My App");
		const exists = (path: string) =>
			stat(join(dir, path)).then(
				() => true,
				() => false,
			);
		expect(await exists("scripts/rename.ts")).toBe(false);
		expect(await exists("scripts/rename.test.ts")).toBe(false);
		const pkg = JSON.parse(await read(dir, "package.json")) as {
			scripts: Record<string, string>;
		};
		expect(pkg.scripts.rename).toBeUndefined();
		// Every path the test script names still exists.
		for (const path of pkg.scripts.test?.match(/\.\/\S+/g) ?? [])
			expect(await exists(path)).toBe(true);
	});

	test("the lock key needs no installed package and matches @viktorbarzin/pg", () => {
		for (const slug of ["starter", "my-app", "tasks", "a", "x-1-y"])
			expect(lockKey(slug)).toBe(migrationLockKey(slug));
	});

	test("imports only node built-ins and src/lib, so it runs before bun install", async () => {
		const source = await read(TEMPLATE, "scripts/rename.ts");
		const imports = [
			...source.matchAll(/^import [^;]* from "([^"]+)";$/gm),
		].map((m) => m[1]);
		expect(imports.length).toBeGreaterThan(0);
		for (const from of imports)
			expect(from).toMatch(/^(node:|\.\.\/src\/lib\/)/);
	});

	test("a dashed slug gets underscores where Postgres needs an identifier", async () => {
		const dir = await copyTemplate();
		await rename(dir, "my-app", "My App");
		for (const doc of ["README.md", "docs/new-app.md"]) {
			const text = await read(dir, doc);
			expect(text).toContain("`my_app = {}`");
			expect(text).toMatch(/username\s*=\s*"my_app"/);
			expect(text).not.toMatch(/my-app = \{\}/);
			expect(text).not.toMatch(/username\s*=\s*"my-app"/);
			// The Vault role key and everything else keep the slug.
			expect(text).toMatch(/\bmy-app = \{/);
			expect(text).toContain("secret/my-app");
		}
	});

	test.each([
		'Bob "The" Shop',
		"Back\\slash",
		"Two\nLines",
		"Dollar $5 Shop",
		"Tick ` mark",
	])("refuses the display name %p", async (name) => {
		const dir = await copyTemplate();
		await expect(rename(dir, "shop", name)).rejects.toThrow("display name");
	});

	test("keeps punctuation a name may need", async () => {
		const dir = await copyTemplate();
		await rename(dir, "bobs-shop", "Bob's Shop & Co.");
		expect(await read(dir, "src/app.config.ts")).toContain(
			`displayName: "Bob's Shop & Co."`,
		);
	});

	test.each([
		"My-App",
		"1app",
		"app_x",
		"",
		"-app",
		"a".repeat(64),
	])("refuses the slug %p", async (slug) => {
		const dir = await copyTemplate();
		await expect(rename(dir, slug, "Name")).rejects.toThrow("slug");
	});

	test("refuses an empty display name and a second run", async () => {
		const dir = await copyTemplate();
		await expect(rename(dir, "ok", " ")).rejects.toThrow("display name");
		await rename(dir, "ok", "Ok");
		await expect(rename(dir, "again", "Again")).rejects.toThrow(
			"already renamed",
		);
	});
});
