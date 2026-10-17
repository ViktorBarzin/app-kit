/**
 * The e2e stack, run by Playwright's webServer with Bun: a migrated throwaway
 * database (TEST_DATABASE_URL), the mock Authentik, the built server on
 * E2E_PORT, and a control API on E2E_CONTROL_PORT that the specs (which run
 * under Node) use to drive the mock and the database.
 */
import { resolve } from "node:path";
import { startMockAuthentik } from "@viktorbarzin/auth/testing";
import { migratedTestDatabase } from "@viktorbarzin/pg/testing";

import { app } from "../src/app.config";

const APP_DIR = resolve(import.meta.dir, "..");
const adminUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl)
	throw new Error("TEST_DATABASE_URL must point at a Postgres for e2e");
const port = Number(process.env.E2E_PORT);
const controlPort = Number(process.env.E2E_CONTROL_PORT);
const origin = `http://127.0.0.1:${port}`;

const database = await migratedTestDatabase({
	adminUrl,
	migrationsFolder: resolve(APP_DIR, "drizzle"),
	lockKey: app.migrationLockKey,
	prefix: "e2e_test",
});
const mock = await startMockAuthentik({
	clientId: app.slug,
	usersGroup: app.usersGroup,
});
mock.addUser({ username: "guest", email: null, groups: ["Public Guests"] });

const server = Bun.spawn(
	[process.execPath, resolve(APP_DIR, ".output/server/index.mjs")],
	{
		cwd: APP_DIR,
		env: {
			...process.env,
			NODE_ENV: "test",
			HOST: "127.0.0.1",
			PORT: String(port),
			METRICS_PORT: "0",
			PUBLIC_ORIGINS: origin,
			DATABASE_URL: database.url,
			OIDC_DISCOVERY_URL: mock.discoveryUrl,
			OIDC_CLIENT_ID: mock.clientId,
			OIDC_CLIENT_SECRET: mock.clientSecret,
			BETTER_AUTH_SECRET: "e2e-secret-0123456789abcdef0123456789abcdef",
			AUTHENTIK_API_URL: mock.apiUrl,
			AUTHENTIK_READER_TOKEN: mock.readerToken,
			AUTHENTIK_APPROVER_TOKEN: mock.approverToken,
		},
		stdout: "inherit",
		stderr: "inherit",
	},
);

async function listenPid(): Promise<number | null> {
	const rows = await database.client`
		select pid from pg_stat_activity
		where datname = current_database() and query ilike ${`listen%${app.realtimeChannel}%`}`;
	return (rows[0] as { pid: number } | undefined)?.pid ?? null;
}

const control = Bun.serve({
	hostname: "127.0.0.1",
	port: controlPort,
	async fetch(request) {
		const { pathname } = new URL(request.url);
		const body =
			request.method === "POST"
				? ((await request.json()) as Record<string, unknown>)
				: {};
		if (pathname === "/user") {
			const user = mock.addUser({
				username: String(body.username),
				groups: (body.groups as string[] | undefined) ?? [],
			});
			return Response.json({ uid: user.uid });
		}
		if (pathname === "/login-as") {
			mock.session = null;
			mock.loginAs = String(body.username);
			return Response.json({ ok: true });
		}
		if (pathname === "/silent-item") {
			// A row written without NOTIFY: only a resync can show it.
			const user = mock.users.get(String(body.username));
			if (!user) return new Response("no such user", { status: 404 });
			await database.client`insert into items (owner_sub, title) values (${user.uid}, ${String(body.title)})`;
			return Response.json({ ok: true });
		}
		if (pathname === "/kill-listen") {
			const pid = await listenPid();
			if (pid === null) return new Response("no LISTEN", { status: 409 });
			await database.client`select pg_terminate_backend(${pid})`;
			return Response.json({ pid });
		}
		if (pathname === "/listen-pid")
			return Response.json({ pid: await listenPid() });
		return new Response("not found", { status: 404 });
	},
});

let stopping = false;
async function stop() {
	if (stopping) return;
	stopping = true;
	server.kill("SIGTERM");
	await Promise.race([server.exited, Bun.sleep(3_000)]);
	server.kill(9);
	await control.stop(true);
	await mock.stop();
	await database.drop();
	process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
void server.exited.then((code) => {
	if (!stopping) {
		console.error(`server exited with ${code}`);
		void stop();
	}
});
