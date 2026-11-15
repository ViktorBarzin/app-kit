/**
 * Refresh viktor/app-template (the repository new apps are made from) from
 * template/, after the packages are published:
 *
 *   bun scripts/export-template.ts [--target <dir>] [--push] [--no-install] [--keep]
 *
 * - copies template/ (without build output or node_modules) over a clone of
 *   viktor/app-template, deleting files the template no longer has;
 * - replaces each `workspace:^` with `^<published version>`;
 * - writes a standalone biome.json (in app-kit, template/biome.json extends
 *   the repo root's);
 * - `bun install` writes the template's own bun.lock (needs the versions on
 *   npm; --no-install skips it, and the export then has no bun.lock, which
 *   its build.yml reports as "publish @viktorbarzin packages first");
 * - with --push, commits and pushes to Forgejo (FORGEJO_GIT_TOKEN, or the
 *   ssh remote when unset).
 *
 * Without --target it clones into a temporary directory under the system's
 * temp dir. With --push it removes that clone afterwards, also when a step
 * fails, unless --keep: on the devvm /tmp is an 8G tmpfs and one clone with
 * node_modules took about 600M (round 9). Without --push the clone is the
 * output, so it stays, and the script says it is temporary.
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
	".readme-check",
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
		// Without it Node rewrites the relative link CLAUDE.md -> AGENTS.md
		// to this checkout's absolute path, which no clone has.
		verbatimSymlinks: true,
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

export interface ExportArgs {
	target: string | null;
	push: boolean;
	install: boolean;
	/** Keep the temporary clone after a push. */
	keep: boolean;
}

export function parseExportArgs(argv: readonly string[]): ExportArgs {
	const out: ExportArgs = {
		target: null,
		push: false,
		install: true,
		keep: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--push") out.push = true;
		else if (arg === "--no-install") out.install = false;
		else if (arg === "--keep") out.keep = true;
		else if (arg === "--target") {
			const dir = argv[++i];
			if (!dir || dir.startsWith("--"))
				throw new Error("--target needs a directory");
			out.target = dir;
		} else throw new Error(`unknown argument ${arg}`);
	}
	return out;
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

export interface ExportOptions {
	/** The git remote of viktor/app-template. */
	remote: string;
	/** Where a temporary clone goes; the system's temp dir by default. */
	tmpRoot?: string;
	log?: (line: string) => void;
}

/**
 * The export: clone (into a temporary directory without --target), copy,
 * install, and with --push commit and push. Returns where the export is and
 * whether that directory is still there.
 */
export async function exportTemplate(
	args: ExportArgs,
	options: ExportOptions,
): Promise<{ target: string; kept: boolean }> {
	const log = options.log ?? ((line: string) => console.log(line));
	if (args.target) {
		const target = resolve(args.target);
		await exportInto(target, args);
		log(`exported to ${target}`);
		return { target, kept: true };
	}
	const target = await mkdtemp(
		join(options.tmpRoot ?? tmpdir(), "app-template-"),
	);
	const keep = args.keep || !args.push;
	try {
		run(["git", "clone", "--quiet", options.remote, target], ROOT);
		await exportInto(target, args);
	} finally {
		if (!keep) await rm(target, { recursive: true, force: true });
	}
	if (!keep) log(`pushed the export and removed the temporary clone ${target}`);
	else if (args.push) log(`pushed the export; the clone stays in ${target}`);
	else
		log(
			`exported to ${target}, a temporary directory: delete it when done with rm -rf ${target}`,
		);
	return { target, kept: keep };
}

async function exportInto(target: string, args: ExportArgs): Promise<void> {
	await copyTemplate(target);
	if (args.install) run([process.execPath, "install"], target);
	if (!args.push) return;
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

if (import.meta.main) {
	const token = process.env.FORGEJO_GIT_TOKEN;
	await exportTemplate(parseExportArgs(process.argv.slice(2)), {
		remote: token
			? `https://viktor:${token}@forgejo.viktorbarzin.me/viktor/app-template.git`
			: "git@git.viktorbarzin.me:viktor/app-template.git",
	});
}
