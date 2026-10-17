# @viktorbarzin/metrics

Prometheus metrics for an app: one prom-client registry per process with the
default process metrics, the HTTP request metrics every app exports, and
`/metrics` on a port of its own that the ingress never routes (point the
pod's `prometheus.io/port` annotation at it).

```ts
import { createHandlerLabeler, getRegistry, observeRequest, parseMetricsPort, startMetricsServer } from "@viktorbarzin/metrics";

// at boot (Bun)
const metrics = startMetricsServer({ port: parseMetricsPort(process.env.METRICS_PORT) });

// request middleware
const label = createHandlerLabeler({ known: ["/api/items", "/healthz"] });
const done = observeRequest(request, { label, accessLog: getLogger("myapp.http") });
// ... handle ...
done(response.status);

// app metrics
new Counter({ name: "myapp_things_total", help: "...", registers: [getRegistry()] });
```

| Export | |
|---|---|
| `getRegistry()` | the process registry, with `collectDefaultMetrics` |
| `httpMetrics()` | `http_requests_total{method,handler,status}` (status as `2xx`), `http_request_duration_seconds{method,handler}` |
| `createHandlerLabeler({ known, buckets? })` | known paths by name; default buckets `/api/auth/` → `/api/auth`, `/api/` → `/api/other`, `/_serverFn/` → `/_serverFn`, else `page` |
| `observeRequest(request, { label, accessLog?, accessLogPrefix? })` | raises the idle timeout, tracks the request, returns `done(status)` that records the metrics and one access-log line `{method, path, status, duration_ms}` under the prefix (default `/api/`) |
| `metricsResponse(registry?)` | the text format |
| `parseMetricsPort(raw)` | a port or null (ERROR logged for junk) |
| `startMetricsServer({ port, hostname?, registry? })` | `Bun.serve` answering `/metrics` only; null without a port |

Peers: `prom-client` ^15.1, `@viktorbarzin/log`, `@viktorbarzin/runtime`.
