/**
 * The app's pool, lazy, once per process. Its size comes from the
 * connection budget (env.server.ts): 4 by default (plus the realtime LISTEN
 * = 5 per pod, the ADR budget), or half of Cloud's per-role connection limit.
 */
import { createPool } from "@viktorbarzin/pg";

import * as schema from "./db/schema.server";
import { connectionBudget, pgSettings } from "./env.server";

export const pool = createPool({
	settings: pgSettings,
	schema,
	max: () => connectionBudget().poolMax,
});

export type Db = ReturnType<typeof pool.getDb>;
/** A transaction handle, for helpers that run inside the caller's transaction. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
