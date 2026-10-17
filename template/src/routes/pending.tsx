import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { app } from "#/app.config";
import { Button } from "#/components/ui/button";
import { getAccessStatus, recheckAccess } from "#/server/access.functions";

/** Sign-in start, coming back here. */
const SIGN_IN_HREF = "/api/auth/start?return=%2Fpending";

export const Route = createFileRoute("/pending")({
	loader: () => getAccessStatus(),
	component: PendingPage,
});

function PendingPage() {
	const status = Route.useLoaderData();
	const router = useRouter();
	const [checking, setChecking] = useState(false);
	const [stillWaiting, setStillWaiting] = useState(false);

	async function checkAgain() {
		setChecking(true);
		const next = await recheckAccess();
		setChecking(false);
		setStillWaiting(!next.member);
		await router.invalidate();
	}

	return (
		<main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-5 p-6">
			<h1 className="text-2xl font-semibold">{app.displayName}</h1>
			{!status.signedIn ? (
				<>
					<p className="text-muted-foreground">
						Sign in to use {app.displayName}.
					</p>
					<Button asChild className="self-start">
						<a href={SIGN_IN_HREF}>Sign in</a>
					</Button>
				</>
			) : status.member ? (
				<>
					<p data-testid="access-granted">
						You have access, {status.username}.
					</p>
					<Button asChild className="self-start">
						<a href="/">Open {app.displayName}</a>
					</Button>
				</>
			) : (
				<>
					<p data-testid="access-pending">
						You are signed in as <strong>{status.username}</strong>. Your
						request to use {app.displayName} is waiting for an admin to approve
						it.
					</p>
					{status.requestedAt ? (
						<p className="text-sm text-muted-foreground">
							Requested {new Date(status.requestedAt).toLocaleString()}
						</p>
					) : null}
					{stillWaiting ? (
						<output className="text-sm text-muted-foreground">
							Not approved yet.
						</output>
					) : null}
					<div className="flex gap-3">
						<Button onClick={checkAgain} disabled={checking}>
							{checking ? "Checking..." : "Check again"}
						</Button>
					</div>
				</>
			)}
		</main>
	);
}
