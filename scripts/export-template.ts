/**
 * Refresh viktor/app-template (the repository new apps are made from) from
 * template/, after the packages are published:
 *
 *   bun scripts/export-template.ts [--target <dir>] [--push]
 *
 * - copies template/ (without build output or node_modules) over a clone of
 *   viktor/app-template, deleting files the template no longer has;
 * - replaces each `workspace:^` with `^<published version>`;
 * - writes a standalone biome.json (in app-kit, template/biome.json extends
 *   the repo root's);
 * - `bun install` writes the template's own bun.lock (needs the versions on npm);
 * - with --push, commits and pushes to Forgejo (FORGEJO_GIT_TOKEN, or the
 *   ssh remote when unset).
 *
 * Without --target it clones into a temporary directory.
 */
import { existsSync } from "node:fs";
import {
	cp,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { listPackages } from "./release.js";

const ROOT = resolve(import.meta.dir, "..");
const TEMPLATE = join(ROOT, "template");
const SKIP = new Set([
	"node_modules",
	".output",
	".nitro",
	".tanstack",
	"test-results",
	"playwright-report",
	".git",
]);

type Deps = Record<string, string>;
interface Manifest {
	dependencies?: Deps;
	devDependencies?: Deps;
	peerDependencies?: Deps;
	[key: string]: unknown;
}

/** Each `workspace:` range on a @viktorbarzin package becomes `^<version>`. */
export function rewriteManifest(
	manifest: Manifest,
	versions: Record<string, string>,
): Manifest {
	const out: Manifest = { ...manifest };
	for (const field of [
		"dependencies",
		"devDependencies",
		"peerDependencies",
	] as const) {
		const deps = manifest[field];
		if (!deps) continue;
		const next: Deps = {};
		for (const [name, range] of Object.entries(deps)) {
			if (!range.startsWith("workspace:")) {
				next[name] = range;
				continue;
			}
			const version = versions[name];
			if (!version) throw new Error(`no published version for ${name}`);
			next[name] = `^${version}`;
		}
		out[field] = next;
	}
	return out;
}

/** Copy template/ into `target` (keeping its .git), with versions resolved and a root biome.json. */
export async function copyTemplate(target: string): Promise<void> {
	for (const entry of await readdir(target))
		if (entry !== ".git")
			await rm(join(target, entry), { recursive: true, force: true });
	await cp(TEMPLATE, target, {
		recursive: true,
		filter: (src) =>
			!src
				.slice(TEMPLATE.length)
				.split("/")
				.some((part) => SKIP.has(part)),
	});
	const versions = Object.fromEntries(
		(await listPackages()).map((p) => [p.name, p.version]),
	);
	const manifestPath = join(target, "package.json");
	const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
	await writeFile(
		manifestPath,
		`${JSON.stringify(rewriteManifest(manifest, versions), null, "\t")}\n`,
	);
	await cp(join(ROOT, "biome.json"), join(target, "biome.json"));
}

function run(cmd: string[], cwd: string): void {
	const proc = Bun.spawnSync(cmd, {
		cwd,
		stdout: "inherit",
		stderr: "inherit",
	});
	if (proc.exitCode !== 0)
		throw new Error(`${cmd.slice(0, 2).join(" ")} failed in ${cwd}`);
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const targetAt = args.indexOf("--target");
	const push = args.includes("--push");
	const token = process.env.FORGEJO_GIT_TOKEN;
	const remote = token
		? `https://viktor:${token}@forgejo.viktorbarzin.me/viktor/app-template.git`
		: "git@git.viktorbarzin.me:viktor/app-template.git";
	let target = targetAt >= 0 ? resolve(args[targetAt + 1] ?? "") : "";
	if (!target) {
		target = await mkdtemp(join(tmpdir(), "app-template-"));
		run(["git", "clone", remote, target], ROOT);
	}
	await copyTemplate(target);
	run([process.execPath, "install"], target);
	if (push) {
		if (!existsSync(join(target, ".git")))
			throw new Error(`${target} is not a git clone`);
		run(["git", "add", "-A"], target);
		const sha = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], {
			cwd: ROOT,
		})
			.stdout.toString()
			.trim();
		run(["git", "commit", "-m", `Export template from app-kit ${sha}`], target);
		run(["git", "push", "origin", "HEAD:master"], target);
	}
	console.log(`exported to ${target}`);
}
