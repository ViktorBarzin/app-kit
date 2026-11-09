/**
 * The env contract: DEV_USER stands in only in development and test,
 * SIGNUP_MODE follows the Terraform module's signup_mode, and telemetry is on
 * whenever a write key is configured, unless TELEMETRY=off.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { type AuthDb, createAppAuth } from "@viktorbarzin/auth";

import { authConfig, serviceInfo, telemetrySettings } from "./env.server";

const saved = { ...process.env };
afterEach(() => {
	for (const key of Object.keys(process.env))
		if (!(key in saved)) delete process.env[key];
	Object.assign(process.env, saved);
});

/** authConfig never touches the database without a session cookie. */
const noDb = (): AuthDb => {
	throw new Error("no database in this test");
};

function setEnv(values: Record<string, string | undefined>): void {
	for (const [key, value] of Object.entries(values))
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
}

describe("DEV_USER", () => {
	test.each([
		["development", "alice"],
		["test", "alice"],
		[undefined, null],
		["", null],
		["staging", null],
		["Production", null],
		["production", null],
	])("NODE_ENV=%p gives devUser %p", (nodeEnv, expected) => {
		setEnv({ NODE_ENV: nodeEnv, DEV_USER: "alice" });
		expect(authConfig(noDb).devUser).toBe(expected);
	});

	test("an anonymous caller stays anonymous when NODE_ENV is unset", async () => {
		setEnv({ NODE_ENV: undefined, DEV_USER: "alice" });
		const appAuth = createAppAuth(() => authConfig(noDb));
		expect(
			await appAuth.resolveUser(new Request("https://starter.example/x")),
		).toBeNull();
	});
});

describe("SIGNUP_MODE", () => {
	test.each<[string | undefined, "request" | "open"]>([
		[undefined, "request"],
		["request", "request"],
		["open", "open"],
	])("SIGNUP_MODE=%p gives signup %p", (mode, expected) => {
		setEnv({ SIGNUP_MODE: mode });
		expect(authConfig(noDb).signup).toBe(expected);
	});

	test("an unknown mode is a configuration error", () => {
		setEnv({ SIGNUP_MODE: "closed" });
		expect(() => authConfig(noDb)).toThrow("SIGNUP_MODE");
	});
});

describe("telemetry", () => {
	const keyed = { TELEMETRY: undefined, TELEMETRY_WRITE_KEY: "wk" };

	test("off without a write key", () => {
		setEnv({
			TELEMETRY_WRITE_KEY: undefined,
			TELEMETRY_WRITE_KEY_FILE: undefined,
		});
		expect(telemetrySettings()).toBeNull();
	});

	test("on with a write key, with the platform defaults", () => {
		setEnv({
			...keyed,
			TELEMETRY_EVENTS_URL: undefined,
			TELEMETRY_SITE_ID: undefined,
			SENTRY_DSN: undefined,
		});
		expect(telemetrySettings()).toMatchObject({
			writeKey: "wk",
			eventsUrl: "http://event-pipeline.rybbit.svc.cluster.local",
			siteId: "1",
			dsn: null,
			productionHosts: ["viktorbarzin.me"],
		});
	});

	test.each(["off", "OFF", "false", "0"])("TELEMETRY=%p opts out", (value) => {
		setEnv({ ...keyed, TELEMETRY: value });
		expect(telemetrySettings()).toBeNull();
	});

	test("the events URL, site id and DSN come from the environment", () => {
		setEnv({
			...keyed,
			TELEMETRY_EVENTS_URL: "http://pipeline.example.invalid",
			TELEMETRY_SITE_ID: "7",
			SENTRY_DSN: "https://k@starter.example/_t/x/3",
		});
		expect(telemetrySettings()).toMatchObject({
			eventsUrl: "http://pipeline.example.invalid",
			siteId: "7",
			dsn: "https://k@starter.example/_t/x/3",
		});
	});
});

describe("serviceInfo", () => {
	test.each<[Record<string, string | undefined>, string, string]>([
		[
			{
				SERVICE_VERSION: "1a2b3c4d",
				NODE_ENV: "production",
				DEPLOYMENT_ENVIRONMENT: undefined,
			},
			"1a2b3c4d",
			"production",
		],
		[
			{
				SERVICE_VERSION: undefined,
				NODE_ENV: "development",
				DEPLOYMENT_ENVIRONMENT: undefined,
			},
			"dev",
			"dev",
		],
		[
			{
				SERVICE_VERSION: undefined,
				NODE_ENV: "production",
				DEPLOYMENT_ENVIRONMENT: "staging",
			},
			"dev",
			"staging",
		],
	])("%p gives version %p in %p", (values, version, environment) => {
		setEnv(values);
		expect(serviceInfo()).toEqual({ name: "starter", version, environment });
	});
});
