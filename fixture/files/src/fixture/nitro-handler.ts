/**
 * The fixture's routes as one Nitro handler (registered for each route by
 * nitro-config.ts), with the real effects: the process, the database, the
 * network and the client build on disk.
 */
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { keepRequestOpen } from "@viktorbarzin/runtime";
import { eq } from "drizzle-orm";
import { defineHandler } from "nitro";

import { items } from "#/server/db/schema.server";
import { pool } from "#/server/db.server";
import { databaseConfigured } from "#/server/env.server";

import { enqueueFixtureJob } from "./boss";
import { type FixtureDeps, handleFixture, type ItemRow } from "./routes";

/** Read through an alias, as env.server.ts does, so no bundler inlines a value. */
const runtimeEnv: Record<string, string | undefined> = process.env;

/** The owner_sub of the rows /items writes. */
const OWNER = "fixture";

function rowView(row: typeof items.$inferSelect): ItemRow {
	return {
		id: row.id,
		title: row.title,
		createdAt: row.createdAt.toISOString(),
	};
}

async function writeItem(title: string): Promise<ItemRow> {
	const [row] = await pool
		.getDb()
		.insert(items)
		.values({ ownerSub: OWNER, title })
		.returning();
	if (!row) throw new Error("insert returned no row");
	return rowView(row);
}

async function deleteItem(id: string): Promise<boolean> {
	const rows = await pool
		.getDb()
		.delete(items)
		.where(eq(items.id, id))
		.returning({ id: items.id });
	return rows.length === 1;
}

async function readItem(id: string): Promise<ItemRow | null> {
	const [row] = await pool.getDb().select().from(items).where(eq(items.id, id));
	return row ? rowView(row) : null;
}

function connect(
	host: string,
	port: number,
	timeoutMs: number,
): Promise<{ connected: boolean; error: string | null }> {
	return new Promise((resolve) => {
		const socket = createConnection({ host, port });
		const done = (connected: boolean, error: string | null) => {
			socket.destroy();
			resolve({ connected, error });
		};
		socket.setTimeout(timeoutMs, () =>
			done(false, `no connection within ${timeoutMs} ms`),
		);
		socket.once("connect", () => done(true, null));
		socket.once("error", (err) => done(false, err.message));
	});
}

/** Keeps every chunk, so the memory stays used until the kernel kills the process. */
const held: Buffer[] = [];

function allocate(): void {
	const step = () => {
		// allocUnsafe + fill touches every page, so the RSS really grows.
		held.push(Buffer.allocUnsafe(64 * 1024 * 1024).fill(1));
		setTimeout(step, 20);
	};
	step();
}

async function assets(): Promise<string[]> {
	for (const dir of ["public/assets", ".output/public/assets"]) {
		const path = join(process.cwd(), dir);
		if (!existsSync(path)) continue;
		return (await readdir(path))
			.filter((name) => name.endsWith(".js"))
			.sort()
			.map((name) => `/assets/${name}`);
	}
	return [];
}

const deps: FixtureDeps = {
	env: runtimeEnv,
	bootTime: new Date(performance.timeOrigin),
	exit: (code) => process.exit(code),
	later: (run) => {
		setTimeout(run, 100);
	},
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	keepOpen: (request) => {
		keepRequestOpen(request);
	},
	writeItem: databaseConfigured() ? writeItem : null,
	readItem: databaseConfigured() ? readItem : null,
	deleteItem: databaseConfigured() ? deleteItem : null,
	log: (line) => console.log(line),
	connect,
	fetch: (url, init) => fetch(url, init),
	allocate,
	assets,
	// On the template's pool: the App opens no second one for pg-boss.
	enqueue: databaseConfigured()
		? () => enqueueFixtureJob(() => pool.getClient())
		: null,
};

export default defineHandler((event) => handleFixture(event.req, deps));
