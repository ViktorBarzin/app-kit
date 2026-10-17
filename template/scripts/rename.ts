/**
 * Give a new app made from this template its own names:
 *
 *   bun run rename <slug> "<Display Name>"
 *
 * Rewrites every `starter` token to the slug and every `Starter` token to the
 * display name in every text file (package.json, src/app.config.ts, the
 * workflows, the docs, bun.lock), the NOTIFY channel to `<slug_with_underscores>_events`,
 * and recomputes the migration lock key. Runs once; scripts/rename.test.ts
 * checks that nothing is left.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { migrationLockKey } from "@viktorbarzin/pg";

/** Directories never touched (build output, dependencies, VCS). */
export const IGNORED_DIRS = [
	"node_modules",
	".output",
	".nitro",
	".tanstack",
	".git",
	"test-results",
	"playwright-report",
];

/** Files that keep the word on purpose: this script and its test. */
export const ALLOW_LIST = ["scripts/rename.ts", "scripts/rename.test.ts"];

const SLUG = /^[a-z][a-z0-9-]{0,49}$/;

/** Every file under `root` (relative paths), skipping IGNORED_DIRS. */
export async function listFiles(root: string): Promise<string[]> {
	const found: string[] = [];
	async function walk(dir: string): Promise<void> {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			if (IGNORED_DIRS.includes(entry.name)) continue;
			const path = join(dir, entry.name);
			if (entry.isDirectory()) await walk(path);
			else if (entry.isFile()) found.push(relative(root, path));
		}
	}
	await walk(root);
	return found.sort();
}

function rewrite(text: string, slug: string, displayName: string): string {
	return text
		.replace(
			/migrationLockKey: -?\d+n/g,
			`migrationLockKey: ${migrationLockKey(slug)}n`,
		)
		.replaceAll("starter_events", `${slug.replaceAll("-", "_")}_events`)
		.replaceAll("Starter", displayName)
		.replaceAll("starter", slug);
}

/** Rename the app in `root`. Returns the files it changed. */
export async function rename(
	root: string,
	slug: string,
	displayName: string,
): Promise<string[]> {
	if (!SLUG.test(slug) || slug.endsWith("-"))
		throw new Error(
			`slug must be a DNS label: lowercase letters, digits and dashes, starting with a letter (got "${slug}")`,
		);
	const name = displayName.trim();
	if (name === "" || /starter/i.test(name))
		throw new Error("display name must be non-empty and new");
	const config = await readFile(join(root, "src/app.config.ts"), "utf8");
	if (!config.includes('slug: "starter"'))
		throw new Error("this app is already renamed");
	const changed: string[] = [];
	for (const file of await listFiles(root)) {
		if (ALLOW_LIST.includes(file)) continue;
		const path = join(root, file);
		const bytes = await readFile(path);
		if (bytes.includes(0)) continue; // binary
		const text = bytes.toString("utf8");
		const next = rewrite(text, slug, name);
		if (next !== text) {
			await writeFile(path, next);
			changed.push(file);
		}
	}
	return changed;
}

if (import.meta.main) {
	const [slug, displayName] = process.argv.slice(2);
	if (!slug || !displayName) {
		console.error('usage: bun run rename <slug> "<Display Name>"');
		process.exit(2);
	}
	const root = resolve(import.meta.dir, "..");
	const changed = await rename(root, slug, displayName);
	console.log(
		`renamed to ${slug} ("${displayName.trim()}") in ${changed.length} files:`,
	);
	for (const file of changed) console.log(`  ${file}`);
	console.log("Next: bun install, then follow docs/new-app.md.");
}
