import { createFileRoute } from "@tanstack/react-router";
import { healthResponse } from "@viktorbarzin/runtime";

/** Liveness and readiness probe: `{"status":"ok"}`. */
export const Route = createFileRoute("/healthz")({
	server: { handlers: { GET: () => healthResponse() } },
});
