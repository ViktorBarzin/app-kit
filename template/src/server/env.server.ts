/**
 * The only module that reads process.env. It maps the platform's env
 * contract onto the package configs: the Terraform app module's
 * (infra modules/kubernetes/tanstack_app), or Cloud's when CLOUD_EDGE_SECRET
 * is set (cloud mode). Secrets may be given inline or as a `<NAME>_FILE` path.
 */
import { readFileSync } from "node:fs";
import type {
	AppAuthConfig,
	AuthDb,
	CloudAuthConfig,
} from "@viktorbarzin/auth";
import { parseMetricsPort } from "@viktorbarzin/metrics";
import {
	type ConnectionBudget,
	connectionBudgetFromEnv,
	type PgSettings,
	pgSettingsFromEnv,
} from "@viktorbarzin/pg";

import { app } from "#/app.config";

/**
 * Read through an alias: Vite rewrites the literal `process.env.NODE_ENV` to
 * "production" at build time, which would make the built server ignore the
 * runtime value. The image sets NODE_ENV=production; tests run the built
 * server with NODE_ENV=test.
 */
const runtimeEnv: Record<string, string | undefined> = process.env;

function env(name: string): string | null {
	const value = runtimeEnv[name];
	return value === undefined || value.trim() === "" ? null : value.trim();
}

/** `NAME`, or the trimmed contents of the file at `NAME_FILE`. */
function secret(name: string): string | null {
	const inline = env(name);
	if (inline !== null) return inline;
	const path = env(`${name}_FILE`);
	if (path === null) return null;
	const text = readFileSync(path, "utf8").trim();
	return text === "" ? null : text;
}

