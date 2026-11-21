/**
 * The fixture's Key Value routes (Cloud's `keyvalue` kind, B27), with the
 * Redis work passed in (kv-redis.ts does it for real; kv.test.ts fakes it):
 *
 * - /kv-selftest: SET, GET, one BullMQ job enqueued and processed and one
 *   pub/sub round trip through the template's createRedis;
 * - /probe/kv?key=K: GET K with the App's own credentials and no prefix, so
 *   a key under another Project's prefix answers Redis's NOPERM;
 * - /kv-fill: only with FIXTURE_FILL=on, writes 1 MiB keys without a TTL
 *   under the App's prefix to fill the Key Value past its Size, one small
 *   write to see whether writes work, and deletes them again. It never
 *   holds more than twice the Size, since the Redis is shared.
 */
/** The most MiB one /kv-fill call writes. */
export const KV_FILL_MAX_MIB = 256;

const MIB = 1048576;

export type SelftestResult =
	| { ok: true }
	| { ok: false; step: string; error: string };

export interface KvFill {
	/** Writes one more 1 MiB key without a TTL. */
	writeOneMib(): Promise<void>;
	/** Writes one small key without a TTL. */
	writeSmall(): Promise<void>;
	/** How many 1 MiB keys the fill holds now. */
	filledMib(): Promise<number>;
	/** Deletes every fill key; answers how many. */
	clear(): Promise<number>;
}

export interface KvDeps {
	selftest(): Promise<SelftestResult>;
	/** GET `key` with the App's own user and no prefix. */
	probe(key: string): Promise<{ ok: true } | { error: string }>;
	fill: KvFill;
}

const json = (body: unknown, status = 200) =>
	Response.json(body, {
		status,
		headers: { "cache-control": "no-store" },
	});

const fail = (status: number, code: string, message: string) =>
	json({ error: { code, message } }, status);

/** A key /probe/kv may try: 1-200 printable characters, no space. */
const PROBE_KEY = /^[\x21-\x7e]{1,200}$/;

/** The template's KeyValueFullError, without importing server code. */
export function isFull(err: unknown): err is Error {
	return err instanceof Error && "code" in err && err.code === "KV_FULL";
}

/** A Redis reply error's text, else only the kind of failure. */
export function redisErrorText(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	return /^[A-Z]+ /.test(message) ? message.slice(0, 300) : "error";
}

/** The most MiB /kv-fill holds: twice the Size, 0 when the Size is unknown. */
export function kvFillLimitMib(
	env: Record<string, string | undefined>,
): number {
	const raw = env.CLOUD_KV_MAX_BYTES?.trim() ?? "";
	return /^[1-9][0-9]*$/.test(raw) ? Math.ceil((2 * Number(raw)) / MIB) : 0;
}

/** One /kv-fill at a time per process. */
function kvFillLock(): { busy: boolean } {
	const key = Symbol.for("app-template-fixture:kv-fill");
	const holder = globalThis as unknown as Record<
		symbol,
		{ busy: boolean } | undefined
	>;
	let lock = holder[key];
	if (!lock) {
		lock = { busy: false };
		holder[key] = lock;
	}
	return lock;
}

async function selftest(kv: KvDeps): Promise<Response> {
	const result = await kv.selftest();
	if (result.ok) return json({ result: "ok" });
	return json(
		{ result: "failed", step: result.step, error: result.error },
		500,
	);
}

async function probe(kv: KvDeps, url: URL): Promise<Response> {
	const key = url.searchParams.get("key") ?? "";
	if (!PROBE_KEY.test(key))
		return fail(
			400,
			"bad_key",
			"key must be 1-200 printable characters with no space",
		);
	return json({ key, ...(await kv.probe(key)) });
}

async function fill(
	kv: KvDeps,
	env: Record<string, string | undefined>,
	url: URL,
): Promise<Response> {
	if (env.FIXTURE_FILL?.trim() !== "on")
		return fail(404, "not_found", "/kv-fill is off: set FIXTURE_FILL=on");
	const lock = kvFillLock();
	if (lock.busy)
		return fail(409, "fill_busy", "another /kv-fill is running; try again");
	lock.busy = true;
	try {
		if (url.searchParams.get("clear") === "1")
			return json({ deleted: await kv.fill.clear() });
		if (url.searchParams.get("write") === "1") {
			try {
				await kv.fill.writeSmall();
				return json({ ok: true });
			} catch (err) {
				if (isFull(err)) return fail(507, "kv_full", err.message);
				return fail(500, "kv_error", redisErrorText(err));
			}
		}
		const mb = url.searchParams.get("mb") ?? "";
		const mib = /^\d+$/.test(mb) ? Number(mb) : 0;
		if (mib < 1 || mib > KV_FILL_MAX_MIB)
			return fail(
				400,
				"bad_fill_request",
				`mb must be a whole number from 1 to ${KV_FILL_MAX_MIB}, or write=1, or clear=1`,
			);
		const limit = kvFillLimitMib(env);
		const before = await kv.fill.filledMib();
		if (before + mib > limit)
			return fail(
				409,
				"fill_limit",
				limit === 0
					? "CLOUD_KV_MAX_BYTES is not set, so the fill has no limit to keep under"
					: `the fill holds ${before} MiB; ${mib} more would pass ${limit} MiB, twice the Size`,
			);
		let wrote = 0;
		try {
			for (; wrote < mib; wrote++) await kv.fill.writeOneMib();
		} catch (err) {
			if (isFull(err))
				return json(
					{
						error: { code: "kv_full", message: err.message },
						wroteMib: wrote,
						keys: wrote,
					},
					507,
				);
			return json(
				{
					error: { code: "kv_error", message: redisErrorText(err) },
					wroteMib: wrote,
					keys: wrote,
				},
				500,
			);
		}
		return json({ wroteMib: wrote, keys: wrote });
	} finally {
		lock.busy = false;
	}
}

/** /kv-selftest, /probe/kv and /kv-fill (KV_PATHS); 503 without a Key Value. */
export async function handleKv(
	request: Request,
	kv: KvDeps | null,
	env: Record<string, string | undefined>,
): Promise<Response> {
	const url = new URL(request.url);
	if (kv === null)
		return fail(
			503,
			"no_key_value",
			"the App has no REDIS_URL: connect a Key Value to it",
		);
	if (url.pathname === "/kv-selftest") return selftest(kv);
	if (url.pathname === "/probe/kv") return probe(kv, url);
	return fill(kv, env, url);
}

/** The paths handleKv answers. */
export const KV_PATHS = new Set(["/kv-selftest", "/probe/kv", "/kv-fill"]);
