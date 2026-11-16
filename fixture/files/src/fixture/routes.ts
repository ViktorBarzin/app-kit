/**
 * The fixture's routes for Cloud's parity suite, as one Request -> Response
 * function with its effects passed in (nitro-handler.ts wires the real ones;
 * routes.test.ts fakes them). FIXTURE.md lists every route.
 */
import { createHash } from "node:crypto";

import {
	fetchAllowed,
	hashedName,
	ownOrigins,
	slowSeconds,
	tcpAllowed,
} from "./guard";

/** The exit code /crash exits with. */
export const CRASH_EXIT_CODE = 42;

/**
 * /tcp gives up after this long: well under the 10 s in which Cloud's SMTP
 * test wants a blocked port to fail. A blocked port drops the packets, so
 * the attempt only ends at this timeout; through the public edge a probe
 * of a blocked port has been seen to take twice as long as the attempt, so
 * 4 s keeps the whole call under 10 s. An allowed port connects in ms.
 */
export const TCP_TIMEOUT_MS = 4_000;

/** /fetch gives up after this long. */
export const FETCH_TIMEOUT_MS = 10_000;

/** /sse ends its stream after this long. */
export const SSE_MAX_MS = 15 * 60_000;

/** The most lines one /log call writes. */
export const LOG_MAX_LINES = 200;

export const NOT_IN_THIS_BATCH = {
	error: {
		code: "not_in_this_batch",
		message:
			"this fixture route comes with a later batch of Cloud's parity work",
	},
} as const;

export interface ItemRow {
	id: string;
	title: string;
	createdAt: string;
}

export interface FixtureDeps {
	env: Record<string, string | undefined>;
	bootTime: Date;
	exit: (code: number) => void;
	/** Runs `run` after the answer is on its way. */
	later: (run: () => void) => void;
	sleep: (ms: number) => Promise<void>;
	/** Lifts the server's idle timeout for a long request or a stream. */
	keepOpen: (request: Request) => void;
	/** Null when the App has no database. */
	writeItem: ((title: string) => Promise<ItemRow>) | null;
	readItem: ((id: string) => Promise<ItemRow | null>) | null;
	deleteItem: ((id: string) => Promise<boolean>) | null;
	/** Writes one line to the App's log. */
	log: (line: string) => void;
	/** How long /sse streams; SSE_MAX_MS unless a test sets it. */
	sseLimitMs?: number;
	connect: (
		host: string,
		port: number,
		timeoutMs: number,
	) => Promise<{ connected: boolean; error: string | null }>;
	fetch: (url: URL, init: RequestInit) => Promise<Response>;
	/** Allocates memory until the kernel kills the process. */
	allocate: () => void;
	/** The client build's JS files, as URL paths. */
	assets: () => Promise<string[]>;
}

interface FixtureState {
	healthy: boolean;
}

/**
 * Process state on globalThis: a Start server built by Nitro may bundle a
 * module twice, and /unhealthy must flip the /healthz every bundle answers.
 */
export function fixtureState(): FixtureState {
	const key = Symbol.for("app-template-fixture:state");
	const holder = globalThis as unknown as Record<
		symbol,
		FixtureState | undefined
	>;
	let state = holder[key];
	if (!state) {
		state = { healthy: true };
		holder[key] = state;
	}
	return state;
}

const sha256 = (value: string) =>
	createHash("sha256").update(value).digest("hex");

const json = (body: unknown, status = 200) =>
	Response.json(body, {
		status,
		headers: { "cache-control": "no-store" },
	});

const fail = (status: number, code: string, message: string) =>
	json({ error: { code, message } }, status);

/**
 * Every env name; the SHA-256 of a value only for the names hashedName
 * allows (null for the rest), and the names whose value is empty.
 */
