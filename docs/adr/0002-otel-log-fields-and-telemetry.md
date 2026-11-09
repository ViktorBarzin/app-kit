---
status: accepted
date: 2026-11-09
---

# ADR-0002: OpenTelemetry field names for logs, and telemetry on by default in new apps

Supersedes the log line in [ADR-0001](0001-default-app-stack.md), Delivery,
Shared code ("Logging follows the existing JSON-lines contract (`ts`,
`level`, `logger`, `msg`, plus extras)"). Related: infra ADR-0041 (product
analytics on Rybbit behind a Vector pipeline, errors in GlitchTip) and the
infra design `docs/plans/2026-11-09-product-analytics-design.md`, which
defines the telemetry standard.

## Context

ADR-0001 kept the log line that the Python services already wrote: `ts` in
Python's `isoformat`, `level`, `logger`, `msg`, extras, and `exc` for an
error, on stderr. `@viktorbarzin/log` 0.1 implements it.

Infra ADR-0041 sets one telemetry standard for every app we serve: product
events in the Segment spec through an ingest path on each app's host,
pageviews and session replay from the Rybbit script, errors through the
Sentry SDKs to GlitchTip, and logs as JSON lines on stdout using
OpenTelemetry field names. One set of field names across TypeScript,
Python, Go and Kotlin lets one Loki query and one dashboard cover every app,
and lets a later move to an OpenTelemetry collector keep the same names.

## Decision

1. **Log lines use the OpenTelemetry log data model and semantic
   conventions.** One JSON object per line on stdout:

   | Field | Value |
   |---|---|
   | `timestamp` | RFC 3339 in UTC, nine fractional digits, `Z` |
   | `severity_text`, `severity_number` | `DEBUG` 5, `INFO` 9, `WARN` 13, `ERROR` 17, `FATAL` 21 |
   | `body` | the message |
   | `logger.name` | the logger's name |
   | `service.name`, `service.version`, `deployment.environment.name` | the app, its release, `production` or `dev` |
   | `trace_id`, `span_id` | when known |
   | `enduser.id` | the person's Authentik `sub`, when known |
   | `exception.type`, `exception.message`, `exception.stacktrace` | for an error |
   | other keys | snake_case attributes |

   `logger.name` is not an OpenTelemetry attribute. The data model records
   the logger name as the instrumentation scope name, which has no flat key,
   so we chose a key in the same dotted style.

2. **`@viktorbarzin/log` 1.0 writes this line.** Its call sites stay the
   same (`getLogger`, `installJsonConsole`, `setLogSink`, `setLogLevel`), so
   apps upgrade by bumping the version. It adds `withLogContext` and
   `setLogContext` (per-request `enduser.id`, `trace_id`, `span_id`, backed
   by `AsyncLocalStorage`) and `setLogService`. The service fields default to
   `OTEL_SERVICE_NAME`, `SERVICE_VERSION` and `DEPLOYMENT_ENVIRONMENT`.

3. **`@viktorbarzin/telemetry` is the TypeScript client for the rest of the
   standard.** `/browser` injects the Rybbit script, loads the Segment
   browser SDK with inline settings (it never contacts Segment), and can
   start Sentry. `/server` sends events with the Segment Node SDK to the
   event pipeline. Both check event names and property keys before sending.
   The package holds no hostnames of ours: the production domains, the
   pipeline's address and the DSN are config inputs.

4. **New apps have telemetry on by default.** The template starts the
   browser and server clients whenever a write key is configured, puts the
   service fields and `enduser.id` on its log lines, and sets
   `SERVICE_VERSION` in the image. An app opts out with
   `telemetry.enabled: false` in `app.config.ts` or `TELEMETRY=off`.

## Consequences

- Every package that names `@viktorbarzin/log` as a peer moves with it. With
  changesets' default rules, the log major bumps each dependent package
  (runtime, metrics, pg, oidc-token, auth, realtime) to 1.0.0 as well when
  the release is versioned.
- Loki queries, dashboards and tests that read `ts`, `level`, `logger`,
  `msg` or `exc` need the new keys. App-kit's own tests moved in the same
  change.
- Lines move from stderr to stdout. Alloy collects both, so collection does
  not change.
- JavaScript's clock has millisecond precision, so `timestamp` carries six
  trailing zeros unless the caller passes nanoseconds.

## Open questions

- Whether the infra `tanstack_app` module should pass `TELEMETRY_WRITE_KEY`,
  `SENTRY_DSN` and `OTEL_SERVICE_NAME` to every app it deploys, or each
  stack adds them.
- The Python, Go and Kotlin libraries are not written yet; they are expected
  to use the same keys, `logger.name` included.
