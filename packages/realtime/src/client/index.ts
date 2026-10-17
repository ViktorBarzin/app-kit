/**
 * The browser side of the realtime contract: an EventSource that reconnects
 * with backoff and treats every "events may have been lost" moment (open,
 * a server `resync`, coming back after a while in the background) as
 * "refetch everything that is on screen". No React here; see ../react.
 */

/** The slice of EventSource this module drives (keeps it unit-testable). */
export interface EventSourceLike {
	readonly readyState: number;
	addEventListener(type: string, listener: (event: MessageEvent) => void): void;
	close(): void;
}

export interface RealtimeDeps {
	url: string;
	/** SSE event names to pass to onEvent (`resync` is handled here). */
	eventTypes: string[];
	createSource(url: string): EventSourceLike;
	onEvent(type: string, data: unknown): void;
	/** Events may have been lost (open, reconnect or a server `resync`): refetch. */
	onResync(): void;
}

export interface RealtimeConnection {
	/** Reopen at once if the browser gave up (after sign-in, online, focus). */
	reconnectNow(): void;
	/**
	 * Back in the foreground after `hiddenForMs`. Past RESUME_RECONNECT_MS the
	 * connection is reopened even if it looks open: iOS can leave a
	 * backgrounded PWA's socket dead with readyState still OPEN, and the
	 * server's heartbeat is an SSE comment the page never sees.
	 */
	resume(hiddenForMs: number): void;
	stop(): void;
}

/** Hidden at least this long: reopen the stream on return (about the 25 s heartbeat). */
export const RESUME_RECONNECT_MS = 30_000;

/** EventSource.CLOSED: the browser will not retry by itself. */
const CLOSED = 2;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;

function parseData(event: MessageEvent): unknown {
	try {
		return JSON.parse(String(event.data));
	} catch {
		return null;
	}
}

export function startRealtime(deps: RealtimeDeps): RealtimeConnection {
	let source: EventSourceLike | null = null;
	let retryTimer: ReturnType<typeof setTimeout> | null = null;
	let retryDelay = 0;
	let stopped = false;

	function cancelRetry(): void {
		if (retryTimer !== null) clearTimeout(retryTimer);
		retryTimer = null;
	}

	function scheduleReconnect(): void {
		retryDelay =
			retryDelay === 0
				? BACKOFF_BASE_MS
				: Math.min(retryDelay * 2, BACKOFF_CAP_MS);
		cancelRetry();
		retryTimer = setTimeout(() => {
			retryTimer = null;
			connect();
		}, retryDelay);
	}

	function connect(): void {
		if (stopped) return;
		cancelRetry();
		source?.close();
		const current = deps.createSource(deps.url);
		source = current;
		current.addEventListener("open", () => {
			retryDelay = 0;
			// Covers the first connect too: an event sent between the page's
			// first fetch and this subscription would otherwise be missed.
			deps.onResync();
		});
		current.addEventListener("resync", () => deps.onResync());
		for (const type of deps.eventTypes) {
			if (type === "resync") continue;
			current.addEventListener(type, (event) =>
				deps.onEvent(type, parseData(event)),
			);
		}
		current.addEventListener("error", () => {
			// CONNECTING means the browser is already retrying (it honours the
			// server's `retry:` hint). CLOSED means it gave up, e.g. on a 401.
			if (current === source && current.readyState === CLOSED)
				scheduleReconnect();
		});
	}

	connect();

	function reconnectNow(): void {
		if (stopped || (source && source.readyState !== CLOSED)) return;
		retryDelay = 0;
		connect();
	}

	return {
		reconnectNow,
		resume(hiddenForMs) {
			if (stopped) return;
			if (hiddenForMs < RESUME_RECONNECT_MS) return reconnectNow();
			retryDelay = 0;
			connect();
		},
		stop() {
			stopped = true;
			cancelRetry();
			source?.close();
			source = null;
		},
	};
}

/** The header an app sends with a mutation so its own invalidations are skipped. */
export const CLIENT_ID_HEADER = "x-client-id";

interface PageState {
	clientId: string | null;
	live: { connection: RealtimeConnection; detach: () => void } | null;
}

function pageState(): PageState {
	const store = globalThis as unknown as Record<symbol, PageState | undefined>;
	const slot = Symbol.for("@viktorbarzin:realtime.page");
	store[slot] ??= { clientId: null, live: null };
	return store[slot];
}

/** This tab's id: random, fixed for the life of the page. */
export function clientId(): string {
	const state = pageState();
	state.clientId ??= crypto.randomUUID().replaceAll("-", "");
	return state.clientId;
}

/**
 * Open the page's realtime connection (one per page; null when one is
 * already open or there is no EventSource). Coming back online or to the
 * foreground reopens a connection the browser gave up on.
 */
export function startLiveUpdates(opts: {
	url?: string;
	eventTypes?: string[];
	onEvent(type: string, data: unknown): void;
	onResync(): void;
}): { reconnectNow(): void; stop(): void } | null {
	const state = pageState();
	if (state.live || typeof window === "undefined" || !("EventSource" in window))
		return null;
	const connection = startRealtime({
		url: opts.url ?? "/api/events",
		eventTypes: opts.eventTypes ?? ["invalidate"],
		createSource: (url) => new EventSource(url),
		onEvent: opts.onEvent,
		onResync: opts.onResync,
	});
	const onOnline = () => connection.reconnectNow();
	let hiddenAt: number | null = null;
	const onVisibility = () => {
		if (document.visibilityState === "hidden") {
			hiddenAt = Date.now();
			return;
		}
		connection.resume(hiddenAt === null ? 0 : Date.now() - hiddenAt);
		hiddenAt = null;
	};
	window.addEventListener("online", onOnline);
	document.addEventListener("visibilitychange", onVisibility);
	const live = {
		connection,
		detach: () => {
			window.removeEventListener("online", onOnline);
			document.removeEventListener("visibilitychange", onVisibility);
		},
	};
	state.live = live;
	return {
		reconnectNow: () => connection.reconnectNow(),
		stop() {
			if (state.live !== live) return;
			live.detach();
			connection.stop();
			state.live = null;
		},
	};
}
