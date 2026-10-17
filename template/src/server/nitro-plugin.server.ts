/**
 * Nitro runtime plugin: runs once when the built server starts, before it
 * listens (registered in vite.config.ts).
 *
 * - console output (Nitro's error handler, srvx's banner) becomes JSON lines;
 * - /metrics is served on METRICS_PORT, which the ingress does not route;
 * - the realtime LISTEN connection opens at boot, so its gauges mean
 *   something before the first SSE subscriber;
 * - SIGTERM/SIGINT close the SSE streams and LISTEN, let in-flight requests
 *   finish, close the metrics listener and the pool, then exit.
 */
import { installJsonConsole } from "@viktorbarzin/log";
import { startMetricsServer } from "@viktorbarzin/metrics";
import { installShutdown } from "@viktorbarzin/runtime";
import { definePlugin } from "nitro";

import { pool } from "./db.server";
import { databaseConfigured, isDevelopment, metricsPort } from "./env.server";
import { realtime } from "./realtime.server";

export default definePlugin(() => {
	// Bun-only steps; `vite dev` may run the server outside Bun.
	if (typeof Bun === "undefined") return;
	if (!isDevelopment()) installJsonConsole();
	const metrics = startMetricsServer({ port: metricsPort() });
	if (databaseConfigured()) void realtime.start().catch(() => {});
	installShutdown({
		beforeDrain: [{ name: "realtime", run: () => realtime.stop() }],
		afterDrain: [
			{ name: "metrics", run: () => metrics?.stop() },
			{ name: "pool", run: () => pool.close() },
		],
	});
});
