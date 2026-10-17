import { createFileRoute } from "@tanstack/react-router";
import { readQuery } from "@viktorbarzin/runtime";
import { z } from "zod";

import { appAuth } from "#/server/auth.server";
import { pool } from "#/server/db.server";
import { listItems } from "#/server/items.server";

const query = z.object({
	limit: z.coerce.number().int().min(1).max(500).default(100),
});

/**
 * GET /api/items for non-browser clients (bearer tokens; CLIs and agents
 * cannot call server functions). A zod schema guards every input.
 */
export const Route = createFileRoute("/api/items")({
	server: {
		handlers: {
			GET: ({ request }) =>
				appAuth.handleApi(request, async (user) => {
					const { limit } = readQuery(request, query);
					const items = await listItems(
						pool.getDb(),
						user.sub ?? user.username,
					);
					return Response.json({ items: items.slice(0, limit) });
				}),
		},
	},
});
