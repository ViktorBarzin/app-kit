/**
 * An in-process app for the package tests: AppAuth wired into a Bun.serve
 * router the way an app wires it into its framework, a migrated throwaway
 * database (TEST_DATABASE_URL) and the mock Authentik.
 */
import { resolve } from "node:path";
import { migrationLockKey } from "@viktorbarzin/pg";
import { migratedTestDatabase } from "@viktorbarzin/pg/testing";
import type { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import client from "prom-client";

import { type AppAuth, type AppAuthConfig, createAppAuth } from "../index.js";
import { authSchema } from "../schema.js";
import {
	CookieJar,
	follow,
	type MockAuthentik,
	startMockAuthentik,
} from "../testing/index.js";

export const adminUrl = process.env.TEST_DATABASE_URL;

export interface Harness<TExtra extends object> {
	origin: string;
	mock: MockAuthentik;
	sql: SQL;
	registry: client.Registry;
	appAuth: AppAuth<TExtra>;
	/** Change the config the next call reads. */
	override(patch: Partial<AppAuthConfig<TExtra>>): void;
	signIn(
		username: string,
		path?: string,
	): Promise<{
		jar: CookieJar;
		hops: Awaited<ReturnType<typeof follow>>["hops"];
		response: Response;
	}>;
	get(
		path: string,
		jar: CookieJar | null,
		headers?: Record<string, string>,
	): Promise<Response>;
	stop(): Promise<void>;
}

export async function startHarness<
	TExtra extends object = Record<never, never>,
>(base: Partial<AppAuthConfig<TExtra>> = {}): Promise<Harness<TExtra>> {
	const database = await migratedTestDatabase({
		adminUrl: adminUrl ?? "",
		migrationsFolder: resolve(import.meta.dir, "drizzle"),
		lockKey: migrationLockKey("auth-tests"),
		prefix: "authpkg",
	});
	const db = drizzle({ client: database.client, schema: authSchema });
	const mock = await startMockAuthentik({
		clientId: "app-web",
		usersGroup: "App Users",
	});
	mock.addUser({ username: "guest", email: null, groups: ["Public Guests"] });
	const registry = new client.Registry();
	let origin = "";
	let patch: Partial<AppAuthConfig<TExtra>> = { ...base };
	const config = (): AppAuthConfig<TExtra> => ({
		appName: "App",
		appSlug: "app",
		db: () => db,
		publicOrigins: [origin],
		betterAuthSecret: "test-secret-0123456789abcdef0123456789abcdef",
		oidc: {
			discoveryUrl: mock.discoveryUrl,
			clientId: mock.clientId,
			clientSecret: mock.clientSecret,
		},
		apiTokenAudiences: [mock.clientId, "app-cli"],
		authentik: {
			apiUrl: mock.apiUrl,
			readerToken: mock.readerToken,
			approverToken: mock.approverToken,
			usersGroupPk: null,
		},
		groups: { users: "App Users", admins: "App Admins", agents: "App Agents" },
		signup: "request",
		metrics: { registry, prefix: "app" },
		...patch,
	});
	const appAuth = createAppAuth(config);
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const rejection = appAuth.csrfRejection(request);
			if (rejection) return rejection;
			const { pathname } = new URL(request.url);
			if (pathname === "/api/auth/start") return appAuth.startSignIn(request);
			if (pathname === "/api/auth/finish") return appAuth.finishSignIn(request);
			if (pathname.startsWith("/api/auth/"))
				return appAuth.handleAuthRequest(request);
			if (
				pathname === "/api/me" ||
				pathname === "/api/events" ||
				pathname === "/api/write"
			)
				return appAuth.handleApi(request, async (user) => Response.json(user));
			return new Response("page", { status: 200 });
		},
	});
	origin = `http://127.0.0.1:${server.port}`;
	return {
		origin,
		mock,
		sql: database.client,
		registry,
		appAuth,
		override(next) {
			patch = { ...base, ...next };
		},
		async signIn(username, path = "/api/auth/start?return=%2F") {
			mock.session = null;
			mock.loginAs = username;
			const jar = new CookieJar();
			const result = await follow(`${origin}${path}`, jar, origin);
			return { jar, ...result };
		},
		get(path, jar, headers = {}) {
			return fetch(`${origin}${path}`, {
				redirect: "manual",
				headers: { ...(jar ? { cookie: jar.header() } : {}), ...headers },
			});
		},
		async stop() {
			await server.stop(true);
			await mock.stop();
			await database.drop();
		},
	};
}
