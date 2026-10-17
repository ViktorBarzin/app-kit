/**
 * Prometheus metrics for an app: one prom-client registry per process (with
 * the default process metrics), the HTTP request metrics every app exports,
 * and /metrics on its own port, which the ingress never routes. The pod's
 * `prometheus.io/*` annotations point at that port.
 *
 * App-specific metrics are registered by the app on getRegistry().
 */
import { getLogger, type Logger } from "@viktorbarzin/log";
import {
	extendIdleTimeout,
	processSingleton,
	trackRequest,
} from "@viktorbarzin/runtime";
import client, {
	type Counter,
	type Histogram,
	type Registry,
} from "prom-client";

const log = getLogger("metrics");

/** The process registry, created once with the default metrics. */
export function getRegistry(): Registry {
	return processSingleton("metrics.registry", () => {
		const registry = new client.Registry();
		client.collectDefaultMetrics({ register: registry });
		return registry;
	});
}

export interface HttpMetrics {
	requestsTotal: Counter<"method" | "handler" | "status">;
	requestDuration: Histogram<"method" | "handler">;
}

export const HTTP_DURATION_BUCKETS = [
	0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

/** http_requests_total and http_request_duration_seconds on the process registry. */
export function httpMetrics(): HttpMetrics {
	return processSingleton("metrics.http", () => {
		const registry = getRegistry();
		return {
			requestsTotal: new client.Counter({
				name: "http_requests_total",
				help: "HTTP requests handled by the app server.",
				labelNames: ["method", "handler", "status"] as const,
				registers: [registry],
			}),
			requestDuration: new client.Histogram({
				name: "http_request_duration_seconds",
				help: "HTTP request latency in seconds.",
				labelNames: ["method", "handler"] as const,
				buckets: HTTP_DURATION_BUCKETS,
				registers: [registry],
			}),
		};
	});
}

export const DEFAULT_HANDLER_BUCKETS: ReadonlyArray<
	readonly [prefix: string, label: string]
> = [
	["/api/auth/", "/api/auth"],
	["/api/", "/api/other"],
	["/_serverFn/", "/_serverFn"],
];

/**
 * The `handler` label: known paths by name, everything else folded into a few
 * prefix buckets (first match wins) or "page", so the label set stays small.
 */
export function createHandlerLabeler(opts: {
	known: readonly string[];
	buckets?: ReadonlyArray<readonly [prefix: string, label: string]>;
}): (pathname: string) => string {
	const known = new Set(opts.known);
	const buckets = opts.buckets ?? DEFAULT_HANDLER_BUCKETS;
	return (pathname) => {
		if (known.has(pathname)) return pathname;
		for (const [prefix, label] of buckets)
			if (pathname.startsWith(prefix)) return label;
		return "page";
	};
}

/**
 * Start observing one request: raises Bun's idle timeout, counts it as in
 * flight, and returns a function to call with the final status. That records
 * the counter (status as "2xx" etc.), the histogram and, for paths under
 * `accessLogPrefix`, one access-log line {method, path, status, duration_ms}.
 */
export function observeRequest(
	request: Request,
	opts: {
		label: (pathname: string) => string;
		accessLog?: Logger;
		accessLogPrefix?: string;
	},
): (status: number) => void {
	extendIdleTimeout(request);
	const untrack = trackRequest();
	const started = performance.now();
	const { pathname } = new URL(request.url);
	const prefix = opts.accessLogPrefix ?? "/api/";
	let recorded = false;
	return (status) => {
		if (recorded) return;
		recorded = true;
		untrack();
		const seconds = (performance.now() - started) / 1000;
		const handler = opts.label(pathname);
		const metrics = httpMetrics();
		metrics.requestsTotal.inc({
			method: request.method,
			handler,
			status: `${Math.floor(status / 100)}xx`,
		});
		metrics.requestDuration.observe(
			{ method: request.method, handler },
			seconds,
		);
		if (opts.accessLog && pathname.startsWith(prefix)) {
			opts.accessLog.info("request", {
				method: request.method,
				path: pathname,
				status,
				duration_ms: Math.round(seconds * 1000),
			});
		}
	};
}

export async function metricsResponse(
	registry: Registry = getRegistry(),
): Promise<Response> {
	return new Response(await registry.metrics(), {
		headers: { "content-type": registry.contentType },
	});
}

/** METRICS_PORT as a port number; null when unset or not a port (logged as ERROR). */
export function parseMetricsPort(raw: string | undefined): number | null {
	if (raw === undefined || raw.trim() === "") return null;
	const port = Number(raw);
	if (!Number.isInteger(port) || port < 0 || port > 65_535) {
		log.error("METRICS_PORT is not a port; metrics are not served", {
			value: raw,
		});
		return null;
	}
	return port;
}

export interface MetricsServer {
	port: number;
	stop(): void;
}

/** Serve /metrics (and nothing else) on its own Bun listener; null without a port. */
export function startMetricsServer(opts: {
	port: number | null;
	hostname?: string;
	registry?: Registry;
}): MetricsServer | null {
	if (opts.port === null) return null;
	const registry = opts.registry ?? getRegistry();
	try {
		const server = Bun.serve({
			hostname: opts.hostname ?? "0.0.0.0",
			port: opts.port,
			fetch: (request) =>
				new URL(request.url).pathname === "/metrics"
					? metricsResponse(registry)
					: new Response("not found\n", { status: 404 }),
		});
		log.info("metrics listening", { port: server.port });
		return {
			port: server.port as number,
			stop: () => void server.stop(true),
		};
	} catch (err) {
		log.exception("metrics server failed to start", err, { port: opts.port });
		return null;
	}
}
