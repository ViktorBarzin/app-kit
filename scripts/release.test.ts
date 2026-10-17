import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	listPackages,
	pack,
	planRelease,
	readReleasePlan,
	releaseOrder,
	type WorkspacePackage,
	writeReleasePlan,
} from "./release.js";

const pkg = (name: string, internal: string[] = []): WorkspacePackage => ({
	dir: `packages/${name}`,
	name: `@viktorbarzin/${name}`,
	version: "0.1.0",
	internalDeps: internal.map((n) => `@viktorbarzin/${n}`),
});

const dirs: string[] = [];
afterAll(async () => {
	for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

describe("releaseOrder", () => {
	test("dependencies come before their dependents", () => {
		const order = releaseOrder([
			pkg("auth", ["log", "runtime", "metrics", "oidc-token"]),
			pkg("metrics", ["log", "runtime"]),
			pkg("runtime", ["log"]),
			pkg("oidc-token", ["log"]),
			pkg("log"),
		]).map((p) => p.name.replace("@viktorbarzin/", ""));
		const before = (a: string, b: string) =>
			order.indexOf(a) < order.indexOf(b);
		expect(before("log", "runtime")).toBe(true);
		expect(before("runtime", "metrics")).toBe(true);
		expect(before("metrics", "auth")).toBe(true);
		expect(before("oidc-token", "auth")).toBe(true);
	});

	test("a cycle is an error", () => {
		expect(() => releaseOrder([pkg("a", ["b"]), pkg("b", ["a"])])).toThrow(
			"cycle",
		);
	});
});

describe("planRelease", () => {
	test("only versions missing from the registry are published", async () => {
		const plan = await planRelease(
			[pkg("log"), pkg("runtime", ["log"])],
			async (name) => name.endsWith("/log"),
		);
		expect(plan.map((p) => p.name)).toEqual(["@viktorbarzin/runtime"]);
	});
});

describe("the release plan file", () => {
	test("lists name, version and tarball per line, in release order, and reads back", async () => {
		const out = await mkdtemp(join(tmpdir(), "plan-"));
		dirs.push(out);
		const path = await writeReleasePlan(out, [
			{ pkg: pkg("log"), tarball: join(out, "viktorbarzin-log-0.1.0.tgz") },
			{
				pkg: pkg("runtime", ["log"]),
				tarball: join(out, "viktorbarzin-runtime-0.1.0.tgz"),
			},
		]);
		expect(path).toBe(join(out, "release-plan.tsv"));
		expect(await Bun.file(path).text()).toBe(
			"@viktorbarzin/log\t0.1.0\tviktorbarzin-log-0.1.0.tgz\n" +
				"@viktorbarzin/runtime\t0.1.0\tviktorbarzin-runtime-0.1.0.tgz\n",
		);
		expect(await readReleasePlan(path)).toEqual([
			{
				name: "@viktorbarzin/log",
				version: "0.1.0",
				tarball: "viktorbarzin-log-0.1.0.tgz",
			},
			{
				name: "@viktorbarzin/runtime",
				version: "0.1.0",
				tarball: "viktorbarzin-runtime-0.1.0.tgz",
			},
		]);
	});

	test("an empty plan is an empty file", async () => {
		const out = await mkdtemp(join(tmpdir(), "plan-"));
		dirs.push(out);
		const path = await writeReleasePlan(out, []);
		expect(await Bun.file(path).text()).toBe("");
		expect(await readReleasePlan(path)).toEqual([]);
	});

	test("a tarball outside the plan directory is refused", async () => {
		const out = await mkdtemp(join(tmpdir(), "plan-"));
		dirs.push(out);
		await expect(
			writeReleasePlan(out, [{ pkg: pkg("log"), tarball: "/elsewhere/x.tgz" }]),
		).rejects.toThrow("outside");
	});
});

describe("the workspace", () => {
	test("lists the seven packages with their internal dependencies", async () => {
		const packages = await listPackages();
		expect(packages.map((p) => p.name).sort()).toEqual([
			"@viktorbarzin/auth",
			"@viktorbarzin/log",
			"@viktorbarzin/metrics",
			"@viktorbarzin/oidc-token",
			"@viktorbarzin/pg",
			"@viktorbarzin/realtime",
			"@viktorbarzin/runtime",
		]);
		expect(
			packages.find((p) => p.name === "@viktorbarzin/runtime")?.internalDeps,
		).toEqual(["@viktorbarzin/log"]);
	});

	test("bun pm pack rewrites workspace ranges and ships only dist", async () => {
		const out = await mkdtemp(join(tmpdir(), "pack-"));
		dirs.push(out);
		const runtime = (await listPackages()).find(
			(p) => p.name === "@viktorbarzin/runtime",
		);
		if (!runtime) throw new Error("no runtime package");
		const tarball = await pack(runtime, out);
		const list = Bun.spawnSync(["tar", "-tzf", tarball])
			.stdout.toString()
			.trim()
			.split("\n");
		expect(list).toContain("package/package.json");
		expect(list).toContain("package/dist/index.js");
		expect(list).toContain("package/dist/index.d.ts");
		expect(list.filter((f) => f.startsWith("package/src/"))).toEqual([]);
		const manifest = Bun.spawnSync([
			"tar",
			"-xzOf",
			tarball,
			"package/package.json",
		]).stdout.toString();
		expect(manifest).not.toContain("workspace:");
		expect(JSON.parse(manifest).devDependencies["@viktorbarzin/log"]).toMatch(
			/^\^0\.1\.0$/,
		);
	}, 60_000);
});
