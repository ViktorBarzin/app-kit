/** The event shapes and the NOTIFY payload format. */

/** The default event set: invalidate TanStack Query keys, or refetch everything (resync). */
export type RealtimeEvent =
	| {
			type: "invalidate";
			keys: ReadonlyArray<ReadonlyArray<string | number>>;
			/** The client id of the tab that caused it, so that tab can skip it. */
			source: string | null;
	  }
	| { type: "resync" };

/** What travels in a NOTIFY payload (JSON). `to` routes it to one topic's streams; null reaches every stream. */
export interface RealtimeMessage<E extends { type: string } = RealtimeEvent> {
	to: string | null;
	event: E;
}

/** Postgres caps a NOTIFY payload at 8000 bytes; stay under it. */
export const MAX_PAYLOAD_BYTES = 7900;

/** A client id is echoed back to its sender; keep it short and plain. */
const CLIENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function sanitizeClientId(
	raw: string | null | undefined,
): string | null {
	return raw && CLIENT_ID.test(raw) ? raw : null;
}

const MAX_KEYS = 32;
const MAX_KEY_PARTS = 8;

function isKeyPart(value: unknown): value is string | number {
	return (
		typeof value === "string" ||
		(typeof value === "number" && Number.isFinite(value))
	);
}

/** The default parser: accepts the two RealtimeEvent shapes, nothing else. */
export function parseRealtimeEvent(raw: unknown): RealtimeEvent | null {
	if (typeof raw !== "object" || raw === null) return null;
	const event = raw as Record<string, unknown>;
	if (event.type === "resync") return { type: "resync" };
	if (event.type !== "invalidate" || !Array.isArray(event.keys)) return null;
	if (event.keys.length > MAX_KEYS) return null;
	const keys: Array<Array<string | number>> = [];
	for (const key of event.keys) {
		if (!Array.isArray(key) || key.length === 0 || key.length > MAX_KEY_PARTS)
			return null;
		if (!key.every(isKeyPart)) return null;
		keys.push([...key]);
	}
	const source =
		typeof event.source === "string" ? sanitizeClientId(event.source) : null;
	return { type: "invalidate", keys, source };
}

/** Parse a NOTIFY payload into a message, using `parseEvent` for the event. */
export function parseMessage<E extends { type: string }>(
	payload: string,
	parseEvent: (raw: unknown) => E | null,
): RealtimeMessage<E> | null {
	let raw: unknown;
	try {
		raw = JSON.parse(payload);
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null) return null;
	const { to, event } = raw as Record<string, unknown>;
	if (to !== null && typeof to !== "string") return null;
	const parsed = parseEvent(event);
	return parsed ? { to, event: parsed } : null;
}

/** Format one SSE frame: `event: <type>\ndata: <json>\n\n`. */
export function formatSseEvent(event: { type: string }): string {
	return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
