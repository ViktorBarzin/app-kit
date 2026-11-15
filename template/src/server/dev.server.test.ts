/**
 * `bun run dev` serves the app under Bun. vite's bin starts with
 * `#!/usr/bin/env node`; without `--bun` the SSR graph runs under Node,
 * cannot import the `bun` built-in @viktorbarzin/pg uses and answers 500.
 */
import { afterAll, expect, test } from "bun:test";
import { resolve } from "node:path";

import { statusWhenServed } from "#/test/served";

const TEMPLATE = resolve(import.meta.dir, "../..");
let dev: Bun.Subprocess | null = null;

/** Signal the whole group: `bun run` does not pass SIGTERM on to vite. */
function signal(child: Bun.Subprocess, name: NodeJS.Signals): void {
	try {
		process.kill(-child.pid, name);
	} catch {
		// Already gone.
	}
}

afterAll(async () => {
	if (!dev) return;
	signal(dev, "SIGTERM");
	const stopped = await Promise.race([
		dev.exited.then(() => true),
		Bun.sleep(5000).then(() => false),
	]);
	if (!stopped) signal(dev, "SIGKILL");
	await dev.exited;
}, 20_000);

function freePort(): number {
	const probe = Bun.serve({ port: 0, fetch: () => new Response() });
	const port = probe.port;
	probe.stop(true);
	if (port === undefined) throw new Error("no free port");
	return port;
}

test("bun run dev serves /healthz", async () => {
	const port = freePort();
	dev = Bun.spawn([process.execPath, "run", "dev"], {
		cwd: TEMPLATE,
		env: {
			...process.env,
			PORT: String(port),
			NODE_ENV: "development",
			DEV_USER: "dev",
		},
		stdout: "ignore",
		stderr: "ignore",
		// Its own process group, so afterAll stops vite too.
		detached: true,
	});
	// Vite answers 503 while it warms up on a loaded box: wait through it.
	const status = await statusWhenServed(`http://127.0.0.1:${port}/healthz`, {
		budgetMs: 60_000,
	});
	expect(status).toBe(200);
}, 90_000);
