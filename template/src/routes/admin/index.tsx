import { createFileRoute, redirect } from "@tanstack/react-router";

import { app } from "#/app.config";
import { getAccessStatus, getAdminOverview } from "#/server/access.functions";

/**
 * The admin home: admins only (on Cloud, the Project owner). The admin check
 * runs inside getAdminOverview; a non-admin sees its "admins only" error.
 * Put the app's admin-only tools here.
 */
export const Route = createFileRoute("/admin/")({
	loader: async () => {
		const status = await getAccessStatus({ data: { returnTo: "/admin" } });
		if (!status.signedIn)
			throw redirect({ href: status.signInUrl, reloadDocument: true });
		return { status, overview: await getAdminOverview() };
	},
	component: AdminPage,
	errorComponent: ({ error }) => (
		<main className="mx-auto max-w-xl p-6">
			<h1 className="mb-3 text-2xl font-semibold">Admin</h1>
			<p role="alert">
				{error instanceof Error ? error.message : String(error)}
			</p>
		</main>
	),
});

function AdminPage() {
	const { status, overview } = Route.useLoaderData();
	return (
		<main
			className="mx-auto flex max-w-xl flex-col gap-4 p-6"
			data-testid="admin-home"
		>
			<h1 className="text-2xl font-semibold">Admin</h1>
			<p className="text-muted-foreground">
				Signed in to {app.displayName} as {overview.username}.
			</p>
			{status.cloud ? (
				<p data-testid="cloud-access">
					Who may use this app is set in Cloud, with the app's access setting.
				</p>
			) : (
				<a className="underline" href="/admin/requests">
					Access requests ({overview.pendingRequests ?? 0})
				</a>
			)}
			<a className="text-sm underline" href="/">
				Back to {app.displayName}
			</a>
		</main>
	);
}
