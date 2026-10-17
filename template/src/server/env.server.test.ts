/**
 * The env contract: DEV_USER stands in only in development and test, and
 * SIGNUP_MODE follows the Terraform module's signup_mode.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { type AuthDb, createAppAuth } from "@viktorbarzin/auth";

import { authConfig } from "./env.server";

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
