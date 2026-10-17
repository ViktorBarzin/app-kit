/**
 * TanStack Query wiring for the realtime contract: an `invalidate` event
 * invalidates its query keys (unless this tab caused it), and every open or
 * `resync` refetches all active queries.
 */
import type { QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { clientId, startLiveUpdates } from "../client/index.js";

export interface InvalidationHandlers {
	onEvent(type: string, data: unknown): void;
	onResync(): void;
}

/** The handlers the hook installs, exported for tests and non-React use. */
export function invalidationHandlers(
	queryClient: Pick<QueryClient, "invalidateQueries">,
	ownClientId: () => string = clientId,
): InvalidationHandlers {
	return {
		onEvent(type, data) {
			if (type !== "invalidate" || typeof data !== "object" || data === null)
				return;
			const { keys, source } = data as { keys?: unknown; source?: unknown };
			if (typeof source === "string" && source === ownClientId()) return;
			if (!Array.isArray(keys)) return;
			for (const key of keys)
				if (Array.isArray(key))
					void queryClient.invalidateQueries({ queryKey: key });
		},
		onResync() {
			void queryClient.invalidateQueries({ refetchType: "active" });
		},
	};
}

export function useRealtimeInvalidation(opts: {
	queryClient: QueryClient;
	url?: string;
	enabled?: boolean;
}): void {
	const { queryClient, url, enabled = true } = opts;
	useEffect(() => {
		if (!enabled) return;
		const live = startLiveUpdates({
			...(url ? { url } : {}),
			eventTypes: ["invalidate"],
			...invalidationHandlers(queryClient),
		});
		return () => live?.stop();
	}, [queryClient, url, enabled]);
}
