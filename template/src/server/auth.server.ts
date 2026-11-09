/** Sign-in, sessions, bearer tokens, membership and CSRF (@viktorbarzin/auth). */
import { createAppAuth } from "@viktorbarzin/auth";
import { setLogContext } from "@viktorbarzin/log";

import { pool } from "./db.server";
import { authConfig } from "./env.server";

export const appAuth = createAppAuth(() => authConfig(() => pool.getDb()));

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
