/**
 * `bun run dev` serves the app under Bun. vite's bin starts with
 * `#!/usr/bin/env node`; without `--bun` the SSR graph runs under Node,
 * cannot import the `bun` built-in @viktorbarzin/pg uses and answers 500.
 */
import { afterAll, expect, test } from "bun:test";
import { resolve } from "node:path";

const TEMPLATE = resolve(import.meta.dir, "../..");
let dev: Bun.Subprocess | null = null;

afterAll(async () => {
	dev?.kill("SIGTERM");
	await dev?.exited;
});

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
	});
	let status = 0;
	for (let i = 0; i < 120 && status === 0; i++) {
		status = await fetch(`http://127.0.0.1:${port}/healthz`)
			.then((r) => r.status)
			.catch(() => 0);
		if (status === 0) await Bun.sleep(500);
	}
	expect(status).toBe(200);
}, 90_000);
