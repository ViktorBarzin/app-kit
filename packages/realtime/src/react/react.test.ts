import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";

import { invalidationHandlers } from "./index.js";

function client() {
	const queryClient = new QueryClient();
	const calls: unknown[] = [];
	const original = queryClient.invalidateQueries.bind(queryClient);
	queryClient.invalidateQueries = ((filters?: unknown) => {
		calls.push(filters);
		return original(filters as Parameters<typeof original>[0]);
	}) as typeof queryClient.invalidateQueries;
	return { queryClient, calls };
}

describe("invalidationHandlers", () => {
	test("an invalidate event invalidates each key", () => {
		const { queryClient, calls } = client();
		const h = invalidationHandlers(queryClient, () => "me");
		h.onEvent("invalidate", {
			type: "invalidate",
			keys: [["items"], ["items", 3]],
			source: "other",
		});
		expect(calls).toEqual([
			{ queryKey: ["items"] },
			{ queryKey: ["items", 3] },
		]);
	});

	test("this tab's own invalidations are skipped; events without a source are not", () => {
		const { queryClient, calls } = client();
		const h = invalidationHandlers(queryClient, () => "me");
		h.onEvent("invalidate", {
			type: "invalidate",
			keys: [["items"]],
			source: "me",
		});
		expect(calls).toEqual([]);
		h.onEvent("invalidate", {
			type: "invalidate",
			keys: [["items"]],
			source: null,
		});
		expect(calls).toEqual([{ queryKey: ["items"] }]);
	});

	test("other event types and junk are ignored", () => {
		const { queryClient, calls } = client();
		const h = invalidationHandlers(queryClient, () => "me");
		h.onEvent("poke", { keys: [["items"]] });
		h.onEvent("invalidate", null);
		h.onEvent("invalidate", { keys: "items" });
		expect(calls).toEqual([]);
	});

	test("open or resync refetches every active query", () => {
		const { queryClient, calls } = client();
		invalidationHandlers(queryClient, () => "me").onResync();
		expect(calls).toEqual([{ refetchType: "active" }]);
	});
});
