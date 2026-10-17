/**
 * Test helpers for apps using @viktorbarzin/auth: a mock Authentik (OIDC
 * provider plus the /api/v3 calls the package makes) and helpers for HTTP
 * tests against a built server. Never import this from app code.
 */
export {
	type BuiltServer,
	CookieJar,
	follow,
	freePort,
	type Hop,
	SCRUBBED_ENV,
	type StartBuiltServerOptions,
	startBuiltServer,
} from "./built-server.js";
export {
	type AuthorizeRecord,
	type MockAuthentik,
	type MockAuthentikOptions,
	type MockUser,
	startMockAuthentik,
} from "./mock-authentik.js";
