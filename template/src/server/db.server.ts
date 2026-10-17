/**
 * The app's pool: at most 4 connections (plus the realtime LISTEN = 5 per
 * pod, the ADR budget), lazy, once per process.
 */
import { createPool } from "@viktorbarzin/pg";

import * as schema from "./db/schema.server";
import { pgSettings } from "./env.server";

export const pool = createPool({ settings: pgSettings, schema });

export type Db = ReturnType<typeof pool.getDb>;
/** A transaction handle, for helpers that run inside the caller's transaction. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
