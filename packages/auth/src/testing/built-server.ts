/**
 * Helpers for HTTP tests against an app's built server: start it on a free
 * 127.0.0.1 port (plus a METRICS_PORT listener), a cookie jar, and a redirect
 * follower that behaves like a browser.
 */
import { dirname, resolve } from "node:path";

export async function freePort(): Promise<number> {
	const probe = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response(),
	});
	const port = probe.port as number;
	await probe.stop(true);
	return port;
}

export interface BuiltServer {
	origin: string;
	/** The METRICS_PORT listener (/metrics), separate from the app port; null when not started. */
	metricsOrigin: string | null;
	/** Every stdout and stderr line so far. */
	logs: string[];
	/** Send a signal to the server process. */
	kill(signal: NodeJS.Signals): void;
	/** Resolves with the exit code once the process has exited. */
	exited: Promise<number>;
	stop(): Promise<void>;
}

/** Env keys that must not leak from the developer's shell into the server under test. */
export const SCRUBBED_ENV = [
	"DEV_USER",
	"PUBLIC_ORIGINS",
	"OIDC_DISCOVERY_URL",
	"OIDC_CLIENT_ID",
	"OIDC_CLIENT_SECRET",
	"OIDC_CLIENT_SECRET_FILE",
	"BETTER_AUTH_SECRET",
	"BETTER_AUTH_SECRET_FILE",
	"API_TOKEN_AUDIENCES",
	"AUTHENTIK_API_URL",
	"AUTHENTIK_READER_TOKEN",
	"AUTHENTIK_READER_TOKEN_FILE",
	"AUTHENTIK_APPROVER_TOKEN",
	"AUTHENTIK_APPROVER_TOKEN_FILE",
	"AUTHENTIK_USERS_GROUP_ID",
	"DATABASE_URL",
	"DATABASE_PASSWORD_FILE",
	"METRICS_PORT",
];

export interface StartBuiltServerOptions {
	/** The built entry, e.g. `<app>/.output/server/index.mjs`. */
	entry: string;
	env: Record<string, string>;
	/** Working directory; defaults to two levels above the entry (the app root). */
	cwd?: string;
	/** Start the METRICS_PORT listener too. Default true. */
	metricsPort?: boolean;
	/** Extra env computed from the chosen port, e.g. PUBLIC_ORIGINS. */
	origin?: (port: number) => Record<string, string>;
	/** How long to wait for /healthz. Default 15 s. */
	startTimeoutMs?: number;
}

export async function startBuiltServer(
	opts: StartBuiltServerOptions,
): Promise<BuiltServer> {
	const port = await freePort();
	const metricsPort = opts.metricsPort === false ? null : await freePort();
	const origin = `http://127.0.0.1:${port}`;
	const base: Record<string, string | undefined> = { ...process.env };
	for (const key of SCRUBBED_ENV) delete base[key];
	const proc = Bun.spawn([process.execPath, opts.entry], {
		cwd: opts.cwd ?? resolve(dirname(opts.entry), "../.."),
		env: {
			...base,
			NODE_ENV: "test",
			LOG_LEVEL: "INFO",
			HOST: "127.0.0.1",
			PORT: String(port),
			...(metricsPort === null ? {} : { METRICS_PORT: String(metricsPort) }),
			...(opts.origin?.(port) ?? {}),
			...opts.env,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const logs: string[] = [];
	const pump = async (stream: ReadableStream<Uint8Array>) => {
		const decoder = new TextDecoder();
		for await (const chunk of stream)
			logs.push(...decoder.decode(chunk).split("\n").filter(Boolean));
	};
	void pump(proc.stdout);
	void pump(proc.stderr);
	const deadline = Date.now() + (opts.startTimeoutMs ?? 15_000);
	for (;;) {
		try {
			const res = await fetch(`${origin}/healthz`);
			if (res.ok) break;
		} catch {
			// not listening yet
		}
		if (proc.exitCode !== null || Date.now() > deadline) {
			proc.kill(9);
			throw new Error(`server did not start:\n${logs.join("\n")}`);
		}
		await Bun.sleep(100);
	}
	return {
		origin,
		metricsOrigin:
			metricsPort === null ? null : `http://127.0.0.1:${metricsPort}`,
		logs,
		kill: (signal) => proc.kill(signal),
		exited: proc.exited,
		async stop() {
			proc.kill();
			// Graceful shutdown waits for open streams; do not wait long.
			const exited = await Promise.race([
				proc.exited.then(() => true),
				Bun.sleep(2_000).then(() => false),
			]);
			if (!exited) {
				proc.kill(9);
				await proc.exited;
			}
		},
	};
}

/** A minimal cookie jar for one origin. */
export class CookieJar {
	readonly cookies = new Map<string, string>();
	/** Every Set-Cookie header seen, attributes included. */
	readonly raw: string[] = [];

	store(response: Response): void {
		for (const header of response.headers.getSetCookie()) {
			this.raw.push(header);
			const [pair, ...attributes] = header.split(";");
			const eq = (pair ?? "").indexOf("=");
			const name = (pair ?? "").slice(0, eq).trim();
			const value = (pair ?? "").slice(eq + 1).trim();
			const expired = attributes.some((a) => {
				const [k, v] = a.trim().split("=");
				if (k?.toLowerCase() === "max-age") return Number(v) <= 0;
				if (k?.toLowerCase() === "expires")
					return new Date(v ?? "").getTime() < Date.now();
				return false;
			});
			if (expired || value === "") this.cookies.delete(name);
			else this.cookies.set(name, value);
		}
	}

	header(): string {
		return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
	}
}

export interface Hop {
	url: string;
	status: number;
	location: string | null;
}

/**
 * Follow redirects by hand like a browser would, keeping cookies for
 * `appOrigin`. Returns every hop and the final response.
 */
export async function follow(
	start: string,
	jar: CookieJar,
	appOrigin: string,
	maxHops = 12,
): Promise<{ hops: Hop[]; response: Response }> {
	const hops: Hop[] = [];
	let url = start;
	for (let i = 0; i < maxHops; i++) {
		const target = new URL(url);
		const headers: Record<string, string> = {};
		if (target.origin === appOrigin && jar.cookies.size > 0)
			headers.cookie = jar.header();
		const response = await fetch(url, { redirect: "manual", headers });
		if (target.origin === appOrigin) jar.store(response);
		const location = response.headers.get("location");
		hops.push({ url, status: response.status, location });
		if (response.status < 300 || response.status >= 400 || !location) {
			return { hops, response };
		}
		url = new URL(location, url).toString();
	}
	throw new Error(`too many redirects: ${hops.map((h) => h.url).join(" -> ")}`);
}
