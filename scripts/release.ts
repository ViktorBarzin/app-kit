/**
 * Publish every package whose version is not on npm yet, then tag it on
 * Forgejo. Run by .github/workflows/release.yml after gitleaks and
 * check-public:
 *
 *   bun scripts/release.ts [--dry-run] [--pack-only <dir>]
 *
 * Per package, in dependency order:
 *   1. `npm view <name>@<version> version`: present means nothing to do.
 *   2. `bun pm pack`: bun rewrites `workspace:^` into real ranges, which
 *      `npm publish` from the directory would not.
 *   3. `npm publish <tgz> --provenance --access public`: npm trusted
 *      publishing (OIDC from GitHub Actions, npm >= 11.5.1), no token.
 *   4. tag `<name>@<version>` and push it to Forgejo with FORGEJO_GIT_TOKEN
 *      (the GitHub repo is a one-way mirror; tags pushed there are wiped).
 *
 * --dry-run packs and reports without publishing or tagging. --pack-only
 * packs every package into <dir> and stops (the template builder uses it).
 */
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SCOPE = "@viktorbarzin/";
const FORGEJO_REPO = "forgejo.viktorbarzin.me/viktor/app-kit.git";

export interface WorkspacePackage {
	/** Relative to the repo root. */
	dir: string;
	name: string;
	version: string;
	/** @viktorbarzin/* packages this one needs (dependencies, peers). */
	internalDeps: string[];
}

interface Manifest {
	name: string;
	version: string;
	private?: boolean;
	dependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
}

export async function listPackages(
	root: string = ROOT,
): Promise<WorkspacePackage[]> {
	const out: WorkspacePackage[] = [];
	for (const entry of (await readdir(join(root, "packages"))).sort()) {
		const manifest = JSON.parse(
			await readFile(join(root, "packages", entry, "package.json"), "utf8"),
		) as Manifest;
		if (manifest.private) continue;
		const deps = { ...manifest.dependencies, ...manifest.peerDependencies };
		out.push({
			dir: `packages/${entry}`,
			name: manifest.name,
			version: manifest.version,
			internalDeps: Object.keys(deps)
				.filter((name) => name.startsWith(SCOPE))
				.sort(),
		});
	}
	return out;
}

/** Dependencies first. Throws on a cycle. */
export function releaseOrder(packages: WorkspacePackage[]): WorkspacePackage[] {
	const byName = new Map(packages.map((p) => [p.name, p]));
	const done = new Set<string>();
	const visiting = new Set<string>();
	const order: WorkspacePackage[] = [];
	const visit = (pkg: WorkspacePackage) => {
		if (done.has(pkg.name)) return;
		if (visiting.has(pkg.name))
			throw new Error(`dependency cycle at ${pkg.name}`);
		visiting.add(pkg.name);
		for (const dep of pkg.internalDeps) {
			const found = byName.get(dep);
			if (found) visit(found);
		}
		visiting.delete(pkg.name);
		done.add(pkg.name);
		order.push(pkg);
	};
	for (const pkg of [...packages].sort((a, b) => a.name.localeCompare(b.name)))
		visit(pkg);
	return order;
}

/** The packages (in release order) whose version is not on the registry. */
export async function planRelease(
	packages: WorkspacePackage[],
	isPublished: (name: string, version: string) => Promise<boolean>,
): Promise<WorkspacePackage[]> {
	const plan: WorkspacePackage[] = [];
	for (const pkg of releaseOrder(packages))
		if (!(await isPublished(pkg.name, pkg.version))) plan.push(pkg);
	return plan;
}

function run(
	cmd: string[],
	cwd: string = ROOT,
): { code: number; stdout: string; stderr: string } {
	const proc = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	return {
		code: proc.exitCode ?? 1,
		stdout: proc.stdout.toString(),
		stderr: proc.stderr.toString(),
	};
}

/** `npm view <name>@<version> version`: true when that exact version exists. */
export async function npmHasVersion(
	name: string,
	version: string,
): Promise<boolean> {
	const result = run(["npm", "view", `${name}@${version}`, "version"]);
	if (result.code === 0) return result.stdout.trim() === version;
	if (/E404|404 Not Found|is not in this registry/.test(result.stderr))
		return false;
	throw new Error(`npm view ${name}@${version} failed:\n${result.stderr}`);
}

/** `bun pm pack` the package into `outDir`; returns the tarball path. */
export async function pack(
	pkg: WorkspacePackage,
	outDir: string,
): Promise<string> {
	await mkdir(outDir, { recursive: true });
	const result = run(
		[
			process.execPath,
			"pm",
			"pack",
			"--destination",
			resolve(outDir),
			"--quiet",
		],
		join(ROOT, pkg.dir),
	);
	if (result.code !== 0)
		throw new Error(
			`bun pm pack ${pkg.name} failed:\n${result.stderr}${result.stdout}`,
		);
	const tarball = result.stdout.trim().split("\n").at(-1)?.trim() ?? "";
	const path = tarball.startsWith("/") ? tarball : resolve(outDir, tarball);
	const manifest = run(["tar", "-xzOf", path, "package/package.json"]);
	if (manifest.code !== 0 || manifest.stdout.includes("workspace:"))
		throw new Error(`${path} still has workspace: ranges or no package.json`);
	return path;
}

function publish(tarball: string): void {
	const result = run([
		"npm",
		"publish",
		tarball,
		"--provenance",
		"--access",
		"public",
	]);
	process.stdout.write(result.stdout);
	if (result.code !== 0)
		throw new Error(`npm publish ${tarball} failed:\n${result.stderr}`);
}

function tagOnForgejo(pkg: WorkspacePackage): void {
	const token = process.env.FORGEJO_GIT_TOKEN;
	if (!token)
		throw new Error(
			"FORGEJO_GIT_TOKEN is not set; cannot push the release tag",
		);
	const tag = `${pkg.name}@${pkg.version}`;
	const created = run(["git", "tag", tag]);
	if (created.code !== 0 && !created.stderr.includes("already exists"))
		throw new Error(`git tag ${tag} failed:\n${created.stderr}`);
	const pushed = run([
		"git",
		"push",
		`https://viktor:${token}@${FORGEJO_REPO}`,
		`refs/tags/${tag}`,
	]);
	if (pushed.code !== 0)
		throw new Error(
			`pushing ${tag} failed:\n${pushed.stderr.replaceAll(token, "***")}`,
		);
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const dryRun = args.includes("--dry-run");
	const packOnlyAt = args.indexOf("--pack-only");
	const packages = await listPackages();
	if (packOnlyAt >= 0) {
		const outDir = resolve(args[packOnlyAt + 1] ?? ".packs");
		for (const pkg of releaseOrder(packages))
			console.log(await pack(pkg, outDir));
		process.exit(0);
	}
	const plan = await planRelease(packages, npmHasVersion);
	if (plan.length === 0) {
		console.log("release: every package version is already on npm");
		process.exit(0);
	}
	const outDir = resolve(ROOT, ".packs");
	for (const pkg of plan) {
		const tarball = await pack(pkg, outDir);
		if (dryRun) {
			console.log(
				`release (dry run): would publish ${tarball} and tag ${pkg.name}@${pkg.version}`,
			);
			continue;
		}
		publish(tarball);
		tagOnForgejo(pkg);
		console.log(`release: published ${pkg.name}@${pkg.version}`);
	}
}
