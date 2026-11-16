/**
 * Two build-time variables the browser bundle carries, for Cloud's build
 * env test: VITE_GREETING, a plain env var, must be in the bundle, and
 * VITE_KEY, a secret, must never be. Vite inlines each value at build time.
 */
export const buildEnv = {
	greeting: import.meta.env.VITE_GREETING ?? "",
	key: import.meta.env.VITE_KEY ?? "",
};
