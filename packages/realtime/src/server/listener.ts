/**
 * A pod's one Postgres LISTEN connection.
 *
 * - Bun SQL's `listen()` keeps a dedicated connection outside the app pool.
 * - Every 30 seconds the listener checks that connection: it sends a ping
 *   NOTIFY (through the pool) and waits for it to come back on the LISTEN
 *   connection. Bun's `listen()` offers no way to run `SELECT 1` on its
 *   connection, so the round trip through LISTEN is the check; it also
 *   notices a LISTEN that silently stopped. A ping that does not return
 *   within 10 seconds closes the connection and opens a new one, with backoff.
 * - After every reconnect (Bun's own after a drop, or ours) it emits a
 *   `resync` to every local subscriber: NOTIFY is not durable, so events sent
 *   while disconnected are lost.
 * - Keeps `realtime_listen_connected` and `realtime_last_notify_age_seconds`
 *   current. Pings count as notifications, so the age stays under about 30
 *   seconds while the path works.
 */
import { getLogger, type Logger } from "@viktorbarzin/log";
import { getRegistry } from "@viktorbarzin/metrics";
import type { SQL } from "bun";
import client, { type Gauge, type Registry } from "prom-client";

import {
	parseMessage,
	parseRealtimeEvent,
	type RealtimeEvent,
	type RealtimeMessage,
} from "./events.js";

export const PING_INTERVAL_MS = 30_000;
export const PING_TIMEOUT_MS = 10_000;
const AGE_UPDATE_MS = 5_000;
const MAX_BACKOFF_MS = 30_000;

export type NotifyFn = (channel: string, payload: string) => Promise<void>;
export type ResyncEvent = { type: "resync" };

export interface Listener<E extends { type: string }> {
	/** Resolves once the first LISTEN is active. Idempotent. */
	start(): Promise<void>;
	stop(): Promise<void>;
	/** Called for each decoded notification, and with `resync` after a reconnect. */
	onMessage(
		handler: (message: RealtimeMessage<E | ResyncEvent>) => void,
	): () => void;
}

export interface ListenerOptions<E extends { type: string }> {
	/** A client for the LISTEN connection (max 1, idleTimeout 0). */
	createClient: () => SQL;
	/** Sends the ping NOTIFY, normally through the app pool. */
	notify: NotifyFn;
	parseEvent?: (raw: unknown) => E | null;
	registry?: Registry;
	logger?: Logger;
	pingIntervalMs?: number;
	pingTimeoutMs?: number;
	/** Delay before reconnect attempt `n` (1-based). */
	backoffMs?: (attempt: number) => number;
}

export interface RealtimeGauges {
	connected: Gauge;
	lastNotifyAge: Gauge;
}

function gauge(registry: Registry, name: string, help: string): Gauge {
	const existing = registry.getSingleMetric(name);
	if (existing) return existing as Gauge;
	return new client.Gauge({ name, help, registers: [registry] });
}

export function realtimeGauges(
	registry: Registry = getRegistry(),
): RealtimeGauges {
	return {
		connected: gauge(
			registry,
			"realtime_listen_connected",
			"1 while the Postgres LISTEN connection is connected.",
		),
		lastNotifyAge: gauge(
			registry,
			"realtime_last_notify_age_seconds",
			"Seconds since the last Postgres NOTIFY was received.",
		),
	};
}

function defaultBackoff(attempt: number): number {
	return Math.min(MAX_BACKOFF_MS, 500 * 2 ** (attempt - 1));
}

const RESYNC: RealtimeMessage<ResyncEvent> = {
	to: null,
	event: { type: "resync" },
};

