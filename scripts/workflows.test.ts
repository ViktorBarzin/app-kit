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
	test("only the publish job can mint an OIDC token, in the npm-publish environment", async () => {
		const wf = await workflow(".github/workflows/release.yml");
		const withIdToken = Object.entries(wf.jobs).filter(
			([, job]) => job.permissions?.["id-token"] === "write",
		);
		expect(withIdToken.map(([name]) => name)).toEqual(["publish"]);
		const publish = wf.jobs.publish as Job;
		expect(publish.environment).toEqual("npm-publish");
		expect(publish.if).toContain("vars.NPM_PUBLISH_ENABLED == 'true'");
		expect(runText(publish)).toContain("npm publish");
		for (const [name, job] of Object.entries(wf.jobs))
			if (name !== "publish") expect(runText(job)).not.toContain("npm publish");
	});

	test("the publish job installs and runs no dependency code", async () => {
		const publish = (await workflow(".github/workflows/release.yml")).jobs
			.publish as Job;
		const text = runText(publish);
		expect(text).not.toMatch(/\bbun\b/);
		expect(text).not.toMatch(/npm (ci|install)(?! -g npm@\d+\.\d+\.\d+\b)/);
		expect(publish.steps.some((s) => s.uses?.startsWith("oven-sh/"))).toBe(
			false,
		);
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
		expect(wf.jobs.publish?.needs).toEqual("build");
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
