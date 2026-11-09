/**
 * Starts browser telemetry once per page (@viktorbarzin/telemetry/browser):
 * the Rybbit script, the Segment client and, with a DSN, Sentry. It does
 * nothing off the production hosts in app.config.ts. Sentry loads as its
 * own chunk, only when a DSN is configured.
 *
 * Product events: `track("noun.past_verb", { snake_case: ... })` from
 * `@viktorbarzin/telemetry/browser`. Call `reset()` from there on sign-out.
 */
import { identify, initTelemetry } from "@viktorbarzin/telemetry/browser";
import { useEffect } from "react";

import type { BrowserTelemetrySettings } from "#/server/telemetry.functions";

export function Telemetry({
	settings,
}: {
	settings: BrowserTelemetrySettings | null;
}) {
	useEffect(() => {
		if (!settings) return;
		const { dsn, personId } = settings;
		void (dsn ? import("#/lib/sentry") : Promise.resolve(undefined)).then(
			(sentry) => {
				initTelemetry({
					writeKey: settings.writeKey,
					siteId: settings.siteId,
					release: settings.release,
					environment: settings.environment,
					productionHosts: settings.productionHosts,
					dsn: dsn ?? undefined,
					sentry,
				});
				if (personId) identify(personId);
			},
		);
	}, [settings]);
	return null;
}
