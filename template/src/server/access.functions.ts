/**
 * Server functions for the pages that deal with access: who is signed in,
 * the sign-in and sign-out links, and the pending, approval and admin pages.
 * Admin authorization is checked inside each admin operation
 * (@viktorbarzin/auth), never by the page or the ingress.
 */
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import type { AccessStatus, PendingRequestView } from "@viktorbarzin/auth";
import { ApiError } from "@viktorbarzin/runtime";
import { z } from "zod";

import { appAuth } from "./auth.server";
import { isCloud, realtimeEnabled } from "./env.server";

/** What a page needs to know about the caller and the app's mode. */
export interface PageAccess extends AccessStatus {
	/** On Cloud: the edge signs people in, and there are no access requests. */
	cloud: boolean;
	/** Live updates over SSE; off when the connection budget is too small, and the UI refetches instead. */
	realtime: boolean;
	/** Sign in, then come back to the page that asked. */
	signInUrl: string;
	/** Sign out, then land on the page that asked; null when sign-out is not a link. */
	signOutUrl: string | null;
}

/** Who is signed in, whether they may use the app yet, and the links to sign in or out. */
export const getAccessStatus = createServerFn({ method: "GET" })
	.validator(z.object({ returnTo: z.string().max(2048) }))
	.handler(
		async ({ data }): Promise<PageAccess> => ({
			...(await appAuth.accessStatus(getRequest())),
			cloud: isCloud(),
			realtime: realtimeEnabled(),
			signInUrl: appAuth.signInUrl(data.returnTo),
			signOutUrl: appAuth.signOutUrl(data.returnTo),
		}),
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

/** The admin page's facts. Admins only: on Cloud, the owner. */
export const getAdminOverview = createServerFn({ method: "GET" }).handler(
	async (): Promise<{ username: string; pendingRequests: number | null }> => {
		const user = await requireSignedIn();
		await appAuth.requireAdmin(user);
		return {
			username: user.username,
			pendingRequests: isCloud()
				? null
				: (await appAuth.listPendingRequests(user)).length,
		};
	},
);

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
