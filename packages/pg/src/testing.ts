/**
 * Throwaway Postgres databases for tests. Point `adminUrl` (TEST_DATABASE_URL
 * by convention) at a server where that role may create databases; each
 * database gets a random name and is dropped with `drop()`.
 */
import { SQL } from "bun";

import { runMigrations } from "./index.js";

const NAME_PREFIX = /^[a-z][a-z0-9_]*$/;

export interface TestDatabase {
	url: string;
	drop(): Promise<void>;
}

export async function createTestDatabase(opts: {
	adminUrl: string;
	prefix?: string;
}): Promise<TestDatabase> {
	const prefix = opts.prefix ?? "test";
	if (!NAME_PREFIX.test(prefix))
		throw new Error("prefix must be lowercase letters, digits and _");
	const name = `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
	const admin = new SQL(opts.adminUrl);
	try {
		await admin.unsafe(`create database ${name}`);
	} finally {
		await admin.close();
	}
	const url = new URL(opts.adminUrl);
	url.pathname = `/${name}`;
	return {
		url: url.toString(),
		async drop() {
			const cleanup = new SQL(opts.adminUrl);
			try {
				await cleanup.unsafe(`drop database if exists ${name} with (force)`);
			} finally {
				await cleanup.close();
			}
		},
	};
}

export interface MigratedTestDatabase extends TestDatabase {
	/** A client on the new database (pool of 2). */
	client: SQL;
}

/** A new database with the app's migrations applied. `drop()` closes the client too. */
export async function migratedTestDatabase(opts: {
	adminUrl: string;
	migrationsFolder: string;
	lockKey: bigint;
	prefix?: string;
}): Promise<MigratedTestDatabase> {
	const db = await createTestDatabase({
		adminUrl: opts.adminUrl,
		...(opts.prefix ? { prefix: opts.prefix } : {}),
	});
	const migrator = new SQL({ url: db.url, max: 1 });
	try {
		await runMigrations(migrator, {
			migrationsFolder: opts.migrationsFolder,
			lockKey: opts.lockKey,
		});
	} finally {
		await migrator.close();
	}
	const client = new SQL({ url: db.url, max: 2 });
	return {
		url: db.url,
		client,
		async drop() {
			await client.close();
			await db.drop();
		},
	};
}
