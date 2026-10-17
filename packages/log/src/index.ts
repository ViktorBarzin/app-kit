/**
 * JSON-lines logging, the platform's log contract: one JSON object per line
 * on stderr with `ts` (Python isoformat, `+00:00`), `level`, `logger`, `msg`,
 * then the extras passed at the call site, then `exc` for an error. Extras
 * never overwrite the four standard keys. Loki and the dashboards parse this
 * shape.
 *
 * The sink and threshold are one per process, kept on globalThis: a server
 * bundled twice (Nitro's entry plus Start's SSR graph) still has one of each.
 * The initial threshold comes from LOG_LEVEL, the only variable read here.
 */
import { format } from "node:util";

export type LogLevel = "DEBUG" | "INFO" | "WARNING" | "ERROR";
export type LogExtra = Record<string, unknown>;
export type LogSink = (line: string) => void;

const LEVEL_RANK: Record<LogLevel, number> = {
	DEBUG: 10,
	INFO: 20,
	WARNING: 30,
	ERROR: 40,
};

/** `WARN` means WARNING; anything unknown or unset is INFO. */
export function parseLogLevel(raw: string | undefined): LogLevel {
	const upper = (raw ?? "").trim().toUpperCase();
	if (upper === "WARN") return "WARNING";
	return upper in LEVEL_RANK ? (upper as LogLevel) : "INFO";
}

interface LogState {
	sink: LogSink;
	threshold: number;
}

function state(): LogState {
	const store = globalThis as unknown as Record<symbol, LogState | undefined>;
	const slot = Symbol.for("@viktorbarzin:log");
	let found = store[slot];
	if (found === undefined) {
		found = {
			sink: (line) => {
				process.stderr.write(`${line}\n`);
			},
			threshold: LEVEL_RANK[parseLogLevel(process.env.LOG_LEVEL)],
		};
		store[slot] = found;
	}
	return found;
}

/** Python's `datetime.isoformat()` for an aware UTC datetime: `...T04:05:06.789000+00:00`. */
export function pythonIsoTimestamp(date: Date): string {
	return date.toISOString().replace("Z", "000+00:00");
}

/** Send lines somewhere other than stderr (tests). Returns a restore function. */
export function setLogSink(sink: LogSink): () => void {
	const current = state();
	const previous = current.sink;
	current.sink = sink;
	return () => {
		current.sink = previous;
	};
}

export function setLogLevel(level: LogLevel): void {
	state().threshold = LEVEL_RANK[level];
}

function jsonReplacer(_key: string, value: unknown): unknown {
	// Python's json.dumps(default=str) stringifies what JSON cannot carry.
	if (typeof value === "bigint") return value.toString();
	if (value instanceof Error) return String(value);
	return value;
}

function formatError(err: unknown): string {
	if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
	return String(err);
}

export function formatRecord(
	level: LogLevel,
	logger: string,
	msg: string,
	extra?: LogExtra,
	err?: unknown,
	now: Date = new Date(),
): string {
	const payload: Record<string, unknown> = {
		ts: pythonIsoTimestamp(now),
		level,
		logger,
		msg,
	};
	if (extra) {
		for (const [key, value] of Object.entries(extra)) {
			if (!(key in payload)) payload[key] = value;
		}
	}
	if (err !== undefined) payload.exc = formatError(err);
	return JSON.stringify(payload, jsonReplacer);
}

export interface Logger {
	debug(msg: string, extra?: LogExtra): void;
	info(msg: string, extra?: LogExtra): void;
	warning(msg: string, extra?: LogExtra): void;
	error(msg: string, extra?: LogExtra): void;
	/** ERROR with the error's stack under `exc`, like Python's logger.exception. */
	exception(msg: string, err: unknown, extra?: LogExtra): void;
	/** Any level, with an optional error under `exc`. */
	record(level: LogLevel, msg: string, extra?: LogExtra, err?: unknown): void;
}

export function getLogger(name: string): Logger {
	const emit = (
		level: LogLevel,
		msg: string,
		extra?: LogExtra,
		err?: unknown,
	) => {
		const current = state();
		if (LEVEL_RANK[level] < current.threshold) return;
		current.sink(formatRecord(level, name, msg, extra, err));
	};
	return {
		debug: (msg, extra) => emit("DEBUG", msg, extra),
		info: (msg, extra) => emit("INFO", msg, extra),
		warning: (msg, extra) => emit("WARNING", msg, extra),
		error: (msg, extra) => emit("ERROR", msg, extra),
		exception: (msg, err, extra) => emit("ERROR", msg, extra, err),
		record: emit,
	};
}

const CONSOLE_LEVELS: Record<string, LogLevel> = {
	error: "ERROR",
	warn: "WARNING",
	log: "INFO",
	info: "INFO",
	debug: "DEBUG",
	trace: "DEBUG",
};

/**
 * Route console.* through the JSON-lines logger (logger "console"), so the
 * framework's own output (Nitro's error handler, srvx's banner, uncaught
 * errors) is JSON lines too. An Error argument goes under `exc` with its
 * stack, as one line. Returns a function that puts the old methods back.
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
