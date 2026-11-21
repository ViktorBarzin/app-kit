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

import { app } from "#/app.config";
import {
	authConfig,
	cloudAuthConfig,
	cloudSettings,
	connectionBudget,
	isCloud,
	keyValueSettings,
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
			await appAuth.resolveUser(new Request("https://app.example/x")),
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
			SENTRY_DSN: "https://k@app.example/_t/x/3",
		});
		expect(telemetrySettings()).toMatchObject({
			eventsUrl: "http://pipeline.example.invalid",
			siteId: "7",
			dsn: "https://k@app.example/_t/x/3",
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
		// The slug, whatever its length after the rename.
		expect(serviceInfo()).toEqual({ name: app.slug, version, environment });
	});
});

describe("cloud mode", () => {
	const SECRET = "edge-secret-0123456789abcdefghijklmnopqrstuv";
	const cloud = {
		CLOUD_EDGE_SECRET: SECRET,
		CLOUD_EDGE_SECRET_FILE: undefined,
		CLOUD_OWNER_EMAIL: "owner@example.com",
		CLOUD_PUBLIC_URL: "https://app.example",
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
			publicUrl: "https://app.example",
		});
		expect(cloudAuthConfig()).toMatchObject({
			appSlug: app.slug,
			edgeSecret: SECRET,
			ownerEmail: "owner@example.com",
			publicUrl: "https://app.example",
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

	test.each<[string, Record<string, string | undefined>, string]>([
		["no owner email", { CLOUD_OWNER_EMAIL: undefined }, "CLOUD_OWNER_EMAIL"],
		["no public URL", { CLOUD_PUBLIC_URL: undefined }, "CLOUD_PUBLIC_URL"],
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
		const forged = new Request("https://app.example/", { headers });
		expect(await appAuth.resolveUser(forged)).toBeNull();
		const real = new Request("https://app.example/", {
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
		setEnv({
			CLOUD_DATABASE_CONNECTION_LIMIT: undefined,
			CLOUD_DATABASE_POOL_SIZE: undefined,
		});
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

	test("CLOUD_DATABASE_POOL_SIZE sets the pool, with realtime on top", () => {
		setEnv({
			CLOUD_DATABASE_POOL_SIZE: "1",
			CLOUD_DATABASE_CONNECTION_LIMIT: "8",
		});
		expect(connectionBudget()).toEqual({
			perPod: 2,
			poolMax: 1,
			realtime: true,
		});
		setEnv({ CLOUD_DATABASE_POOL_SIZE: undefined });
	});
});

describe("Key Value", () => {
	test("off without REDIS_URL", () => {
		delete process.env.REDIS_URL;
		delete process.env.REDIS_URL_FILE;
		expect(keyValueSettings()).toBeNull();
	});

	test("on Cloud: the URL, the prefix and the Size in bytes", () => {
		process.env.REDIS_URL = "redis://p_a_b_0123456789:pw@127.0.0.1:6379/0";
		process.env.CLOUD_KV_PREFIX = "p:a:b:";
		process.env.CLOUD_KV_MAX_BYTES = "16777216";
		expect(keyValueSettings()).toEqual({
			url: "redis://p_a_b_0123456789:pw@127.0.0.1:6379/0",
			prefix: "p:a:b:",
			maxBytes: 16777216,
		});
	});

	test("outside Cloud: no prefix and no Size", () => {
		process.env.REDIS_URL = "redis://127.0.0.1:6379/0";
		delete process.env.CLOUD_KV_PREFIX;
		delete process.env.CLOUD_KV_MAX_BYTES;
		expect(keyValueSettings()).toEqual({
			url: "redis://127.0.0.1:6379/0",
			prefix: "",
			maxBytes: null,
		});
	});

	test("a Size that is not a whole number of bytes is a configuration error", () => {
		process.env.REDIS_URL = "redis://127.0.0.1:6379/0";
		process.env.CLOUD_KV_MAX_BYTES = "16 MiB";
		expect(() => keyValueSettings()).toThrow(/CLOUD_KV_MAX_BYTES/);
	});
});