function list(name: string): string[] {
	return (env(name) ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

export function isDevelopment(): boolean {
	return runtimeEnv.NODE_ENV === "development";
}

/**
 * Development or test, exactly. Anything else (unset, "staging", a typo) is
 * treated like production, so a stray DEV_USER cannot open the app.
 */
export function isDevOrTest(): boolean {
	return isDevelopment() || runtimeEnv.NODE_ENV === "test";
}

/** SIGNUP_MODE from the Terraform module (signup_mode); "request" when unset. */
function signupMode(): "request" | "open" {
	const mode = env("SIGNUP_MODE") ?? "request";
	if (mode === "request" || mode === "open") return mode;
	throw new Error(`SIGNUP_MODE must be "request" or "open" (got "${mode}")`);
}

export function databaseConfigured(): boolean {
	return env("DATABASE_URL") !== null;
}

/** DATABASE_URL and DATABASE_PASSWORD_FILE. */
export function pgSettings(): PgSettings {
	return pgSettingsFromEnv(runtimeEnv);
}

/**
 * The pod's Postgres connections: half of CLOUD_DATABASE_CONNECTION_LIMIT
 * on Cloud, else the default pool of 4 plus the realtime LISTEN connection.
 */
export function connectionBudget(): ConnectionBudget {
	return connectionBudgetFromEnv(runtimeEnv);
}

/** Realtime (LISTEN + SSE) is on unless the connection budget is 1. Off: the UI refetches. */
export function realtimeEnabled(): boolean {
	return connectionBudget().realtime;
}

export interface CloudSettings {
	/** CLOUD_EDGE_SECRET: the edge sends it on every request it forwards. */
	edgeSecret: string;
	/** CLOUD_OWNER_EMAIL: the Project owner, this app's admin. */
	ownerEmail: string;
	/** CLOUD_PUBLIC_URL: `https://<host>`; the CSRF origin. */
	publicUrl: string;
	/** CLOUD_ACCESS: who the edge lets in. */
	access: "public" | "private";
}

/** Cloud's env contract, or null outside Cloud (CLOUD_EDGE_SECRET unset). */
export function cloudSettings(): CloudSettings | null {
	const edgeSecret = secret("CLOUD_EDGE_SECRET");
	if (edgeSecret === null) return null;
	const ownerEmail = env("CLOUD_OWNER_EMAIL");
	if (ownerEmail === null)
		throw new Error("CLOUD_OWNER_EMAIL must be set with CLOUD_EDGE_SECRET");
	const publicUrl = env("CLOUD_PUBLIC_URL");
	if (publicUrl === null)
		throw new Error("CLOUD_PUBLIC_URL must be set with CLOUD_EDGE_SECRET");
	const access = env("CLOUD_ACCESS") ?? "public";
	if (access !== "public" && access !== "private")
		throw new Error(
			`CLOUD_ACCESS must be "public" or "private" (got "${access}")`,
		);
	return { edgeSecret, ownerEmail, publicUrl, access };
}

/** True when the app runs on Cloud, behind its edge. */
export function isCloud(): boolean {
	return secret("CLOUD_EDGE_SECRET") !== null;
}

/** The identity config in cloud mode. Throws outside Cloud. */
export function cloudAuthConfig(): CloudAuthConfig {
	const cloud = cloudSettings();
	if (cloud === null) throw new Error("CLOUD_EDGE_SECRET is not set");
	return {
		appSlug: app.slug,
		edgeSecret: cloud.edgeSecret,
		ownerEmail: cloud.ownerEmail,
		publicUrl: cloud.publicUrl,
	};
}

export function metricsPort(): number | null {
	return parseMetricsPort(runtimeEnv.METRICS_PORT);
}

/** The service fields for logs and telemetry. */
export function serviceInfo(): {
	name: string;
	version: string;
	environment: string;
} {
	return {
		name: app.slug,
		// The image sets SERVICE_VERSION to the commit it was built from.
		version: env("SERVICE_VERSION") ?? "dev",
		environment:
			env("DEPLOYMENT_ENVIRONMENT") ??
			(runtimeEnv.NODE_ENV === "production" ? "production" : "dev"),
	};
}

export interface TelemetrySettings {
	writeKey: string;
	/** The event pipeline inside the cluster, for server-side events. */
	eventsUrl: string;
	siteId: string;
	/** The app's GlitchTip DSN, `https://<key>@<app host>/_t/x/<project>`. */
	dsn: string | null;
	productionHosts: readonly string[];
	release: string;
	environment: string;
}

const OFF = new Set(["off", "false", "0", "no"]);

/**
 * Telemetry settings, or null when it is off: `app.telemetry.enabled` is
 * false, TELEMETRY is off, or no write key is configured (local runs, tests).
 */
export function telemetrySettings(): TelemetrySettings | null {
	if (!app.telemetry.enabled) return null;
	if (OFF.has((env("TELEMETRY") ?? "").toLowerCase())) return null;
	const writeKey = secret("TELEMETRY_WRITE_KEY");
	if (writeKey === null) return null;
	const service = serviceInfo();
	return {
		writeKey,
		eventsUrl:
			env("TELEMETRY_EVENTS_URL") ??
			"http://event-pipeline.rybbit.svc.cluster.local",
		siteId: env("TELEMETRY_SITE_ID") ?? app.telemetry.siteId,
		dsn: env("SENTRY_DSN"),
		productionHosts: app.telemetry.productionHosts,
		release: service.version,
		environment: service.environment,
	};
}

/** The identity config. `db` is passed in so this module stays free of the pool. */
export function authConfig(db: () => AuthDb): AppAuthConfig {
	const discoveryUrl = env("OIDC_DISCOVERY_URL");
	const clientId = env("OIDC_CLIENT_ID");
	const clientSecret = secret("OIDC_CLIENT_SECRET");
	const audiences = list("API_TOKEN_AUDIENCES");
	return {
		appName: app.displayName,
		appSlug: app.slug,
		db,
		publicOrigins: list("PUBLIC_ORIGINS"),
		betterAuthSecret: secret("BETTER_AUTH_SECRET"),
		oidc:
			discoveryUrl && clientId && clientSecret
				? { discoveryUrl, clientId, clientSecret }
				: null,
		...(audiences.length > 0 ? { apiTokenAudiences: audiences } : {}),
		authentik: {
			apiUrl: env("AUTHENTIK_API_URL"),
			readerToken: secret("AUTHENTIK_READER_TOKEN"),
			approverToken: secret("AUTHENTIK_APPROVER_TOKEN"),
			usersGroupPk: env("AUTHENTIK_USERS_GROUP_ID"),
		},
		groups: {
			users: env("AUTH_USERS_GROUP") ?? app.usersGroup,
			admins: env("AUTH_ADMINS_GROUP") ?? app.adminsGroup,
			agents: env("AUTH_AGENTS_GROUP") ?? app.agentsGroup,
		},
		signup: signupMode(),
		// DEV_USER is a dev and test fallback, honoured only when NODE_ENV is
		// exactly development or test (and @viktorbarzin/auth ignores it while
		// OIDC is configured).
		devUser: isDevOrTest() ? env("DEV_USER") : null,
	};
}
