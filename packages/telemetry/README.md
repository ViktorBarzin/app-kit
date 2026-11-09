# @viktorbarzin/telemetry

Product events, pageviews, session replay and error reports for apps on the
platform's telemetry standard. Everything goes through an ingest path on the
app's own host (`/_t/` by default):

| Path | Receives | From |
|---|---|---|
| `/_t/r/` | the Rybbit script, pageviews, replay | `@viktorbarzin/telemetry/browser` |
| `/_t/e/` | Segment-spec product events | the Segment SDKs, browser and server |
| `/_t/x/` | Sentry envelopes | `@sentry/browser`, `@sentry/bun`, with a DSN on that path |

Three entry points:

| Import | For |
|---|---|
| `@viktorbarzin/telemetry/browser` | `initTelemetry`, `track`, `identify`, `reset` |
| `@viktorbarzin/telemetry/server` | `initServerTelemetry`, `track`, `identify`, `flush`, `closeAndFlush` (Bun or Node) |
| `@viktorbarzin/telemetry` | the shared checks: `checkEvent`, `isProductionHost`, the patterns |

## Browser

<!-- typecheck-preamble
declare const writeKey: string;
declare const release: string;
declare const dsn: string | undefined;
declare const sub: string;
-->
```ts
import * as Sentry from "@sentry/browser";
import { identify, initTelemetry, reset, track } from "@viktorbarzin/telemetry/browser";

initTelemetry({
	writeKey,
	siteId: 1,
	release,
	productionHosts: ["example.com"], // example.com and *.example.com
	dsn, // https://<key>@<app host>/_t/x/<project>
	sentry: Sentry,
});

identify(sub); // after sign-in: the person's OIDC sub
track("recording.started", { channel_id: 4 });
reset(); // on sign-out
```

On a host outside `productionHosts` (localhost, previews), `initTelemetry`
loads nothing and sends nothing, and `track` prints a console warning for an
event the pipeline would reject. On a production host it:

- adds `<script src="/_t/r/script.js" data-site-id="1" defer data-replay-mask-all-inputs="false" data-replay-mask-input-options='{"password":true}'>`
  to the page. Rybbit (v2.9.2) turns session replay on per site, from the
  site's settings, so the tag has no replay switch; its attributes only say
  that replay masks password inputs and nothing else;
- loads `@segment/analytics-next` with the source settings inline, so it
  never contacts Segment: events go to `https://<host>/_t/e/v1/<t|i|...>`
  with the write key as Basic auth, SDK metrics are off, and there is no
  automatic `page()` (pageviews come from Rybbit);
- initialises Sentry when both `dsn` and `sentry` are given. Sentry is an
  optional peer: an app that does not pass it does not bundle it.

`identify` sets the person in Segment, Rybbit (`window.rybbit.identify`,
after the script has loaded) and Sentry. `reset` clears all three.

## Server

<!-- typecheck-preamble
declare const writeKey: string;
declare const release: string;
declare const dsn: string | undefined;
-->
```ts
import * as Sentry from "@sentry/bun";
import { closeAndFlush, initServerTelemetry, track } from "@viktorbarzin/telemetry/server";

initServerTelemetry({
	writeKey,
	host: "http://pipeline.example.svc.cluster.local", // the event pipeline, inside the cluster
	release,
	service: "myapp",
	dsn,
	sentry: Sentry,
});

track({ event: "trip.created", properties: { trip_id: 12 }, userId: "the person's sub" });

process.on("SIGTERM", () => void closeAndFlush());
```

The client posts batches to `new URL(path, host)` with `path` defaulting to
`/v1/batch`, so a prefix such as `/_t/e/v1/batch` goes in `path`, not in
`host`. Every message carries `context.app` (`name`, `version`).
`enabled: false` keeps the checks and sends nothing.

## The checks

Both clients apply the pipeline's rules before sending:

| Rule | On failure |
|---|---|
| event name matches `^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$` (`noun.past_verb`) | the event is dropped |
| property keys match `^[a-z][a-z0-9_]*$` | the key is dropped |
| `properties` as JSON is at most 2,048 characters | the event is dropped |

The browser client warns off production and is silent in production. The
server client warns through `warn` (default `console.warn`) every time.

```ts
import { checkEvent } from "@viktorbarzin/telemetry";

checkEvent("item.created", { item_id: 1, itemName: "x" });
// { accepted: { event: "item.created", properties: { item_id: 1 } },
//   problems: ['property key is not snake_case: "itemName"'] }
```

Dependencies: `@segment/analytics-next`, `@segment/analytics-node`. Optional
peers: `@sentry/browser`, `@sentry/bun`, passed in as modules.
