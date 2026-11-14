import { createFileRoute } from "@tanstack/react-router";
import { healthResponse } from "@viktorbarzin/runtime";

import { connectionBudget } from "#/server/env.server";

/**
 * Liveness and readiness probe: `{"status":"ok"}`. A bad connection limit
 * makes it fail, like a bad cloud identity config does (the CSRF check in
 * start.ts reads that on every request), so a misconfigured pod never
 * becomes ready.
 */
export const Route = createFileRoute("/healthz")({
	server: {
		handlers: {
			GET: () => {
				connectionBudget();
				return healthResponse();
			},
		},
	},
});
