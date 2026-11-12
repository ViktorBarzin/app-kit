/**
 * The browser client's logic, with the DOM, the Segment SDK and the Rybbit
 * global behind a small runtime interface so tests can drive it. The public
 * entry point (index.ts) supplies the real runtime.
 */
import type {
	AnalyticsBrowserSettings,
	InitOptions,
} from "@segment/analytics-next";

import {
	checkEvent,
	type EventProperties,
	isProductionHost,
	VISITOR_HEADER,
} from "../index.js";

/** The parts of `@sentry/browser` this package calls. Pass the module itself. */
export interface SentryBrowserLike {
	init(options: { dsn: string; release: string; environment: string }): unknown;
	setUser(user: { id: string } | null): void;
}

export interface BrowserTelemetryConfig {
	/** The app's write key for the event pipeline. */
	writeKey: string;
	/** The Rybbit site id. */
	siteId: string | number;
	/** The app's release, e.g. the image tag; Sentry groups errors by it. */
	release: string;
	/**
	 * Domains whose hosts count as production; each entry matches itself and
	 * its subdomains. On any other host (localhost, previews) nothing loads
	 * and nothing is sent.
	 */
	productionHosts: readonly string[];
	/** Sentry's environment. Default `production`. */
	environment?: string | undefined;
	/** Where the ingest path is mounted on the app's own host. Default `/_t`. */
	ingestPath?: string | undefined;
	/** A Sentry DSN; errors are reported only when this and `sentry` are given. */
	dsn?: string | undefined;
	/** The `@sentry/browser` module (`import * as Sentry from "@sentry/browser"`). */
	sentry?: SentryBrowserLike | undefined;
	/**
	 * The signed-in person's OIDC `sub`, when the page knows it at start.
	 * Every init then identifies them in Segment, Rybbit and Sentry, not only
	 * the page load right after sign-in.
	 */
	personId?: string | undefined;
}

export interface BrowserTelemetry {
	/** True on a production host, where events are sent. */
	readonly active: boolean;
	/** A product event: `noun.past_verb` and snake_case property keys. */
	track(name: string, properties?: EventProperties): void;
	/** The signed-in person (their OIDC `sub`), in Segment, Rybbit and Sentry. */
	identify(personId: string, traits?: Record<string, unknown>): void;
	/** Forget the person, on sign-out. */
	reset(): void;
	/**
	 * `{ "X-Visitor-Id": <Rybbit visitor id> }` for same-origin API calls, so
	 * server events join this browser's person; `{}` until the id exists and
	 * off production.
	 */
	visitorHeaders(): Record<string, string>;
}

/** The parts of the Segment browser client this package calls. */
export interface SegmentLike {
	track(name: string, properties?: EventProperties): unknown;
	identify(id: string, traits?: Record<string, unknown>): unknown;
	reset(): unknown;
	setAnonymousId(id: string): unknown;
}

/** The parts of `window.rybbit` this package calls. */
export interface RybbitLike {
	identify(userId: string, traits?: Record<string, unknown>): void;
	clearUserId(): void;
}

export type SegmentLoadArgs = [AnalyticsBrowserSettings, InitOptions];

export interface BrowserRuntime {
	/** `location.hostname`. */
	hostname: string;
	/** `location.host` (with the port, if any). */
	host: string;
	/**
	 * Add a `<script>` with these attributes; call `onLoad` once it has run,
	 * or `onError` if it cannot load (blocked, offline).
	 */
	injectScript(
		attributes: Record<string, string>,
		onLoad: () => void,
		onError: () => void,
	): void;
	/** `setTimeout(fn, ms)`. */
	after(ms: number, fn: () => void): void;
	/** `window.rybbit`, once the script has defined it. */
	rybbit(): RybbitLike | undefined;
	/** `AnalyticsBrowser.load(...args)`, resolved once it is ready to buffer calls. */
	loadSegment(args: SegmentLoadArgs): Promise<SegmentLike>;
	/** localStorage `rybbit-visitor-id`, which the Rybbit script creates. */
	visitorId(): string | undefined;
	warn(message: string): void;
}

/** How long Segment calls wait for a new visitor's Rybbit id. */
export const VISITOR_ID_WAIT_MS = 5000;

function trimSlashes(path: string): string {
	return `/${path.replace(/^\/+|\/+$/g, "")}`;
}

/**
 * The Rybbit script tag. Session replay itself is switched on per site in
 * Rybbit (the site's `sessionReplay` setting, read by the script from
 * `/site/tracking-config/<id>`); these attributes set how replay masks
 * inputs: only password fields.
 */
export function rybbitScriptAttributes(
	siteId: string,
	ingestPath: string,
): Record<string, string> {
	return {
		src: `${trimSlashes(ingestPath)}/r/script.js`,
		"data-site-id": siteId,
		defer: "",
		"data-replay-mask-all-inputs": "false",
		"data-replay-mask-input-options": '{"password":true}',
	};
}

