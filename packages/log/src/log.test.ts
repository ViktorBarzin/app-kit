import { afterEach, describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
	formatRecord,
	formatTimestamp,
	getLogContext,
	getLogger,
	installJsonConsole,
	parseLogLevel,
	SEVERITY_NUMBER,
	serviceFromEnv,
	setLogContext,
	setLogLevel,
	setLogService,
	setLogSink,
	withLogContext,
} from "./index.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const fn of cleanups.splice(0)) fn();
	setLogLevel("WARN");
});

function capture(): string[] {
	const lines: string[] = [];
	cleanups.push(setLogSink((line) => lines.push(line)));
	return lines;
}

function service(name?: string, version?: string, environment?: string) {
	cleanups.push(setLogService({ name, version, environment }));
}

const AT = new Date("2026-10-16T04:05:06.789Z");

describe("formatRecord", () => {
	test("a record has the OpenTelemetry fields in order, then extras", () => {
		const line = formatRecord(
			"INFO",
			"app.sync",
			"sync served",
			{ user_name: "someone", full: true, lists: 3 },
			undefined,
			AT,
			{
				service: { name: "app", version: "1.2.3", environment: "production" },
				context: { enduserId: "sub-1", traceId: "t1", spanId: "s1" },
			},
		);
		expect(line).toBe(
			'{"timestamp":"2026-10-16T04:05:06.789000000Z","severity_text":"INFO","severity_number":9,' +
				'"body":"sync served","logger.name":"app.sync","service.name":"app","service.version":"1.2.3",' +
				'"deployment.environment.name":"production","trace_id":"t1","span_id":"s1","enduser.id":"sub-1",' +
				'"user_name":"someone","full":true,"lists":3}',
		);
	});

	test("unknown service and context fields are left out, not null", () => {
		const record = JSON.parse(
			formatRecord("WARN", "a", "m", undefined, undefined, AT, {
				service: {},
			}),
		);
		expect(Object.keys(record)).toEqual([
			"timestamp",
			"severity_text",
			"severity_number",
			"body",
			"logger.name",
		]);
		expect(record.severity_number).toBe(13);
	});

	test("extras never overwrite the standard keys; exception fields come last", () => {
		const record = JSON.parse(
			formatRecord(
				"INFO",
				"a",
				"real",
				{
					body: "fake",
					severity_text: "DEBUG",
					timestamp: "x",
					"logger.name": "y",
					"enduser.id": "z",
					"exception.message": "w",
					x: 1,
				},
				new TypeError("bad"),
				AT,
				{ context: { enduserId: "sub-1" } },
			),
		);
		expect(record).toMatchObject({
			severity_text: "INFO",
			body: "real",
			"logger.name": "a",
			"enduser.id": "sub-1",
			x: 1,
			"exception.type": "TypeError",
			"exception.message": "bad",
		});
		expect(record["exception.stacktrace"]).toContain("TypeError: bad");
		expect(Object.keys(record).slice(-3)).toEqual([
			"exception.type",
			"exception.message",
			"exception.stacktrace",
		]);
	});

	test("an Error subclass reports its class name as exception.type", () => {
		class QuotaExceeded extends Error {}
		const record = JSON.parse(
			formatRecord("ERROR", "a", "m", undefined, new QuotaExceeded("full")),
		);
		expect(record["exception.type"]).toBe("QuotaExceeded");
	});

	test("a non-Error exception becomes exception.message only", () => {
		const record = JSON.parse(formatRecord("ERROR", "a", "m", undefined, 42));
		expect(record["exception.message"]).toBe("42");
		expect(record["exception.type"]).toBeUndefined();
	});

	test("bigints and errors in extras become strings", () => {
		const record = JSON.parse(
			formatRecord("INFO", "a", "m", { n: 7n, e: new Error("boom") }),
		);
		expect(record).toMatchObject({ n: "7", e: "Error: boom" });
	});

	test("context attributes are added, and call-site extras win over them", () => {
		const record = JSON.parse(
			formatRecord("INFO", "a", "m", { route: "/x" }, undefined, AT, {
				context: { attributes: { route: "/ctx", request_id: "r1" } },
			}),
		);
		expect(record).toMatchObject({ route: "/x", request_id: "r1" });
	});

	test("every line is one JSON object with the standard fields (property)", () => {
		const levels = fc.constantFrom(
			...(Object.keys(SEVERITY_NUMBER) as (keyof typeof SEVERITY_NUMBER)[]),
		);
		fc.assert(
			fc.property(
				levels,
				fc.string(),
				fc.string(),
				fc.dictionary(fc.string(), fc.jsonValue()),
				(level, logger, body, extra) => {
					const line = formatRecord(level, logger, body, extra);
					expect(line.includes("\n")).toBe(false);
					const record = JSON.parse(line);
					expect(record.severity_text).toBe(level);
					expect(record.severity_number).toBe(SEVERITY_NUMBER[level]);
					expect(record.body).toBe(body);
					expect(record["logger.name"]).toBe(logger);
				},
			),
		);
	});
});

