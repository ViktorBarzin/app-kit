---
"@viktorbarzin/log": major
---

Log lines use OpenTelemetry log data model field names (app-kit ADR-0002), replacing `ts`, `level`, `logger`, `msg` and `exc`: `timestamp` (RFC 3339, nine fractional digits, `Z`), `severity_text` and `severity_number`, `body`, `logger.name`, `service.name`, `service.version`, `deployment.environment.name`, `trace_id`, `span_id`, `enduser.id`, and `exception.type`, `exception.message`, `exception.stacktrace`. Lines go to stdout instead of stderr.

- New: `withLogContext`, `setLogContext` and `getLogContext` for per-request fields; `setLogService` and `serviceFromEnv` for the service fields (`OTEL_SERVICE_NAME`, `SERVICE_VERSION`, `DEPLOYMENT_ENVIRONMENT`); `warn` and `fatal` on the logger; `formatTimestamp` and `SEVERITY_NUMBER`.
- Changed: the level is `WARN` (`WARNING` is still accepted by `setLogLevel`, `record` and `LOG_LEVEL`), `formatRecord` takes an optional scope, and `pythonIsoTimestamp` is removed.
- Callers keep `getLogger`, `installJsonConsole`, `setLogSink`, `setLogLevel` and `parseLogLevel` as they were. Loki queries and dashboards that read the old keys need the new ones.
