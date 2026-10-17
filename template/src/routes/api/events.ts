import { createFileRoute } from "@tanstack/react-router";

import { appAuth } from "#/server/auth.server";
import { realtime } from "#/server/realtime.server";

/**
 * Server-Sent Events for the signed-in member: `invalidate` and `resync`.
 * The CSRF origin check runs first (src/start.ts).
 */
export const Route = createFileRoute("/api/events")({
	server: {
		handlers: {
			GET: ({ request }) =>
				appAuth.handleApi(request, async (user) =>
					realtime.subscribe(request, user.sub ?? user.username),
				),
		},
	},
});
