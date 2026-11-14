/**
 * Identity (@viktorbarzin/auth). On Cloud (CLOUD_EDGE_SECRET set) the edge
 * signs people in and forwards who they are; createCloudAuth trusts those
 * headers only with the edge secret. Elsewhere the app signs people in
 * itself through Authentik (sessions, bearer tokens, membership, CSRF).
 * Both return the same interface, so the rest of the app does not care.
 */
import {
	type AppAuth,
	createAppAuth,
	createCloudAuth,
} from "@viktorbarzin/auth";
import { setLogContext } from "@viktorbarzin/log";

import { pool } from "./db.server";
import { authConfig, cloudAuthConfig, isCloud } from "./env.server";

export const appAuth: AppAuth<Record<never, never>> = isCloud()
	? createCloudAuth(cloudAuthConfig)
	: createAppAuth(() => authConfig(() => pool.getDb()));

/**
 * The signed-in member, or a 401/403 ApiError. Their `sub` becomes
 * `enduser.id` on the rest of this request's log lines, the access-log line
 * included.
 */
export async function requireMember(request: Request) {
	const user = await appAuth.requireUser(request);
	if (user.sub) setLogContext({ enduserId: user.sub });
	return user;
}
