/**
 * Browser telemetry: the Rybbit script (pageviews, session replay), the
 * Segment browser SDK for product events, and optionally Sentry for errors,
 * all through the app's own host. Nothing loads off a production host.
 *
 * `initTelemetry` once at start; then `track`, `identify` and `reset`
 * anywhere. Calls made before `initTelemetry` are dropped.
 */
import type { EventProperties } from "../index.js";
import {
	type BrowserRuntime,
	type BrowserTelemetry,
	type BrowserTelemetryConfig,
	createBrowserTelemetry,
	type RybbitLike,
} from "./core.js";

export type {
	BrowserTelemetry,
	BrowserTelemetryConfig,
	SentryBrowserLike,
} from "./core.js";
export { rybbitScriptAttributes, segmentLoadArgs } from "./core.js";

function domRuntime(): BrowserRuntime {
	return {
		hostname: window.location.hostname,
		host: window.location.host,
		injectScript(attributes, onLoad) {
			const script = document.createElement("script");
			for (const [name, value] of Object.entries(attributes))
				script.setAttribute(name, value);
			script.addEventListener("load", onLoad, { once: true });
			document.head.appendChild(script);
		},
		rybbit() {
			const holder = window as unknown as { rybbit?: RybbitLike };
			return holder.rybbit;
		},
		async loadSegment(args) {
			const { AnalyticsBrowser } = await import("@segment/analytics-next");
			// AnalyticsBrowser is a thenable; returning it from an async
			// function would await it, so wrap the calls in a plain object.
			const analytics = AnalyticsBrowser.load(...args);
			return {
				track: (name, properties) =>
					analytics.track(name, properties).catch(() => undefined),
				identify: (id, traits) =>
					analytics.identify(id, traits).catch(() => undefined),
				reset: () => analytics.reset().catch(() => undefined),
			};
		},
		warn: (message) => console.warn(message),
	};
}

const SLOT = Symbol.for("@viktorbarzin:telemetry-browser");

function current(): BrowserTelemetry | undefined {
	return (
		globalThis as unknown as Record<symbol, BrowserTelemetry | undefined>
	)[SLOT];
}

/**
 * Start telemetry for this page. A second call returns the first instance,
 * so React's double effects and remounts are harmless.
 */
export function initTelemetry(
	config: BrowserTelemetryConfig,
): BrowserTelemetry {
	const existing = current();
	if (existing) return existing;
	const telemetry = createBrowserTelemetry(config, domRuntime());
	(globalThis as unknown as Record<symbol, BrowserTelemetry>)[SLOT] = telemetry;
	return telemetry;
}

/** A product event, e.g. `track("recording.started", { channel_id: 4 })`. */
export function track(name: string, properties?: EventProperties): void {
	current()?.track(name, properties);
}

/** The signed-in person, by their OIDC `sub`. */
export function identify(
	personId: string,
	traits?: Record<string, unknown>,
): void {
	current()?.identify(personId, traits);
}

/** Forget the person, on sign-out. */
export function reset(): void {
	current()?.reset();
}
