/**
 * tick.ts as Cloud's cron runs it: `bun entrypoints/tick.js [seconds]`.
 * The optional argument is how long it sleeps before it logs `tick`.
 */
import { expect, test } from "bun:test";

const TICK = new URL("./tick.ts", import.meta.url).pathname;

async function tick(...args: string[]) {
	const started = performance.now();
	const proc = Bun.spawn([process.execPath, TICK, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, SERVICE_VERSION: "v-tick" },
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, code, ms: performance.now() - started };
}

test("no argument: logs tick at once and exits 0", async () => {
	const run = await tick();
	expect(run.code).toBe(0);
	expect(JSON.parse(run.stdout)).toMatchObject({
		msg: "tick",
		version: "v-tick",
	});
});

test("a number of seconds: sleeps that long, then logs tick and exits 0", async () => {
	const run = await tick("2");
	expect(run.code).toBe(0);
	expect(run.ms).toBeGreaterThanOrEqual(2_000);
	expect(JSON.parse(run.stdout)).toMatchObject({ msg: "tick", slept: 2 });
});

test("an argument that is not a whole number exits 2 without a tick", async () => {
	const run = await tick("soon");
	expect(run.code).toBe(2);
	expect(run.stdout).toBe("");
	expect(run.stderr).toContain("whole number of seconds");
});
