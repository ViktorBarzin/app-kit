import { createFileRoute } from "@tanstack/react-router";

import { appAuth } from "#/server/auth.server";

/** Better Auth's endpoints: OAuth callback, sign-out, session, error page. */
const handle = ({ request }: { request: Request }) =>
	appAuth.handleAuthRequest(request);

export const Route = createFileRoute("/api/auth/$")({
	server: { handlers: { GET: handle, POST: handle } },
});
