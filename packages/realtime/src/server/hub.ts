/**
 * The SSE hub: fans messages out to this pod's open event streams.
 *
 * - One stream per open tab or device, keyed by a topic the app chooses
 *   (the template uses the user's `sub`).
 * - A `: ping` comment every 25 seconds (proxies close idle responses after
 *   about 100 seconds), a `retry:` hint on open, no-cache/no-transform and
 *   `x-accel-buffering: no` so nothing buffers the stream.
 * - A message with `to: null` goes to every stream.
 */
import type { RealtimeMessage } from "./events.js";
import { formatSseEvent } from "./events.js";

export const HEARTBEAT_INTERVAL_MS = 25_000;
export const RETRY_HINT_MS = 3_000;

export const SSE_HEADERS: Readonly<Record<string, string>> = {
	"content-type": "text/event-stream; charset=utf-8",
	"cache-control": "no-cache, no-transform",
	connection: "keep-alive",
	"x-accel-buffering": "no",
};

export interface SseHub {
	/** A streaming Response for one subscriber; closes when `signal` aborts. */
	subscribe(topic: string, signal: AbortSignal): Response;
	/** Deliver a message to the matching local streams. */
	dispatch<E extends { type: string }>(message: RealtimeMessage<E>): void;
	/** Open streams on this pod. */
	size(): number;
	/** Close every stream (shutdown, tests). */
	closeAll(): void;
}

interface Stream {
	topic: string;
	send(chunk: string): void;
	close(): void;
}

export function createSseHub(
	opts: { heartbeatMs?: number; retryMs?: number } = {},
): SseHub {
	const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_INTERVAL_MS;
	const retryMs = opts.retryMs ?? RETRY_HINT_MS;
	const streams = new Set<Stream>();
	const encoder = new TextEncoder();

	return {
		subscribe(topic, signal) {
			let stream: Stream | null = null;
			let heartbeat: ReturnType<typeof setInterval> | null = null;
			const onAbort = () => stream?.close();
			const cleanup = () => {
				if (heartbeat) clearInterval(heartbeat);
				heartbeat = null;
				if (stream) streams.delete(stream);
				signal.removeEventListener("abort", onAbort);
			};
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					let open = true;
					const current: Stream = {
						topic,
						send(chunk) {
							if (!open) return;
							try {
								controller.enqueue(encoder.encode(chunk));
							} catch {
								current.close();
							}
						},
						close() {
							if (!open) return;
							open = false;
							cleanup();
							try {
								controller.close();
							} catch {
								// already closed by the client going away
							}
						},
					};
					stream = current;
					streams.add(current);
					// The retry hint, and a first byte so proxies flush the headers.
					current.send(`retry: ${retryMs}\n: connected\n\n`);
					heartbeat = setInterval(
						() => current.send(": ping\n\n"),
						heartbeatMs,
					);
					if (signal.aborted) current.close();
					else signal.addEventListener("abort", onAbort, { once: true });
				},
				cancel() {
					stream?.close();
				},
			});
			return new Response(body, { headers: SSE_HEADERS });
		},
		dispatch(message) {
			const frame = formatSseEvent(message.event);
			for (const stream of streams)
				if (message.to === null || message.to === stream.topic)
					stream.send(frame);
		},
		size() {
			return streams.size;
		},
		closeAll() {
			for (const stream of [...streams]) stream.close();
		},
	};
}
