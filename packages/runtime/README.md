# @viktorbarzin/runtime

Process-level plumbing for a Bun web app. Framework-free: every function takes
a `Request` or returns a `Response`, and the app wires it into its middleware
and routes.

```ts
import {
	ApiError, createErrorResponder, extendIdleTimeout, healthResponse,
	installShutdown, readJson, trackRequest, withFrameDenial,
} from "@viktorbarzin/runtime";

// once, at boot
installShutdown({
	beforeDrain: [{ name: "realtime", run: () => realtime.stop() }],
	afterDrain: [{ name: "pool", run: () => pool.close() }],
});

// in a route
const body = await readJson(request, z.object({ title: z.string().min(1) })); // 422 validation_error on failure
throw new ApiError(409, "conflict", "already there");
```

| Export | |
|---|---|
| `processSingleton(key, create)` | one value per process on `globalThis[Symbol.for("@viktorbarzin:<key>")]`, for servers bundled twice |
| `extendIdleTimeout(request, s = 120)`, `keepRequestOpen(request)` | Bun's per-request idle timeout (default 10 s) raised, or lifted for a stream; false off Bun |
| `trackRequest()`, `requestsInFlight()`, `waitForDrain(ms)` | in-flight accounting for graceful shutdown |
| `shutdown(signal, opts)`, `installShutdown(opts)` | `beforeDrain` steps, wait for in-flight requests (`drainMs`, default 5000), `afterDrain` steps, exit 0; a failing step is logged and the rest still run |
| `ApiError`, `errorResponse`, `createErrorResponder({ mappers, logger })` | the `{"error": {"code", "message"}}` envelope; app-specific errors map through `mappers`; anything else is logged and answered 500 `internal_error` |
| `readJson(request, schema)`, `readQuery(request, schema)`, `validationMessage` | zod validation; failures name fields, never values |
| `noContent()`, `healthResponse()` | 204; `{"status":"ok"}` |
| `FRAME_DENY_HEADERS`, `withFrameDenial(response)` | `frame-ancestors 'none'` and `X-Frame-Options: DENY`, keeping a policy the route set |

Peers: `@viktorbarzin/log`, `zod` ^4.6.
