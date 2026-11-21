/**
 * The Key Value routes' real Redis work (kv.ts has the routes), on the
 * template's createRedis: the App's own prefix, BullMQ under it and the
 * full error. /probe/kv alone uses a plain client without the prefix.
 */
import { randomUUID } from "node:crypto";
import { processSingleton } from "@viktorbarzin/runtime";
import { Queue, Worker } from "bullmq";
import Redis from "ioredis";

import type { KeyValueSettings } from "#/server/env.server";
import { createRedis, type KeyValue } from "#/server/redis.server";

import { type KvDeps, redisErrorText, type SelftestResult } from "./kv";

/** The queue /kv-selftest sends one job to and works it. */
export const SELFTEST_QUEUE = "fixture-selftest";
const STEP_TIMEOUT_MS = 10_000;

/** The fill's keys, under the App's prefix: fixture-fill:<n> and the counter. */
const FILL_NEXT = "fixture-fill:next";
const FILL_SMALL = "fixture-fill:small";
const fillKey = (n: number) => `fixture-fill:${n}`;
const ONE_MIB = Buffer.alloc(1048576, "f");

function within<T>(promise: Promise<T>, what: string): Promise<T> {
	return Promise.race([
		promise,
		new Promise<T>((_, reject) =>
			setTimeout(
				() =>
					reject(new Error(`${what}: no answer within ${STEP_TIMEOUT_MS} ms`)),
				STEP_TIMEOUT_MS,
			),
		),
	]);
}

async function step(
	name: string,
	run: () => Promise<void>,
): Promise<SelftestResult | null> {
	try {
		await run();
		return null;
	} catch (err) {
		return {
			ok: false,
			step: name,
			error: err instanceof Error ? err.message.slice(0, 300) : String(err),
		};
	}
}

async function selftest(kv: KeyValue): Promise<SelftestResult> {
	const id = randomUUID();
	const steps: [string, () => Promise<void>][] = [
		[
			"set",
			async () => void (await kv.client.set(`selftest:${id}`, id, "EX", 60)),
		],
		[
			"get",
			async () => {
				const got = await kv.client.get(`selftest:${id}`);
				if (got !== id) throw new Error(`GET answered ${JSON.stringify(got)}`);
			},
		],
		[
			"bullmq",
			async () => {
				const queue = new Queue(SELFTEST_QUEUE, kv.bullmq());
				let done: (value: string) => void = () => {};
				const processed = new Promise<string>((resolve) => {
					done = resolve;
				});
				const worker = new Worker(
					SELFTEST_QUEUE,
					async (job) => {
						if (job.data.id === id) done(id);
					},
					{ ...kv.bullmq(), autorun: true },
				);
				try {
					await queue.add("selftest", { id }, { removeOnComplete: true });
					await within(processed, "the BullMQ job");
				} finally {
					await worker.close();
					await queue.close();
				}
			},
		],
		[
			"pubsub",
			async () => {
				const sub = kv.subscriber();
				const channel = kv.channel(`selftest:${id}`);
				try {
					const got = new Promise<string>((resolve) => {
						sub.on("message", (_channel: string, message: string) =>
							resolve(message),
						);
					});
					await sub.subscribe(channel);
					await kv.client.publish(channel, id);
					const message = await within(got, "the pub/sub message");
					if (message !== id) throw new Error("another message arrived");
				} finally {
					sub.disconnect();
				}
			},
		],
	];
	for (const [name, run] of steps) {
		const failed = await step(name, run);
		if (failed) return failed;
	}
	return { ok: true };
}

/** GET `key` as the App's own user, with no prefix and no retries. */
async function probe(
	url: string,
	key: string,
): Promise<{ ok: true } | { error: string }> {
	const client = new Redis(url, {
		lazyConnect: true,
		enableReadyCheck: false,
		maxRetriesPerRequest: 0,
		connectTimeout: 5_000,
	});
	try {
		await client.get(key);
		return { ok: true };
	} catch (err) {
		return { error: redisErrorText(err) };
	} finally {
		client.disconnect();
	}
}

/** The Key Value routes' Redis work for this process. */
export function redisKv(settings: KeyValueSettings): KvDeps {
	const kv = processSingleton("fixture-kv", () => createRedis(settings));
	return {
		selftest: () => selftest(kv),
		probe: (key) => probe(settings.url, key),
		fill: {
			async writeOneMib() {
				const n = await kv.client.incr(FILL_NEXT);
				await kv.client.set(fillKey(n), ONE_MIB);
			},
			async writeSmall() {
				await kv.client.set(FILL_SMALL, "x");
			},
			async filledMib() {
				return Number((await kv.client.get(FILL_NEXT)) ?? 0);
			},
			async clear() {
				const next = Number((await kv.client.get(FILL_NEXT)) ?? 0);
				let deleted = 0;
				for (let from = 1; from <= next; from += 500) {
					const keys: string[] = [];
					for (let n = from; n < from + 500 && n <= next; n++)
						keys.push(fillKey(n));
					deleted += await kv.client.del(...keys);
				}
				await kv.client.del(FILL_NEXT, FILL_SMALL);
				return deleted;
			},
		},
	};
}
