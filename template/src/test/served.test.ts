import { afterEach, expect, test } from "bun:test";

import { statusWhenServed } from "./served";

let server: ReturnType<typeof Bun.serve> | null = null;
afterEach(() => {
	server?.stop(true);
	server = null;
});

test("waits through 503s while the dev server warms up, then gives its 200", async () => {
	let calls = 0;
	server = Bun.serve({
		port: 0,
		fetch: () => new Response(null, { status: ++calls <= 2 ? 503 : 200 }),
	});
	const status = await statusWhenServed(
		`http://127.0.0.1:${server.port}/healthz`,
		{ budgetMs: 5000, intervalMs: 10 },
	);
	expect(status).toBe(200);
	expect(calls).toBe(3);
});

test("a 4xx is an answer: it is returned at once", async () => {
	server = Bun.serve({
		port: 0,
		fetch: () => new Response(null, { status: 404 }),
	});
	expect(
		await statusWhenServed(`http://127.0.0.1:${server.port}/`, {
			budgetMs: 5000,
			intervalMs: 10,
		}),
	).toBe(404);
});

test("at the budget it gives the last status: 0 when nothing listened", async () => {
	expect(
		await statusWhenServed("http://127.0.0.1:9/", {
			budgetMs: 50,
			intervalMs: 10,
		}),
	).toBe(0);
});
