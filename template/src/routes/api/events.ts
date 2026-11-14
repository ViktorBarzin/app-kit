import { createFileRoute } from "@tanstack/react-router";
import { errorResponse } from "@viktorbarzin/runtime";

import { appAuth } from "#/server/auth.server";
import { realtimeEnabled } from "#/server/env.server";
import { realtime } from "#/server/realtime.server";

/**
 * Server-Sent Events for the signed-in member: `invalidate` and `resync`.
 * The CSRF origin check runs first (src/start.ts). 404 while the connection
 * budget keeps realtime off: subscribing would open the LISTEN connection.
 */
export const Route = createFileRoute("/api/events")({
	server: {
		handlers: {
			GET: ({ request }) =>
				realtimeEnabled()
					? appAuth.handleApi(request, async (user) =>
							realtime.subscribe(request, user.sub ?? user.username),
						)
					: errorResponse(404, "not_found", "realtime is off for this app"),
		},
	},
});
