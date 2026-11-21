/**
 * The App's Key Value (Cloud's `keyvalue` kind, or any Redis): one ioredis
 * client whose keys start with CLOUD_KV_PREFIX, a channel helper, BullMQ
 * options under the same prefix, and the error that names the Size when a
 * write is refused because the Key Value is full.
 *
 * On Cloud the App's Redis user may touch only keys and channels that start
 * with CLOUD_KV_PREFIX. ioredis's `keyPrefix` prefixes keys only, never
 * channels, and BullMQ refuses a client with `keyPrefix`, so:
 * - keys: `kv.client` adds the prefix itself (`kv.client.set("a", "1")`
 *   writes `<prefix>a`);
 * - channels: name them with `kv.channel("news")`, on `kv.client.publish`
 *   and on a `kv.subscriber()` connection;
 * - BullMQ: `new Queue(name, kv.bullmq())` and `new Worker(name, fn,
 *   kv.bullmq())`, which put its keys under `<prefix>bull:`.
 *
 * A Key Value over its Size refuses writes until keys are deleted; GET and
 * DEL still work. Such a write rejects with KeyValueFullError, whose message
 * names the Size.
 */
import { hasFlag } from "@ioredis/commands";
import Redis, { type Command, type RedisOptions } from "ioredis";

import { type KeyValueSettings, keyValueSettings } from "./env.server";

const MIB = 1048576;

/** "16 MiB" for a whole number of MiB, else the bytes. */
export function sizeText(bytes: number): string {
	return bytes % MIB === 0 ? `${bytes / MIB} MiB` : `${bytes} bytes`;
}

export function fullMessage(maxBytes: number): string {
	return `Key Value is full: over its Size of ${sizeText(maxBytes)}; delete keys or choose a bigger Size`;
}

/** A write refused because the Key Value is over its Size. */
export class KeyValueFullError extends Error {
	readonly code = "KV_FULL";
	constructor(
		readonly maxBytes: number,
		readonly command: string,
		options: { cause: unknown },
	) {
		super(fullMessage(maxBytes), options);
		this.name = "KeyValueFullError";
	}
}

/**
 * Commands a full Key Value refuses besides those Redis flags `write`:
 * scripts and functions (they may write) and publishing.
 */
const REFUSED_WHEN_FULL = new Set([
	"eval",
	"evalsha",
	"eval_ro",
	"evalsha_ro",
	"fcall",
	"fcall_ro",
	"publish",
	"spublish",
]);

const COMMAND_REFUSED =
	/^NOPERM .* has no permissions to run the '([^']+)' command/;

/**
 * Whether `err` is Redis refusing a write command by name. The App's user
 * may run every write while under its Size, so such a refusal means it is
 * full; a key outside the prefix is refused with another message.
 */
export function isFullRefusal(err: unknown, commandName: string): boolean {
	if (!(err instanceof Error)) return false;
	const match = COMMAND_REFUSED.exec(err.message);
	if (!match) return false;
	const name = commandName.toLowerCase();
	return hasFlag(name, "write") || REFUSED_WHEN_FULL.has(name);
}

/** KeyValueFullError for a full refusal with a known Size, else `err` itself. */
export function toKeyValueError(
	err: unknown,
	commandName: string,
	maxBytes: number | null,
): unknown {
	if (maxBytes === null || !isFullRefusal(err, commandName)) return err;
	return new KeyValueFullError(maxBytes, commandName.toLowerCase(), {
		cause: err,
	});
}

/** ioredis options with its default reply mapping (RESP2-shaped replies). */
type ClientOptions = Omit<RedisOptions, "replyMapping">;

/** ioredis that turns a full refusal into KeyValueFullError. */
class KeyValueClient extends Redis {
	readonly #maxBytes: number | null;

	constructor(url: string, options: ClientOptions, maxBytes: number | null) {
		super(url, options);
		this.#maxBytes = maxBytes;
	}

	override sendCommand(
		command: Command,
		stream?: Parameters<Redis["sendCommand"]>[1],
	): unknown {
		const reject = command.reject;
		const maxBytes = this.#maxBytes;
		command.reject = (err: Error) => {
			const mapped = toKeyValueError(err, command.name, maxBytes);
			reject(mapped instanceof Error ? mapped : err);
		};
		return super.sendCommand(command, stream);
	}
}

export interface KeyValue {
	/** Keys get the prefix added; connects on the first command. */
	client: Redis;
	/** CLOUD_KV_PREFIX ("" off Cloud). */
	prefix: string;
	/** The Size in bytes; null off Cloud. */
	maxBytes: number | null;
	/** A channel name under the prefix, for publish, subscribe and psubscribe. */
	channel(name: string): string;
	/** A new connection for SUBSCRIBE (a subscribed connection runs nothing else). */
	subscriber(): Redis;
	/** BullMQ's prefix: `<prefix>bull`, so its keys are `<prefix>bull:<queue>:...`. */
	bullmqPrefix: string;
	/**
	 * Options for a BullMQ Queue or Worker: one shared connection without
	 * keyPrefix, the prefix, and skipVersionCheck (BullMQ reads INFO for its
	 * version check, which the App's user may not run).
	 */
	bullmq(): { connection: Redis; prefix: string; skipVersionCheck: true };
	/** Closes every connection this object opened. */
	close(): Promise<void>;
}

/**
 * The App's Key Value from REDIS_URL, CLOUD_KV_PREFIX and CLOUD_KV_MAX_BYTES.
 * Make it once per process. Throws when REDIS_URL is not set: connect a Key
 * Value to the App in the Project File (`connects: [cache]`).
 */
export function createRedis(
	settings: KeyValueSettings | null = keyValueSettings(),
): KeyValue {
	if (settings === null)
		throw new Error(
			"REDIS_URL is not set: connect a Key Value to this App in the Project File (connects)",
		);
	const { url, prefix, maxBytes } = settings;
	const opened: Redis[] = [];
	const open = (options: ClientOptions): Redis => {
		// The ready check runs INFO, which the App's user may not run.
		const conn = new KeyValueClient(
			url,
			{ lazyConnect: true, enableReadyCheck: false, ...options },
			maxBytes,
		);
		opened.push(conn);
		return conn;
	};
	const client = open(prefix === "" ? {} : { keyPrefix: prefix });
	let queueConnection: Redis | null = null;
	const bullmqPrefix = `${prefix}bull`;
	return {
		client,
		prefix,
		maxBytes,
		channel: (name) => `${prefix}${name}`,
		subscriber: () => open({}),
		bullmqPrefix,
		bullmq() {
			// Workers need maxRetriesPerRequest null (BullMQ's docs).
			queueConnection ??= open({ maxRetriesPerRequest: null });
			return {
				connection: queueConnection,
				prefix: bullmqPrefix,
				skipVersionCheck: true,
			};
		},
		async close() {
			await Promise.all(
				opened.map(async (conn) => {
					if (conn.status === "wait" || conn.status === "end") {
						conn.disconnect();
						return;
					}
					await conn.quit().catch(() => conn.disconnect());
				}),
			);
		},
	};
}
