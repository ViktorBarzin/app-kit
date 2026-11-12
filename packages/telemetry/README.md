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
| `@viktorbarzin/telemetry/browser` | `initTelemetry`, `track`, `identify`, `reset`, `visitorHeaders` |
| `@viktorbarzin/telemetry/server` | `initServerTelemetry`, `track`, `identify`, `flush`, `closeAndFlush`, `withRequestContext` (Bun or Node) |
| `@viktorbarzin/telemetry` | the shared checks: `checkEvent`, `isProductionHost`, the patterns |

## Browser

<!-- typecheck-preamble
declare const writeKey: string;
declare const release: string;
declare const dsn: string | undefined;
declare const sub: string;
declare const signedInSub: string | undefined;
-->
```ts
import * as Sentry from "@sentry/browser";
import {
	identify,
	initTelemetry,
	reset,
	track,
	visitorHeaders,
} from "@viktorbarzin/telemetry/browser";

initTelemetry({
	writeKey,
	siteId: 1,
	release,
	productionHosts: ["example.com"], // example.com and *.example.com
	dsn, // https://<key>@<app host>/_t/x/<project>
	sentry: Sentry,
	personId: signedInSub, // the signed-in person's OIDC sub, if the page knows it
});

identify(sub); // right after sign-in: the person's OIDC sub
track("recording.started", { channel_id: 4 });
await fetch("/api/items", { headers: { ...visitorHeaders() } });
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
- initialises Sentry when both `dsn` and `sentry` are given. The app
  installs `@sentry/browser` itself and passes the module in; an app that
  does not pass it does not bundle it.

On a new visitor's first page, Segment calls wait until the Rybbit script has
created the visitor id, so Segment's anonymousId is that id from the first
event. They wait at most 5 seconds, or until the script fails to load, and
then go out under Segment's own id.

`identify` sets the person in Segment, Rybbit (`window.rybbit.identify`,
after the script has loaded) and Sentry. `reset` clears all three. With
`personId`, every `initTelemetry` identifies the person, so a session that
started signed in is tied to them too, not only the page load after sign-in.

Segment's anonymousId is the Rybbit script's visitor id (localStorage
`rybbit-visitor-id`): a returning visitor's at start, a new visitor's once
the script has run and created it. `visitorHeaders()` returns
`{ "X-Visitor-Id": <that id> }` for same-origin API calls, or `{}` before it
exists and off production. The server client reads the header and uses it as
the anonymousId of events sent while handling the call, so they land on the
same Rybbit user as the browser's pageviews.

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

### The request's sender

<!-- typecheck-preamble
declare function handle(request: Request): Promise<Response>;
-->
```ts
import { withRequestContext } from "@viktorbarzin/telemetry/server";

Bun.serve({ fetch: (request) => withRequestContext(request, () => handle(request)) });
```

In TanStack Start, a global request middleware in `src/start.ts`:
`createMiddleware().server(({ request, next }) => withRequestContext(request, next))`.
Nitro and Node handlers pass any object with `headers`, plus `{ peer }` for
the socket address. Inside it, every `track` and `identify`, through every
await, gets:

| Field | Value |
|---|---|
| `anonymousId` | the explicit one, else `X-Visitor-Id`. Without either: none when `userId` is set, else `defaultAnonymousId` (`server:<service>` unless set). Never a new random id per event |
| `context.ip` | `X-Real-Ip` (set by Traefik's real-ip middleware), else the first `X-Forwarded-For` entry, else `peer` |
| `context.userAgent` | the request's User-Agent, unless it is a Segment SDK agent, which Rybbit flags as a bot |

The event pipeline maps `context.ip` and `context.userAgent` to Rybbit's IP
and user agent, so server events get a country and a device.
`currentRequestContext()` returns what was read.

The client posts batches to `new URL(path, host)` with `path` defaulting to
`/v1/batch`, so a prefix such as `/_t/e/v1/batch` goes in `path`, not in
`host`. Every message carries `context.app` (`name`, `version`). `track`
needs no id at all; `identify` needs `userId`.
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

Dependencies: `@segment/analytics-next`, `@segment/analytics-node`. Sentry
(`@sentry/browser`, `@sentry/bun` or `@sentry/node`, major 10 or 11) is the
app's own dependency, passed in as a module. It is not declared as a peer:
Forgejo's npm registry drops `peerDependenciesMeta`, so an optional peer
became a required one and npm installed every Sentry SDK in every app.
