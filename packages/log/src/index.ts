/**
 * JSON-lines logging with OpenTelemetry log data model field names (app-kit
 * ADR-0002): one JSON object per line on stdout with `timestamp`,
 * `severity_text`, `severity_number`, `body`, `logger.name`, the service
 * fields, the request context (`trace_id`, `span_id`, `enduser.id`), then
 * the extras passed at the call site, then `exception.*` for an error.
 * Extras never overwrite the standard keys.
 *
 * The sink, threshold, service fields and the context store are one per
 * process, kept on globalThis: a server bundled twice (Nitro's entry plus
 * Start's SSR graph) still has one of each. The initial values come from
 * LOG_LEVEL, OTEL_SERVICE_NAME, SERVICE_VERSION and DEPLOYMENT_ENVIRONMENT.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { format } from "node:util";

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL";
/** What `setLogLevel` and `record` accept: a level, or `WARNING` for WARN. */
export type LogLevelName = LogLevel | "WARNING";
export type LogExtra = Record<string, unknown>;
export type LogSink = (line: string) => void;

/** OpenTelemetry severity numbers: the first number of each range. */
export const SEVERITY_NUMBER: Readonly<Record<LogLevel, number>> = {
	DEBUG: 5,
	INFO: 9,
	WARN: 13,
	ERROR: 17,
	FATAL: 21,
};

/** The resource fields on every line. Unknown fields are left out. */
export interface LogService {
	/** `service.name`, the app. */
	name?: string | undefined;
	/** `service.version`, the release. */
	version?: string | undefined;
	/** `deployment.environment.name`, e.g. `production` or `dev`. */
	environment?: string | undefined;
}

/** Per-request fields, set with `withLogContext` and `setLogContext`. */
export interface LogContext {
	/** `enduser.id`: the person's stable id (for example the OIDC `sub`). */
	enduserId?: string | undefined;
	/** `trace_id`, hex. */
	traceId?: string | undefined;
	/** `span_id`, hex. */
	spanId?: string | undefined;
	/** More snake_case attributes for every line in the scope. */
	attributes?: LogExtra | undefined;
}

function toLevel(level: LogLevelName): LogLevel {
	return level === "WARNING" ? "WARN" : level;
}

/** `WARNING` means WARN; anything unknown or unset is INFO. */
export function parseLogLevel(raw: string | undefined): LogLevel {
	const upper = (raw ?? "").trim().toUpperCase();
	if (upper === "WARNING") return "WARN";
	return upper in SEVERITY_NUMBER ? (upper as LogLevel) : "INFO";
}

function nonBlank(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed : undefined;
}

/** The service fields from OTEL_SERVICE_NAME, SERVICE_VERSION and DEPLOYMENT_ENVIRONMENT. */
export function serviceFromEnv(
	env: Record<string, string | undefined> = process.env,
): LogService {
	const service: LogService = {};
	const name = nonBlank(env.OTEL_SERVICE_NAME);
	const version = nonBlank(env.SERVICE_VERSION);
	const environment = nonBlank(env.DEPLOYMENT_ENVIRONMENT);
	if (name !== undefined) service.name = name;
	if (version !== undefined) service.version = version;
	if (environment !== undefined) service.environment = environment;
	return service;
}

interface LogState {
	sink: LogSink;
	threshold: number;
	service: LogService;
	context: AsyncLocalStorage<LogContext>;
}

function state(): LogState {
	const store = globalThis as unknown as Record<symbol, LogState | undefined>;
	const slot = Symbol.for("@viktorbarzin:log");
	let found = store[slot];
	if (found === undefined) {
		found = {
			sink: (line) => {
				process.stdout.write(`${line}\n`);
			},
			threshold: SEVERITY_NUMBER[parseLogLevel(process.env.LOG_LEVEL)],
			service: serviceFromEnv(),
			context: new AsyncLocalStorage<LogContext>(),
		};
		store[slot] = found;
	}
	return found;
}

const NANOS_PER_MS = 1_000_000n;
const NANOS_PER_SECOND = 1_000_000_000n;

