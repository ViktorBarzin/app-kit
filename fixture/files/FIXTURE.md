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
| `GET /info` | `bootTime`, `serviceVersion` (`SERVICE_VERSION`), `instanceId` (`CLOUD_INSTANCE_ID` or null), `pid`, and `env`: every env name with the SHA-256 hex of its value. Never a value. |
| `GET /items` | Writes a row to table `items` (from the template's migration), reads it back: `{wrote, read}`. 503 without `DATABASE_URL`. |
| `GET /crash` | 202, then the process exits with code 42. |
| `GET /oom` | 202, then the process allocates 64 MiB every 20 ms until the kernel kills it. |
| `GET /unhealthy`, `GET /healthy` | Make `/healthz` answer 500, or 200 again. |
| `GET /healthz` | 200 `{"status":"ok"}`, or 500 after `/unhealthy` or when `HEALTHZ_FAILS_AT_BOOT` in `src/fixture/knobs.ts` is true. |
| `GET /slow?s=N` | Answers after N seconds, at most 600. |
| `GET /ws` | WebSocket: sends every text frame back. |
| `GET /sse?every=N` | Server-Sent Events: one `data:` event at once, then one every N seconds (default 5). |
| `GET /egress-ip` | `{ip, source}`: the address a public IP echo service sees. |
| `GET /tcp?host=H&port=P` | A TCP connect with a 10 s timeout: `{connected, error, ms}`. Only `smtp.gmail.com` on ports 25, 465, 587, 2525 and 443, and `www.google.com` on 443, the SMTP test's control. |
| `GET /fetch?url=U` | A GET with a 10 s timeout: `{connected, status, error, ms}`, never the body. Only the App's own origins (`CLOUD_PUBLIC_URL`, each `CLOUD_URL_<NAME>`, the comma-separated `FIXTURE_FETCH_ALLOW`) and https hosts under viktorbarzin.me. |
| `GET /build-assets` | `{assets}`: the client build's JS files, for the build env test. |
| `/enqueue`, `/kv-selftest`, `/upload`, `/files/:key`, `/probe/pg`, `/probe/kv`, `/probe/s3` | 501 `{"error":{"code":"not_in_this_batch"}}` until a later batch of the parity work. |

The client bundle carries `VITE_GREETING` and `VITE_KEY` from the build
(`src/fixture/build-env.ts`). The Dockerfile declares both as build
arguments.

Entrypoints, run as `bun entrypoints/<name>.js` from the image:
`worker.js` logs `worker-started` and a heartbeat each minute, `tick.js`
logs `tick` and exits 0, `seed.js` logs `seed-ran` and exits 0.

Knobs a test changes in a commit are in `src/fixture/knobs.ts`.
