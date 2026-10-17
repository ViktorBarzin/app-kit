/**
 * First bun test preload (bunfig.toml): registers a happy-dom window before
 * any test or library module loads, so Testing Library's `screen` binds to it.
 * Bun's own fetch, Request, Response and crypto are put back afterwards, so
 * server code under test behaves as it does under `bun .output/server/index.mjs`.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const bunGlobals = {
	fetch: globalThis.fetch,
	Request: globalThis.Request,
	Response: globalThis.Response,
	Headers: globalThis.Headers,
	FormData: globalThis.FormData,
	URL: globalThis.URL,
	URLSearchParams: globalThis.URLSearchParams,
	AbortController: globalThis.AbortController,
	AbortSignal: globalThis.AbortSignal,
	ReadableStream: globalThis.ReadableStream,
	TextEncoder: globalThis.TextEncoder,
	TextDecoder: globalThis.TextDecoder,
	crypto: globalThis.crypto,
};

GlobalRegistrator.register({ url: "http://localhost:3000/" });
Object.assign(globalThis, bunGlobals);
