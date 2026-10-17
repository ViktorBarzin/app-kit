import { createFileRoute } from "@tanstack/react-router";

import { appAuth } from "#/server/auth.server";

/** Begin sign-in: redirect to Authentik (`?return=<path>`, `&login=1` for prompt=login). */
export const Route = createFileRoute("/api/auth/start")({
	server: { handlers: { GET: ({ request }) => appAuth.startSignIn(request) } },
});
