# @viktorbarzin/log

A JSON-lines logger for the platform's log contract: one object per line on
stderr with `ts` (Python `isoformat`, `+00:00`), `level`, `logger`, `msg`,
then the call's extras (which never overwrite those four keys), then `exc`
for an error. No dependencies; works on Bun and Node.

<!-- typecheck-preamble
declare const err: unknown;
-->
```ts
import { getLogger, installJsonConsole } from "@viktorbarzin/log";

const log = getLogger("myapp.sync");
log.info("sync served", { user: "someone", lists: 3 });
log.exception("sync failed", err, { path: "/api/sync" });

installJsonConsole(); // console.* from the framework becomes JSON lines too (logger "console")
```

```json
{"ts":"2026-10-16T04:05:06.789000+00:00","level":"INFO","logger":"myapp.sync","msg":"sync served","user":"someone","lists":3}
```

## API

| Export | |
|---|---|
| `getLogger(name)` | `debug`, `info`, `warning`, `error`, `exception(msg, err, extra?)`, `record(level, msg, extra?, err?)` |
| `parseLogLevel(raw)` | `WARN` → `WARNING`; unknown or unset → `INFO` |
| `setLogLevel(level)` | the threshold; starts from `LOG_LEVEL` |
| `setLogSink(sink)` | send lines elsewhere (tests); returns a restore function |
| `installJsonConsole(target?)` | route `console.*` through the logger; an `Error` argument goes under `exc`; returns a restore function |
| `formatRecord`, `pythonIsoTimestamp` | the formatting, exported for tests |

The sink and threshold are one per process (kept on `globalThis`), so a
server bundled twice still logs through one sink. `LOG_LEVEL` is the only
environment variable read.