describe("formatTimestamp", () => {
	test("RFC 3339 in UTC with nine fractional digits and Z", () => {
		expect(formatTimestamp(new Date("2026-01-02T03:04:05.006Z"))).toBe(
			"2026-01-02T03:04:05.006000000Z",
		);
	});

	test("nanoseconds since the epoch keep every digit", () => {
		expect(formatTimestamp(1_767_323_045_006_007_008n)).toBe(
			"2026-01-02T03:04:05.006007008Z",
		);
	});

	test("a Date and its nanosecond count format the same (property)", () => {
		fc.assert(
			fc.property(fc.integer({ min: 0, max: 253_402_300_799_999 }), (ms) => {
				const fromDate = formatTimestamp(new Date(ms));
				expect(fromDate).toBe(formatTimestamp(BigInt(ms) * 1_000_000n));
				expect(fromDate).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{9}Z$/);
				expect(Date.parse(fromDate)).toBe(ms);
			}),
		);
	});
});

describe("getLogger", () => {
	test("exception() logs ERROR with the exception fields", () => {
		const lines = capture();
		setLogLevel("DEBUG");
		getLogger("t").exception("boom", new Error("bad"), { path: "/api/x" });
		const record = JSON.parse(lines[0] ?? "{}");
		expect(record).toMatchObject({
			severity_text: "ERROR",
			severity_number: 17,
			body: "boom",
			path: "/api/x",
			"exception.type": "Error",
			"exception.message": "bad",
		});
	});

	test("warn and warning are the same level; fatal is 21", () => {
		const lines = capture();
		setLogLevel("DEBUG");
		const log = getLogger("t");
		log.warn("a");
		log.warning("b");
		log.fatal("c");
		expect(lines.map((l) => JSON.parse(l).severity_number)).toEqual([
			13, 13, 21,
		]);
	});

	test("records below the threshold are dropped", () => {
		const lines = capture();
		setLogLevel("WARNING");
		getLogger("t").info("quiet");
		getLogger("t").warning("loud");
		expect(lines.map((l) => JSON.parse(l).body)).toEqual(["loud"]);
	});

	test("the service fields come from setLogService", () => {
		const lines = capture();
		service("starter", "abc123", "production");
		getLogger("t").error("x");
		expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
			"service.name": "starter",
			"service.version": "abc123",
			"deployment.environment.name": "production",
		});
	});

	test("setLogSink returns a restore function", () => {
		const outer: string[] = [];
		const restoreOuter = setLogSink((l) => outer.push(l));
		const restoreInner = setLogSink(() => {});
		getLogger("t").error("to inner");
		restoreInner();
		getLogger("t").error("to outer");
		restoreOuter();
		expect(outer.map((l) => JSON.parse(l).body)).toEqual(["to outer"]);
	});

	test("the sink, threshold and context are shared through globalThis", () => {
		const state = (globalThis as unknown as Record<symbol, unknown>)[
			Symbol.for("@viktorbarzin:log")
		];
		expect(state).toBeDefined();
	});
});

