/**
 * scripts/rename.ts on a copy of this template: every `starter` / `Starter`
 * token is rewritten, outside a short allow-list.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
		expect(build).toContain(
			"FORGEJO_REPO: ${{ vars.FORGEJO_REPO || 'viktor/my-app' }}",
		);
		expect(build).toContain(
			'git push "https://${FORGEJO_REPO%%/*}:${FORGEJO_GIT_TOKEN}@forgejo.viktorbarzin.me/${FORGEJO_REPO}.git"',
		);
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

	test("the renamed README opens with the Cloud paragraph and no infra steps (round 9)", async () => {
		// A Cloud App keeps this README; Vault and Terraform steps on its first
		// screen read as work Cloud already did. They live in docs/new-app.md.
		const dir = await copyTemplate();
		await rename(dir, "my-app", "My App");
		const readme = await read(dir, "README.md");
		const firstScreen = readme.split("\n").slice(0, 30).join("\n");
		expect(firstScreen).toContain("## On Cloud");
		expect(firstScreen).toContain("no infra steps");
		expect(firstScreen).not.toMatch(/Vault|Terraform/);
		expect(readme).toContain("[docs/new-app.md](docs/new-app.md)");
		const guide = await read(dir, "docs/new-app.md");
		expect(guide).toContain("vault kv put secret/my-app");
		expect(guide).toContain("modules/kubernetes/tanstack_app");
		expect(guide).toContain("renovate-bot");
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
		for (const doc of ["docs/new-app.md"]) {
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

	test("a 50-character slug leaves a tree that passes biome check (round 7)", async () => {
		const dir = await copyTemplate();
		// The standalone config an App repo has: in app-kit the template's
		// biome.json extends the repo root's ("root": false), and
		// export-template.ts writes that root config into the exported repo.
		const own = JSON.parse(
			await readFile(resolve(TEMPLATE, "biome.json"), "utf8"),
		);
		const root =
			own.root === false
				? JSON.parse(await readFile(resolve(TEMPLATE, "../biome.json"), "utf8"))
				: own;
		await writeFile(
			join(dir, "biome.json"),
			`${JSON.stringify({ ...root, vcs: { enabled: false } }, null, "\t")}\n`,
		);
		const slug = `a${"b".repeat(48)}c`;
		expect(slug).toHaveLength(50);
		await rename(dir, slug, "Long Name");
		const biome = Bun.spawnSync(
			[resolve(TEMPLATE, "node_modules/.bin/biome"), "check", "."],
			{ cwd: dir, stdout: "pipe", stderr: "pipe" },
		);
		expect(
			`${biome.stdout.toString()}${biome.stderr.toString()}`.slice(-4000),
		).not.toContain("×");
		expect(biome.exitCode).toBe(0);
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
