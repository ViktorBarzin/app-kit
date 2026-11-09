import type { QueryClient } from "@tanstack/react-query";
import {
	createRootRouteWithContext,
	HeadContent,
	Outlet,
	Scripts,
} from "@tanstack/react-router";
import type { ReactNode } from "react";

import { app } from "#/app.config";
import { Telemetry } from "#/components/telemetry";
import { getTelemetrySettings } from "#/server/telemetry.functions";
import appCss from "../styles.css?url";

interface RouterContext {
	queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{ name: "viewport", content: "width=device-width, initial-scale=1" },
			{ title: app.displayName },
		],
		links: [{ rel: "stylesheet", href: appCss }],
	}),
	// Telemetry settings, once per document load (sign-in reloads the page).
	loader: () => getTelemetrySettings(),
	staleTime: Number.POSITIVE_INFINITY,
	shellComponent: RootDocument,
	component: Root,
});

function Root() {
	return (
		<>
			<Telemetry settings={Route.useLoaderData()} />
			<Outlet />
		</>
	);
}

function RootDocument({ children }: { children: ReactNode }) {
	return (
		<html lang="en">
			<head>
				<HeadContent />
			</head>
			<body>
				{children}
				<Scripts />
			</body>
		</html>
	);
}