describe("log context", () => {
	test("withLogContext adds enduser.id, trace_id and span_id to every line inside it", async () => {
		const lines = capture();
		const log = getLogger("t");
		await withLogContext({ traceId: "t1", spanId: "s1" }, async () => {
			await Promise.resolve();
			setLogContext({ enduserId: "sub-1" });
			log.error("inside");
		});
		log.error("outside");
		const [inside, outside] = lines.map((l) => JSON.parse(l));
		expect(inside).toMatchObject({
			trace_id: "t1",
			span_id: "s1",
			"enduser.id": "sub-1",
		});
		expect(outside["enduser.id"]).toBeUndefined();
		expect(outside.trace_id).toBeUndefined();
	});

	test("setLogContext outside withLogContext changes nothing and says so", () => {
		expect(setLogContext({ enduserId: "x" })).toBe(false);
		expect(getLogContext()).toBeUndefined();
	});

	test("a value set inside a scope is seen by code that runs after it in the same scope", async () => {
		const seen = await withLogContext({}, async () => {
			const later = new Promise<string | undefined>((resolve) =>
				setTimeout(() => resolve(getLogContext()?.enduserId), 1),
			);
			setLogContext({ enduserId: "sub-2" });
			return later;
		});
		expect(seen).toBe("sub-2");
	});

	test("concurrent scopes do not see each other's values", async () => {
		const run = (id: string) =>
			withLogContext({ enduserId: id }, async () => {
				await new Promise((resolve) => setTimeout(resolve, 2));
				return getLogContext()?.enduserId;
			});
		expect(await Promise.all([run("a"), run("b"), run("c")])).toEqual([
			"a",
			"b",
			"c",
		]);
	});

	test("nested scopes inherit and override, and the outer one is restored (property)", () => {
		const id = fc.option(fc.string({ minLength: 1 }), { nil: undefined });
		fc.assert(
			fc.property(
				id,
				id,
				id,
				id,
				(outerUser, outerTrace, innerUser, innerSpan) => {
					withLogContext({ enduserId: outerUser, traceId: outerTrace }, () => {
						withLogContext({ enduserId: innerUser, spanId: innerSpan }, () => {
							const inner = getLogContext();
							expect(inner?.enduserId).toBe(innerUser ?? outerUser);
							expect(inner?.traceId).toBe(outerTrace);
							expect(inner?.spanId).toBe(innerSpan);
						});
						expect(getLogContext()?.enduserId).toBe(outerUser);
						expect(getLogContext()?.spanId).toBeUndefined();
					});
				},
			),
		);
	});
});

describe("serviceFromEnv", () => {
	test("reads OTEL_SERVICE_NAME, SERVICE_VERSION and DEPLOYMENT_ENVIRONMENT", () => {
		expect(
			serviceFromEnv({
				OTEL_SERVICE_NAME: "starter",
				SERVICE_VERSION: "abc123",
				DEPLOYMENT_ENVIRONMENT: "dev",
			}),
		).toEqual({ name: "starter", version: "abc123", environment: "dev" });
	});

	test("blank or missing variables are left out", () => {
		expect(serviceFromEnv({ OTEL_SERVICE_NAME: " " })).toEqual({});
	});
});

describe("parseLogLevel", () => {
	test.each([
		[undefined, "INFO"],
		["", "INFO"],
		["debug", "DEBUG"],
		["Info", "INFO"],
		["WARN", "WARN"],
		["warning", "WARN"],
		["ERROR", "ERROR"],
		["fatal", "FATAL"],
		["verbose", "INFO"],
	] as const)("%p -> %p", (raw, level) => {
		expect(parseLogLevel(raw)).toBe(level);
	});
});

describe("installJsonConsole", () => {
	test("console output becomes one JSON line, an Error under the exception fields", () => {
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
		expect(records.map((r) => [r.severity_text, r["logger.name"]])).toEqual([
			["INFO", "console"],
			["ERROR", "console"],
			["WARN", "console"],
			["DEBUG", "console"],
		]);
		expect(records[0].body).toBe("Listening on: http://localhost:3000/");
		expect(records[1].body).toBe("[request error]");
		expect(records[1]["exception.message"]).toBe(
			"Server function info not found",
		);
		expect(records[1]["exception.stacktrace"]).toContain("\n    at ");
		expect(records[3].body).toBe("Error: only an error");
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
