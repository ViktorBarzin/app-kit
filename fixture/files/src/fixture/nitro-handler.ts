/**
 * The fixture's routes as one Nitro handler (registered for each route by
 * nitro-config.ts), with the real effects: the process, the database, the
 * Bucket, the network and the client build on disk.
 */
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { ListObjectsV2Command, S3ServiceException } from "@aws-sdk/client-s3";
import { readPasswordFile } from "@viktorbarzin/pg";
import { keepRequestOpen } from "@viktorbarzin/runtime";
import { SQL } from "bun";
import { eq } from "drizzle-orm";
import { defineHandler } from "nitro";

import {
	type Bucket,
	bucket,
	getStream,
	putStream,
} from "#/server/bucket.server";
import { items } from "#/server/db/schema.server";
import { pool } from "#/server/db.server";
import { databaseConfigured, pgSettings } from "#/server/env.server";

import { enqueueFixtureJob } from "./boss";
import {
	BucketError,
	type FillDb,
	type FixtureBucket,
	type FixtureDeps,
	genericError,
	handleFixture,
	type ItemRow,
	type ProbeResult,
} from "./routes";
import { UploadRequestError } from "./upload";

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

/**
 * One MiB of pseudo-random bytes per row (65536 md5 digests), so Postgres
 * cannot compress it; 16 MiB per statement.
 */
const FILL_ROWS = `insert into fixture_fill (b)
	select (select decode(string_agg(md5(random()::text || g::text || r::text), ''), 'hex')
		from generate_series(1, 65536) g)
	from generate_series(1, $1::int) r`;

const fillDb: FillDb = {
	async write(mib) {
		const client = pool.getClient();
		await client.unsafe(
			"create table if not exists fixture_fill (id bigserial primary key, b bytea not null)",
		);
		for (let done = 0; done < mib; done += 16)
			await client.unsafe(FILL_ROWS, [Math.min(16, mib - done)]);
	},
	async clear() {
		await pool.getClient().unsafe("drop table if exists fixture_fill");
	},
	async databaseMib() {
		const [row] = await pool
			.getClient()
			.unsafe("select pg_database_size(current_database())::bigint as bytes");
		return Math.round(Number(row?.bytes ?? 0) / 1048576);
	},
};

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

/**
 * An SDK error as a BucketError with the S3 code, status and message as the
 * store sent them (a write past the quota: Garage's 403 AccessDenied,
 * "Bucket size quota is reached"). A refused body passes through; any
 * other error is a failure to reach the store, named by its kind only.
 */
function storeFailure(err: unknown): unknown {
	if (err instanceof S3ServiceException)
		return new BucketError(
			err.name,
			err.$metadata.httpStatusCode ?? null,
			err.message,
		);
	if (err instanceof UploadRequestError || !(err instanceof Error)) return err;
	return new BucketError("s3_unreachable", null, genericError(err.message));
}

function fixtureBucket(target: Bucket): FixtureBucket {
	return {
		async put(key, body, contentType) {
			try {
				await putStream(target, key, body, contentType ?? undefined);
			} catch (err) {
				throw storeFailure(err);
			}
		},
		async get(key) {
			try {
				const found = await getStream(target, key);
				return found
					? {
							body: found.body,
							contentType: found.contentType,
							bytes: found.contentLength,
						}
					: null;
			} catch (err) {
				throw storeFailure(err);
			}
		},
		async probe(name): Promise<ProbeResult> {
			try {
				await target.client.send(
					new ListObjectsV2Command({ Bucket: name, MaxKeys: 1 }),
				);
				return { ok: true };
			} catch (err) {
				if (err instanceof S3ServiceException)
					return { ok: false, code: err.name, message: err.message };
				return {
					ok: false,
					code: "s3_unreachable",
					message: genericError(
						err instanceof Error ? err.message : String(err),
					),
				};
			}
		},
	};
}

/** The server's code (SQLSTATE) when it sent one, else the driver's. */
function pgCode(err: unknown): string {
	if (err instanceof SQL.PostgresError) return err.errno ?? err.code;
	if (err instanceof Error && "code" in err && typeof err.code === "string")
		return err.code;
	return "error";
}

/** One connection with DATABASE_URL's user and password to database `db`. */
async function probePg(db: string): Promise<ProbeResult> {
	const settings = pgSettings();
	const url = new URL(settings.url);
	url.pathname = `/${encodeURIComponent(db)}`;
	const { passwordFile } = settings;
	const sql = new SQL({
		url: url.href,
		max: 1,
		idleTimeout: 1,
		connectionTimeout: 5,
		...(passwordFile ? { password: () => readPasswordFile(passwordFile) } : {}),
	});
	try {
		await sql`select 1`;
		return { ok: true };
	} catch (err) {
		return {
			ok: false,
			code: pgCode(err),
			message: err instanceof Error ? err.message : String(err),
		};
	} finally {
		await sql.close();
	}
}

const appBucket = bucket();

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
	// console.error and console.warn: the JSON console records their level.
	log: (line, level) => {
		if (level === "error") console.error(line);
		else if (level === "warn") console.warn(line);
		else console.log(line);
	},
	connect,
	fetch: (url, init) => fetch(url, init),
	allocate,
	assets,
	// On the template's pool: the App opens no second one for pg-boss.
	enqueue: databaseConfigured()
		? () => enqueueFixtureJob(() => pool.getClient())
		: null,
	fill: databaseConfigured() ? fillDb : null,
	bucket: appBucket ? fixtureBucket(appBucket) : null,
	probePg: databaseConfigured() ? probePg : null,
};

export default defineHandler((event) => handleFixture(event.req, deps));
