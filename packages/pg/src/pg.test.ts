/**
 * Pure helpers always run. The database tests run when TEST_DATABASE_URL
 * points at a Postgres where that role may create databases, e.g.
 *
 *   docker run -d --tmpfs /var/lib/postgresql -e POSTGRES_PASSWORD=ci -p 127.0.0.1::5432 postgres:18
 *   TEST_DATABASE_URL=postgres://postgres:ci@127.0.0.1:<port>/postgres bun test
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SQL } from "bun";
import { pgTable, serial, text } from "drizzle-orm/pg-core";
import fc from "fast-check";

import {
	APP_POOL_MAX,
	connectionBudget,
	connectionBudgetFromEnv,
	createPool,
	createSqlClient,
	migrationLockKey,
	pgSettingsFromEnv,
	readPasswordFile,
	runMigrateCli,
	runMigrations,
} from "./index.js";
import { createTestDatabase, migratedTestDatabase } from "./testing.js";

const adminUrl = process.env.TEST_DATABASE_URL;
const migrationsFolder = resolve(import.meta.dir, "testdata/migrations");
const LOCK = migrationLockKey("pg-package-tests");
const drops: (() => Promise<void>)[] = [];

afterAll(async () => {
	for (const drop of drops) await drop();
});

async function freshUrl(): Promise<string> {
	const db = await createTestDatabase({
		adminUrl: adminUrl ?? "",
		prefix: "pgpkg",
	});
	drops.push(db.drop);
	return db.url;
}

describe("pgSettingsFromEnv", () => {
	test("reads DATABASE_URL and DATABASE_PASSWORD_FILE", () => {
		expect(
			pgSettingsFromEnv({
				DATABASE_URL: "postgres://app@db:5432/app",
				DATABASE_PASSWORD_FILE: "/secrets/db/password",
			}),
		).toEqual({
			url: "postgres://app@db:5432/app",
			passwordFile: "/secrets/db/password",
		});
		expect(
			pgSettingsFromEnv({
				DATABASE_URL: "postgres://a@b/c",
				DATABASE_PASSWORD_FILE: "",
			}),
		).toEqual({ url: "postgres://a@b/c", passwordFile: null });
	});

	test("DATABASE_URL is required", () => {
		expect(() => pgSettingsFromEnv({})).toThrow("DATABASE_URL is not set");
	});
});

describe("migrationLockKey", () => {
	test("stable per app, different across apps, a signed int64", () => {
		expect(migrationLockKey("starter")).toBe(migrationLockKey("starter"));
		expect(migrationLockKey("starter")).not.toBe(migrationLockKey("other"));
		fc.assert(
			fc.property(fc.string(), (name) => {
				const key = migrationLockKey(name);
				return key >= -(2n ** 63n) && key < 2n ** 63n;
			}),
		);
	});
});

test("readPasswordFile strips one trailing newline", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pg-pw-"));
	try {
		await writeFile(join(dir, "a"), "pw\n");
		await writeFile(join(dir, "b"), "pw\r\n");
		await writeFile(join(dir, "c"), "pw\n\n");
		expect(await readPasswordFile(join(dir, "a"))).toBe("pw");
		expect(await readPasswordFile(join(dir, "b"))).toBe("pw");
		expect(await readPasswordFile(join(dir, "c"))).toBe("pw\n");
	} finally {
		await rm(dir, { recursive: true });
	}
});

test("the pool budget is 4 (plus 1 LISTEN = 5 per pod)", () => {
	expect(APP_POOL_MAX).toBe(4);
});

describe("connectionBudget", () => {
	test("no limit: the default pool of 4 plus the LISTEN connection", () => {
		expect(connectionBudget(null)).toEqual({
			perPod: 5,
			poolMax: APP_POOL_MAX,
			realtime: true,
		});
	});

	test.each([
		// [size, limit, per pod, pool, realtime]
		["nano", 2, 1, 1, false],
		["small", 4, 2, 1, true],
		["medium", 8, 4, 3, true],
	] as const)("%s (limit %d): %d per pod, pool %d, realtime %p", (_size, limit, perPod, poolMax, realtime) => {
		expect(connectionBudget(limit)).toEqual({ perPod, poolMax, realtime });
	});

	test("an odd limit rounds down: 5 gives 2 per pod", () => {
		expect(connectionBudget(5)).toEqual({
			perPod: 2,
			poolMax: 1,
			realtime: true,
		});
	});

	test.each([
		0,
		1,
		-4,
		2.5,
		Number.NaN,
	])("a limit of %p that leaves no whole connection per pod is an error", (limit) => {
		expect(() => connectionBudget(limit)).toThrow("connection limit");
	});
});

describe("connectionBudgetFromEnv", () => {
	test("reads CLOUD_DATABASE_CONNECTION_LIMIT", () => {
		expect(
			connectionBudgetFromEnv({ CLOUD_DATABASE_CONNECTION_LIMIT: "4" }),
		).toEqual({ perPod: 2, poolMax: 1, realtime: true });
		expect(
			connectionBudgetFromEnv({ CLOUD_DATABASE_CONNECTION_LIMIT: " 2 " }),
		).toEqual({ perPod: 1, poolMax: 1, realtime: false });
	});

	test("unset or empty gives the default budget", () => {
		expect(connectionBudgetFromEnv({})).toEqual(connectionBudget(null));
		expect(
			connectionBudgetFromEnv({ CLOUD_DATABASE_CONNECTION_LIMIT: "" }),
		).toEqual(connectionBudget(null));
	});

	test.each([
		"four",
		"4x",
		"0x4",
		"1e1",
		"-2",
	])("a value of %p is a configuration error", (value) => {
		expect(() =>
			connectionBudgetFromEnv({ CLOUD_DATABASE_CONNECTION_LIMIT: value }),
		).toThrow("CLOUD_DATABASE_CONNECTION_LIMIT");
	});
});

describe.skipIf(!adminUrl)("migrations", () => {
	test("an empty database runs every migration, a second run applies none", async () => {
		const client = createSqlClient(
			{ url: await freshUrl(), passwordFile: null },
			{ max: 1 },
		);
		const first = await runMigrations(client, {
			migrationsFolder,
			lockKey: LOCK,
		});
		const second = await runMigrations(client, {
			migrationsFolder,
			lockKey: LOCK,
		});
		const columns = await client`
			select column_name from information_schema.columns
			where table_name = 'notes' order by ordinal_position`;
		await client.close();
		expect(first).toEqual({ applied: 2 });
		expect(second).toEqual({ applied: 0 });
		expect(columns.map((c: { column_name: string }) => c.column_name)).toEqual([
			"id",
			"body",
			"created_at",
		]);
	});

	test("two migrators started together apply each migration once", async () => {
		const url = await freshUrl();
		const a = createSqlClient({ url, passwordFile: null }, { max: 1 });
		const b = createSqlClient({ url, passwordFile: null }, { max: 1 });
		const results = await Promise.all([
			runMigrations(a, { migrationsFolder, lockKey: LOCK }),
			runMigrations(b, { migrationsFolder, lockKey: LOCK }),
		]);
		const rows = await a`select hash from drizzle.__drizzle_migrations`;
		await Promise.all([a.close(), b.close()]);
		expect(results.map((r) => r.applied).sort()).toEqual([0, 2]);
		expect(rows).toHaveLength(2);
	});

	test("beforeMigrate runs under the lock, before the migrator", async () => {
		const url = await freshUrl();
		const client = createSqlClient({ url, passwordFile: null }, { max: 1 });
		const seen: boolean[] = [];
		await runMigrations(client, {
			migrationsFolder,
			lockKey: LOCK,
			beforeMigrate: async (c) => {
				const [row] = await c`
					select count(*)::int as n from pg_locks
					where locktype = 'advisory' and pid = pg_backend_pid()`;
				seen.push((row as { n: number }).n === 1);
				const [notes] =
					await c`select to_regclass('public.notes') is null as missing`;
				seen.push((notes as { missing: boolean }).missing);
			},
		});
		await client.close();
		expect(seen).toEqual([true, true]);
	});

	test("custom migrations schema and table", async () => {
		const url = await freshUrl();
		const client = createSqlClient({ url, passwordFile: null }, { max: 1 });
		await runMigrations(client, {
			migrationsFolder,
			lockKey: LOCK,
			migrationsSchema: "meta",
			migrationsTable: "applied",
		});
		const rows = await client`select hash from meta.applied`;
		await client.close();
		expect(rows).toHaveLength(2);
	});
});

describe.skipIf(!adminUrl)("pool", () => {
	const notes = pgTable("notes", {
		id: serial("id").primaryKey(),
		body: text("body").notNull(),
	});

	test("lazy, once per process, reads the password from a file, closes", async () => {
		const url = new URL(await freshUrl());
		const password = decodeURIComponent(url.password);
		url.password = "";
		const dir = await mkdtemp(join(tmpdir(), "pg-pool-"));
		const file = join(dir, "password");
		await writeFile(file, `${password}\n`);
		let reads = 0;
		const key = `test.pool.${crypto.randomUUID()}`;
		const settings = () => {
			reads += 1;
			return { url: url.toString(), passwordFile: file };
		};
		try {
			const pool = createPool({ settings, schema: { notes }, key });
			expect(reads).toBe(0);
			const again = createPool({ settings, schema: { notes }, key });
			const migrator = createSqlClient(
				{ url: url.toString(), passwordFile: file },
				{ max: 1 },
			);
			await runMigrations(migrator, { migrationsFolder, lockKey: LOCK });
			await migrator.close();
			await pool.getDb().insert(notes).values({ body: "hello" });
			const rows = await again.getDb().select().from(notes);
			expect(rows.map((r) => r.body)).toEqual(["hello"]);
			expect(again.getClient()).toBe(pool.getClient());
			expect(reads).toBe(1);
			await pool.close();
			await again.close();
		} finally {
			await rm(dir, { recursive: true });
		}
	});

	test.each([
		1, 2,
	])("max %d caps the open connections, read when the pool opens", async (max) => {
		const url = await freshUrl();
		let reads = 0;
		const pool = createPool({
			settings: () => ({ url, passwordFile: null }),
			schema: { notes },
			key: `test.pool.${crypto.randomUUID()}`,
			max: () => {
				reads += 1;
				return max;
			},
		});
		expect(reads).toBe(0);
		try {
			const pids = await Promise.all(
				Array.from({ length: 6 }, async () => {
					const [row] = await pool.getClient()`
							select pg_backend_pid() as pid, pg_sleep(0.05)`;
					return (row as { pid: number }).pid;
				}),
			);
			expect(new Set(pids).size).toBe(max);
			expect(reads).toBe(1);
		} finally {
			await pool.close();
		}
	});

	test("a plain number works too, and the default is APP_POOL_MAX", async () => {
		const url = await freshUrl();
		for (const [max, expected] of [
			[3, 3],
			[undefined, APP_POOL_MAX],
		] as const) {
			const pool = createPool({
				settings: () => ({ url, passwordFile: null }),
				schema: { notes },
				key: `test.pool.${crypto.randomUUID()}`,
				...(max === undefined ? {} : { max }),
			});
			try {
				const pids = await Promise.all(
					Array.from({ length: 8 }, async () => {
						const [row] = await pool.getClient()`
							select pg_backend_pid() as pid, pg_sleep(0.05)`;
						return (row as { pid: number }).pid;
					}),
				);
				expect(new Set(pids).size).toBe(expected);
			} finally {
				await pool.close();
			}
		}
	});

	test.each([0, -1, 1.5])("max %p is refused when the pool opens", (max) => {
		const pool = createPool({
			settings: () => ({
				url: "postgres://a@127.0.0.1:1/x",
				passwordFile: null,
			}),
			schema: { notes },
			key: `test.pool.${crypto.randomUUID()}`,
			max,
		});
		expect(() => pool.getDb()).toThrow("pool max");
	});
});

describe.skipIf(!adminUrl)("runMigrateCli", () => {
	test("exit code 0 after migrating, 1 when the database is unreachable", async () => {
		const url = await freshUrl();
		expect(
			await runMigrateCli({
				lockKey: LOCK,
				env: { DATABASE_URL: url, MIGRATIONS_DIR: migrationsFolder },
			}),
		).toBe(0);
		const check = new SQL(url);
		const [row] =
			await check`select count(*)::int as n from drizzle.__drizzle_migrations`;
		await check.close();
		expect((row as { n: number }).n).toBe(2);
		expect(
			await runMigrateCli({
				lockKey: LOCK,
				env: {
					DATABASE_URL: "postgres://nobody:x@127.0.0.1:1/none",
					MIGRATIONS_DIR: migrationsFolder,
				},
			}),
		).toBe(1);
		expect(await runMigrateCli({ lockKey: LOCK, env: {} })).toBe(1);
	});
});

describe.skipIf(!adminUrl)("migratedTestDatabase", () => {
	test("creates a migrated database and drops it", async () => {
		const db = await migratedTestDatabase({
			adminUrl: adminUrl ?? "",
			migrationsFolder,
			lockKey: LOCK,
			prefix: "pgpkg_migrated",
		});
		const name = new URL(db.url).pathname.slice(1);
		expect(name).toStartWith("pgpkg_migrated_");
		const [row] =
			await db.client`select to_regclass('public.notes') is not null as ok`;
		expect((row as { ok: boolean }).ok).toBe(true);
		await db.drop();
		const admin = new SQL(adminUrl ?? "");
		const left = await admin`select 1 from pg_database where datname = ${name}`;
		await admin.close();
		expect(left).toHaveLength(0);
	});
});
