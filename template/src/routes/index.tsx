import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { CLIENT_ID_HEADER, clientId } from "@viktorbarzin/realtime/client";
import { useRealtimeInvalidation } from "@viktorbarzin/realtime/react";
import { type FormEvent, useState } from "react";

import { app } from "#/app.config";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { itemKeys } from "#/lib/query-keys";
import { getAccessStatus } from "#/server/access.functions";
import { addItem, listItems } from "#/server/items.functions";

/**
 * The auth wall: signed-out visitors go to sign-in, people waiting for
 * approval go to /pending, members see their items.
 */
export const Route = createFileRoute("/")({
	loader: async () => {
		const status = await getAccessStatus();
		if (!status.signedIn)
			throw redirect({
				href: "/api/auth/start?return=%2F",
				reloadDocument: true,
			});
		if (!status.member) throw redirect({ to: "/pending" });
		return status;
	},
	component: Home,
});

function Home() {
	const status = Route.useLoaderData();
	const queryClient = useQueryClient();
	const [title, setTitle] = useState("");
	useRealtimeInvalidation({ queryClient });
	const items = useQuery({
		queryKey: itemKeys.all,
		queryFn: () => listItems(),
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
			<header className="flex items-baseline justify-between">
				<h1 className="text-2xl font-semibold">{app.displayName}</h1>
				<span className="text-sm text-muted-foreground" data-testid="username">
					{status.username}
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
				<a className="text-sm underline" href="/admin/requests">
					Access requests
				</a>
			) : null}
		</main>
	);
}