function info(deps: FixtureDeps): Response {
	const env: Record<string, string | null> = {};
	const empty: string[] = [];
	for (const name of Object.keys(deps.env).sort()) {
		const value = deps.env[name];
		if (value === undefined) continue;
		env[name] = hashedName(name) ? sha256(value) : null;
		if (value === "") empty.push(name);
	}
	return json({
		bootTime: deps.bootTime.toISOString(),
		serviceVersion: deps.env.SERVICE_VERSION ?? null,
		instanceId: deps.env.CLOUD_INSTANCE_ID ?? null,
		pid: process.pid,
		env,
		empty,
	});
}

/** The kind of a network failure, with no address or host in it. */
export function genericError(message: string): string {
	if (/timed? ?out|timeout|no connection within|abort/i.test(message))
		return "timeout";
	if (/ECONNREFUSED|refused/i.test(message)) return "refused";
	if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|DNS/i.test(message)) return "dns";
	if (/EHOSTUNREACH|ENETUNREACH|unreachable/i.test(message))
		return "unreachable";
	if (/ECONNRESET|reset/i.test(message)) return "reset";
	return "error";
}

const messageOf = (err: unknown) =>
	err instanceof Error ? `${err.name} ${err.message}` : String(err);

async function items(deps: FixtureDeps): Promise<Response> {
	if (!deps.writeItem || !deps.readItem || !deps.deleteItem)
		return fail(503, "no_database", "the App has no DATABASE_URL");
	const wrote = await deps.writeItem(`fixture ${new Date().toISOString()}`);
	const read = await deps.readItem(wrote.id);
	if (!read)
		return fail(
			500,
			"not_read_back",
			`row ${wrote.id} was not found after the write`,
		);
	// The row goes again, so repeated calls leave the table as it was.
	const deleted = await deps.deleteItem(wrote.id);
	return json({ wrote, read, deleted });
}

function log(deps: FixtureDeps, url: URL): Response {
	const n = slowSeconds(url.searchParams.get("n"));
	const tag = url.searchParams.get("tag") ?? "";
	if (n === null || !/^[a-z0-9-]{1,40}$/.test(tag))
		return fail(
			400,
			"bad_log_request",
			"n must be a whole number and tag 1-40 of a-z, 0-9 and -",
		);
	const count = Math.min(n, LOG_MAX_LINES);
	for (let i = 1; i <= count; i++) deps.log(`fixture-log ${tag} ${i}`);
	return json({ logged: count, tag });
}

function sse(request: Request, deps: FixtureDeps, url: URL): Response {
	const every = slowSeconds(url.searchParams.get("every")) ?? 5;
	const everyMs = Math.max(1, every) * 1000;
	deps.keepOpen(request);
	const encoder = new TextEncoder();
	let timer: ReturnType<typeof setInterval> | undefined;
	let limit: ReturnType<typeof setTimeout> | undefined;
	let n = 0;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const end = () => {
				clearInterval(timer);
				clearTimeout(limit);
				try {
					controller.close();
				} catch {
					// already closed
				}
			};
			const send = () => {
				n += 1;
				try {
					controller.enqueue(
						encoder.encode(
							`data: ${JSON.stringify({ n, at: new Date().toISOString() })}\n\n`,
						),
					);
				} catch {
					clearInterval(timer);
				}
			};
			send();
			timer = setInterval(send, everyMs);
			limit = setTimeout(end, deps.sseLimitMs ?? SSE_MAX_MS);
			request.signal.addEventListener("abort", end);
		},
		cancel() {
			clearInterval(timer);
			clearTimeout(limit);
		},
	});
	return new Response(stream, {
		headers: {
			"content-type": "text/event-stream",
			"cache-control": "no-store",
			"x-accel-buffering": "no",
		},
	});
}

