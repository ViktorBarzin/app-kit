/**
 * What the browser needs to start telemetry (src/components/telemetry.tsx):
 * the write key, site, DSN and release from the server's environment, so
 * one image serves every environment. Null while telemetry is off.
 */
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

import { appAuth } from "./auth.server";
import { telemetrySettings } from "./env.server";

export interface BrowserTelemetrySettings {
	writeKey: string;
	siteId: string;
	release: string;
	environment: string;
	dsn: string | null;
	productionHosts: string[];
	/** The signed-in person's `sub`, for identify; null when signed out. */
	personId: string | null;
}

export const getTelemetrySettings = createServerFn({ method: "GET" }).handler(
	async (): Promise<BrowserTelemetrySettings | null> => {
		const settings = telemetrySettings();
		if (!settings) return null;
		const user = await appAuth.resolveUser(getRequest()).catch(() => null);
		return {
			writeKey: settings.writeKey,
			siteId: settings.siteId,
			release: settings.release,
			environment: settings.environment,
			dsn: settings.dsn,
			productionHosts: [...settings.productionHosts],
			personId: user?.sub ?? null,
		};
	},
);
