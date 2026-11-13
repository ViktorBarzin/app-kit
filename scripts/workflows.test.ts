/**
 * Supply-chain rules for the CI files, here and in the template every app
 * starts from:
 * - every action is pinned to a full commit SHA, every container image to a
 *   digest, every downloaded binary to a sha256;
 * - only the release job that runs `npm publish` can mint an OIDC token, it
 *   runs in the `npm-publish` environment and it installs and runs no
 *   dependency code;
 * - only the template's image build can write packages, and the step holding
 *   FORGEJO_GIT_TOKEN downloads nothing.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

interface Step {
	name?: string;
	uses?: string;
	run?: string;
	env?: Record<string, string>;
	with?: Record<string, unknown>;
}
interface Job {
	permissions?: Record<string, string>;
	environment?: string | { name: string };
	needs?: string | string[];
	if?: string;
	steps: Step[];
}
interface Workflow {
	permissions?: Record<string, string>;
	jobs: Record<string, Job>;
}

async function workflow(path: string): Promise<Workflow> {
	return Bun.YAML.parse(await readFile(join(ROOT, path), "utf8")) as Workflow;
}

const GITHUB_WORKFLOWS = [
	".github/workflows/ci.yml",
	".github/workflows/release.yml",
	"template/.github/workflows/build.yml",
];

const runText = (job: Job) => job.steps.map((s) => s.run ?? "").join("\n");

describe.each(GITHUB_WORKFLOWS)("%s", (path) => {
	test("every action is pinned to a full commit SHA", async () => {
		const unpinned: string[] = [];
		for (const job of Object.values((await workflow(path)).jobs))
			for (const step of job.steps)
				if (step.uses && !/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(step.uses))
					unpinned.push(step.uses);
		expect(unpinned).toEqual([]);
	});

	test("the workflow-level token cannot write or mint OIDC tokens", async () => {
		expect((await workflow(path)).permissions).toEqual({ contents: "read" });
	});

	test("every downloaded binary is checked against a sha256", async () => {
		for (const job of Object.values((await workflow(path)).jobs))
			for (const step of job.steps) {
				const run = step.run ?? "";
				if (/curl[^\n]*releases\/download/.test(run))
					expect(run).toContain("sha256sum -c");
			}
	});
});

describe("release.yml", () => {
	test("only publish-npm can mint an OIDC token, in the npm-publish environment", async () => {
		const wf = await workflow(".github/workflows/release.yml");
		const withIdToken = Object.entries(wf.jobs).filter(
			([, job]) => job.permissions?.["id-token"] === "write",
		);
		expect(withIdToken.map(([name]) => name)).toEqual(["publish-npm"]);
		const npm = wf.jobs["publish-npm"] as Job;
		expect(npm.environment).toEqual("npm-publish");
		expect(npm.if).toContain("vars.NPM_PUBLISH_ENABLED == 'true'");
		expect(runText(npm)).toContain("npm publish");
		expect(runText(npm)).toContain("--provenance");
	});

	test("publish-npm falls back to the NPM_TOKEN secret when trusted publishing fails", async () => {
		const wf = await workflow(".github/workflows/release.yml");
		const npm = wf.jobs["publish-npm"] as Job;
		const publish = npm.steps.find((s) =>
			(s.run ?? "").includes("npm publish"),
		);
		expect(publish?.env?.NODE_AUTH_TOKEN).toContain("secrets.NPM_TOKEN");
	});

	test("publish-npm tries every package before it fails", async () => {
		const wf = await workflow(".github/workflows/release.yml");
		const text = runText(wf.jobs["publish-npm"] as Job);
		expect(text).toMatch(/npm publish [^\n]*\|\| failed=1/);
		expect(text).toContain('exit "$failed"');
	});

	test("publish-forgejo publishes to Forgejo with its own token and tags the release", async () => {
		const wf = await workflow(".github/workflows/release.yml");
		const forgejo = wf.jobs["publish-forgejo"] as Job;
		expect(forgejo.permissions).toEqual({ contents: "read" });
		expect(forgejo.environment).toEqual("forgejo-publish");
		expect(forgejo.if).toContain("refs/heads/master");
		const text = runText(forgejo);
		expect(text).toContain("npm publish");
		expect(text).toContain("git push");
		// A version already on Forgejo is already tagged; re-pushing its tag
		// is rejected and fails the run.
		expect(
			text.indexOf("continue", text.indexOf("already on Forgejo")),
		).toBeLessThan(text.indexOf("npm publish"));
		const node = forgejo.steps.find((s) =>
			s.uses?.startsWith("actions/setup-node@"),
		);
		expect(String(node?.with?.["registry-url"])).toContain(
			"forgejo.viktorbarzin.me/api/packages/viktor/npm/",
		);
		const publish = forgejo.steps.find((s) =>
			(s.run ?? "").includes("npm publish"),
		);
		expect(publish?.env?.NODE_AUTH_TOKEN).toContain(
			"secrets.FORGEJO_PACKAGE_TOKEN",
		);
	});

	test("only the publish jobs run npm publish", async () => {
		const wf = await workflow(".github/workflows/release.yml");
		for (const [name, job] of Object.entries(wf.jobs))
			if (!name.startsWith("publish-"))
				expect(runText(job)).not.toContain("npm publish");
	});

	test("the publish jobs install and run no dependency code", async () => {
		const wf = await workflow(".github/workflows/release.yml");
		for (const name of ["publish-forgejo", "publish-npm"]) {
			const job = wf.jobs[name] as Job;
			const text = runText(job);
			expect(text).not.toMatch(/\bbun\b/);
			expect(text).not.toMatch(/npm (ci|install)(?! -g npm@\d+\.\d+\.\d+\b)/);
			expect(job.steps.some((s) => s.uses?.startsWith("oven-sh/"))).toBe(false);
		}
	});

	test("npm is pinned to an exact version", async () => {
		const wf = await workflow(".github/workflows/release.yml");
		for (const job of Object.values(wf.jobs)) {
			const installs = runText(job).match(/npm install -g npm@\S+/g) ?? [];
			for (const install of installs)
				expect(install).toMatch(/npm@\d+\.\d+\.\d+$/);
		}
	});

	test("the build job packs, and hands the tarballs over as an artifact", async () => {
		const wf = await workflow(".github/workflows/release.yml");
		const build = wf.jobs.build as Job;
		expect(runText(build)).toContain("bun scripts/release.ts --plan");
		expect(
			build.steps.some((s) => s.uses?.startsWith("actions/upload-artifact@")),
		).toBe(true);
		expect(wf.jobs["publish-forgejo"]?.needs).toEqual("build");
		expect(wf.jobs["publish-npm"]?.needs).toEqual("build");
	});

	test("artifacts are not in a hidden directory (upload-artifact skips those)", async () => {
		const wf = await workflow(".github/workflows/release.yml");
		for (const job of Object.values(wf.jobs))
			for (const step of job.steps)
				if (step.uses?.startsWith("actions/upload-artifact@"))
					expect(String(step.with?.path)).not.toMatch(/(^|\/)\./);
	});
});

describe("template build.yml", () => {
	test("only the image build job can write packages", async () => {
		const wf = await workflow("template/.github/workflows/build.yml");
		const writers = Object.entries(wf.jobs)
			.filter(([, job]) => job.permissions?.packages === "write")
			.map(([name]) => name);
		expect(writers).toEqual(["build"]);
	});

	test("the step holding FORGEJO_GIT_TOKEN downloads nothing", async () => {
		const wf = await workflow("template/.github/workflows/build.yml");
		for (const job of Object.values(wf.jobs))
			for (const step of job.steps)
				if (step.env && "FORGEJO_GIT_TOKEN" in step.env)
					expect(step.run ?? "").not.toMatch(/curl|wget/);
	});
});

describe("template .woodpecker/deploy.yml", () => {
	test("every image is pinned to a digest", async () => {
		const deploy = Bun.YAML.parse(
			await readFile(join(ROOT, "template/.woodpecker/deploy.yml"), "utf8"),
		) as { steps: Array<{ image: string }> };
		for (const step of deploy.steps)
			expect(step.image).toMatch(/@sha256:[0-9a-f]{64}$/);
	});
});
