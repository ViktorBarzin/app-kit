/**
 * The fixture's part of the Nitro config in vite.config.ts: WebSocket
 * support and its routes as Nitro handlers, which Nitro matches before
 * TanStack Start's renderer. /healthz stays the template's route; the
 * variant edits it to ask fixtureHealthy (routes.ts).
 */
import { fileURLToPath } from "node:url";

const handler = fileURLToPath(new URL("./nitro-handler.ts", import.meta.url));

/** Every path the fixture answers; FIXTURE.md describes each. */
export const FIXTURE_ROUTES = [
	"/info",
	"/items",
	"/unhealthy",
	"/healthy",
	"/crash",
	"/oom",
	"/slow",
	"/sse",
	"/egress-ip",
	"/tcp",
	"/fetch",
	"/build-assets",
	"/log",
	"/enqueue",
	"/kv-selftest",
	"/upload",
	"/files/**",
	"/probe/**",
] as const;

/**
 * WebSocket support only in `vite build`: Nitro's dev server under
 * `vite --bun` picks crossws's Node adapter, which fails under Bun, so
 * /ws exists only in the built server.
 */
const building = process.argv.includes("build");

export const fixtureNitro = {
	features: { websocket: building },
	handlers: [
		{
			route: "/ws",
			handler: fileURLToPath(new URL("./ws.ts", import.meta.url)),
		},
		...FIXTURE_ROUTES.map((route) => ({ route, handler })),
	],
};
