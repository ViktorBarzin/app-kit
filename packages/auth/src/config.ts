/** The configuration an app passes to createAppAuth, and the types it gets back. */
import type { Logger } from "@viktorbarzin/log";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { Registry } from "prom-client";

/** Any Drizzle Postgres database whose schema includes the tables in @viktorbarzin/auth/schema. */
export type AuthDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

export interface AuthUser {
	/** OIDC `sub`; null only for the dev user. */
	sub: string | null;
	/** `preferred_username`. */
	username: string;
	via: "session" | "token" | "dev";
	/** In the users, admins or agents group, as of the last check. */
	member: boolean;
	/** In the admins group. */
	admin: boolean;
}

export interface AccessStatus {
	signedIn: boolean;
	username: string | null;
	member: boolean;
	admin: boolean;
	/** Set while an access request is waiting. */
	requestedAt: string | null;
}

export interface PendingRequestView {
	sub: string;
	username: string;
	email: string | null;
	name: string | null;
	requestedAt: string;
}

export interface GroupNames {
	users: string;
	admins: string;
	agents?: string | null;
}

export interface AuthentikSettings {
	/** The provider's base URL; `/api/v3` is appended. Null: re-checks fail closed. */
	apiUrl: string | null;
	/** A token that may view users and the users group (membership re-checks). */
	readerToken: string | null;
	/** A token that may only add users to the users group (approvals). */
	approverToken: string | null;
	/** The users group's pk; looked up by name when null. */
	usersGroupPk: string | null;
	timeoutMs?: number;
}

export interface OidcClientSettings {
	/** The provider's `.well-known/openid-configuration` URL. */
	discoveryUrl: string;
	clientId: string;
	clientSecret: string;
}

export interface AppAuthConfig<TExtra extends object = Record<never, never>> {
	/** Shown by Better Auth, e.g. "Starter". */
	appName: string;
	/** DNS-label slug: cookie prefix, logger prefix and placeholder emails derive from it. */
	appSlug: string;
	db: () => AuthDb;
	/** Exact origins; [0] is Better Auth's baseURL. Also the CSRF allow-list. */
	publicOrigins: string[];
	/** Signs session cookies and OAuth state. */
	betterAuthSecret: string | null;
	/** Null turns browser sign-in off (dev and tests on devUser). */
	oidc: OidcClientSettings | null;
	providerId?: string;
	basePath?: string;
	scopes?: string[];
	sessionMaxAgeSeconds?: number;
	cookiePrefix?: string;
	/** The header the ingress sets to the client address (Traefik's real-ip plugin). */
	clientIpHeader?: string;
	/** Client IDs accepted as `aud` on bearer tokens. Defaults to [oidc.clientId]. */
	apiTokenAudiences?: string[];
	authentik: AuthentikSettings;
	groups: GroupNames;
	/** The provider's anonymous auto-login identity. */
	guestUsername?: string;
	membershipMaxAgeMs?: number;
	adminRecheckMaxAgeMs?: number;
	/** "request": a non-member gets an access_requests row. "open": the provider adds people to the group. */
	signup: "request" | "open";
	/**
	 * A stand-in user (member and admin) for callers with no session or token,
	 * for local dev and tests. Ignored, with an ERROR log, whenever `oidc` is
	 * set. The app passes it only in development and test.
	 */
	devUser?: string | null;
	/** Extra per-user fields, looked up on every resolved request and once at sign-in. */
	enrich?: (
		db: AuthDb,
		who: { sub: string | null; username: string },
	) => Promise<TExtra>;
	/** GET paths that get the CSRF origin check (SSE streams). */
	streamPaths?: string[];
	metrics?: { registry?: Registry; prefix?: string };
	/** Logger names are `<loggerPrefix>.auth` etc. Defaults to appSlug. */
	loggerPrefix?: string;
	/** Overrides the loggers entirely (tests). */
	logger?: Logger;
}

export const DEFAULTS = {
	providerId: "authentik",
	basePath: "/api/auth",
	scopes: ["openid", "profile", "email"],
	/** ADR-0001: sessions have an absolute cap of 7 days. */
	sessionMaxAgeSeconds: 7 * 24 * 60 * 60,
	clientIpHeader: "x-real-ip",
	guestUsername: "guest",
	/** ADR-0001: membership is re-asked after 15 minutes. */
	membershipMaxAgeMs: 15 * 60 * 1000,
	adminRecheckMaxAgeMs: 60 * 1000,
	streamPaths: ["/api/events"],
	metricsPrefix: "auth",
	authentikTimeoutMs: 5_000,
} as const;
