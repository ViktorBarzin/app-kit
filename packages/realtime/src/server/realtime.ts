/**
 * The realtime contract in one object: the pod's LISTEN connection, the SSE
 * hub it feeds, and publishing through `pg_notify` (from the pool, or inside
 * the caller's transaction so the event fires at COMMIT).
 *
 * State is one per process and channel: a server bundled twice still holds
 * one LISTEN connection.
 */
import { getLogger, type Logger } from "@viktorbarzin/log";
import { keepRequestOpen, processSingleton } from "@viktorbarzin/runtime";
import type { SQL } from "bun";
import { type SQLWrapper, sql } from "drizzle-orm";
import type { Registry } from "prom-client";

import { MAX_PAYLOAD_BYTES, type RealtimeEvent } from "./events.js";
import { createSseHub, type SseHub } from "./hub.js";
import { createListener, type Listener, type NotifyFn } from "./listener.js";

export interface RealtimeConfig<E extends { type: string }> {
	/** The NOTIFY channel, one per app, e.g. `<slug>_events`. */
	channel: string;
	/** A client for the LISTEN connection: max 1, idleTimeout 0. */
	createListenClient: () => SQL;
	/** Sends a NOTIFY outside a transaction (pings, publish). poolNotify(getClient) fits. */
	notify: NotifyFn;
	/** Accepts the payloads this app sends; default accepts RealtimeEvent. */
	parseEvent?: (raw: unknown) => E | null;
	registry?: Registry;
	logger?: Logger;
	heartbeatMs?: number;
	retryMs?: number;
	pingIntervalMs?: number;
	pingTimeoutMs?: number;
	backoffMs?: (attempt: number) => number;
}

/** NOTIFY through the app pool: one short query, no extra connection. */
export function poolNotify(client: () => SQL): NotifyFn {
	return async (channel, payload) => {
		await client().notify(channel, payload);
	};
}

export interface Realtime<E extends { type: string }> {
	/** Open the LISTEN connection; resolves on the first LISTEN. Idempotent. */
	start(): Promise<void>;
	/** Close every stream, then the LISTEN connection. */
	stop(): Promise<void>;
	/** An SSE Response for `topic`; the stream ends when the request aborts. */
	subscribe(request: Request, topic: string): Response;
	/** Send an event to `to`'s streams on every pod (null: every stream). Never throws. */
	publish(to: string | null, event: E): Promise<void>;
	/** The same, as `select pg_notify(...)` inside the caller's transaction: it fires at COMMIT. */
	publishInTx(
		tx: { execute(query: SQLWrapper): Promise<unknown> },
		to: string | null,
		event: E,
	): Promise<void>;
	/** Open streams on this pod. */
	size(): number;
}

interface State<E extends { type: string }> {
	hub: SseHub;
	listener: Listener<E>;
	started: Promise<void> | null;
}

export function createRealtime<E extends { type: string } = RealtimeEvent>(
	config: () => RealtimeConfig<E>,
): Realtime<E> {
	const log = (): Logger => config().logger ?? getLogger("realtime");

	function state(): State<E> {
		const cfg = config();
		return processSingleton(`realtime:${cfg.channel}`, () => {
			const hub = createSseHub({
				...(cfg.heartbeatMs ? { heartbeatMs: cfg.heartbeatMs } : {}),
				...(cfg.retryMs ? { retryMs: cfg.retryMs } : {}),
			});
			const listener = createListener<E>(cfg.channel, {
				createClient: cfg.createListenClient,
				notify: cfg.notify,
				...(cfg.parseEvent ? { parseEvent: cfg.parseEvent } : {}),
				...(cfg.registry ? { registry: cfg.registry } : {}),
				...(cfg.logger ? { logger: cfg.logger } : {}),
				...(cfg.pingIntervalMs ? { pingIntervalMs: cfg.pingIntervalMs } : {}),
				...(cfg.pingTimeoutMs ? { pingTimeoutMs: cfg.pingTimeoutMs } : {}),
				...(cfg.backoffMs ? { backoffMs: cfg.backoffMs } : {}),
			});
			listener.onMessage((message) => hub.dispatch(message));
			return { hub, listener, started: null };
		});
	}

	function payloadFor(to: string | null, event: E): string | null {
		const payload = JSON.stringify({ to, event });
		const bytes = new TextEncoder().encode(payload).length;
		if (bytes > MAX_PAYLOAD_BYTES) {
			log().error("realtime event too large; dropped", {
				type: event.type,
				bytes,
				max_bytes: MAX_PAYLOAD_BYTES,
			});
			return null;
		}
		return payload;
	}

	function start(): Promise<void> {
		const s = state();
		if (s.started === null) {
			s.started = s.listener.start();
			s.started.catch((err) =>
				log().exception("realtime listener failed to start", err),
			);
		}
		return s.started;
	}

	return {
		start,
		async stop() {
			const s = state();
			s.hub.closeAll();
			await s.listener.stop();
			s.started = null;
		},
		subscribe(request, topic) {
			void start().catch(() => {});
			keepRequestOpen(request);
			return state().hub.subscribe(topic, request.signal);
		},
		async publish(to, event) {
			const payload = payloadFor(to, event);
			if (payload === null) return;
			try {
				await config().notify(config().channel, payload);
			} catch (err) {
				log().warning("realtime event not sent", {
					type: event.type,
					error: String(err),
				});
			}
		},
		async publishInTx(tx, to, event) {
			const payload = payloadFor(to, event);
			if (payload === null) return;
			await tx.execute(sql`select pg_notify(${config().channel}, ${payload})`);
		},
		size() {
			return state().hub.size();
		},
	};
}
