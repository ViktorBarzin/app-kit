import { describe, expect, test } from "bun:test";

import { handleKv, KV_FILL_MAX_MIB, type KvDeps, kvFillLimitMib } from "./kv";

const FULL_MESSAGE =
	"Key Value is full: over its Size of 16 MiB; delete keys or choose a bigger Size";

class FullError extends Error {
	readonly code = "KV_FULL";
}

/** A Key Value that holds `sizeMib` and then refuses writes as full. */
function fakeKv(sizeMib = 16): KvDeps & { filled: number; probed: string[] } {
	const state = {
		filled: 0,
		probed: [] as string[],
	};
	const full = () => new FullError(FULL_MESSAGE);
	return Object.assign(state, {
		selftest: async () => ({ ok: true as const }),
		probe: async (key: string) => {
			state.probed.push(key);
			return key.startsWith("p:other:")
				? { error: "NOPERM No permissions to access a key" }
				: { ok: true as const };
		},
		fill: {
			writeOneMib: async () => {
				if (state.filled >= sizeMib) throw full();
				state.filled += 1;
			},
			writeSmall: async () => {
				if (state.filled >= sizeMib) throw full();
			},
			filledMib: async () => state.filled,
			clear: async () => {
				const n = state.filled;
				state.filled = 0;
				return n;
			},
		},
	});
}

const ENV = {
	FIXTURE_FILL: "on",
	CLOUD_KV_MAX_BYTES: String(16 * 1048576),
};

const call = (
	path: string,
	kv: KvDeps | null,
	env: Record<string, string | undefined> = ENV,
) => handleKv(new Request(`http://fx.test${path}`), kv, env);

describe("/kv-selftest", () => {
	test("ok when every step works", async () => {
		const response = await call("/kv-selftest", fakeKv());
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ result: "ok" });
	});

	test("names the failing step", async () => {
		const kv = fakeKv();
		kv.selftest = async () => ({
			ok: false,
			step: "bullmq",
			error: "NOPERM User u has no permissions to run the 'info' command",
		});
		const response = await call("/kv-selftest", kv);
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({
			result: "failed",
			step: "bullmq",
			error: "NOPERM User u has no permissions to run the 'info' command",
		});
	});

	test("503 without a Key Value", async () => {
		const response = await call("/kv-selftest", null);
		expect(response.status).toBe(503);
		expect((await response.json()).error.code).toBe("no_key_value");
	});
});

describe("/probe/kv", () => {
	test("answers the Redis error for another Project's key", async () => {
		const kv = fakeKv();
		const response = await call("/probe/kv?key=p:other:cache:x", kv);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			key: "p:other:cache:x",
			error: "NOPERM No permissions to access a key",
		});
		expect(kv.probed).toEqual(["p:other:cache:x"]);
	});

	test("ok for a key the App may read", async () => {
		const response = await call("/probe/kv?key=p:mine:cache:x", fakeKv());
		expect(await response.json()).toEqual({ key: "p:mine:cache:x", ok: true });
	});

	test("refuses an empty, long or spaced key", async () => {
		for (const key of ["", "a b", "x".repeat(201)]) {
			const response = await call(
				`/probe/kv?key=${encodeURIComponent(key)}`,
				fakeKv(),
			);
			expect(response.status).toBe(400);
		}
	});
});

describe("/kv-fill", () => {
	test("off unless FIXTURE_FILL=on", async () => {
		const response = await call("/kv-fill?mb=1", fakeKv(), {
			CLOUD_KV_MAX_BYTES: ENV.CLOUD_KV_MAX_BYTES,
		});
		expect(response.status).toBe(404);
	});

	test("writes N MiB of 1 MiB keys", async () => {
		const kv = fakeKv();
		const response = await call("/kv-fill?mb=3", kv);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ wroteMib: 3, keys: 3 });
		expect(kv.filled).toBe(3);
	});

	test("past the Size: 507 kv_full with the message, after what fit", async () => {
		const kv = fakeKv(16);
		const response = await call("/kv-fill?mb=20", kv);
		expect(response.status).toBe(507);
		expect(await response.json()).toEqual({
			error: { code: "kv_full", message: FULL_MESSAGE },
			wroteMib: 16,
			keys: 16,
		});
	});

	test("write=1: ok, then the full error once full", async () => {
		const kv = fakeKv(1);
		const ok = await call("/kv-fill?write=1", kv);
		expect([ok.status, await ok.json()]).toEqual([200, { ok: true }]);
		await call("/kv-fill?mb=1", kv);
		const full = await call("/kv-fill?write=1", kv);
		expect(full.status).toBe(507);
		expect(await full.json()).toEqual({
			error: { code: "kv_full", message: FULL_MESSAGE },
		});
	});

	test("clear=1 deletes the fill keys", async () => {
		const kv = fakeKv();
		await call("/kv-fill?mb=2", kv);
		const response = await call("/kv-fill?clear=1", kv);
		expect(await response.json()).toEqual({ deleted: 2 });
		expect(kv.filled).toBe(0);
	});

	test("never fills past twice the Size, so the shared Redis is safe", async () => {
		expect(kvFillLimitMib(ENV)).toBe(32);
		const kv = fakeKv(1000);
		kv.filled = 30;
		const response = await call("/kv-fill?mb=3", kv);
		expect(response.status).toBe(409);
		expect((await response.json()).error.code).toBe("fill_limit");
		expect(kv.filled).toBe(30);
	});

	test("refuses a bad mb and a Key Value without a Size", async () => {
		for (const mb of ["0", "x", String(KV_FILL_MAX_MIB + 1)]) {
			const response = await call(`/kv-fill?mb=${mb}`, fakeKv());
			expect([mb, response.status]).toEqual([mb, 400]);
		}
		const response = await call("/kv-fill?mb=1", fakeKv(), {
			FIXTURE_FILL: "on",
		});
		expect(response.status).toBe(409);
	});

	test("other errors are 500 kv_error", async () => {
		const kv = fakeKv();
		kv.fill.writeSmall = async () => {
			throw new Error("WRONGTYPE Operation against a key");
		};
		const response = await call("/kv-fill?write=1", kv);
		expect(response.status).toBe(500);
		expect((await response.json()).error.code).toBe("kv_error");
	});
});
