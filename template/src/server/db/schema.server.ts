/**
 * The app's Drizzle schema: the identity tables from @viktorbarzin/auth plus
 * this app's own tables. `bun run db:generate` writes migrations to drizzle/.
 * Migrations are additive (expand, then contract in a later release), so the
 * previous image stays a working rollback.
 */
import {
	index,
	pgTable,
	text,
	timestamp,
	uuid,
	varchar,
} from "drizzle-orm/pg-core";

export * from "@viktorbarzin/auth/schema";

export const items = pgTable(
	"items",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		/** The owner's OIDC `sub` (the dev user's name in development). */
		ownerSub: varchar("owner_sub", { length: 255 }).notNull(),
		title: text("title").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
			.defaultNow()
			.notNull(),
	},
	(table) => [index("items_owner_sub_idx").on(table.ownerSub)],
);

export type Item = typeof items.$inferSelect;
