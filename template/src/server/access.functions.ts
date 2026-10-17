/**
 * Server functions for the pending and approval pages. Admin authorization
 * is checked inside each admin operation (@viktorbarzin/auth), never by the
 * page or the ingress.
 */
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import type { AccessStatus, PendingRequestView } from "@viktorbarzin/auth";
import { ApiError } from "@viktorbarzin/runtime";
import { z } from "zod";

import { appAuth } from "./auth.server";

/** Who is signed in and whether they may use the app yet. */
export const getAccessStatus = createServerFn({ method: "GET" }).handler(
	(): Promise<AccessStatus> => appAuth.accessStatus(getRequest()),
);

/** Ask Authentik again now (the pending page's "Check again"). */
export const recheckAccess = createServerFn({ method: "POST" }).handler(
	(): Promise<AccessStatus> =>
		appAuth.accessStatus(getRequest(), { recheck: true }),
);

async function requireSignedIn() {
	const user = await appAuth.resolveUser(getRequest());
	if (!user) throw new ApiError(401, "unauthorized", "not signed in");
	return user;
}

/** Pending access requests, oldest first. Admins only. */
export const listAccessRequests = createServerFn({ method: "GET" }).handler(
	async (): Promise<PendingRequestView[]> =>
		appAuth.listPendingRequests(await requireSignedIn()),
);

/** Approve one request: adds the person to the users group in Authentik. Admins only. */
export const approveAccessRequest = createServerFn({ method: "POST" })
	.validator(z.object({ sub: z.string().min(1).max(255) }))
	.handler(async ({ data }) => {
		await appAuth.approveRequest(await requireSignedIn(), data.sub);
		return { ok: true as const };
	});
