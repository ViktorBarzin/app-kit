import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	listPackages,
	pack,
	planRelease,
	releaseOrder,
	type WorkspacePackage,
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
