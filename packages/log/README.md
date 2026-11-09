# @viktorbarzin/log

A JSON-lines logger for the platform's log standard (app-kit ADR-0002): one
object per line on stdout, with field names from the OpenTelemetry log data
model and semantic conventions. No dependencies; works on Bun and Node.

<!-- typecheck-preamble
declare const err: unknown;
declare const request: Request;
declare const handle: (request: Request) => Promise<Response>;
-->
```ts
import {
	getLogger,
	installJsonConsole,
	setLogContext,
	withLogContext,
} from "@viktorbarzin/log";

const log = getLogger("myapp.sync");
log.info("sync served", { lists: 3, duration_ms: 12 });
log.exception("sync failed", err, { path: "/api/sync" });

// Per request: every line inside carries enduser.id, trace_id and span_id.
await withLogContext({ traceId: request.headers.get("x-trace-id") ?? undefined }, async () => {
	setLogContext({ enduserId: "the person's OIDC sub" });
	return handle(request);
});

installJsonConsole(); // console.* from the framework becomes JSON lines too (logger "console")
```

```json
{"timestamp":"2026-10-16T04:05:06.789000000Z","severity_text":"INFO","severity_number":9,"body":"sync served","logger.name":"myapp.sync","service.name":"myapp","service.version":"1a2b3c4d","deployment.environment.name":"production","enduser.id":"…","lists":3,"duration_ms":12}
```

## Fields

| Field | Meaning |
|---|---|
| `timestamp` | RFC 3339 in UTC with nine fractional digits and `Z`. JavaScript's clock has millisecond precision, so the last six digits are zero unless `formatRecord` is given nanoseconds |
| `severity_text`, `severity_number` | `DEBUG` 5, `INFO` 9, `WARN` 13, `ERROR` 17, `FATAL` 21 |
| `body` | the message |
| `logger.name` | the name given to `getLogger` |
| `service.name`, `service.version`, `deployment.environment.name` | from `setLogService`, else `OTEL_SERVICE_NAME`, `SERVICE_VERSION`, `DEPLOYMENT_ENVIRONMENT` |
| `trace_id`, `span_id`, `enduser.id` | from the current `withLogContext` scope |
| extras | the call's extras (snake_case keys by convention), after the scope's `attributes` |
| `exception.type`, `exception.message`, `exception.stacktrace` | for an error, last |

Fields with no value are left out rather than written as `null`. Extras
never overwrite the standard fields.

`logger.name` is our key. OpenTelemetry's data model records the logger
name as the instrumentation scope name, which has no attribute key of its
own in a flat JSON line, and the semantic conventions define no logger
attribute. `logger.name` keeps the dotted OpenTelemetry style and says
what the value is. The libraries for other languages should use the same
key, so that one Loki query covers every app.

## API

| Export | |
|---|---|
| `getLogger(name)` | `debug`, `info`, `warn` (and `warning`), `error`, `fatal`, `exception(msg, err, extra?)`, `record(level, msg, extra?, err?)` |
| `withLogContext(context, fn)` | run `fn` with `enduserId`, `traceId`, `spanId` and `attributes` on every line written inside it, async work included; scopes nest |
| `setLogContext(context)` | add fields to the current scope (for example once the session is known); false outside a scope |
| `getLogContext()` | the current scope's fields |
| `setLogService(service)` | set `name`, `version`, `environment` explicitly; returns a restore function |
| `serviceFromEnv(env?)` | the service fields from the environment |
| `parseLogLevel(raw)` | `WARNING` → `WARN`; unknown or unset → `INFO` |
| `setLogLevel(level)` | the threshold; starts from `LOG_LEVEL` (`WARNING` is accepted for `WARN`) |
| `setLogSink(sink)` | send lines elsewhere (tests); returns a restore function |
| `installJsonConsole(target?)` | route `console.*` through the logger; an `Error` argument goes under `exception.*`; returns a restore function |
| `formatRecord`, `formatTimestamp`, `SEVERITY_NUMBER` | the formatting, exported for tests |

The sink, threshold, service fields and context store are one per process
(kept on `globalThis`), so a server bundled twice still logs through one
sink and one context. The environment variables read are `LOG_LEVEL`,
`OTEL_SERVICE_NAME`, `SERVICE_VERSION` and `DEPLOYMENT_ENVIRONMENT`.

## Upgrading from 0.x

1.0 renames every field (ADR-0002) and writes to stdout instead of stderr.
Code that calls the logger needs no change. Loki queries, dashboards and
tests that read `ts`, `level`, `logger`, `msg` or `exc` move to
`timestamp`, `severity_text`, `logger.name`, `body` and `exception.*`.
