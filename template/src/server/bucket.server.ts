/**
 * The App's Bucket: an S3 client for the store Cloud connects (Garage),
 * built from the env (bucketSettings in env.server.ts), and two streaming
 * helpers. `bucket()` is null when the App has no Bucket, so a route can
 * answer 503 instead of failing at boot.
 *
 * Browsers never talk to the store: it has no public address. Upload and
 * download through the App, as streams, never whole files in memory.
 */
import {
	GetObjectCommand,
	NoSuchKey,
	type PutObjectCommandInput,
	S3Client,
	S3ServiceException,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

import { type BucketSettings, bucketSettings } from "./env.server";

export interface Bucket {
	client: S3Client;
	/** The bucket's name, for `Bucket:` in each command. */
	name: string;
}

/**
 * An S3 client for Garage: path-style addresses (Garage serves no
 * per-bucket host names here), and checksums only where S3 requires them.
 * The SDK's default since 3.729 adds CRC checksums and aws-chunked uploads
 * that S3-compatible stores may refuse.
 */
export function createBucketClient(settings: BucketSettings): S3Client {
	return new S3Client({
		endpoint: settings.endpoint,
		region: settings.region,
		forcePathStyle: true,
		credentials: {
			accessKeyId: settings.accessKeyId,
			secretAccessKey: settings.secretAccessKey,
		},
		requestChecksumCalculation: "WHEN_REQUIRED",
		responseChecksumValidation: "WHEN_REQUIRED",
	});
}

const buckets = new Map<string, Bucket>();

/**
 * The App's Bucket (S3_*), or a named one (CLOUD_S3_*_<NAME>); null when
 * the App connects to none. One client per Bucket per process.
 */
export function bucket(name?: string): Bucket | null {
	const settings = bucketSettings(name);
	if (settings === null) return null;
	const cacheKey = `${settings.endpoint} ${settings.bucket} ${settings.accessKeyId}`;
	let found = buckets.get(cacheKey);
	if (!found) {
		found = { client: createBucketClient(settings), name: settings.bucket };
		buckets.set(cacheKey, found);
	}
	return found;
}

/**
 * Writes `body` to `key`, streamed: a body over 5 MiB goes up as a
 * multipart upload of 5 MiB parts, 2 at a time, so memory stays near
 * 10 MiB whatever the size. A write past the Bucket's Size fails with
 * the store's S3 error (see s3ErrorCode).
 */
export async function putStream(
	target: Bucket,
	key: string,
	body: NonNullable<PutObjectCommandInput["Body"]>,
	contentType?: string,
): Promise<void> {
	const upload = new Upload({
		client: target.client,
		params: {
			Bucket: target.name,
			Key: key,
			Body: body,
			...(contentType ? { ContentType: contentType } : {}),
		},
		queueSize: 2,
		partSize: 5 * 1024 * 1024,
	});
	await upload.done();
}

export interface StoredObject {
	body: ReadableStream<Uint8Array>;
	contentType: string | null;
	contentLength: number | null;
}

/** The object at `key` as a web stream, or null when there is none. */
export async function getStream(
	target: Bucket,
	key: string,
): Promise<StoredObject | null> {
	try {
		const answer = await target.client.send(
			new GetObjectCommand({ Bucket: target.name, Key: key }),
		);
		if (!answer.Body) return null;
		return {
			body: answer.Body.transformToWebStream() as ReadableStream<Uint8Array>,
			contentType: answer.ContentType ?? null,
			contentLength: answer.ContentLength ?? null,
		};
	} catch (err) {
		if (err instanceof NoSuchKey) return null;
		throw err;
	}
}

/** The S3 error code of a failed command (`AccessDenied`, ...), or null. */
export function s3ErrorCode(err: unknown): string | null {
	return err instanceof S3ServiceException ? err.name : null;
}
