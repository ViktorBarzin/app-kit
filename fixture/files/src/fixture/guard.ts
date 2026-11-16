/**
 * What the fixture's network routes may reach. The fixture runs on public
 * URLs from the home address, so /tcp and /fetch must not be a port scanner
 * or an open proxy: /tcp reaches two named hosts on fixed ports, and /fetch
 * reaches only the App's own Service URLs, origins its owner lists in
 * FIXTURE_FETCH_ALLOW, or https hosts under viktorbarzin.me, and answers
 * only the status, never the body.
 */

/**
 * The hosts /tcp may connect to, each with its ports: the SMTP host of
 * Cloud's SMTP block test (S01) on SMTP's ports and 443, and a host that
 * listens on 443, the test's control (smtp.gmail.com does not answer on 443).
 */
export const TCP_TARGETS: ReadonlyMap<string, ReadonlySet<number>> = new Map([
	["smtp.gmail.com", new Set([25, 465, 587, 2525, 443])],
	["www.google.com", new Set([443])],
]);

/** The longest /slow may wait, in seconds. */
export const SLOW_MAX_S = 600;

/** The https host suffix /fetch accepts besides the App's own origins. */
const PUBLIC_SUFFIX = ".viktorbarzin.me";

export type Allowed<T> = ({ ok: true } & T) | { ok: false; reason: string };

export function tcpAllowed(
	host: string,
	port: string,
): Allowed<{ host: string; port: number }> {
	const name = host.trim().toLowerCase();
	const ports = TCP_TARGETS.get(name);
	if (!ports)
		return {
			ok: false,
			reason: `host must be one of ${[...TCP_TARGETS.keys()].join(", ")}`,
		};
	const number = /^\d{1,5}$/.test(port) ? Number(port) : Number.NaN;
	if (!ports.has(number))
		return {
			ok: false,
			reason: `port for ${name} must be one of ${[...ports].join(", ")}`,
		};
	return { ok: true, host: name, port: number };
}

function originOf(value: string): string | null {
	try {
		const url = new URL(value.trim());
		return url.protocol === "http:" || url.protocol === "https:"
			? url.origin
			: null;
	} catch {
		return null;
	}
}

/**
 * The origins of the App's own URLs: CLOUD_PUBLIC_URL, every CLOUD_URL_<NAME>
 * Cloud sets for a Service the App connects to, and the comma-separated
 * FIXTURE_FETCH_ALLOW the App's owner may set in the Project File (the
 * isolation test points it at another Project's URL).
 */
export function ownOrigins(
	env: Record<string, string | undefined>,
): Set<string> {
	const out = new Set<string>();
	for (const [name, value] of Object.entries(env)) {
		if (value === undefined) continue;
		const values =
			name === "CLOUD_PUBLIC_URL" || name.startsWith("CLOUD_URL_")
				? [value]
				: name === "FIXTURE_FETCH_ALLOW"
					? value.split(",")
					: [];
		for (const item of values) {
			const origin = originOf(item);
			if (origin) out.add(origin);
		}
	}
	return out;
}

export function fetchAllowed(
	raw: string,
	own: ReadonlySet<string>,
): Allowed<{ url: URL }> {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return { ok: false, reason: "url is not a URL" };
	}
	if (url.username || url.password)
		return { ok: false, reason: "url may not carry credentials" };
	if (own.has(url.origin)) return { ok: true, url };
	if (url.protocol === "https:" && url.hostname.endsWith(PUBLIC_SUFFIX))
		return { ok: true, url };
	return {
		ok: false,
		reason: `url must be on one of the App's own URLs or an https host under ${PUBLIC_SUFFIX.slice(1)}`,
	};
}

export function slowSeconds(value: string | null): number | null {
	if (value === null || !/^\d+$/.test(value)) return null;
	return Math.min(Number(value), SLOW_MAX_S);
}
