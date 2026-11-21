# Fixture App

This repo is the template with test routes added. Cloud's parity suite
creates Apps from it with `cloud new <app> --template fixture`. It is
generated from app-kit: `fixture/` there overlays `template/`
(`bun scripts/export-template.ts --variant fixture`). Change it in app-kit,
not here.

Every route answers JSON. None needs a sign-in. The routes are Nitro
handlers (`src/fixture/nitro-config.ts`), matched before TanStack Start.

| Route | Answer |
|---|---|
| `GET /info` | `bootTime`, `serviceVersion` (`SERVICE_VERSION`), `instanceId` (`CLOUD_INSTANCE_ID` or null), `pid`, `env` and `empty`. `env` has every env name. Its value is the SHA-256 hex of the variable's value for the names the parity suite sets (`TOKEN`, `SESSION_SECRET`, `FOO`, `VITE_GREETING`, `VITE_KEY`, and names starting `FIXTURE_` or a checklist ID such as `P27_`) and for `SERVICE_VERSION`, `CLOUD_INSTANCE_ID` and `CLOUD_PUBLIC_URL`; it is null for every other name, so a platform credential's hash is never on a public URL. `empty` lists the names whose value is empty. `urls` shows each `CLOUD_URL_<NAME>` in clear: the address of a Service the App connects to (null if it carries a user or password). No other value. |
| `GET /items` | Writes a row to table `items` (from the template's migration), reads it back, then deletes it: `{wrote, read, deleted}`. 503 without `DATABASE_URL`. |
| `GET /enqueue` | Queues a pg-boss job with a fresh id on queue `fixture`: `{id}`. The worker entrypoint logs `job-done <id>` when it has done it. It uses the App's own pool through pg-boss's `fromBunSql`, so it opens no second pool. 503 without `DATABASE_URL`. |
| `GET /crash` | 202, then the process exits with code 42. |
| `GET /oom` | 202, then the process allocates 64 MiB every 20 ms until the kernel kills it. |
| `GET /unhealthy`, `GET /healthy` | Make `/healthz` answer 500, or 200 again. |
| `GET /healthz` | 200 `{"status":"ok"}`, or 500 after `/unhealthy` or when `HEALTHZ_FAILS_AT_BOOT` in `src/fixture/knobs.ts` is true. |
| `GET /slow?s=N` | Answers after N seconds, at most 600. |
| `GET /ws` | WebSocket: sends every text frame back. |
| `GET /sse?every=N` | Server-Sent Events: one `data:` event at once, then one every N seconds (default 5). The stream ends after 15 min. |
| `GET /log?n=N&tag=T` | Writes N lines `fixture-log T 1` to `fixture-log T N` to the App's log, at most 200; T is 1-40 of a-z, 0-9 and `-`. `&level=error`, `warn` or `info` starts each line with that word in capitals (`ERROR fixture-log T 1`) and logs it at that level (`console.error` or `console.warn`), so the built server's JSON line carries `severity_text` `ERROR` or `WARN` and `cloud logs --level` reads it. |
| `GET /egress-ip` | `{ip, source}`: the address a public IP echo service sees. |
| `GET /tcp?host=H&port=P` | A TCP connect with a 9 s timeout, under the SMTP test's 10 s: `{connected, error, ms}`; `error` is only the kind of failure (`timeout`, `refused`, `dns`, `unreachable`, `reset` or `error`). Only `smtp.gmail.com` on ports 25, 465, 587, 2525 and 443, and `www.google.com` on 443, the SMTP test's control. |
| `GET /fetch?url=U` | A GET with an 8 s timeout, under the server's 10 s idle timeout, so a target that never answers gives `error: "timeout"`: `{connected, status, error, ms}`, never the body; `error` as for `/tcp`. Only the App's own origins (`CLOUD_PUBLIC_URL`, each `CLOUD_URL_<NAME>`) and the origins its owner lists, comma-separated, in `FIXTURE_FETCH_ALLOW`. |
| `GET /fill?mb=N` | Only with `FIXTURE_FILL=on` (else 404): writes N MiB (1 to 256) of random bytes to table `fixture_fill`, so the database grows by about that much: `{wroteMib, databaseMib, maxMib}`. One call at a time (409 `fill_busy`). The call lifts the server's idle timeout, so a large write answers when it is done. It refuses a write that would take the database past `FIXTURE_FILL_MAX_MIB` (default 921, 90% of the nano Size's 1 GiB) with 409 `fill_limit`, whose body also has `databaseMib` and `maxMib`. `GET /fill?status=1` answers `{databaseMib, maxMib, busy}` and writes nothing. `GET /fill?clear=1` drops the table. 503 without `DATABASE_URL`. |
| `POST /sink/<name>` | Only with `FIXTURE_SINK=on`: a webhook receiver. Keeps the delivery in memory and answers 200, or 500 when the name starts with `fail-`. The name is 16-80 of A-Z, a-z, 0-9, `_` and `-`; it is the only key, so make it long and random. It keeps the `webhook-*` headers, `content-type`, `user-agent` and the body, never another header. A body over 64 KiB answers 413 and is not kept. |
| `GET /sink/<name>/inbox` | `{deliveries}`, oldest first: each with `n`, `at`, `method`, `headers`, `body` and `answered`. At most 200 per name, 50 names and 16 MiB of bodies in all; the oldest go first. |
| `GET /build-assets` | `{assets}`: the client build's JS files, for the build env test. |
| `GET /kv-selftest` | Through the template's `createRedis()` on the connected Key Value: SET, GET, one BullMQ job enqueued and processed (queue `fixture-selftest`) and one pub/sub round trip. 200 `{"result":"ok"}`, or 500 `{"result":"failed","step":"set"\|"get"\|"bullmq"\|"pubsub","error":"<message>"}`. 503 `no_key_value` without `REDIS_URL`. |
| `GET /probe/kv?key=K` | `GET K` with the App's own `REDIS_URL` user and no prefix: `{"key":K,"ok":true}`, or `{"key":K,"error":"<the Redis error>"}`, such as `NOPERM No permissions to access a key` for a key under another Project's prefix. K is 1-200 printable characters without a space. 503 without `REDIS_URL`. |
| `GET /kv-fill?mb=N` | Only with `FIXTURE_FILL=on` (else 404): writes N (1 to 256) keys of 1 MiB each, without a TTL, under the App's prefix (`fixture-fill:<n>`): `{"wroteMib":N,"keys":N}`. Once the Key Value refuses writes: 507 `{"error":{"code":"kv_full","message":"Key Value is full: over its Size of 16 MiB; ..."},"wroteMib","keys"}` with what it wrote before. It never holds more than the Size (`CLOUD_KV_MAX_BYTES`) plus 1 MiB, since the Redis is shared: past that, 409 `fill_limit` and nothing is written. One call at a time (409 `fill_busy`). |
| `GET /kv-fill?write=1` | Only with `FIXTURE_FILL=on`: writes one small key without a TTL. 200 `{"ok":true}`, or 507 `{"error":{"code":"kv_full","message":"<the message that names the Size>"}}`, or 500 `kv_error`. |
| `GET /kv-fill?clear=1` | Only with `FIXTURE_FILL=on`: deletes the fill's keys (with DEL, which works while the Key Value is full): `{"deleted":K}`. |
| `/upload`, `/files/:key`, `/probe/pg`, `/probe/s3` | 501 `{"error":{"code":"not_in_this_batch"}}` until a later batch of the parity work. |

