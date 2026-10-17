/**
 * Postgres access for an app on the shared CNPG cluster: Drizzle on Bun's
 * built-in SQL client (`drizzle-orm/bun-sql`).
 *
 * - The password comes from DATABASE_PASSWORD_FILE, read each time a new
 *   connection opens, so a Vault rotation does not break new connections.
 * - An app pod keeps at most 5 connections: the pool (APP_POOL_MAX = 4) plus
 *   the realtime LISTEN connection. The migrate entrypoint uses 1.
 * - Nothing connects at import time: the first getDb() call opens the pool.
 * - drizzle-orm's migrator takes no lock of its own, so runMigrations holds a
 *   session-level pg_advisory_lock around it.
 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { getLogger, type Logger } from "@viktorbarzin/log";
import { processSingleton } from "@viktorbarzin/runtime";
import { SQL } from "bun";
import { type BunSQLDatabase, drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";

export interface PgSettings {
	/** DATABASE_URL, normally without a password, e.g. `postgres://app@pg-host:5432/app`. */
	url: string;
	/** DATABASE_PASSWORD_FILE: a mounted file with the rotated password; null uses the URL's password. */
	passwordFile: string | null;
}

/** ADR budget: 5 connections per pod, one of them the realtime LISTEN. */
export const APP_POOL_MAX = 4;

function nonEmpty(value: string | undefined): string | null {
	return value === undefined || value.trim() === "" ? null : value.trim();
}

/**
 * The platform env contract the Terraform app module sets: DATABASE_URL
 * (required) and DATABASE_PASSWORD_FILE.
 */
export function pgSettingsFromEnv(
	env: Record<string, string | undefined> = process.env,
): PgSettings {
	const url = nonEmpty(env.DATABASE_URL);
	if (url === null) throw new Error("DATABASE_URL is not set");
	return { url, passwordFile: nonEmpty(env.DATABASE_PASSWORD_FILE) };
}

/** The mounted password file's contents, without one trailing newline. */
export async function readPasswordFile(path: string): Promise<string> {
	const text = await Bun.file(path).text();
	return text.replace(/\r?\n$/, "");
}

export function createSqlClient(
	settings: PgSettings,
	opts: { max?: number; idleTimeout?: number } = {},
): SQL {
	const { passwordFile } = settings;
	return new SQL({
		url: settings.url,
		max: opts.max ?? APP_POOL_MAX,
		idleTimeout: opts.idleTimeout ?? 0,
		...(passwordFile ? { password: () => readPasswordFile(passwordFile) } : {}),
	});
}

export interface Pool<TSchema extends Record<string, unknown>> {
	getDb(): BunSQLDatabase<TSchema>;
	getClient(): SQL;
	close(): Promise<void>;
}

/**
 * The app's pool, once per process (keyed by `key`): lazy, so nothing
 * connects until the first getDb() or getClient().
 */
export function createPool<TSchema extends Record<string, unknown>>(opts: {
	settings: () => PgSettings;
	schema: TSchema;
	key?: string;
}): Pool<TSchema> {
	const slot = processSingleton(opts.key ?? "db.pool", () => ({
		shared: null as { client: SQL; db: BunSQLDatabase<TSchema> } | null,
	}));
	const open = () => {
		if (slot.shared === null) {
			const client = createSqlClient(opts.settings());
			slot.shared = { client, db: drizzle({ client, schema: opts.schema }) };
		}
		return slot.shared;
	};
	return {
		getDb: () => open().db,
		getClient: () => open().client,
		async close() {
			if (slot.shared === null) return;
			const { client } = slot.shared;
			slot.shared = null;
			await client.close();
		},
	};
}

/** A per-app advisory-lock key: the first 8 bytes of sha256(`migrate:<app>`) as a signed int64. */
export function migrationLockKey(appName: string): bigint {
	const digest = createHash("sha256").update(`migrate:${appName}`).digest();
	return BigInt.asIntN(64, digest.readBigUInt64BE(0));
}

export interface MigrateOptions {
	migrationsFolder: string;
	lockKey: bigint;
	migrationsSchema?: string;
	migrationsTable?: string;
	/** Runs under the lock, before the migrator (e.g. marking a pulled baseline as applied). */
	beforeMigrate?: (client: SQL) => Promise<void>;
	logger?: Logger;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

async function appliedCount(
	client: SQL,
	schema: string,
	table: string,
): Promise<number> {
	const [exists] = await client`
		select to_regclass(${`"${schema}"."${table}"`}) is not null as found`;
	if (!(exists as { found: boolean }).found) return 0;
	const [row] = await client.unsafe(
		`select count(*)::int as n from "${schema}"."${table}"`,
	);
	return (row as { n: number }).n;
}

/**
 * Run the migrations in `migrationsFolder` under a session advisory lock.
 * The client must have a pool of exactly one connection, so the lock, the
 * migrator's transaction and the unlock share one session.
 */
export async function runMigrations(
	client: SQL,
	opts: MigrateOptions,
): Promise<{ applied: number }> {
	const log = opts.logger ?? getLogger("pg.migrate");
	const schema = opts.migrationsSchema ?? "drizzle";
	const table = opts.migrationsTable ?? "__drizzle_migrations";
	if (!IDENTIFIER.test(schema) || !IDENTIFIER.test(table))
		throw new Error("migrations schema and table must be plain identifiers");
	log.info("waiting for migration lock", { lock_key: opts.lockKey });
	await client`select pg_advisory_lock(${opts.lockKey})`;
	try {
		if (opts.beforeMigrate) await opts.beforeMigrate(client);
		const before = await appliedCount(client, schema, table);
		await migrate(drizzle({ client }), {
			migrationsFolder: opts.migrationsFolder,
			migrationsSchema: schema,
			migrationsTable: table,
		});
		const applied = (await appliedCount(client, schema, table)) - before;
		log.info("migrations complete", { applied });
		return { applied };
	} finally {
		await client`select pg_advisory_unlock(${opts.lockKey})`;
	}
}

/**
 * The migrate entrypoint's body, for an init container or Job:
 *
 *   process.exitCode = await runMigrateCli({ lockKey })
 *
 * Reads DATABASE_URL, DATABASE_PASSWORD_FILE and MIGRATIONS_DIR (default
 * ./drizzle). Returns the exit code.
 */
export async function runMigrateCli(opts: {
	lockKey: bigint;
	beforeMigrate?: MigrateOptions["beforeMigrate"];
	env?: Record<string, string | undefined>;
	logger?: Logger;
}): Promise<number> {
	const env = opts.env ?? process.env;
	const log = opts.logger ?? getLogger("pg.migrate");
	const folder = resolve(nonEmpty(env.MIGRATIONS_DIR) ?? "drizzle");
	let client: SQL | null = null;
	try {
		client = createSqlClient(pgSettingsFromEnv(env), { max: 1 });
		await runMigrations(client, {
			migrationsFolder: folder,
			lockKey: opts.lockKey,
			logger: log,
			...(opts.beforeMigrate ? { beforeMigrate: opts.beforeMigrate } : {}),
		});
		return 0;
	} catch (err) {
		log.exception("migration failed", err, { migrations_dir: folder });
		return 1;
	} finally {
		await client?.close().catch(() => {});
	}
}
