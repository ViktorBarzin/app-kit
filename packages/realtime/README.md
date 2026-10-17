# @viktorbarzin/realtime

Realtime updates over Postgres LISTEN/NOTIFY and Server-Sent Events:

- each pod holds one LISTEN connection outside the pool, checked every 30 s
  by a ping NOTIFY that must come back on it (10 s timeout, then a reconnect
  with backoff), and tells every stream to `resync` after a reconnect;
- an SSE hub with a `: ping` comment every 25 s, a retry hint, and
  no-cache/no-transform/`x-accel-buffering: no` headers;
- publishing through `pg_notify`, from the pool or inside the caller's
  transaction so the event fires at COMMIT;
- `realtime_listen_connected` and `realtime_last_notify_age_seconds`;
- a browser client that reconnects with backoff and refetches on every
  open or resync, and a TanStack Query hook.

<!-- typecheck-preamble
import type { AuthUser } from "@viktorbarzin/auth";
import type { QueryClient } from "@tanstack/react-query";
import type { SQL } from "bun";
declare const createListenClient: () => SQL;
declare const pool: { getClient(): SQL };
declare const db: { transaction<T>(fn: (tx: { execute(q: unknown): Promise<unknown>; insert(t: unknown): { values(v: unknown): Promise<unknown> } }) => Promise<T>): Promise<T> };
declare const items: unknown, row: unknown, userSub: string, source: string | null;
declare const appAuth: { handleApi(r: Request, fn: (u: AuthUser) => Promise<Response>): Promise<Response> };
declare const queryClient: QueryClient;
-->
```ts
// server
import { createRealtime, poolNotify } from "@viktorbarzin/realtime/server";
export const realtime = createRealtime(() => ({
	channel: "myapp_events",
	createListenClient, // e.g. () => createSqlClient(settings, { max: 1, idleTimeout: 0 }) from @viktorbarzin/pg
	notify: poolNotify(() => pool.getClient()),
}));
await db.transaction(async (tx) => {
	await tx.insert(items).values(row);
	await realtime.publishInTx(tx, userSub, { type: "invalidate", keys: [["items"]], source });
});
// GET /api/events; the topic is the user's sub (null for the dev user)
export const events = (request: Request) =>
	appAuth.handleApi(request, async (user) =>
		realtime.subscribe(request, user.sub ?? user.username),
	);

// browser (React)
import { useRealtimeInvalidation } from "@viktorbarzin/realtime/react";
useRealtimeInvalidation({ queryClient });
```

| Subpath | |
|---|---|
| `/server` | `createRealtime` (`start`, `stop`, `subscribe`, `publish`, `publishInTx`, `size`), `poolNotify`, `createSseHub`, `createListener`, `realtimeGauges`, `formatSseEvent`, `sanitizeClientId`, `parseRealtimeEvent` |
| `/client` | `startRealtime`, `startLiveUpdates` (one per page; online and visibility handling), `clientId()`, `CLIENT_ID_HEADER` |
| `/react` | `useRealtimeInvalidation({ queryClient, url?, enabled? })`, `invalidationHandlers` |

Events are `{ type: "invalidate", keys, source }` or `{ type: "resync" }` by
default; pass `parseEvent` for an app-defined type. The topic in `publish(to,
…)` is an opaque string the app chooses; `null` reaches every stream.
Payloads over 7,900 bytes are logged and dropped. State is one per process
and channel.

Peers: server `@viktorbarzin/log`, `@viktorbarzin/runtime`,
`@viktorbarzin/metrics`, `prom-client` ^15.1, `drizzle-orm` ^0.45 (Bun only);
react `react` ^19, `@tanstack/react-query` ^5. All optional, by subpath.