The client bundle carries `VITE_GREETING` and `VITE_KEY` from the build
(`src/fixture/build-env.ts`). The Dockerfile declares both as build
arguments.

Entrypoints, run as `bun entrypoints/<name>.js` from the image:
`worker.js` logs `worker-started` and a heartbeat each minute, and with
`DATABASE_URL` works queue `fixture` and logs one `job-done <id>` line per
job; its pool has `CLOUD_DATABASE_POOL_SIZE` connections, 1 when unset, and
it stops at start when that is not a whole number of at least 1. On SIGTERM
it logs `worker-stopped` and exits 0. `tick.js [seconds]` sleeps the given
whole number of seconds, 0 by default, then logs `tick` and exits 0, so
`bun entrypoints/tick.js 400` outlasts a 5 minute schedule. `seed.js` logs
`seed-ran` and exits 0.

Knobs a test changes in a commit are in `src/fixture/knobs.ts`:
`HEALTHZ_FAILS_AT_BOOT`, `REVISION`, and for the migrate step
`MIGRATION_LOG` (a line it prints first, such as `migration-ran`) and
`MIGRATION_EXIT` (not 0: it prints why and exits with that code before
it migrates, so the Deploy fails).

`FIXTURE_PG_BUSY=<seconds>` (1 to 60) in the App's env keeps every
Postgres connection the process may open busy with `select
pg_sleep(<seconds>)`: the App on its own pool from boot, `worker.js` on
its pg-boss pool until it stops, and each `tick.js` run for 60 s on a
pool of `CLOUD_DATABASE_POOL_SIZE` connections (1 when unset) before it
logs `tick`. A query that fails logs `pg-busy-error` with Postgres's
message, such as `too many connections for role`.