/**
 * `AnalyticsBrowser.load` arguments with the source settings inline, so the
 * SDK never fetches them from Segment's CDN, sends events to the app's own
 * host, sends no SDK metrics and leaves pageviews to Rybbit.
 */
export function segmentLoadArgs(
	writeKey: string,
	host: string,
	ingestPath: string,
): SegmentLoadArgs {
	const base = `${host}${trimSlashes(ingestPath)}/e`;
	const apiHost = `${base}/v1`;
	return [
		{
			writeKey,
			// Nothing should be fetched from a CDN; if something is, it goes to
			// the app's own host rather than Segment's.
			cdnURL: `https://${base}`,
			cdnSettings: {
				integrations: {
					"Segment.io": { apiKey: writeKey, apiHost, protocol: "https" },
				},
				metrics: { sampleRate: 0 },
			},
		},
		{
			initialPageview: false,
			integrations: { "Segment.io": { apiHost, protocol: "https" } },
		},
	];
}

export function createBrowserTelemetry(
	config: BrowserTelemetryConfig,
	runtime: BrowserRuntime,
): BrowserTelemetry {
	const active = isProductionHost(runtime.hostname, config.productionHosts);
	const ingestPath = config.ingestPath ?? "/_t";

	function check(name: string, properties?: EventProperties) {
		const result = checkEvent(name, properties);
		// Off production these are developer mistakes worth seeing; in
		// production the event is trimmed or dropped without noise.
		if (!active)
			for (const problem of result.problems)
				runtime.warn(`telemetry: ${problem}`);
		return result.accepted;
	}

	if (!active)
		return {
			active,
			track: (name, properties) => void check(name, properties),
			identify: () => {},
			reset: () => {},
			visitorHeaders: () => ({}),
		};

	const sentry = config.dsn && config.sentry ? config.sentry : undefined;
	sentry?.init({
		dsn: config.dsn ?? "",
		release: config.release,
		environment: config.environment ?? "production",
	});

	let scriptLoaded = false;
	const waitingForRybbit: ((rybbit: RybbitLike) => void)[] = [];
	function withRybbit(fn: (rybbit: RybbitLike) => void): void {
		const rybbit = scriptLoaded ? runtime.rybbit() : undefined;
		if (rybbit) fn(rybbit);
		else waitingForRybbit.push(fn);
	}
	// Segment's anonymousId is Rybbit's visitor id, so browser events and
	// pageviews are one person. A returning visitor's id is already stored;
	// a new visitor's is created when the script runs, so Segment calls wait
	// for the script (at most VISITOR_ID_WAIT_MS, or until it fails to load)
	// instead of going out under Segment's own random id.
	let visitorIdSettled: () => void = () => {};
	const visitorIdKnown = new Promise<void>((resolve) => {
		visitorIdSettled = resolve;
	});
	let anonymousId: string | undefined;
	const loaded = runtime.loadSegment(
		segmentLoadArgs(config.writeKey, runtime.host, ingestPath),
	);
	const segment = Promise.all([loaded, visitorIdKnown]).then(([analytics]) => {
		const id = runtime.visitorId();
		if (id) {
			anonymousId = id;
			analytics.setAnonymousId(id);
		}
		return analytics;
	});
	function withSegment(fn: (analytics: SegmentLike) => void): void {
		void segment.then(fn, () => {});
	}
	function adoptVisitorId(): void {
		const id = runtime.visitorId();
		if (!id || id === anonymousId || !anonymousId) return;
		anonymousId = id;
		withSegment((a) => a.setAnonymousId(id));
	}
	if (runtime.visitorId()) visitorIdSettled();
	else runtime.after(VISITOR_ID_WAIT_MS, visitorIdSettled);

	runtime.injectScript(
		rybbitScriptAttributes(String(config.siteId), ingestPath),
		() => {
			scriptLoaded = true;
			visitorIdSettled();
			adoptVisitorId();
			const rybbit = runtime.rybbit();
			if (rybbit) for (const fn of waitingForRybbit.splice(0)) fn(rybbit);
		},
		visitorIdSettled,
	);

	function identify(personId: string, traits?: Record<string, unknown>) {
		withSegment((a) => a.identify(personId, traits));
		withRybbit((r) => r.identify(personId, traits));
		sentry?.setUser({ id: personId });
	}
	if (config.personId) identify(config.personId);

	return {
		active,
		track(name, properties) {
			const accepted = check(name, properties);
			if (accepted)
				withSegment((a) => a.track(accepted.event, accepted.properties));
		},
		identify,
		reset() {
			withSegment((a) => a.reset());
			withRybbit((r) => r.clearUserId());
			sentry?.setUser(null);
		},
		visitorHeaders(): Record<string, string> {
			const id = runtime.visitorId();
			return id ? { [VISITOR_HEADER]: id } : {};
		},
	};
}
