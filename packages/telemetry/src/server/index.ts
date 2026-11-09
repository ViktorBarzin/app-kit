/**
 * Server telemetry for Bun and Node: product events through the Segment
 * Node SDK to the event pipeline, and optionally Sentry for errors.
 *
 * `initServerTelemetry` once at boot; then `track` and `identify` anywhere;
 * `closeAndFlush` on shutdown. The client is one per process (kept on
 * globalThis), so a server bundled twice still has one queue.
 */
import { Analytics } from "@segment/analytics-node";

import { checkEvent, type EventProperties } from "../index.js";

/** The parts of `@sentry/bun` (or `@sentry/node`) this package calls. Pass the module itself. */
export interface SentryServerLike {
	init(options: { dsn: string; release: string; environment: string }): unknown;
	flush(timeout?: number): PromiseLike<boolean>;
}

export interface ServerTelemetryConfig {
	/** The app's write key for the event pipeline. */
	writeKey: string;
	/** The event pipeline's origin, e.g. `http://pipeline.namespace.svc.cluster.local`. */
	host: string;
	/**
	 * The batch path on `host`. Default `/v1/batch`. A path prefix belongs
	 * here, not in `host`: the URL is resolved as `new URL(path, host)`.
	 */
	path?: string | undefined;
	/** The app's release, e.g. the image tag. Sent as `context.app.version`. */
	release: string;
	/** The app's name, sent as `context.app.name`. */
	service?: string | undefined;
	/** Sentry's environment. Default `production`. */
	environment?: string | undefined;
	/** Send events. Default true; false still checks them. */
	enabled?: boolean | undefined;
	/** Messages per request. Default 15 (the SDK's). */
	flushAt?: number | undefined;
	/** Milliseconds before a partial batch is sent. Default 10000 (the SDK's). */
	flushInterval?: number | undefined;
	/** A Sentry DSN; errors are reported only when this and `sentry` are given. */
	dsn?: string | undefined;
	/** The `@sentry/bun` module (`import * as Sentry from "@sentry/bun"`). */
	sentry?: SentryServerLike | undefined;
	/** Where problems with events and delivery go. Default `console.warn`. */
	warn?: ((message: string) => void) | undefined;
}

/** Who the event is about: the person's `sub`, an anonymous id, or both. */
export type Identity =
	| { userId: string; anonymousId?: string | undefined }
	| { userId?: string | undefined; anonymousId: string };

export type TrackParams = {
	event: string;
	properties?: EventProperties | undefined;
} & Identity;

export type IdentifyParams = {
	traits?: Record<string, unknown> | undefined;
} & Identity;

export interface ServerTelemetry {
	readonly active: boolean;
	/** A product event: `noun.past_verb` and snake_case property keys. */
	track(params: TrackParams): void;
	identify(params: IdentifyParams): void;
	/** Send what is queued now. */
	flush(): Promise<void>;
	/** Send what is queued and stop; for shutdown. Waits at most `timeoutMs`. */
	closeAndFlush(timeoutMs?: number): Promise<void>;
}

export function createServerTelemetry(
	config: ServerTelemetryConfig,
): ServerTelemetry {
	const warn = config.warn ?? ((message: string) => console.warn(message));
	const active = config.enabled ?? true;
	const app = {
		...(config.service ? { name: config.service } : {}),
		version: config.release,
	};

	const analytics = active
		? new Analytics({
				writeKey: config.writeKey,
				host: config.host,
				path: config.path ?? "/v1/batch",
				...(config.flushAt !== undefined ? { flushAt: config.flushAt } : {}),
				...(config.flushInterval !== undefined
					? { flushInterval: config.flushInterval }
					: {}),
			})
		: null;
	analytics?.on("error", (err) => {
		warn(`telemetry: delivery failed: ${String(err.reason ?? err.code)}`);
	});

	const sentry = active && config.dsn && config.sentry ? config.sentry : null;
	sentry?.init({
		dsn: config.dsn ?? "",
		release: config.release,
		environment: config.environment ?? "production",
	});

	return {
		active,
		track(params) {
			const result = checkEvent(params.event, params.properties);
			for (const problem of result.problems) warn(`telemetry: ${problem}`);
			if (!analytics || !result.accepted) return;
			analytics.track({
				...identity(params),
				event: result.accepted.event,
				properties: result.accepted.properties,
				context: { app },
			});
		},
		identify(params) {
			analytics?.identify({
				...identity(params),
				...(params.traits ? { traits: params.traits } : {}),
				context: { app },
			});
		},
		async flush() {
			await analytics?.flush();
		},
		async closeAndFlush(timeoutMs = 5000) {
			await Promise.all([
				analytics?.closeAndFlush({ timeout: timeoutMs }),
				sentry?.flush(timeoutMs),
			]);
		},
	};
}

/** Only the ids that are set: the SDK refuses a message with neither. */
function identity({ userId, anonymousId }: Identity): Identity {
	if (userId !== undefined)
		return anonymousId !== undefined ? { userId, anonymousId } : { userId };
	if (anonymousId !== undefined) return { anonymousId };
	throw new Error("telemetry: a message needs userId or anonymousId");
}

const SLOT = Symbol.for("@viktorbarzin:telemetry-server");

function slot(): Record<symbol, ServerTelemetry | undefined> {
	return globalThis as unknown as Record<symbol, ServerTelemetry | undefined>;
}

/** Start the process's client. A second call returns the first one. */
export function initServerTelemetry(
	config: ServerTelemetryConfig,
): ServerTelemetry {
	const existing = slot()[SLOT];
	if (existing) return existing;
	const telemetry = createServerTelemetry(config);
	slot()[SLOT] = telemetry;
	return telemetry;
}

/** A product event through the process's client; dropped before `initServerTelemetry`. */
export function track(params: TrackParams): void {
	slot()[SLOT]?.track(params);
}

export function identify(params: IdentifyParams): void {
	slot()[SLOT]?.identify(params);
}

export async function flush(): Promise<void> {
	await slot()[SLOT]?.flush();
}

/** Send what is queued and drop the process's client; for shutdown. */
export async function closeAndFlush(timeoutMs?: number): Promise<void> {
	const telemetry = slot()[SLOT];
	slot()[SLOT] = undefined;
	await telemetry?.closeAndFlush(timeoutMs);
}
