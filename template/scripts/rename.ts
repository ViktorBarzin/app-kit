/**
 * Give a new app made from this template its own names:
 *
 *   bun scripts/rename.ts <slug> "<Display Name>"   (or: bun run rename ...)
 *
 * Rewrites every `starter` token to the slug and every `Starter` token to the
 * display name in every text file (package.json, src/app.config.ts, the
 * workflows, the docs, bun.lock), the NOTIFY channel and the database names
 * in the infra snippets to the slug with underscores, and recomputes the
 * migration lock key.
 *
 * It runs once: afterwards it deletes itself, its test and the `rename`
 * npm script, so the new app's own test run does not re-run it. It imports
 * only node built-ins and src/lib, so it works before `bun install`.
 * scripts/rename.test.ts (in app-kit) checks that nothing is left.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { assertBunVersion } from "../src/lib/bun-version";

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

/**
 * A display name lands in TypeScript and YAML string literals and in
 * Markdown; quotes, backslashes, backticks, `$` and control characters would
 * break one of them.
 */
const UNSAFE_NAME = /["\\`$\p{Cc}]/u;

/** Same as migrationLockKey in @viktorbarzin/pg (the test checks it). */
export function lockKey(slug: string): bigint {
	const digest = createHash("sha256").update(`migrate:${slug}`).digest();
	return BigInt.asIntN(64, digest.readBigUInt64BE(0));
}

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
	const ident = slug.replaceAll("-", "_");
	return (
		text
			.replace(
				/migrationLockKey: -?\d+n/g,
				`migrationLockKey: ${lockKey(slug)}n`,
			)
			.replaceAll("starter_events", `${ident}_events`)
			// Postgres identifiers in the infra snippets: the app_databases key
			// (`starter = {}`) and the role's username.
			.replace(/\bstarter(\s*=\s*\{\s*\})/g, `${ident}$1`)
			.replace(/(\busername\s*=\s*)"starter"/g, `$1"${ident}"`)
			.replaceAll("Starter", displayName)
			.replaceAll("starter", slug)
	);
}

/** Delete the one-shot rename script, its test and the npm script. */
async function removeRename(root: string): Promise<void> {
	for (const file of ALLOW_LIST) await rm(join(root, file), { force: true });
	await rmdir(join(root, "scripts")).catch(() => {}); // only when now empty
	const path = join(root, "package.json");
	const pkg = JSON.parse(await readFile(path, "utf8")) as {
		scripts?: Record<string, string>;
	};
	if (pkg.scripts) {
		delete pkg.scripts.rename;
		if (pkg.scripts.test)
			pkg.scripts.test = pkg.scripts.test.replace(" ./scripts", "");
	}
	await writeFile(path, `${JSON.stringify(pkg, null, "\t")}\n`);
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
	if (UNSAFE_NAME.test(name))
		throw new Error(
			"display name must not contain quotes, backslashes, backticks, $ or line breaks",
		);
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
	await removeRename(root);
	return changed;
}

if (import.meta.main) {
	assertBunVersion(Bun.version);
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
	console.log(
		"Removed scripts/rename.ts, its test and the rename script (it runs once).",
	);
	console.log(
		"Next: bun install (refreshes bun.lock), commit, then follow README.md from step 3.",
	);
}
