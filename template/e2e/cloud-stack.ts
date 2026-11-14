/**
 * The cloud-mode e2e stack, run by Playwright's webServer with Bun: a
 * migrated throwaway database (TEST_DATABASE_URL), the built server in cloud
 * mode on a nano database (connection limit 2: realtime off), and a fake
 * Cloud edge on E2E_CLOUD_PORT in front of it. The specs drive it through
 * a control API on E2E_CLOUD_CONTROL_PORT.
 *
 * The fake edge does what the contract says the real one does: it deletes
 * client-sent identity headers, serves /oauth2/start and /oauth2/sign_out
 * itself (sign-in here is a cookie naming the control API's chosen email),
 * and forwards everything else with X-Cloud-User-* for a signed-in browser
 * plus X-Cloud-Edge-Secret on every request. The App is public: anonymous
 * requests reach it with no identity.
 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { freePort } from "@viktorbarzin/auth/testing";
import { migratedTestDatabase } from "@viktorbarzin/pg/testing";

import { app } from "../src/app.config";

const APP_DIR = resolve(import.meta.dir, "..");
const adminUrl = process.env.TEST_DATABASE_URL;
if (!adminUrl)
	throw new Error("TEST_DATABASE_URL must point at a Postgres for e2e");
const edgePort = Number(process.env.E2E_CLOUD_PORT);
const controlPort = Number(process.env.E2E_CLOUD_CONTROL_PORT);
const edgeOrigin = `http://127.0.0.1:${edgePort}`;
const SECRET = "e2e-cloud-edge-secret-0123456789abcdefghij";
const SESSION_COOKIE = "e2e_edge_session";

const database = await migratedTestDatabase({
	adminUrl,
	migrationsFolder: resolve(APP_DIR, "drizzle"),
	lockKey: app.migrationLockKey,
	prefix: "e2e_cloud",
});

const appPort = await freePort();
const appOrigin = `http://127.0.0.1:${appPort}`;
const inherited: Record<string, string | undefined> = { ...process.env };
for (const key of Object.keys(inherited))
	if (key.startsWith("CLOUD_") || key.startsWith("OIDC_"))
		delete inherited[key];
delete inherited.DEV_USER;
delete inherited.PUBLIC_ORIGINS;
const server = Bun.spawn(
	[process.execPath, resolve(APP_DIR, ".output/server/index.mjs")],
	{
		cwd: APP_DIR,
		env: {
			...inherited,
			NODE_ENV: "test",
			HOST: "127.0.0.1",
			PORT: String(appPort),
			METRICS_PORT: "0",
			DATABASE_URL: database.url,
			CLOUD_EDGE_SECRET: SECRET,
			CLOUD_OWNER_EMAIL: "owner@example.com",
			CLOUD_PUBLIC_URL: edgeOrigin,
			CLOUD_ACCESS: "public",
			CLOUD_DATABASE_CONNECTION_LIMIT: "2",
		},
		stdout: "inherit",
		stderr: "inherit",
	},
);

/** The email /oauth2/start signs in as; null: the sign-in page stays put. */
let loginAs: string | null = null;

function sessionEmail(request: Request): string | null {
	for (const part of (request.headers.get("cookie") ?? "").split(";")) {
		const [name, ...value] = part.trim().split("=");
		if (name === SESSION_COOKIE) return decodeURIComponent(value.join("="));
	}
	return null;
}

/** The request's cookies without the edge's own, as the real edge strips _oauth2_proxy*. */
function appCookies(request: Request): string | null {
	const kept = (request.headers.get("cookie") ?? "")
		.split(";")
		.map((part) => part.trim())
		.filter((part) => part !== "" && !part.startsWith(`${SESSION_COOKIE}=`));
	return kept.length > 0 ? kept.join("; ") : null;
}

function redirect(location: string, cookie?: string): Response {
	const headers = new Headers({ location, "cache-control": "no-store" });
	if (cookie) headers.append("set-cookie", cookie);
	return new Response(null, { status: 302, headers });
}

/** A same-origin path from `rd`, like oauth2-proxy's own check. */
function returnPath(url: URL): string {
	const rd = url.searchParams.get("rd") ?? "/";
	return rd.startsWith("/") && !rd.startsWith("//") ? rd : "/";
}

const edge = Bun.serve({
	hostname: "127.0.0.1",
	port: edgePort,
	idleTimeout: 0,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/oauth2/start") {
			if (loginAs === null)
				return new Response("<h1>Sign-in page</h1>", {
					headers: { "content-type": "text/html" },
				});
			return redirect(
				returnPath(url),
				`${SESSION_COOKIE}=${encodeURIComponent(loginAs)}; Path=/; HttpOnly; SameSite=Lax`,
			);
		}
		if (url.pathname === "/oauth2/sign_out")
			return redirect(returnPath(url), `${SESSION_COOKIE}=; Path=/; Max-Age=0`);
		if (url.pathname.startsWith("/oauth2/"))
			return new Response("not found", { status: 404 });

		const headers = new Headers(request.headers);
		for (const name of [...headers.keys()])
			if (/^x[-_](cloud|auth[-_]request)[-_]/i.test(name)) headers.delete(name);
		headers.delete("cookie");
		const cookies = appCookies(request);
		if (cookies) headers.set("cookie", cookies);
		const email = sessionEmail(request);
		if (email) {
			headers.set(
				"x-cloud-user-id",
				createHash("sha256").update(email).digest("hex"),
			);
			headers.set("x-cloud-user-email", email);
			headers.set("x-cloud-user-username", email.split("@")[0] ?? email);
		}
		headers.set("x-cloud-edge-secret", SECRET);
		// Plain bodies: the edge passes the App's response through unchanged.
		headers.set("accept-encoding", "identity");
		const hasBody = request.method !== "GET" && request.method !== "HEAD";
		const body = hasBody ? await request.arrayBuffer() : null;
		const upstream = await fetch(`${appOrigin}${url.pathname}${url.search}`, {
			method: request.method,
			headers,
			redirect: "manual",
			...(body ? { body } : {}),
		}).catch(() => null);
		// The App is still starting (Playwright polls /healthz until it is up).
		if (upstream === null) return new Response("bad gateway", { status: 502 });
		const out = new Headers(upstream.headers);
		out.delete("content-encoding");
		out.delete("content-length");
		return new Response(upstream.body, {
			status: upstream.status,
			headers: out,
		});
	},
});

const control = Bun.serve({
	hostname: "127.0.0.1",
	port: controlPort,
	async fetch(request) {
		const { pathname } = new URL(request.url);
		const body =
			request.method === "POST"
				? ((await request.json()) as Record<string, unknown>)
				: {};
		if (pathname === "/login-as") {
			loginAs = typeof body.email === "string" ? body.email : null;
			return Response.json({ ok: true });
		}
		if (pathname === "/connections") {
			const rows = (await database.client`
				select query from pg_stat_activity
				where datname = current_database() and pid <> pg_backend_pid()`) as {
				query: string;
			}[];
			return Response.json({
				listen: rows.filter((r) => /^listen/i.test(r.query)).length,
			});
		}
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
	await edge.stop(true);
	await control.stop(true);
	await database.drop();
	process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
void server.exited.then((code) => {
	if (!stopping) {
		console.error(`cloud-mode server exited with ${code}`);
		void stop();
	}
});
