/**
 * createRedis on Cloud's Key Value: the App's keys and channels stay under
 * CLOUD_KV_PREFIX, BullMQ runs under it, and a write refused because the
 * Key Value is over its Size throws an error that names the Size.
 *
 * The integration tests start their own redis:8.10.3-alpine container (the
 * shared homelab Redis's image) with a tenant user made from the exact rule
 * template of infra's redis-acl-sync, and are skipped without docker or
 * that image.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { Queue, Worker } from "bullmq";
import Redis from "ioredis";
import {
	createRedis,
	fullMessage,
	isFullRefusal,
	KeyValueFullError,
	sizeText,
	toKeyValueError,
} from "./redis.server";
import { TENANT_WRITE_COMMANDS } from "./redis-tenant-writes";

class ReplyError extends Error {}

describe("the full error", () => {
	test("names the Size in MiB", () => {
		expect(sizeText(16 * 1048576)).toBe("16 MiB");
		expect(sizeText(1500)).toBe("1500 bytes");
		expect(fullMessage(16 * 1048576)).toBe(
			"Key Value is full: over its Size of 16 MiB; delete keys or choose a bigger Size",
		);
	});

	const refusal = (command: string) =>
		new ReplyError(
			`NOPERM User p_a_b_0123456789 has no permissions to run the '${command}' command`,
		);

	test("a refused write the tenant may run while under its Size is the full error", () => {
		for (const command of [
			"set",
			"hset",
			"incr",
			"publish",
			"eval",
			"evalsha",
			"xgroup|create",
			"blmove",
		])
			expect([command, isFullRefusal(refusal(command))]).toEqual([
				command,
				true,
			]);
		const refused = refusal("set");
		const mapped = toKeyValueError(refused, 16 * 1048576);
		expect(mapped).toBeInstanceOf(KeyValueFullError);
		expect((mapped as KeyValueFullError).message).toBe(
			fullMessage(16 * 1048576),
		);
		expect((mapped as KeyValueFullError).code).toBe("KV_FULL");
		expect((mapped as KeyValueFullError).command).toBe("set");
		expect((mapped as KeyValueFullError).maxBytes).toBe(16 * 1048576);
		expect((mapped as KeyValueFullError).cause).toBe(refused);
	});

	test("a command the tenant may never run is never the full error", () => {
		for (const command of [
			"flushdb",
			"flushall",
			"sort",
			"swapdb",
			"move",
			"copy",
			"keys",
			"select",
			"scan",
			"randomkey",
			"dbsize",
			"function|load",
			"function|delete",
			"script|flush",
			"script|kill",
			"pubsub|channels",
			"config|set",
			"info",
		])
			expect([command, isFullRefusal(refusal(command))]).toEqual([
				command,
				false,
			]);
	});

	test("other refusals pass through unchanged", () => {
		const key = new ReplyError("NOPERM No permissions to access a key");
		const keys = refusal("keys");
		const other = new ReplyError("WRONGTYPE Operation against a key");
		expect(toKeyValueError(key, 16)).toBe(key);
		expect(toKeyValueError(keys, 16)).toBe(keys);
		expect(toKeyValueError(other, 16)).toBe(other);
		// Without a Size there is no limit to name.
		expect(toKeyValueError(refusal("set"), null)).toBeInstanceOf(ReplyError);
	});

	test("the channel helper prefixes, the client is lazy", async () => {
		const kv = createRedis({
			url: "redis://127.0.0.1:9/0",
			prefix: "p:a:b:",
			maxBytes: 16,
		});
		expect(kv.prefix).toBe("p:a:b:");
		expect(kv.channel("news")).toBe("p:a:b:news");
		expect(kv.bullmqPrefix).toBe("p:a:b:bull");
		expect(kv.client.options.keyPrefix).toBe("p:a:b:");
		expect(kv.client.status).toBe("wait");
		await kv.close();
	});

	test("without settings it says what to set", () => {
		expect(() => createRedis(null)).toThrow(/REDIS_URL/);
	});
});

// --- integration: a real redis:8.10.3 ------------------------------------------

const IMAGE = "docker.io/library/redis:8.10.3-alpine";

function dockerOk(): boolean {
	try {
		return (
			Bun.spawnSync(["docker", "image", "inspect", IMAGE], {
				stdout: "ignore",
				stderr: "ignore",
			}).exitCode === 0
		);
	} catch {
		return false;
	}
}

const USER = "p_t_t_0123456789";
const OTHER = "p_o_o_9876543210";
const PREFIX = "p:t:t:";
const SIZE = 16 * 1048576;

/** The tenant template of infra's redis-acl-sync, for one prefix. */
function tenantRules(prefix: string): string[] {
	return [
		"resetkeys",
		`~${prefix}*`,
		"resetchannels",
		`&${prefix}*`,
		"-@all",
		"+@read",
		"+@write",
		"+@keyspace",
		"+@hash",
		"+@list",
		"+@set",
		"+@sortedset",
		"+@stream",
		"+@string",
		"+@pubsub",
		"+@transaction",
		"+@scripting",
		"+@connection",
		"-@dangerous",
		"-select",
		"-scan",
		"-randomkey",
		"-function",
		"-script|flush",
		"-move",
		"-copy",
		"-script|kill",
		"-dbsize",
		"-pubsub|channels",
		"-pubsub|shardchannels",
		"-pubsub|numsub",
		"-pubsub|shardnumsub",
		"-pubsub|numpat",
		"-script|debug",
		"-@search",
		// Keyless module commands: they read other tenants' keys by label.
		...KEYLESS_MODULE_COMMANDS.map((name) => `-${name}`),
	];
}

