# @viktorbarzin/oidc-token

Verifies JWT bearer tokens an OIDC provider issued, for non-browser clients
(CLIs, agents, home automation). It pins RS256, the issuer from the
provider's discovery document, `aud` in the app's client IDs, and requires
`exp` and `sub`, using the provider's JWKS.

<!-- typecheck-preamble
import type { Counter } from "prom-client";
declare const verifications: Counter<"outcome">;
declare const request: Request;
-->
```ts
import { createDiscoveredVerifier } from "@viktorbarzin/oidc-token";

const tokens = createDiscoveredVerifier({
	discoveryUrl: "https://idp.example/application/o/myapp/.well-known/openid-configuration",
	audiences: ["myapp", "myapp-cli"],
	onOutcome: (outcome) => verifications.inc({ outcome }),
});
const verified = await tokens.verifyRequest(request); // null when absent or refused
```

| Export | |
|---|---|
| `createTokenVerifier(config, { keys?, onOutcome?, logger? })` | `(token) => VerifiedToken \| null` for a known issuer and JWKS URL |
| `createDiscoveredVerifier({ discoveryUrl, audiences, onOutcome?, logger? })` | discovery fetched once per process, retried on the next call after a failure |
| `fetchDiscovery(url, { timeoutMs?, fetch? })` | `{ issuer, jwks_uri }` |
| `bearerToken(request)` | the token in `Authorization: Bearer`, or null |
| `TokenOutcome` | `ok`, `expired`, `bad_<claim>`, `bad_alg`, `invalid`, `missing_claims`, `not_configured`, `no_discovery` |

Runtime dependency: `jose`. Optional peer: `@viktorbarzin/log`.
