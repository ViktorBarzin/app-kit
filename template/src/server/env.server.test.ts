/**
 * The env contract: DEV_USER stands in only in development and test,
 * SIGNUP_MODE follows the Terraform module's signup_mode, telemetry is on
 * whenever a write key is configured, unless TELEMETRY=off, and
 * CLOUD_EDGE_SECRET switches to cloud mode with the pool sized from
 * CLOUD_DATABASE_CONNECTION_LIMIT.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AuthDb,
	createAppAuth,
	createCloudAuth,
} from "@viktorbarzin/auth";

import {
	authConfig,
	cloudAuthConfig,
	cloudSettings,
	connectionBudget,
	isCloud,
	realtimeEnabled,
	serviceInfo,
	telemetrySettings,
} from "./env.server";

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

describe("cloud mode", () => {
	const SECRET = "edge-secret-0123456789abcdefghijklmnopqrstuv";
	const cloud = {
		CLOUD_EDGE_SECRET: SECRET,
		CLOUD_EDGE_SECRET_FILE: undefined,
		CLOUD_OWNER_EMAIL: "owner@example.com",
		CLOUD_PUBLIC_URL: "https://starter.example",
		CLOUD_ACCESS: "private",
		CLOUD_DATABASE_CONNECTION_LIMIT: undefined,
	};

	test("off without CLOUD_EDGE_SECRET", () => {
		setEnv({ CLOUD_EDGE_SECRET: undefined, CLOUD_EDGE_SECRET_FILE: undefined });
		expect(cloudSettings()).toBeNull();
		expect(isCloud()).toBe(false);
	});

	test("on with CLOUD_EDGE_SECRET, from the contract's variables", () => {
		setEnv(cloud);
		expect(isCloud()).toBe(true);
		expect(cloudSettings()).toEqual({
			edgeSecret: SECRET,
			ownerEmail: "owner@example.com",
			publicUrl: "https://starter.example",
			access: "private",
		});
		expect(cloudAuthConfig()).toMatchObject({
			appSlug: "starter",
			edgeSecret: SECRET,
			ownerEmail: "owner@example.com",
			publicUrl: "https://starter.example",
		});
	});

	test("the secret may come from a file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "cloud-env-"));
		const file = join(dir, "edge-secret");
		await writeFile(file, `${SECRET}\n`);
		try {
			setEnv({
				...cloud,
				CLOUD_EDGE_SECRET: undefined,
				CLOUD_EDGE_SECRET_FILE: file,
			});
			expect(cloudSettings()?.edgeSecret).toBe(SECRET);
		} finally {
			await rm(dir, { recursive: true });
		}
	});

	test("CLOUD_ACCESS defaults to public", () => {
		setEnv({ ...cloud, CLOUD_ACCESS: undefined });
		expect(cloudSettings()?.access).toBe("public");
	});

	test.each<[string, Record<string, string | undefined>, string]>([
		["no owner email", { CLOUD_OWNER_EMAIL: undefined }, "CLOUD_OWNER_EMAIL"],
		["no public URL", { CLOUD_PUBLIC_URL: undefined }, "CLOUD_PUBLIC_URL"],
		["an unknown access mode", { CLOUD_ACCESS: "family" }, "CLOUD_ACCESS"],
	])("%s is a configuration error", (_label, values, name) => {
		setEnv({ ...cloud, ...values });
		expect(() => cloudSettings()).toThrow(name);
	});

	test("the auth object trusts the edge's headers only with the secret", async () => {
		setEnv(cloud);
		const appAuth = createCloudAuth(() => cloudAuthConfig());
		const headers = {
			"x-cloud-user-id": "o1",
			"x-cloud-user-email": "Owner@example.com",
		};
		const forged = new Request("https://starter.example/", { headers });
		expect(await appAuth.resolveUser(forged)).toBeNull();
		const real = new Request("https://starter.example/", {
			headers: { ...headers, "x-cloud-edge-secret": SECRET },
		});
		expect(await appAuth.resolveUser(real)).toMatchObject({
			via: "cloud",
			admin: true,
		});
	});
});

describe("connection budget", () => {
	test("without a limit: pool 4 and realtime", () => {
		setEnv({ CLOUD_DATABASE_CONNECTION_LIMIT: undefined });
		expect(connectionBudget()).toEqual({
			perPod: 5,
			poolMax: 4,
			realtime: true,
		});
		expect(realtimeEnabled()).toBe(true);
	});

	test.each([
		["nano", "2", 1, false],
		["small", "4", 1, true],
		["medium", "8", 3, true],
	] as const)("%s (limit %s): pool %d, realtime %p", (_size, limit, poolMax, realtime) => {
		setEnv({ CLOUD_DATABASE_CONNECTION_LIMIT: limit });
		expect(connectionBudget().poolMax).toBe(poolMax);
		expect(realtimeEnabled()).toBe(realtime);
	});
});