/**
 * The module commands in the template's categories that take no key, so
 * the key pattern cannot confine them (COMMAND INFO first key 0 on 8.10.3).
 */
const KEYLESS_MODULE_COMMANDS = [
	"ts.mget",
	"ts.mrange",
	"ts.mrevrange",
	"ts.nrange",
	"ts.nrevrange",
	"ts.queryindex",
	"ts.querylabels",
	"json.debug",
];

/** The template's own refusals beyond -@dangerous, for the category check. */
const TEMPLATE_REFUSES = ["move", "copy"];

/** The read-and-delete rule set of a tenant over its Size. */
function fullRules(prefix: string): string[] {
	return [
		"resetkeys",
		`~${prefix}*`,
		"resetchannels",
		`&${prefix}*`,
		"-@all",
		"+@read",
		"+del",
		"+unlink",
		"+@connection",
		"-@dangerous",
		"-select",
		"-scan",
		"-randomkey",
	];
}

describe.skipIf(!dockerOk())("on a real Redis with the tenant rules", () => {
	const name = `app-kit-kv-${randomBytes(4).toString("hex")}`;
	const password = randomBytes(16).toString("hex");
	let port = 0;
	let admin: Redis;

	const url = (user: string) =>
		`redis://${user}:${password}@127.0.0.1:${port}/0`;

	beforeAll(async () => {
		Bun.spawnSync([
			"docker",
			"run",
			"-d",
			"--rm",
			"--name",
			name,
			"-p",
			"127.0.0.1::6379",
			IMAGE,
			"redis-server",
			"--save",
			"",
			"--appendonly",
			"no",
		]);
		const mapped = Bun.spawnSync(["docker", "port", name, "6379/tcp"])
			.stdout.toString()
			.trim()
			.split("\n")[0];
		port = Number(mapped?.split(":").pop());
		admin = new Redis({ port, host: "127.0.0.1", lazyConnect: true });
		for (let i = 0; i < 50; i++) {
			try {
				await admin.connect();
				break;
			} catch {
				admin.disconnect();
				await Bun.sleep(100);
			}
		}
		await admin.call(
			"ACL",
			"SETUSER",
			USER,
			"reset",
			"on",
			`>${password}`,
			...tenantRules(PREFIX),
		);
		await admin.call(
			"ACL",
			"SETUSER",
			OTHER,
			"reset",
			"on",
			`>${password}`,
			...tenantRules("p:o:o:"),
		);
	}, 30_000);

	afterAll(() => {
		admin?.disconnect();
		Bun.spawnSync(["docker", "rm", "-f", name], {
			stdout: "ignore",
			stderr: "ignore",
		});
	});

	test("SET and GET land under the prefix", async () => {
		const kv = createRedis({ url: url(USER), prefix: PREFIX, maxBytes: SIZE });
		try {
			await kv.client.set("greeting", "hello");
			expect(await kv.client.get("greeting")).toBe("hello");
			expect(await admin.get(`${PREFIX}greeting`)).toBe("hello");
		} finally {
			await kv.close();
		}
	});

	test("another Project's prefix and KEYS are refused", async () => {
		await admin.set("p:o:o:secret", "x");
		const raw = new Redis(url(USER), { enableReadyCheck: false });
		try {
			await expect(raw.get("p:o:o:secret")).rejects.toThrow(/NOPERM/);
			await expect(raw.keys("*")).rejects.toThrow(/NOPERM/);
			await expect(raw.select(1)).rejects.toThrow(/NOPERM/);
		} finally {
			raw.disconnect();
		}
	});

	test("a BullMQ job is enqueued and processed under the prefix", async () => {
		const kv = createRedis({ url: url(USER), prefix: PREFIX, maxBytes: SIZE });
		const queue = new Queue("selftest", kv.bullmq());
		let resolveDone: (value: string) => void = () => {};
		const done = new Promise<string>((resolve) => {
			resolveDone = resolve;
		});
		const worker = new Worker(
			"selftest",
			async (job) => {
				resolveDone(String(job.data.n));
				return "ok";
			},
			kv.bullmq(),
		);
		try {
			await queue.add("one", { n: 7 });
			expect(await done).toBe("7");
			const keys = (await admin.keys("*bull*")).sort();
			expect(keys.length).toBeGreaterThan(0);
			for (const key of keys)
				expect(key.startsWith(`${PREFIX}bull:`)).toBe(true);
		} finally {
			await worker.close();
			await queue.close();
			await kv.close();
		}
	}, 20_000);

	test("a pub/sub round trip on a prefixed channel", async () => {
		const kv = createRedis({ url: url(USER), prefix: PREFIX, maxBytes: SIZE });
		const sub = kv.subscriber();
		try {
			const got = new Promise<[string, string]>((resolve) => {
				sub.on("message", (channel: string, message: string) =>
					resolve([channel, message]),
				);
			});
			await sub.subscribe(kv.channel("news"));
			await kv.client.publish(kv.channel("news"), "hi");
			expect(await got).toEqual([`${PREFIX}news`, "hi"]);
			// An unprefixed channel is outside the tenant's channels.
			await expect(kv.client.publish("news", "hi")).rejects.toThrow(/NOPERM/);
		} finally {
			sub.disconnect();
			await kv.close();
		}
	});

	test("the full-error write list is what the tenant template allows on this Redis", async () => {
		const list = async (category: string) =>
			new Set(
				(
					(await admin.call(
						"COMMAND",
						"LIST",
						"FILTERBY",
						"ACLCAT",
						category,
					)) as string[]
				).map((name) => name.toLowerCase()),
			);
		const [write, dangerous, scripting, search] = await Promise.all([
			list("write"),
			list("dangerous"),
			list("scripting"),
			list("search"),
		]);
		const expected = new Set(
			[...write].filter(
				(name) =>
					!dangerous.has(name) &&
					!search.has(name) &&
					!KEYLESS_MODULE_COMMANDS.includes(name) &&
					!TEMPLATE_REFUSES.includes(name) &&
					!name.startsWith("function|"),
			),
		);
		for (const name of scripting)
			if (!dangerous.has(name) && !name.includes("|")) expected.add(name);
		expected.add("publish");
		expected.add("spublish");
		expect([...TENANT_WRITE_COMMANDS].sort()).toEqual([...expected].sort());
		// And the tenant really may run them, and may not run the refused ones.
		const dryrun = (args: string[]) =>
			admin.call("ACL", "DRYRUN", USER, ...args).then(String);
		expect(await dryrun(["set", `${PREFIX}a`, "1"])).toBe("OK");
		expect(await dryrun(["publish", `${PREFIX}c`, "1"])).toBe("OK");
		for (const args of [
			["flushdb"],
			["sort", `${PREFIX}a`, "store", `${PREFIX}b`],
			["swapdb", "0", "1"],
			["move", `${PREFIX}a`, "1"],
			["copy", `${PREFIX}a`, `${PREFIX}b`],
			["dbsize"],
			["pubsub", "channels"],
			["script", "kill"],
			["script", "debug", "no"],
			["ft.add", "idx", "doc", "1.0", "fields", "f", "v"],
			["ft.search", "idx", "*"],
			["ts.queryindex", "a=b"],
			["ts.querylabels", "a=b"],
			["ts.mrange", "-", "+", "filter", "a=b"],
			["json.debug", "help"],
		])
			expect([
				args.slice(0, 2).join(" "),
				/has no permissions to run the/.test(
					await dryrun(args).catch((err: Error) => err.message),
				),
			]).toEqual([args.slice(0, 2).join(" "), true]);
	});

	test("over its Size: writes throw the full error, GET and DEL still work", async () => {
		const kv = createRedis({ url: url(USER), prefix: PREFIX, maxBytes: SIZE });
		try {
			await kv.client.set("kept", "1");
			await admin.call(
				"ACL",
				"SETUSER",
				USER,
				"reset",
				"on",
				`>${password}`,
				...fullRules(PREFIX),
			);
			const err = await kv.client.set("more", "2").catch((e: unknown) => e);
			expect(err).toBeInstanceOf(KeyValueFullError);
			expect((err as Error).message).toBe(
				"Key Value is full: over its Size of 16 MiB; delete keys or choose a bigger Size",
			);
			expect(await kv.client.get("kept")).toBe("1");
			expect(await kv.client.del("kept")).toBe(1);
			// A key outside the prefix is still the plain NOPERM.
			const raw = new Redis(url(USER), { enableReadyCheck: false });
			try {
				const other = await raw.get("p:o:o:secret").catch((e: unknown) => e);
				expect(other).not.toBeInstanceOf(KeyValueFullError);
			} finally {
				raw.disconnect();
			}
		} finally {
			await admin.call(
				"ACL",
				"SETUSER",
				USER,
				"reset",
				"on",
				`>${password}`,
				...tenantRules(PREFIX),
			);
			await kv.close();
		}
	});
});
