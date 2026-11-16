import { describe, expect, test } from "bun:test";

import { runFixtureMigration } from "./migration";

describe("runFixtureMigration", () => {
	test("with the knobs at rest it only migrates", async () => {
		const printed: string[] = [];
		let ran = 0;
		const code = await runFixtureMigration(
			async () => {
				ran += 1;
				return 0;
			},
			{ log: "", exit: 0 },
			(l) => printed.push(l),
		);
		expect([code, ran, printed]).toEqual([0, 1, []]);
	});

	test("MIGRATION_LOG prints its line once, then migrates", async () => {
		const printed: string[] = [];
		const code = await runFixtureMigration(
			async () => 0,
			{ log: "migration-ran", exit: 0 },
			(l) => printed.push(l),
		);
		expect(code).toBe(0);
		expect(printed).toEqual(["migration-ran"]);
	});

	test("MIGRATION_EXIT prints why and exits with it, without migrating", async () => {
		const printed: string[] = [];
		let ran = 0;
		const code = await runFixtureMigration(
			async () => {
				ran += 1;
				return 0;
			},
			{ log: "p10-fails-abc", exit: 1 },
			(l) => printed.push(l),
		);
		expect(code).toBe(1);
		expect(ran).toBe(0);
		expect(printed[0]).toBe("p10-fails-abc");
		expect(printed[1]).toContain("MIGRATION_EXIT is 1");
	});

	test("a failing real migration keeps its own code", async () => {
		expect(
			await runFixtureMigration(
				async () => 3,
				{ log: "", exit: 0 },
				() => {},
			),
		).toBe(3);
	});
});