async function egressIp(deps: FixtureDeps): Promise<Response> {
	const sources = ["https://api.ipify.org", "https://icanhazip.com"];
	const errors: string[] = [];
	for (const source of sources) {
		try {
			const answer = await deps.fetch(new URL(source), {
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});
			const ip = (await answer.text()).trim();
			if (answer.ok && /^[0-9a-f.:]{3,45}$/i.test(ip))
				return json({ ip, source });
			errors.push(`${new URL(source).host}: HTTP ${answer.status}`);
		} catch (err) {
			errors.push(`${new URL(source).host}: ${genericError(messageOf(err))}`);
		}
	}
	return fail(502, "no_answer", errors.join("; "));
}

async function tcp(deps: FixtureDeps, url: URL): Promise<Response> {
	const allowed = tcpAllowed(
		url.searchParams.get("host") ?? "",
		url.searchParams.get("port") ?? "",
	);
	if (!allowed.ok) return fail(400, "not_allowed", allowed.reason);
	const started = performance.now();
	const result = await deps.connect(allowed.host, allowed.port, TCP_TIMEOUT_MS);
	return json({
		host: allowed.host,
		port: allowed.port,
		connected: result.connected,
		error: result.error === null ? null : genericError(result.error),
		ms: Math.round(performance.now() - started),
	});
}

async function fetchStatus(deps: FixtureDeps, url: URL): Promise<Response> {
	const allowed = fetchAllowed(
		url.searchParams.get("url") ?? "",
		ownOrigins(deps.env),
	);
	if (!allowed.ok) return fail(400, "not_allowed", allowed.reason);
	const started = performance.now();
	try {
		const answer = await deps.fetch(allowed.url, {
			redirect: "manual",
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		await answer.body?.cancel();
		return json({
			url: allowed.url.href,
			connected: true,
			status: answer.status,
			error: null,
			ms: Math.round(performance.now() - started),
		});
	} catch (err) {
		return json({
			url: allowed.url.href,
			connected: false,
			status: null,
			error: genericError(messageOf(err)),
			ms: Math.round(performance.now() - started),
		});
	}
}

const LATER = [
	/^\/enqueue$/,
	/^\/kv-selftest$/,
	/^\/upload$/,
	/^\/files\/[^/]+$/,
	/^\/probe\/(pg|kv|s3)$/,
];

/**
 * Whether /healthz answers 200: the template's /healthz route asks this
 * (the fixture variant edits it), so the probe keeps the template's
 * metrics and headers.
 */
export function fixtureHealthy(failsAtBoot: boolean): boolean {
	return fixtureState().healthy && !failsAtBoot;
}

/** Every fixture route; 404 for a path the fixture does not own. */
export async function handleFixture(
	request: Request,
	deps: FixtureDeps,
): Promise<Response> {
	const url = new URL(request.url);
	const state = fixtureState();
	switch (url.pathname) {
		case "/info":
			return info(deps);
		case "/items":
			return items(deps);
		case "/unhealthy":
			state.healthy = false;
			return json({ healthy: false });
		case "/healthy":
			state.healthy = true;
			return json({ healthy: true });
		case "/crash":
			deps.later(() => deps.exit(CRASH_EXIT_CODE));
			return json({ exiting: CRASH_EXIT_CODE }, 202);
		case "/oom":
			deps.later(() => deps.allocate());
			return json({ allocating: true }, 202);
		case "/slow": {
			const seconds = slowSeconds(url.searchParams.get("s"));
			if (seconds === null)
				return fail(400, "bad_seconds", "s must be a whole number of seconds");
			deps.keepOpen(request);
			await deps.sleep(seconds * 1000);
			return json({ slept: seconds });
		}
		case "/sse":
			return sse(request, deps, url);
		case "/egress-ip":
			return egressIp(deps);
		case "/tcp":
			return tcp(deps, url);
		case "/fetch":
			return fetchStatus(deps, url);
		case "/log":
			return log(deps, url);
		case "/build-assets":
			return json({ assets: await deps.assets() });
	}
	if (LATER.some((pattern) => pattern.test(url.pathname)))
		return json(NOT_IN_THIS_BATCH, 501);
	return fail(404, "not_found", `${url.pathname} is not a fixture route`);
}
