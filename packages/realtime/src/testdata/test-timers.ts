/**
 * Fake `setTimeout`/`clearTimeout` only, leaving `setImmediate` real (the
 * vitest `toFake: ['setTimeout', 'clearTimeout']` the Svelte tests used):
 * fake-indexeddb schedules its work on setImmediate, so faking that too
 * would hang every IndexedDB call. Test-only helper.
 */
interface Pending {
	at: number;
	fn: () => void;
}

export interface FakeTimeouts {
	/** Advance the clock, firing due timers in order and letting their async work settle. */
	advance(ms: number): Promise<void>;
	restore(): void;
}

async function settle(turns = 5): Promise<void> {
	for (let i = 0; i < turns; i++)
		await new Promise<void>((resolve) => setImmediate(resolve));
}

export function fakeTimeouts(): FakeTimeouts {
	const realSetTimeout = globalThis.setTimeout;
	const realClearTimeout = globalThis.clearTimeout;
	const timers = new Map<number, Pending>();
	let now = 0;
	let nextId = 1;

	globalThis.setTimeout = ((fn: () => void, ms = 0) => {
		const id = nextId++;
		timers.set(id, { at: now + ms, fn });
		return id;
	}) as unknown as typeof setTimeout;
	globalThis.clearTimeout = ((id: number) => {
		timers.delete(id);
	}) as unknown as typeof clearTimeout;

	return {
		async advance(ms) {
			const end = now + ms;
			for (;;) {
				let due: [number, Pending] | undefined;
				for (const entry of timers) {
					if (entry[1].at <= end && (!due || entry[1].at < due[1].at))
						due = entry;
				}
				if (!due) break;
				timers.delete(due[0]);
				now = due[1].at;
				due[1].fn();
				await settle();
			}
			now = end;
		},
		restore() {
			globalThis.setTimeout = realSetTimeout;
			globalThis.clearTimeout = realClearTimeout;
		},
	};
}
