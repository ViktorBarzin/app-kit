import { afterEach, describe, expect, test } from "bun:test";
import { setLogLevel, setLogSink } from "@viktorbarzin/log";
import { requestsInFlight } from "@viktorbarzin/runtime";
import client from "prom-client";

import {
	createHandlerLabeler,
	getRegistry,
	httpMetrics,
	metricsResponse,
	observeRequest,
	parseMetricsPort,
	startMetricsServer,
} from "./index.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const fn of cleanups.splice(0)) fn();
	setLogLevel("WARNING");
});

function captureLogs(): Record<string, unknown>[] {
	const records: Record<string, unknown>[] = [];
	cleanups.push(setLogSink((line) => records.push(JSON.parse(line))));
	setLogLevel("DEBUG");
	return records;
}

describe("getRegistry", () => {
	test("one registry per process, with the default metrics", async () => {
		expect(getRegistry()).toBe(getRegistry());
		expect(await getRegistry().metrics()).toContain(
			"process_cpu_user_seconds_total",
		);
	});

	test("httpMetrics are the platform names, registered once", () => {
		const a = httpMetrics();
		expect(httpMetrics()).toBe(a);
		expect(getRegistry().getSingleMetric("http_requests_total")).toBe(
			a.requestsTotal,
		);
		expect(getRegistry().getSingleMetric("http_request_duration_seconds")).toBe(
			a.requestDuration,
		);
	});
});

describe("createHandlerLabeler", () => {
	test("known paths by name, the rest in the default buckets", () => {
		const label = createHandlerLabeler({ known: ["/api/items", "/healthz"] });
		expect(label("/api/items")).toBe("/api/items");
		expect(label("/healthz")).toBe("/healthz");
		expect(label("/api/auth/callback/x")).toBe("/api/auth");
		expect(label("/api/other/123")).toBe("/api/other");
		expect(label("/_serverFn/abc")).toBe("/_serverFn");
		expect(label("/list/42")).toBe("page");
	});

	test("custom buckets replace the defaults, first match wins", () => {
		const label = createHandlerLabeler({
			known: [],
			buckets: [
				["/api/v2/", "/api/v2"],
				["/api/", "/api/v1"],
			],
		});
		expect(label("/api/v2/x")).toBe("/api/v2");
		expect(label("/api/x")).toBe("/api/v1");
		expect(label("/_serverFn/x")).toBe("page");
	});
});

describe("observeRequest", () => {
	test("records the counter, the histogram and one access-log line for /api", async () => {
		const records = captureLogs();
		const handler = `/api/obs-${crypto.randomUUID()}`;
		const request = new Request(`http://app.invalid${handler}`, {
			method: "POST",
		});
		const done = observeRequest(request, {
			label: createHandlerLabeler({ known: [handler] }),
			accessLog: (await import("@viktorbarzin/log")).getLogger("app.http"),
		});
		expect(requestsInFlight()).toBeGreaterThanOrEqual(1);
		done(201);
		const text = await getRegistry().metrics();
		expect(text).toContain(
			`http_requests_total{method="POST",handler="${handler}",status="2xx"} 1`,
		);
		expect(text).toContain(
			`http_request_duration_seconds_count{method="POST",handler="${handler}"} 1`,
		);
		const line = records.find((r) => r.logger === "app.http");
		expect(line).toMatchObject({
			msg: "request",
			method: "POST",
			path: handler,
			status: 201,
		});
		expect(typeof line?.duration_ms).toBe("number");
	});

	test("no access-log line outside the prefix, and done() is idempotent", async () => {
		const records = captureLogs();
		const before = requestsInFlight();
		const done = observeRequest(new Request("http://app.invalid/page"), {
			label: () => "page",
			accessLog: (await import("@viktorbarzin/log")).getLogger("app.http"),
		});
		done(500);
		done(500);
		expect(requestsInFlight()).toBe(before);
		expect(records.filter((r) => r.logger === "app.http")).toEqual([]);
	});
});

describe("parseMetricsPort", () => {
	test("unset is null; a port is a number; junk is null and logged", () => {
		const records = captureLogs();
		expect(parseMetricsPort(undefined)).toBeNull();
		expect(parseMetricsPort("")).toBeNull();
		expect(parseMetricsPort("9090")).toBe(9090);
		expect(parseMetricsPort("0")).toBe(0);
		expect(parseMetricsPort("70000")).toBeNull();
		expect(parseMetricsPort("abc")).toBeNull();
		expect(records.filter((r) => r.level === "ERROR")).toHaveLength(2);
	});
});

describe("metrics endpoint", () => {
	test("metricsResponse serves a registry in the Prometheus text format", async () => {
		const registry = new client.Registry();
		new client.Counter({
			name: "custom_total",
			help: "x",
			registers: [registry],
		}).inc();
		const res = await metricsResponse(registry);
		expect(res.headers.get("content-type")).toBe(registry.contentType);
		expect(await res.text()).toContain("custom_total 1");
	});

	test("startMetricsServer serves /metrics only, and nothing without a port", async () => {
		expect(startMetricsServer({ port: null })).toBeNull();
		const server = startMetricsServer({ port: 0, hostname: "127.0.0.1" });
		expect(server).not.toBeNull();
		cleanups.push(() => server?.stop());
		const base = `http://127.0.0.1:${server?.port}`;
		const metrics = await fetch(`${base}/metrics`);
		expect(metrics.status).toBe(200);
		expect(await metrics.text()).toContain("process_cpu_user_seconds_total");
		expect((await fetch(`${base}/`)).status).toBe(404);
		expect((await fetch(`${base}/api/x`)).status).toBe(404);
	});
});
