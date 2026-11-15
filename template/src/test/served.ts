/**
 * The status a starting server answers once it serves, for tests that
 * start one. A refused connection (0) and a 5xx (the dev server answers 503
 * while it warms up on a loaded box) mean "not yet"; anything else is the
 * answer. At the budget it returns the last status seen.
 */
export async function statusWhenServed(
	url: string,
	options: { budgetMs: number; intervalMs?: number },
): Promise<number> {
	const deadline = Date.now() + options.budgetMs;
	const interval = options.intervalMs ?? 500;
	for (;;) {
		const status = await fetch(url, { signal: AbortSignal.timeout(5000) })
			.then((r) => r.status)
			.catch(() => 0);
		const waiting = status === 0 || status >= 500;
		if (!waiting || Date.now() >= deadline) return status;
		await Bun.sleep(interval);
	}
}
