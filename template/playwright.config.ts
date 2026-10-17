import { createServer } from "node:net";
import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests against the BUILT server (`bun run build` first) with a
 * real Postgres (TEST_DATABASE_URL) and the mock Authentik, all started by
 * e2e/stack.ts. A real browser is the only check that catches a server-only
 * module leaking into the client bundle: build, tsc and curl all pass, and
 * hydration fails with "Buffer is not defined".
 */
async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			server.close(() =>
				typeof address === "object" && address
					? resolve(address.port)
					: reject(new Error("no port")),
			);
		});
	});
}

// Workers inherit the env, so they see the ports the main process chose.
process.env.E2E_PORT ??= String(await freePort());
process.env.E2E_CONTROL_PORT ??= String(await freePort());
const port = Number(process.env.E2E_PORT);

export default defineConfig({
	testDir: "./e2e",
	// The specs share one mock provider session; run them one at a time.
	workers: 1,
	forbidOnly: Boolean(process.env.CI),
	retries: 0,
	reporter: "list",
	timeout: 30_000,
	use: {
		baseURL: `http://127.0.0.1:${port}`,
		trace: "retain-on-failure",
	},
	projects: [
		{ name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
	],
	webServer: {
		command: "bun e2e/stack.ts",
		url: `http://127.0.0.1:${port}/healthz`,
		reuseExistingServer: false,
		timeout: 60_000,
		gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
		env: {
			E2E_PORT: String(port),
			E2E_CONTROL_PORT: String(process.env.E2E_CONTROL_PORT),
			TEST_DATABASE_URL: process.env.TEST_DATABASE_URL ?? "",
		},
	},
});