/**
 * RFC 3339 in UTC with nine fractional digits: `2026-10-16T04:05:06.789000000Z`.
 * Takes a Date (millisecond precision, so the last six digits are zero) or
 * nanoseconds since the epoch as a bigint (every digit kept).
 */
export function formatTimestamp(time: Date | bigint): string {
	const nanos =
		typeof time === "bigint" ? time : BigInt(time.getTime()) * NANOS_PER_MS;
	const seconds = nanos / NANOS_PER_SECOND;
	const fraction = (nanos % NANOS_PER_SECOND).toString().padStart(9, "0");
	const whole = new Date(Number(seconds) * 1000).toISOString().slice(0, 19);
	return `${whole}.${fraction}Z`;
}

/** Send lines somewhere other than stdout (tests). Returns a restore function. */
export function setLogSink(sink: LogSink): () => void {
	const current = state();
	const previous = current.sink;
	current.sink = sink;
	return () => {
		current.sink = previous;
	};
}

export function setLogLevel(level: LogLevelName): void {
	state().threshold = SEVERITY_NUMBER[toLevel(level)];
}

/**
 * Set the service fields explicitly; given fields replace the ones from the
 * environment. Returns a restore function.
 */
export function setLogService(service: LogService): () => void {
	const current = state();
	const previous = current.service;
	const next: LogService = { ...previous };
	for (const key of ["name", "version", "environment"] as const) {
		const value = nonBlank(service[key]);
		if (value !== undefined) next[key] = value;
	}
	current.service = next;
	return () => {
		current.service = previous;
	};
}

function mergeContext(
	parent: LogContext | undefined,
	child: LogContext,
): LogContext {
	const merged: LogContext = { ...parent };
	if (child.enduserId !== undefined) merged.enduserId = child.enduserId;
	if (child.traceId !== undefined) merged.traceId = child.traceId;
	if (child.spanId !== undefined) merged.spanId = child.spanId;
	if (child.attributes !== undefined)
		merged.attributes = { ...parent?.attributes, ...child.attributes };
	return merged;
}

/**
 * Run `fn` with `context` added to every log line written inside it,
 * including in async work it starts. Nested scopes inherit the outer fields
 * and may override them.
 */
export function withLogContext<T>(context: LogContext, fn: () => T): T {
	const store = state().context;
	return store.run(mergeContext(store.getStore(), context), fn);
}

/**
 * Add fields to the current `withLogContext` scope, for example `enduserId`
 * once the session is known. The whole scope sees them, including lines
 * written after this call by code that started earlier. Outside a scope it
 * changes nothing and returns false.
 */
export function setLogContext(context: LogContext): boolean {
	const current = state().context.getStore();
	if (current === undefined) return false;
	Object.assign(current, mergeContext(current, context));
	return true;
}

/** The current scope's fields, or undefined outside `withLogContext`. */
export function getLogContext(): LogContext | undefined {
	const current = state().context.getStore();
	return current === undefined ? undefined : { ...current };
}

function jsonReplacer(_key: string, value: unknown): unknown {
	// Stringify what JSON cannot carry instead of throwing.
	if (typeof value === "bigint") return value.toString();
	if (value instanceof Error) return String(value);
	return value;
}

function exceptionFields(err: unknown): LogExtra {
	if (!(err instanceof Error)) return { "exception.message": String(err) };
	const ctor = err.constructor?.name;
	const type = ctor && ctor !== "Error" ? ctor : err.name;
	return {
		"exception.type": type,
		"exception.message": err.message,
		"exception.stacktrace": err.stack ?? `${type}: ${err.message}`,
	};
}

const RESERVED = new Set([
	"timestamp",
	"severity_text",
	"severity_number",
	"body",
	"logger.name",
	"service.name",
	"service.version",
	"deployment.environment.name",
	"trace_id",
	"span_id",
	"enduser.id",
	"exception.type",
	"exception.message",
	"exception.stacktrace",
]);

/** The service and context for one record; `formatRecord` reads the process's when omitted. */
export interface RecordScope {
	service?: LogService | undefined;
	context?: LogContext | undefined;
}

