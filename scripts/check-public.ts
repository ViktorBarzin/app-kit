/**
 * The public-package guard, run before every release: published packages
 * hold no homelab hostnames, internal addresses, client IDs or secrets
 * (ADR-0001, Shared code). Scans packages/<pkg>/src and packages/<pkg>/dist
 * plus the files npm always ships (package.json, README.md, CHANGELOG.md),
 * then runs gitleaks over the same directories.
 *
 *   bun scripts/check-public.ts [--require-gitleaks]
 *
 * gitleaks is required in CI (CI=true) and with --require-gitleaks; locally
 * a missing binary is a warning.
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

export interface Violation {
	path: string;
	line: number;
	rule: string;
	text: string;
}

const RULES: Array<{ rule: string; pattern: RegExp }> = [
	{ rule: "viktorbarzin.me", pattern: /viktorbarzin\.me/i },
	{ rule: "forgejo hostname", pattern: /\bforgejo\.[a-z0-9-]+\.[a-z]{2,}/i },
	{ rule: "10.0.x.x address", pattern: /\b10\.0\.\d{1,3}\.\d{1,3}\b/ },
	{
		rule: "authentik hostname",
		pattern: /\bauthentik\.[a-z0-9-]+\.[a-z]{2,}/i,
	},
	{
		rule: "client_id literal",
		pattern: /\bclient_id["']?\s*[:=]\s*["'`][^"'`\s]+["'`]/i,
	},
];

export function findViolations(
	files: Array<{ path: string; text: string }>,
): Violation[] {
	const found: Violation[] = [];
	for (const { path, text } of files) {
		const lines = text.split("\n");
		lines.forEach((content, index) => {
			for (const { rule, pattern } of RULES) {
				if (pattern.test(content))
					found.push({
						path,
						line: index + 1,
						rule,
						text: content.trim().slice(0, 160),
					});
			}
		});
	}
	return found;
}

const ROOT = resolve(import.meta.dir, "..");

async function filesUnder(dir: string): Promise<string[]> {
	if (!existsSync(dir)) return [];
	const out: string[] = [];
	for (const entry of await readdir(dir, {
		withFileTypes: true,
		recursive: true,
	})) {
		if (entry.isFile()) out.push(join(entry.parentPath, entry.name));
	}
	return out;
}

export async function scanDirectories(
	root: string = ROOT,
): Promise<{ dirs: string[]; violations: Violation[] }> {
	const dirs: string[] = [];
	for (const pkg of await readdir(join(root, "packages"))) {
		for (const sub of ["src", "dist"]) {
			const dir = join(root, "packages", pkg, sub);
			if (existsSync(dir)) dirs.push(dir);
		}
	}
	const files: Array<{ path: string; text: string }> = [];
	for (const pkg of await readdir(join(root, "packages")))
		for (const name of ["package.json", "README.md", "CHANGELOG.md"]) {
			const path = join(root, "packages", pkg, name);
			if (existsSync(path))
				files.push({
					path: relative(root, path),
					text: await readFile(path, "utf8"),
				});
		}
	for (const dir of dirs)
		for (const path of await filesUnder(dir))
			files.push({
				path: relative(root, path),
				text: await readFile(path, "utf8"),
			});
	return { dirs, violations: findViolations(files) };
}

async function gitleaks(dirs: string[], required: boolean): Promise<boolean> {
	const binary = Bun.which("gitleaks");
	if (!binary) {
		if (required) {
			console.error("gitleaks is not installed, and this run requires it");
			return false;
		}
		console.warn("warning: gitleaks is not installed; skipped (CI runs it)");
		return true;
	}
	let ok = true;
	for (const dir of dirs) {
		const proc = Bun.spawn(
			[
				binary,
				"dir",
				dir,
				"--config",
				join(ROOT, ".gitleaks.toml"),
				"--no-banner",
				"--redact",
				"--exit-code",
				"1",
			],
			{ stdout: "inherit", stderr: "inherit" },
		);
		if ((await proc.exited) !== 0) {
			console.error(`gitleaks flagged ${relative(ROOT, dir)}`);
			ok = false;
		}
	}
	return ok;
}

if (import.meta.main) {
	const required =
		process.argv.includes("--require-gitleaks") || process.env.CI === "true";
	const { dirs, violations } = await scanDirectories();
	for (const v of violations)
		console.error(`${v.path}:${v.line}: ${v.rule}: ${v.text}`);
	const leaksOk = await gitleaks(dirs, required);
	if (violations.length > 0 || !leaksOk) {
		console.error(
			`check-public: FAILED (${violations.length} pattern hits${leaksOk ? "" : ", gitleaks findings"})`,
		);
		process.exit(1);
	}
	console.log(`check-public: ok (${dirs.length} directories)`);
}
