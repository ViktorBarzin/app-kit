/**
 * The two @sentry/browser functions telemetry calls. Importing them by name,
 * rather than the whole module, lets the bundler leave out the rest of the
 * SDK (replay, tracing); components/telemetry.tsx loads this lazily.
 */
export { init, setUser } from "@sentry/browser";
