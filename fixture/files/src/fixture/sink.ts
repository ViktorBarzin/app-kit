/**
 * A webhook receiver for Cloud's notification test (P67): with
 * FIXTURE_SINK=on, `POST /sink/<name>` keeps the delivery and answers 200,
 * or 500 when the name starts with `fail-`; `GET /sink/<name>/inbox` lists
 * what that name received. The name is the only key, so the parity suite
 * makes a long random one per run. Deliveries live in the process's memory
 * (the receiver App runs one instance) and keep only the headers a webhook
 * check reads, never a cookie, an edge or a proxy header.
 */

/** A sink name: 16-80 of A-Z, a-z, 0-9, `_` and `-`. */
export const SINK_NAME = /^[A-Za-z0-9_-]{16,80}$/;

/** The most sinks kept; the oldest goes first. */
export const SINK_MAX_SINKS = 50;

/** The most deliveries one sink keeps; the oldest goes first. */
export const SINK_MAX_DELIVERIES = 200;

/** The most body characters kept per delivery. */
export const SINK_MAX_BODY = 64 * 1024;

/** The headers kept: Standard Webhooks' own, the content type and the sender's agent. */
const KEPT_HEADER = /^(webhook-[a-z-]+|content-type|user-agent)$/;

export interface SinkDelivery {
	/** The delivery's number in this sink, from 1. */
	n: number;
	at: string;
	method: string;
	headers: Record<string, string>;
	body: string;
	truncated: boolean;
	/** The status the sink answered. */
	answered: number;
}

export function sinkEnabled(env: Record<string, string | undefined>): boolean {
	return env.FIXTURE_SINK?.trim() === "on";
}

/** 500 for a name that starts with `fail-`, else 200. */
export function sinkAnswer(name: string): number {
	return name.startsWith("fail-") ? 500 : 200;
}

export function keptHeaders(headers: Headers): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, value] of headers.entries())
		if (KEPT_HEADER.test(name.toLowerCase())) out[name.toLowerCase()] = value;
	return out;
}

export class SinkStore {
	private readonly sinks = new Map<string, SinkDelivery[]>();

	record(
		name: string,
		delivery: { method: string; headers: Headers; body: string; at: Date },
	): SinkDelivery {
		let list = this.sinks.get(name);
		if (!list) {
			if (this.sinks.size >= SINK_MAX_SINKS) {
				const oldest = this.sinks.keys().next().value;
				if (oldest !== undefined) this.sinks.delete(oldest);
			}
			list = [];
			this.sinks.set(name, list);
		}
		const last = list.at(-1);
		const kept: SinkDelivery = {
			n: (last?.n ?? 0) + 1,
			at: delivery.at.toISOString(),
			method: delivery.method,
			headers: keptHeaders(delivery.headers),
			body: delivery.body.slice(0, SINK_MAX_BODY),
			truncated: delivery.body.length > SINK_MAX_BODY,
			answered: sinkAnswer(name),
		};
		list.push(kept);
		if (list.length > SINK_MAX_DELIVERIES) list.shift();
		return kept;
	}

	inbox(name: string): SinkDelivery[] {
		return [...(this.sinks.get(name) ?? [])];
	}
}

/** The process's one store, on globalThis, as fixtureState is. */
export function sinkStore(): SinkStore {
	const key = Symbol.for("app-template-fixture:sink");
	const holder = globalThis as unknown as Record<symbol, SinkStore | undefined>;
	let store = holder[key];
	if (!store) {
		store = new SinkStore();
		holder[key] = store;
	}
	return store;
}
