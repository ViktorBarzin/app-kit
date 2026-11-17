/**
 * How long a request may go without a byte either way before Bun closes it.
 * observeRequest (@viktorbarzin/metrics) raises Bun's 10 s default to the
 * runtime's 120 s; this raises it again to Bun's maximum, 255 s. Cloud gives
 * a request 125 s to start its answer (`cloud help limits`), so at 120 s Bun
 * would cut a slow answer that the edge still waits for.
 */
import { extendIdleTimeout } from "@viktorbarzin/runtime";

/** Bun's maximum idle timeout, in seconds. */
export const REQUEST_IDLE_S = 255;

/** Raise this request's idle timeout; false off Bun (tests, vite dev). */
export function raiseIdleTimeout(request: Request): boolean {
	return extendIdleTimeout(request, REQUEST_IDLE_S);
}
