import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { Button } from "#/components/ui/button";
import {
	approveAccessRequest,
	listAccessRequests,
} from "#/server/access.functions";

/**
 * Pending access requests, for admins. The admin check runs inside the
 * server functions; this page only shows what they return.
 */
export const Route = createFileRoute("/admin/requests")({
	loader: () => listAccessRequests(),
	component: RequestsPage,
	errorComponent: ({ error }) => (
		<main className="mx-auto max-w-xl p-6">
			<h1 className="mb-3 text-2xl font-semibold">Access requests</h1>
			<p role="alert">
				{error instanceof Error ? error.message : String(error)}
			</p>
		</main>
	),
});

function RequestsPage() {
	const requests = Route.useLoaderData();
	const router = useRouter();
	const [busy, setBusy] = useState<string | null>(null);
	const [failure, setFailure] = useState<string | null>(null);

	async function approve(sub: string) {
		setBusy(sub);
		setFailure(null);
		try {
			await approveAccessRequest({ data: { sub } });
		} catch (err) {
			setFailure(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(null);
			await router.invalidate();
		}
	}

	return (
		<main className="mx-auto flex max-w-xl flex-col gap-4 p-6">
			<h1 className="text-2xl font-semibold">Access requests</h1>
			{failure ? (
				<p role="alert" className="text-destructive">
					{failure}
				</p>
			) : null}
			{requests.length === 0 ? (
				<p data-testid="no-requests" className="text-muted-foreground">
					No one is waiting.
				</p>
			) : (
				<ul className="flex flex-col gap-3">
					{requests.map((request) => (
						<li
							key={request.sub}
							data-testid="access-request"
							className="flex items-center justify-between gap-3 rounded-md border p-3"
						>
							<div className="min-w-0">
								<p className="truncate font-medium">
									{request.name ?? request.username}
								</p>
								<p className="truncate text-sm text-muted-foreground">
									{request.username}
									{request.email && request.email !== request.username
										? ` · ${request.email}`
										: ""}
								</p>
								<p className="text-xs text-muted-foreground">
									{new Date(request.requestedAt).toLocaleString()}
								</p>
							</div>
							<Button
								onClick={() => approve(request.sub)}
								disabled={busy !== null}
							>
								{busy === request.sub ? "Approving..." : "Approve"}
							</Button>
						</li>
					))}
				</ul>
			)}
		</main>
	);
}
