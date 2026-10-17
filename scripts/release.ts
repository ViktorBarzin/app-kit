/**
 * Pack every package whose version is not on npm yet, for
 * .github/workflows/release.yml:
 *
 *   bun scripts/release.ts --plan <dir> | --dry-run | --pack-only <dir>
 *
 * The workflow has two jobs. The build job (no OIDC token) installs, builds,
 * tests, runs gitleaks and check-public, then runs `--plan .packs`: per
 * package, in dependency order,
 *   1. `npm view <name>@<version> version`: present means nothing to do;
 *   2. `bun pm pack`: bun rewrites `workspace:^` into real ranges, which
 *      `npm publish` from the directory would not;
 * and it writes <dir>/release-plan.tsv (name, version, tarball per line).
 * The publish job (the only one with `id-token: write`, in the `npm-publish`
 * environment) downloads that directory and, with no bun and no repo code,
 * runs `npm publish <tgz> --provenance --access public` and pushes the tag
 * `<name>@<version>` to Forgejo (the GitHub repo is a one-way mirror; tags
 * pushed there are wiped).
 *
 * --dry-run packs and reports. --pack-only packs every package into <dir>
 * whether published or not, and stops (the template builder uses it).
 */
import { mkdir, readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SCOPE = "@viktorbarzin/";
export const PLAN_FILE = "release-plan.tsv";

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

export interface PlanEntry {
	name: string;
	version: string;
	/** File name inside the plan directory. */
	tarball: string;
}

/**
 * Write <outDir>/release-plan.tsv: one `name<TAB>version<TAB>tarball` line per
 * package, in release order. The publish job reads it with plain shell.
 */
export async function writeReleasePlan(
	outDir: string,
	packed: Array<{ pkg: WorkspacePackage; tarball: string }>,
): Promise<string> {
	const lines = packed.map(({ pkg, tarball }) => {
		if (resolve(dirname(tarball)) !== resolve(outDir))
			throw new Error(`${tarball} is outside the plan directory ${outDir}`);
		return `${pkg.name}\t${pkg.version}\t${basename(tarball)}\n`;
	});
	await mkdir(outDir, { recursive: true });
	const path = join(outDir, PLAN_FILE);
	await Bun.write(path, lines.join(""));
	return path;
}

export async function readReleasePlan(path: string): Promise<PlanEntry[]> {
	return (await readFile(path, "utf8"))
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => {
			const [name = "", version = "", tarball = ""] = line.split("\t");
			return { name, version, tarball };
		});
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const dirAfter = (flag: string): string | null => {
		const at = args.indexOf(flag);
		return at >= 0 ? resolve(args[at + 1] ?? ".packs") : null;
	};
	const packages = await listPackages();
	const packOnly = dirAfter("--pack-only");
	if (packOnly) {
		for (const pkg of releaseOrder(packages))
			console.log(await pack(pkg, packOnly));
		process.exit(0);
	}
	const planDir = dirAfter("--plan");
	if (!planDir && !args.includes("--dry-run")) {
		console.error(
			"usage: bun scripts/release.ts --plan <dir> | --dry-run | --pack-only <dir>",
		);
		process.exit(2);
	}
	const outDir = planDir ?? resolve(ROOT, ".packs");
	const packed: Array<{ pkg: WorkspacePackage; tarball: string }> = [];
	for (const pkg of await planRelease(packages, npmHasVersion))
		packed.push({ pkg, tarball: await pack(pkg, outDir) });
	const planPath = await writeReleasePlan(outDir, packed);
	if (packed.length === 0)
		console.log("release: every package version is already on npm");
	for (const { pkg, tarball } of packed)
		console.log(
			`release: ${pkg.name}@${pkg.version} is not on npm; packed ${tarball}`,
		);
	console.log(`release: plan written to ${planPath}`);
}
