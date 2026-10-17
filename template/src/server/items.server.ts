/**
 * The example domain: a per-user list of items. A change is published inside
 * the same transaction (`publishInTx`), so the NOTIFY fires at COMMIT and a
 * rolled-back write tells no one.
 */
import { desc, eq } from "drizzle-orm";

import { itemKeys } from "#/lib/query-keys";
import { items } from "./db/schema.server";
import type { Db, Tx } from "./db.server";
import { realtime } from "./realtime.server";

/** The wire shape: dates as ISO strings. */
export interface ItemView {
	id: string;
	title: string;
	createdAt: string;
}

function view(row: typeof items.$inferSelect): ItemView {
	return {
		id: row.id,
		title: row.title,
		createdAt: row.createdAt.toISOString(),
	};
}

export async function listItems(
	db: Db | Tx,
	ownerSub: string,
): Promise<ItemView[]> {
	const rows = await db
		.select()
		.from(items)
		.where(eq(items.ownerSub, ownerSub))
		.orderBy(desc(items.createdAt));
	return rows.map(view);
}

export async function addItem(
	db: Db | Tx,
	ownerSub: string,
	title: string,
	source: string | null,
): Promise<ItemView> {
	return db.transaction(async (tx) => {
		const [row] = await tx
			.insert(items)
			.values({ ownerSub, title })
			.returning();
		if (!row) throw new Error("insert returned no row");
		await realtime.publishInTx(tx, ownerSub, {
			type: "invalidate",
			keys: [itemKeys.all],
			source,
		});
		return view(row);
	});
}
