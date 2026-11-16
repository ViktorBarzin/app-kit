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
| `GET /info` | `bootTime`, `serviceVersion` (`SERVICE_VERSION`), `instanceId` (`CLOUD_INSTANCE_ID` or null), `pid`, `env` and `empty`. `env` has every env name. Its value is the SHA-256 hex of the variable's value for the names the parity suite sets (`TOKEN`, `SESSION_SECRET`, `FOO`, `VITE_GREETING`, `VITE_KEY`, and names starting `FIXTURE_` or a checklist ID such as `P27_`) and for `SERVICE_VERSION`, `CLOUD_INSTANCE_ID` and `CLOUD_PUBLIC_URL`; it is null for every other name, so a platform credential's hash is never on a public URL. `empty` lists the names whose value is empty. Never a value. |
| `GET /items` | Writes a row to table `items` (from the template's migration), reads it back, then deletes it: `{wrote, read, deleted}`. 503 without `DATABASE_URL`. |
| `GET /enqueue` | Queues a pg-boss job with a fresh id on queue `fixture`: `{id}`. The worker entrypoint logs `job-done <id>` when it has done it. It uses the App's own pool through pg-boss's `fromBunSql`, so it opens no second pool. 503 without `DATABASE_URL`. |
| `GET /crash` | 202, then the process exits with code 42. |
| `GET /oom` | 202, then the process allocates 64 MiB every 20 ms until the kernel kills it. |
| `GET /unhealthy`, `GET /healthy` | Make `/healthz` answer 500, or 200 again. |
| `GET /healthz` | 200 `{"status":"ok"}`, or 500 after `/unhealthy` or when `HEALTHZ_FAILS_AT_BOOT` in `src/fixture/knobs.ts` is true. |
| `GET /slow?s=N` | Answers after N seconds, at most 600. |
| `GET /ws` | WebSocket: sends every text frame back. |
| `GET /sse?every=N` | Server-Sent Events: one `data:` event at once, then one every N seconds (default 5). The stream ends after 15 min. |
| `GET /log?n=N&tag=T` | Writes N lines `fixture-log T 1` to `fixture-log T N` to the App's log, at most 200; T is 1-40 of a-z, 0-9 and `-`. |
| `GET /egress-ip` | `{ip, source}`: the address a public IP echo service sees. |
| `GET /tcp?host=H&port=P` | A TCP connect with a 9 s timeout, under the SMTP test's 10 s: `{connected, error, ms}`; `error` is only the kind of failure (`timeout`, `refused`, `dns`, `unreachable`, `reset` or `error`). Only `smtp.gmail.com` on ports 25, 465, 587, 2525 and 443, and `www.google.com` on 443, the SMTP test's control. |
| `GET /fetch?url=U` | A GET with a 10 s timeout: `{connected, status, error, ms}`, never the body; `error` as for `/tcp`. Only the App's own origins (`CLOUD_PUBLIC_URL`, each `CLOUD_URL_<NAME>`) and the origins its owner lists, comma-separated, in `FIXTURE_FETCH_ALLOW`. |
| `GET /build-assets` | `{assets}`: the client build's JS files, for the build env test. |
| `/kv-selftest`, `/upload`, `/files/:key`, `/probe/pg`, `/probe/kv`, `/probe/s3` | 501 `{"error":{"code":"not_in_this_batch"}}` until a later batch of the parity work. |

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

Knobs a test changes in a commit are in `src/fixture/knobs.ts`.
