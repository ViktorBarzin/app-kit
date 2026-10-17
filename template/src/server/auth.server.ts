/** Sign-in, sessions, bearer tokens, membership and CSRF (@viktorbarzin/auth). */
import { createAppAuth } from "@viktorbarzin/auth";

import { pool } from "./db.server";
import { authConfig } from "./env.server";

export const appAuth = createAppAuth(() => authConfig(() => pool.getDb()));
