/**
 * The identity tables an app adds to its own schema
 * (`export * from "@viktorbarzin/auth/schema"` in the app's Drizzle schema).
 *
 * - auth_user, auth_session, auth_account, auth_verification: Better Auth's
 *   tables (Drizzle adapter). Property names are the field names Better Auth
 *   uses; columns are snake_case.
 * - member_checks: the last membership answer per OIDC `sub`, re-asked every
 *   15 minutes.
 * - access_requests: request + approve sign-up.
 *
 * Changing a column here is a breaking change: apps regenerate migrations.
 */
import {
	boolean,
	index,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	varchar,
} from "drizzle-orm/pg-core";

const tz = { withTimezone: true, mode: "date" } as const;

export const authUser = pgTable("auth_user", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	email: text("email").notNull().unique(),
	emailVerified: boolean("email_verified").default(false).notNull(),
	image: text("image"),
	createdAt: timestamp("created_at", tz).notNull(),
	updatedAt: timestamp("updated_at", tz)
		.$onUpdate(() => new Date())
		.notNull(),
});

export const authSession = pgTable(
	"auth_session",
	{
		id: text("id").primaryKey(),
		expiresAt: timestamp("expires_at", tz).notNull(),
		token: text("token").notNull().unique(),
		createdAt: timestamp("created_at", tz).notNull(),
		updatedAt: timestamp("updated_at", tz)
			.$onUpdate(() => new Date())
			.notNull(),
		ipAddress: text("ip_address"),
		userAgent: text("user_agent"),
		userId: text("user_id")
			.notNull()
			.references(() => authUser.id, { onDelete: "cascade" }),
	},
	(table) => [index("auth_session_user_id_idx").on(table.userId)],
);

export const authAccount = pgTable(
	"auth_account",
	{
		id: text("id").primaryKey(),
		/** The provider's subject: the OIDC `sub`. */
		accountId: text("account_id").notNull(),
		providerId: text("provider_id").notNull(),
		userId: text("user_id")
			.notNull()
			.references(() => authUser.id, { onDelete: "cascade" }),
		accessToken: text("access_token"),
		refreshToken: text("refresh_token"),
		idToken: text("id_token"),
		accessTokenExpiresAt: timestamp("access_token_expires_at", tz),
		refreshTokenExpiresAt: timestamp("refresh_token_expires_at", tz),
		scope: text("scope"),
		password: text("password"),
		createdAt: timestamp("created_at", tz).notNull(),
		updatedAt: timestamp("updated_at", tz)
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [
		index("auth_account_user_id_idx").on(table.userId),
		uniqueIndex("auth_account_provider_subject_key").on(
			table.providerId,
			table.accountId,
		),
	],
);

export const authVerification = pgTable(
	"auth_verification",
	{
		id: text("id").primaryKey(),
		identifier: text("identifier").notNull(),
		value: text("value").notNull(),
		expiresAt: timestamp("expires_at", tz).notNull(),
		createdAt: timestamp("created_at", tz).notNull(),
		updatedAt: timestamp("updated_at", tz)
			.$onUpdate(() => new Date())
			.notNull(),
	},
	(table) => [index("auth_verification_identifier_idx").on(table.identifier)],
);

/** The last membership answer for a subject, from the id_token, a bearer token or the provider's API. */
export const memberChecks = pgTable("member_checks", {
	sub: varchar("sub", { length: 255 }).primaryKey(),
	username: varchar("username", { length: 255 }).notNull(),
	member: boolean("member").notNull(),
	admin: boolean("admin").notNull(),
	/** "id_token", "token" or "api". */
	source: varchar("source", { length: 16 }).notNull(),
	checkedAt: timestamp("checked_at", tz).notNull(),
});

/** A signed-in person who is not in the app's users group yet. */
export const accessRequests = pgTable("access_requests", {
	sub: varchar("sub", { length: 255 }).primaryKey(),
	username: varchar("username", { length: 255 }).notNull(),
	email: varchar("email", { length: 320 }),
	name: varchar("name", { length: 255 }),
	/** "pending" or "approved". */
	status: varchar("status", { length: 16 }).notNull(),
	requestedAt: timestamp("requested_at", tz).defaultNow().notNull(),
	decidedBy: varchar("decided_by", { length: 255 }),
	decidedAt: timestamp("decided_at", tz),
});

export const authSchema = {
	authUser,
	authSession,
	authAccount,
	authVerification,
	memberChecks,
	accessRequests,
};

/** The Better Auth Drizzle adapter's schema map, keyed by model name. */
export const betterAuthModels = {
	auth_user: authUser,
	auth_session: authSession,
	auth_account: authAccount,
	auth_verification: authVerification,
};

export type MemberCheck = typeof memberChecks.$inferSelect;
export type AccessRequest = typeof accessRequests.$inferSelect;
