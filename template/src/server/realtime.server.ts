/**
 * Realtime (ADR-0001, Realtime contract): one LISTEN connection per pod on
 * this app's channel, an SSE stream per tab, and pg_notify to publish.
 */
import { createSqlClient } from "@viktorbarzin/pg";
import { createRealtime, poolNotify } from "@viktorbarzin/realtime/server";

import { app } from "#/app.config";
import { pool } from "./db.server";
import { pgSettings } from "./env.server";

export const realtime = createRealtime(() => ({
	channel: app.realtimeChannel,
	createListenClient: () =>
		createSqlClient(pgSettings(), { max: 1, idleTimeout: 0 }),
	notify: poolNotify(() => pool.getClient()),
}));
