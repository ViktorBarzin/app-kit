import { createFileRoute } from "@tanstack/react-router";

import { appAuth } from "#/server/auth.server";

/** Where Better Auth lands after the OAuth callback: redirect to `?return=<path>`. */
export const Route = createFileRoute("/api/auth/finish")({
	server: { handlers: { GET: ({ request }) => appAuth.finishSignIn(request) } },
});
