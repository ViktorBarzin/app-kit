/**
 * Server functions for this app's own UI (internal RPC; non-browser clients
 * use /api routes). Safe to import from components: Start replaces each
 * handler with an RPC stub in the client bundle, and the server-only imports
 * are only used inside handlers.
 */
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { CLIENT_ID_HEADER } from "@viktorbarzin/realtime/client";
import { sanitizeClientId } from "@viktorbarzin/realtime/server";
import { track } from "@viktorbarzin/telemetry/server";
import { z } from "zod";

import { requireMember } from "./auth.server";
import { pool } from "./db.server";
import {
	addItem as addItemFor,
	listItems as listItemsFor,
} from "./items.server";

/** The signed-in member's items, newest first. */
export const listItems = createServerFn({ method: "GET" }).handler(async () => {
	const user = await requireMember(getRequest());
	return listItemsFor(pool.getDb(), user.sub ?? user.username);
});

/** Add an item; the caller's tab id (x-client-id) rides along so that tab skips its own event. */
export const addItem = createServerFn({ method: "POST" })
	.validator(z.object({ title: z.string().trim().min(1).max(200) }))
	.handler(async ({ data }) => {
		const request = getRequest();
		const user = await requireMember(request);
		const source = sanitizeClientId(request.headers.get(CLIENT_ID_HEADER));
		const item = await addItemFor(
			pool.getDb(),
			user.sub ?? user.username,
			data.title,
			source,
		);
		// A product event (noun.past_verb, snake_case properties); a no-op
		// while telemetry is off.
		if (user.sub) track({ event: "item.created", userId: user.sub });
		return item;
	});
