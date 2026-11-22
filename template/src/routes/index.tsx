import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { CLIENT_ID_HEADER, clientId } from "@viktorbarzin/realtime/client";
import { useRealtimeInvalidation } from "@viktorbarzin/realtime/react";
import { type FormEvent, useState } from "react";

import { app } from "#/app.config";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { itemKeys } from "#/lib/query-keys";
import { getAccessStatus, type PageAccess } from "#/server/access.functions";
import { addItem, listItems } from "#/server/items.functions";

/**
 * The home page. Signed-out visitors see a landing page with a sign-in link
 * (the link comes from the auth object: the app's own on Authentik, the
 * edge's on Cloud), so a public App answers / with 200. People waiting for
 * approval go to /pending, members see their items.
 */
export const Route = createFileRoute("/")({
	loader: async () => {
		const status = await getAccessStatus({ data: { returnTo: "/" } });
		if (status.signedIn && !status.member) throw redirect({ to: "/pending" });
		return status;
	},
	component: Home,
});

function Home() {
	const status = Route.useLoaderData();
	return status.signedIn ? (
		<Items status={status} />
	) : (
		<Landing signInUrl={status.signInUrl} />
	);
}

function Landing({ signInUrl }: { signInUrl: string }) {
	return (
		<main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-5 p-6">
			<h1 className="text-2xl font-semibold">{app.displayName}</h1>
			<p className="text-muted-foreground">Sign in to use {app.displayName}.</p>
			<Button asChild className="self-start">
				<a href={signInUrl}>Sign in</a>
			</Button>
		</main>
	);
}

function Items({ status }: { status: PageAccess }) {
	const queryClient = useQueryClient();
	const [title, setTitle] = useState("");
	// Other tabs' writes arrive over SSE; when the connection budget keeps
	// realtime off, the list refetches every app.pollMs instead.
	useRealtimeInvalidation({ queryClient, enabled: status.realtime });
	const items = useQuery({
		queryKey: itemKeys.all,
		queryFn: () => listItems(),
		refetchInterval: status.realtime ? false : app.pollMs,
	});
	const add = useMutation({
		mutationFn: (next: string) =>
			addItem({
				data: { title: next },
				headers: { [CLIENT_ID_HEADER]: clientId() },
			}),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: itemKeys.all }),
	});

	function submit(event: FormEvent) {
		event.preventDefault();
		const next = title.trim();
		if (!next) return;
		add.mutate(next, { onSuccess: () => setTitle("") });
	}

	return (
		<main className="mx-auto flex min-h-dvh max-w-md flex-col gap-5 p-6">
			<header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
				<h1 className="text-2xl font-semibold">{app.displayName}</h1>
				<span className="flex min-w-0 items-baseline gap-3 text-sm text-muted-foreground">
					<span className="break-all" data-testid="username">
						{status.username}
					</span>
					{status.signOutUrl ? (
						<a className="underline" href={status.signOutUrl}>
							Sign out
						</a>
					) : null}
				</span>
			</header>
			<form className="flex gap-2" onSubmit={submit}>
				<Input
					aria-label="New item"
					placeholder="New item"
					value={title}
					maxLength={200}
					onChange={(event) => setTitle(event.target.value)}
				/>
				<Button type="submit" disabled={add.isPending}>
					Add
				</Button>
			</form>
			{add.isError ? (
				<p role="alert" className="text-sm text-destructive">
					Could not add that item.
				</p>
			) : null}
			{items.isPending ? (
				<p className="text-muted-foreground">Loading...</p>
			) : items.isError ? (
				<p role="alert">Could not load items.</p>
			) : items.data.length === 0 ? (
				<p className="text-muted-foreground" data-testid="no-items">
					Nothing here yet.
				</p>
			) : (
				<ul className="flex flex-col gap-2" data-testid="items">
					{items.data.map((item) => (
						<li key={item.id} className="rounded-md border p-3">
							{item.title}
						</li>
					))}
				</ul>
			)}
			{status.admin ? (
				<a className="text-sm underline" href="/admin">
					Admin
				</a>
			) : null}
		</main>
	);
}
