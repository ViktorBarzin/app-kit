/**
 * Process lifecycle for a Bun server:
 *
 * - every request may stay idle for REQUEST_IDLE_TIMEOUT_S, not Bun's default
 *   10 s, so a slow upstream answer reaches the client instead of an empty
 *   reply; a stream lifts the limit entirely (keepRequestOpen);
 * - in-flight requests are counted, so shutdown can let them finish;
 * - SIGTERM/SIGINT run the app's shutdown steps, then exit, instead of
 *   waiting for Kubernetes' SIGKILL.
 */
import { getLogger, type Logger } from "@viktorbarzin/log";

import { processSingleton } from "./singleton.js";

/** Longest a request may go without sending or receiving a byte. Bun's maximum is 255. */
export const REQUEST_IDLE_TIMEOUT_S = 120;

/** How long shutdown waits for in-flight requests by default. */
export const SHUTDOWN_DRAIN_MS = 5_000;

interface BunServerHandle {
	timeout(request: Request, seconds: number): void;
}
type BunRuntimeRequest = Request & {
	runtime?: { bun?: { server?: Partial<BunServerHandle> } };
};

function bunServer(request: Request): BunServerHandle | null {
	const server = (request as BunRuntimeRequest).runtime?.bun?.server;
	return typeof server?.timeout === "function"
		? (server as BunServerHandle)
		: null;
}

/**
 * Raise Bun's per-request idle timeout for this request (srvx exposes Bun's
 * server as `request.runtime.bun.server`). Returns false when the request did
 * not come through Bun.serve (tests, dev).
 */
export function extendIdleTimeout(
	request: Request,
	seconds: number = REQUEST_IDLE_TIMEOUT_S,
): boolean {
	const server = bunServer(request);
	if (!server) return false;
	server.timeout(request, seconds);
	return true;
}

/**
 * No idle timeout for this request (Bun's `server.timeout(request, 0)`), for
 * an SSE stream whose heartbeat is longer than Bun's 10 s default.
 */
export function keepRequestOpen(request: Request): boolean {
	return extendIdleTimeout(request, 0);
}

const requests = processSingleton("runtime.requests", () => ({
	inFlight: 0,
	drained: new Set<() => void>(),
}));

/** Count a request as in flight; call the returned function when it is answered. */
export function trackRequest(): () => void {
	requests.inFlight += 1;
	let done = false;
	return () => {
		if (done) return;
		done = true;
		requests.inFlight -= 1;
		if (requests.inFlight === 0)
			for (const resolve of [...requests.drained]) resolve();
	};
}

export function requestsInFlight(): number {
	return requests.inFlight;
}

/** Resolves when no request is in flight, or after `timeoutMs`. */
export function waitForDrain(timeoutMs: number): Promise<void> {
	if (requests.inFlight === 0) return Promise.resolve();
	return new Promise((resolve) => {
		const finish = () => {
			clearTimeout(timer);
			requests.drained.delete(finish);
			resolve();
		};
		const timer = setTimeout(finish, timeoutMs);
		requests.drained.add(finish);
	});
}

export interface ShutdownStep {
	name: string;
	run(): Promise<void> | void;
}

export interface ShutdownOptions {
	/** Runs first: close what would hold the server open (SSE streams, LISTEN). */
	beforeDrain: ShutdownStep[];
	/** Runs after in-flight requests finish: the metrics listener, the pool. */
	afterDrain: ShutdownStep[];
	drainMs: number;
	exit(code: number): void;
	logger?: Logger;
}

async function runSteps(steps: ShutdownStep[], log: Logger): Promise<void> {
	for (const step of steps) {
		try {
			await step.run();
		} catch (err) {
			log.exception("shutdown step failed", err, { step: step.name });
		}
	}
}

/**
 * The shutdown sequence: beforeDrain steps, wait for in-flight requests (at
 * most drainMs), afterDrain steps, exit(0). A failing step is logged and the
 * rest still run.
 */
export async function shutdown(
	signal: string,
	opts: ShutdownOptions,
): Promise<void> {
	const log = opts.logger ?? getLogger("runtime.lifecycle");
	log.info("shutting down", { signal, in_flight: requestsInFlight() });
	try {
		await runSteps(opts.beforeDrain, log);
		await waitForDrain(opts.drainMs);
		await runSteps(opts.afterDrain, log);
	} finally {
		opts.exit(0);
	}
}

const shutdownState = processSingleton("runtime.shutdown", () => ({
	installed: false,
	shuttingDown: false,
}));

/** Register the SIGTERM/SIGINT handler, once per process. */
export function installShutdown(opts: {
	beforeDrain: ShutdownStep[];
	afterDrain: ShutdownStep[];
	drainMs?: number;
	logger?: Logger;
}): void {
	if (shutdownState.installed) return;
	shutdownState.installed = true;
	const onSignal = (signal: NodeJS.Signals) => {
		if (shutdownState.shuttingDown) return;
		shutdownState.shuttingDown = true;
		void shutdown(signal, {
			beforeDrain: opts.beforeDrain,
			afterDrain: opts.afterDrain,
			drainMs: opts.drainMs ?? SHUTDOWN_DRAIN_MS,
			exit: (code) => process.exit(code),
			...(opts.logger ? { logger: opts.logger } : {}),
		});
	};
	process.once("SIGTERM", onSignal);
	process.once("SIGINT", onSignal);
}
