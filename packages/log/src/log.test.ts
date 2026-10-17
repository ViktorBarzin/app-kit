import { afterEach, describe, expect, test } from "bun:test";

import {
	formatRecord,
	getLogger,
	installJsonConsole,
	parseLogLevel,
	pythonIsoTimestamp,
	setLogLevel,
	setLogSink,
} from "./index.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const fn of cleanups.splice(0)) fn();
	setLogLevel("WARNING");
});

function capture(): string[] {
	const lines: string[] = [];
	cleanups.push(setLogSink((line) => lines.push(line)));
	return lines;
}

describe("formatRecord", () => {
	test("a record has ts, level, logger, msg, then extras", () => {
		const line = formatRecord(
			"INFO",
			"app.sync",
			"sync served",
			{ user: "someone", full: true, lists: 3 },
			undefined,
			new Date("2026-10-16T04:05:06.789Z"),
		);
		expect(line).toBe(
			'{"ts":"2026-10-16T04:05:06.789000+00:00","level":"INFO","logger":"app.sync","msg":"sync served","user":"someone","full":true,"lists":3}',
		);
	});

	test("extras never overwrite the standard keys, exc comes last", () => {
		const record = JSON.parse(
			formatRecord(
				"INFO",
				"a",
				"real",
				{ msg: "fake", level: "DEBUG", ts: "x", logger: "y", x: 1 },
				new Error("bad"),
			),
		);
		expect(record).toMatchObject({
			level: "INFO",
			msg: "real",
			logger: "a",
			x: 1,
		});
		expect(Object.keys(record).at(-1)).toBe("exc");
	});

	test("bigints and errors in extras become strings", () => {
		const record = JSON.parse(
			formatRecord("INFO", "a", "m", { n: 7n, e: new Error("boom") }),
		);
		expect(record).toMatchObject({ n: "7", e: "Error: boom" });
	});

	test("a non-Error exception is stringified", () => {
		expect(JSON.parse(formatRecord("ERROR", "a", "m", undefined, 42)).exc).toBe(
			"42",
		);
	});
});

describe("getLogger", () => {
	test("exception() adds the stack under exc", () => {
		const lines = capture();
		setLogLevel("DEBUG");
		getLogger("t").exception("boom", new Error("bad"), { path: "/api/x" });
		const record = JSON.parse(lines[0] ?? "{}");
		expect(record).toMatchObject({
			level: "ERROR",
			msg: "boom",
			path: "/api/x",
		});
		expect(record.exc).toContain("Error: bad");
	});

	test("records below the threshold are dropped", () => {
		const lines = capture();
		setLogLevel("WARNING");
		getLogger("t").info("quiet");
		getLogger("t").warning("loud");
		expect(lines.map((l) => JSON.parse(l).msg)).toEqual(["loud"]);
	});

	test("setLogSink returns a restore function", () => {
		const outer: string[] = [];
		const restoreOuter = setLogSink((l) => outer.push(l));
		const restoreInner = setLogSink(() => {});
		getLogger("t").error("to inner");
		restoreInner();
		getLogger("t").error("to outer");
		restoreOuter();
		expect(outer.map((l) => JSON.parse(l).msg)).toEqual(["to outer"]);
	});

	test("the sink and threshold are shared through globalThis", () => {
		const state = (globalThis as unknown as Record<symbol, unknown>)[
			Symbol.for("@viktorbarzin:log")
		];
		expect(state).toBeDefined();
	});
});

describe("parseLogLevel", () => {
	test.each([
		[undefined, "INFO"],
		["", "INFO"],
		["debug", "DEBUG"],
		["Info", "INFO"],
		["WARN", "WARNING"],
		["warning", "WARNING"],
		["ERROR", "ERROR"],
		["verbose", "INFO"],
	] as const)("%p -> %p", (raw, level) => {
		expect(parseLogLevel(raw)).toBe(level);
	});
});

test("timestamps match Python's isoformat for UTC", () => {
	expect(pythonIsoTimestamp(new Date("2026-01-02T03:04:05.006Z"))).toBe(
		"2026-01-02T03:04:05.006000+00:00",
	);
});

describe("installJsonConsole", () => {
	test("console output becomes one JSON line, an Error's stack under exc", () => {
		const lines = capture();
		setLogLevel("DEBUG");
		const target = { ...console } as Console;
		cleanups.push(installJsonConsole(target));
		target.log("Listening on: %s", "http://localhost:3000/");
		target.error(
			"[request error]",
			new Error("Server function info not found"),
		);
		target.warn({ nested: { a: 1 } });
		target.debug(new Error("only an error"));
		const records = lines.map((line) => JSON.parse(line));
		expect(records.map((r) => [r.level, r.logger])).toEqual([
			["INFO", "console"],
			["ERROR", "console"],
			["WARNING", "console"],
			["DEBUG", "console"],
		]);
		expect(records[0].msg).toBe("Listening on: http://localhost:3000/");
		expect(records[1].msg).toBe("[request error]");
		expect(records[1].exc).toContain("Error: Server function info not found");
		expect(records[1].exc).toContain("\n    at ");
		expect(records[3].msg).toBe("Error: only an error");
		expect(lines.every((line) => !line.includes("\n"))).toBe(true);
	});

	test("the returned function restores the console methods", () => {
		const original = () => {};
		const target = { log: original, error: original } as unknown as Console;
		const restore = installJsonConsole(target);
		expect(target.log).not.toBe(original);
		restore();
		expect(target.log).toBe(original);
	});
});
