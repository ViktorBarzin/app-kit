/**
 * pg-boss for /enqueue and the worker entrypoint: the worker's pool size,
 * its job handler, and with TEST_DATABASE_URL a job queued the App's way
 * and done the worker's way on a real Postgres.
 */
import { describe, expect, test } from "bun:test";
import { createSqlClient } from "@viktorbarzin/pg";
import { createTestDatabase } from "@viktorbarzin/pg/testing";

import {
	enqueueFixtureJob,
	FIXTURE_QUEUE,
	jobHandler,
	startWorkerBoss,
	stopFixtureBoss,
	WORKER_POOL_DEFAULT,
	workerPoolSize,
} from "./boss";

describe("workerPoolSize (CLOUD_DATABASE_POOL_SIZE)", () => {
	test("unset or empty: the default of 1, what Cloud gives a worker", () => {
		expect(WORKER_POOL_DEFAULT).toBe(1);
		expect(workerPoolSize(undefined)).toBe(1);
		expect(workerPoolSize("")).toBe(1);
		expect(workerPoolSize("  ")).toBe(1);
	});

	test("a whole number of at least 1 is the pool's max", () => {
		expect(workerPoolSize("1")).toBe(1);
		expect(workerPoolSize("3")).toBe(3);
		expect(workerPoolSize(" 8 ")).toBe(8);
	});

	test("anything else stops the worker with the value in the message", () => {
		for (const raw of ["0", "x", "-1", "1.5", "2x"])
			expect(() => workerPoolSize(raw)).toThrow(
				`CLOUD_DATABASE_POOL_SIZE must be a whole number >= 1 (got "${raw.trim()}")`,
			);
	});
});

describe("jobHandler", () => {
	test("logs one job-done line per job, with the job id and the version", async () => {
		const lines: string[] = [];
		await jobHandler("v-1", (line) => lines.push(line))([
			{ id: "a-1" },
			{ id: "b-2" },
		]);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("job-done a-1");
		expect(lines[1]).toContain("job-done b-2");
		expect(JSON.parse(lines[0] ?? "")).toEqual({
			msg: "job-done a-1",
			id: "a-1",
			version: "v-1",
		});
	});
});

const adminUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!adminUrl)("on Postgres", () => {
	test("a job queued the App's way is done by the worker", async () => {
		const database = await createTestDatabase({
			adminUrl: adminUrl ?? "",
			prefix: "fixture_boss",
		});
		const app = createSqlClient(
			{ url: database.url, passwordFile: null },
			{ max: 1 },
		);
		const worker = createSqlClient(
			{ url: database.url, passwordFile: null },
			{ max: WORKER_POOL_DEFAULT },
		);
		const lines: string[] = [];
		try {
			// The App first: the queue is made idempotently on both sides.
			const id = await enqueueFixtureJob(() => app);
			expect(id).toMatch(/^[0-9a-f-]{36}$/);
			const boss = await startWorkerBoss(worker, "v-2", (line) =>
				lines.push(line),
			);
			const deadline = Date.now() + 20_000;
			while (!lines.some((line) => line.includes(`job-done ${id}`))) {
				if (Date.now() > deadline) throw new Error("the job was not done");
				await Bun.sleep(100);
			}
			const second = await enqueueFixtureJob(() => app);
			expect(second).not.toBe(id);
			await boss.stop({ graceful: true, timeout: 5_000 });
			const [queue] = await app.unsafe(
				"select name from pgboss.queue where name = $1",
				[FIXTURE_QUEUE],
			);
			expect(queue).toEqual({ name: FIXTURE_QUEUE });
		} finally {
			await stopFixtureBoss();
			await app.close();
			await worker.close();
			await database.drop();
		}
	}, 40_000);
});
