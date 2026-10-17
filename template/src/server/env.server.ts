/**
 * The only module that reads process.env. It maps the Terraform app module's
 * env contract (infra modules/kubernetes/tanstack_app) onto the package
 * configs. Secrets may be given inline or as a `<NAME>_FILE` path.
 */
import { readFileSync } from "node:fs";
import type { AppAuthConfig, AuthDb } from "@viktorbarzin/auth";
import { parseMetricsPort } from "@viktorbarzin/metrics";
import { type PgSettings, pgSettingsFromEnv } from "@viktorbarzin/pg";

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

export function metricsPort(): number | null {
	return parseMetricsPort(runtimeEnv.METRICS_PORT);
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