export function createListener<E extends { type: string } = RealtimeEvent>(
	channel: string,
	opts: ListenerOptions<E>,
): Listener<E> {
	const parseEvent =
		opts.parseEvent ??
		(parseRealtimeEvent as unknown as (raw: unknown) => E | null);
	const pingInterval = opts.pingIntervalMs ?? PING_INTERVAL_MS;
	const pingTimeout = opts.pingTimeoutMs ?? PING_TIMEOUT_MS;
	const backoff = opts.backoffMs ?? defaultBackoff;
	const log = opts.logger ?? getLogger("realtime");
	const gauges = realtimeGauges(opts.registry);
	const instance = crypto.randomUUID();

	const handlers = new Set<
		(message: RealtimeMessage<E | ResyncEvent>) => void
	>();
	let sql: SQL | null = null;
	let stopped = true;
	let listenedOnce = false;
	let lastNotifyAt = Date.now();
	let pingSeq = 0;
	let waitingPing: { id: string; resolve: () => void } | null = null;
	let pingTimer: ReturnType<typeof setInterval> | null = null;
	let ageTimer: ReturnType<typeof setInterval> | null = null;
	let reconnecting: Promise<void> | null = null;
	let firstListen = deferred();

	function deferred() {
		let resolve = () => {};
		const promise = new Promise<void>((r) => {
			resolve = r;
		});
		return { promise, resolve };
	}

	function emit(message: RealtimeMessage<E | ResyncEvent>) {
		for (const handler of handlers) {
			try {
				handler(message);
			} catch (err) {
				log.exception("realtime handler failed", err);
			}
		}
	}

	function updateAge() {
		gauges.lastNotifyAge.set((Date.now() - lastNotifyAt) / 1000);
	}

	function onPayload(payload: string) {
		lastNotifyAt = Date.now();
		updateAge();
		let ping: unknown;
		try {
			ping = (JSON.parse(payload) as { ping?: unknown }).ping;
		} catch {
			ping = undefined;
		}
		if (typeof ping === "string") {
			if (waitingPing?.id === ping) waitingPing.resolve();
			return;
		}
		const message = parseMessage(payload, parseEvent);
		if (message) emit(message);
		else
			log.debug("ignored a NOTIFY payload that is not a realtime message", {
				channel,
			});
	}

	function onListen() {
		gauges.connected.set(1);
		if (listenedOnce) {
			log.info("LISTEN re-established; asking clients to resync", { channel });
			emit(RESYNC);
		}
		listenedOnce = true;
		firstListen.resolve();
	}

	async function closeClient() {
		const old = sql;
		sql = null;
		if (old) await old.close({ timeout: 0 }).catch(() => {});
	}

	async function connect(): Promise<void> {
		let attempt = 0;
		while (!stopped) {
			const next = opts.createClient();
			try {
				sql = next;
				await next.listen(channel, onPayload, onListen);
				return;
			} catch (err) {
				attempt += 1;
				gauges.connected.set(0);
				if (sql === next) await closeClient();
				const delay = backoff(attempt);
				log.warning("LISTEN failed; retrying", {
					channel,
					attempt,
					delay_ms: delay,
					error: String(err),
				});
				await Bun.sleep(delay);
			}
		}
	}

	function reconnect(reason: string): Promise<void> {
		if (reconnecting) return reconnecting;
		reconnecting = (async () => {
			gauges.connected.set(0);
			log.warning("LISTEN connection looks dead; reconnecting", {
				channel,
				reason,
			});
			await closeClient();
			await connect();
		})().finally(() => {
			reconnecting = null;
		});
		return reconnecting;
	}

	/** One heartbeat: a ping NOTIFY must come back on the LISTEN connection. */
	async function ping(): Promise<void> {
		if (stopped || reconnecting || !sql) return;
		pingSeq += 1;
		const id = `${instance}:${pingSeq}`;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const arrived = new Promise<boolean>((resolve) => {
			waitingPing = { id, resolve: () => resolve(true) };
			timer = setTimeout(() => resolve(false), pingTimeout);
		});
		try {
			await opts.notify(channel, JSON.stringify({ ping: id }));
		} catch (err) {
			// The pool could not send; that says nothing about the LISTEN side.
			log.warning("realtime ping not sent", { error: String(err) });
			clearTimeout(timer);
			waitingPing = null;
			return;
		}
		const ok = await arrived;
		clearTimeout(timer);
		waitingPing = null;
		if (!ok && !stopped) await reconnect("ping timed out");
	}

	return {
		async start() {
			if (!stopped) return firstListen.promise;
			stopped = false;
			lastNotifyAt = Date.now();
			gauges.connected.set(0);
			updateAge();
			pingTimer = setInterval(() => void ping(), pingInterval);
			ageTimer = setInterval(updateAge, AGE_UPDATE_MS);
			pingTimer.unref?.();
			ageTimer.unref?.();
			void connect();
			return firstListen.promise;
		},
		async stop() {
			stopped = true;
			if (pingTimer) clearInterval(pingTimer);
			if (ageTimer) clearInterval(ageTimer);
			pingTimer = null;
			ageTimer = null;
			waitingPing?.resolve();
			await closeClient();
			gauges.connected.set(0);
			listenedOnce = false;
			firstListen = deferred();
		},
		onMessage(handler) {
			handlers.add(handler);
			return () => {
				handlers.delete(handler);
			};
		},
	};
}