export function formatRecord(
	level: LogLevelName,
	logger: string,
	body: string,
	extra?: LogExtra,
	err?: unknown,
	now: Date | bigint = new Date(),
	scope?: RecordScope,
): string {
	const severity = toLevel(level);
	const service = scope?.service ?? state().service;
	const context = scope ? scope.context : state().context.getStore();
	const payload: Record<string, unknown> = {
		timestamp: formatTimestamp(now),
		severity_text: severity,
		severity_number: SEVERITY_NUMBER[severity],
		body,
		"logger.name": logger,
	};
	if (service.name !== undefined) payload["service.name"] = service.name;
	if (service.version !== undefined)
		payload["service.version"] = service.version;
	if (service.environment !== undefined)
		payload["deployment.environment.name"] = service.environment;
	if (context?.traceId !== undefined) payload.trace_id = context.traceId;
	if (context?.spanId !== undefined) payload.span_id = context.spanId;
	if (context?.enduserId !== undefined)
		payload["enduser.id"] = context.enduserId;
	const attributes = { ...context?.attributes, ...extra };
	for (const [key, value] of Object.entries(attributes)) {
		if (!RESERVED.has(key)) payload[key] = value;
	}
	if (err !== undefined) Object.assign(payload, exceptionFields(err));
	return JSON.stringify(payload, jsonReplacer);
}

export interface Logger {
	debug(msg: string, extra?: LogExtra): void;
	info(msg: string, extra?: LogExtra): void;
	warn(msg: string, extra?: LogExtra): void;
	/** The same as `warn`. */
	warning(msg: string, extra?: LogExtra): void;
	error(msg: string, extra?: LogExtra): void;
	fatal(msg: string, extra?: LogExtra): void;
	/** ERROR with the error under `exception.*`, like Python's logger.exception. */
	exception(msg: string, err: unknown, extra?: LogExtra): void;
	/** Any level, with an optional error under `exception.*`. */
	record(
		level: LogLevelName,
		msg: string,
		extra?: LogExtra,
		err?: unknown,
	): void;
}

export function getLogger(name: string): Logger {
	const emit = (
		level: LogLevelName,
		msg: string,
		extra?: LogExtra,
		err?: unknown,
	) => {
		const current = state();
		if (SEVERITY_NUMBER[toLevel(level)] < current.threshold) return;
		current.sink(formatRecord(level, name, msg, extra, err));
	};
	return {
		debug: (msg, extra) => emit("DEBUG", msg, extra),
		info: (msg, extra) => emit("INFO", msg, extra),
		warn: (msg, extra) => emit("WARN", msg, extra),
		warning: (msg, extra) => emit("WARN", msg, extra),
		error: (msg, extra) => emit("ERROR", msg, extra),
		fatal: (msg, extra) => emit("FATAL", msg, extra),
		exception: (msg, err, extra) => emit("ERROR", msg, extra, err),
		record: emit,
	};
}

const CONSOLE_LEVELS: Record<string, LogLevel> = {
	error: "ERROR",
	warn: "WARN",
	log: "INFO",
	info: "INFO",
	debug: "DEBUG",
	trace: "DEBUG",
};

/**
 * Route console.* through the JSON-lines logger (logger "console"), so the
 * framework's own output (Nitro's error handler, srvx's banner, uncaught
 * errors) is JSON lines too. An Error argument goes under `exception.*`, as
 * one line. Returns a function that puts the old methods back.
 */
export function installJsonConsole(target: Console = console): () => void {
	const consoleLog = getLogger("console");
	const methods = target as unknown as Record<string, unknown>;
	const saved = new Map<string, unknown>();
	for (const [method, level] of Object.entries(CONSOLE_LEVELS)) {
		saved.set(method, methods[method]);
		methods[method] = (...args: unknown[]) => {
			const err = args.find((arg) => arg instanceof Error);
			const rest = args.filter((arg) => arg !== err);
			const msg = rest.length > 0 ? format(...rest) : err ? String(err) : "";
			consoleLog.record(level, msg, undefined, err);
		};
	}
	return () => {
		for (const [method, fn] of saved) methods[method] = fn;
	};
}
