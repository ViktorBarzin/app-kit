/**
 * The Bucket helper: an S3 client set up for Garage (path-style, the
 * contract's region, checksums only where S3 requires them), null for an
 * App without a Bucket, and a missing object read as null, not a throw.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	type GetObjectCommandOutput,
	NoSuchKey,
	type S3Client,
	S3ServiceException,
} from "@aws-sdk/client-s3";

import {
	bucket,
	createBucketClient,
	getStream,
	s3ErrorCode,
} from "./bucket.server";

const saved = { ...process.env };
afterEach(() => {
	for (const key of Object.keys(process.env))
		if (!(key in saved)) delete process.env[key];
	Object.assign(process.env, saved);
});

const settings = {
	endpoint: "http://s3.example:3900",
	region: "garage",
	bucket: "p-demo-files-0123456789",
	accessKeyId: "GK0123",
	secretAccessKey: "secret-key",
};

/** A client whose every command answers `answer` without the network. */
function answering(answer: () => Promise<GetObjectCommandOutput>): S3Client {
	const client = createBucketClient(settings);
	client.middlewareStack.add(
		() => async () => ({ output: await answer(), response: {} }),
		{ step: "initialize", name: "fakeAnswer" },
	);
	return client;
}

describe("createBucketClient", () => {
	test("path-style, the contract's region and endpoint, checksums only when required", async () => {
		const client = createBucketClient(settings);
		expect(client.config.forcePathStyle).toBe(true);
		expect(await client.config.region()).toBe("garage");
		expect(await client.config.requestChecksumCalculation()).toBe(
			"WHEN_REQUIRED",
		);
		expect(await client.config.responseChecksumValidation()).toBe(
			"WHEN_REQUIRED",
		);
		const endpoint = await client.config.endpoint?.();
		expect(endpoint?.hostname).toBe("s3.example");
		expect(endpoint?.port).toBe(3900);
		const credentials = await client.config.credentials();
		expect(credentials.accessKeyId).toBe("GK0123");
	});
});

describe("bucket", () => {
	test("null for an App without a Bucket", () => {
		delete process.env.S3_BUCKET;
		delete process.env.CLOUD_S3_BUCKET_ARCHIVE;
		expect(bucket()).toBeNull();
		expect(bucket("archive")).toBeNull();
	});

	test("the App's Bucket from the env, one client per Bucket", () => {
		Object.assign(process.env, {
			S3_ENDPOINT: settings.endpoint,
			S3_REGION: settings.region,
			S3_BUCKET: "p-demo-memo-0123456789",
			S3_ACCESS_KEY_ID: settings.accessKeyId,
			S3_SECRET_ACCESS_KEY: settings.secretAccessKey,
		});
		const first = bucket();
		expect(first?.name).toBe("p-demo-memo-0123456789");
		expect(bucket()).toBe(first);
	});
});

describe("getStream", () => {
	test("the object's body as a web stream, with its type and length", async () => {
		const client = answering(async () => ({
			Body: Object.assign(new Blob(["hello"]), {
				transformToWebStream: () =>
					new Response("hello").body as ReadableStream,
				transformToString: async () => "hello",
				transformToByteArray: async () => new TextEncoder().encode("hello"),
			}),
			ContentType: "text/plain",
			ContentLength: 5,
			$metadata: {},
		}));
		const object = await getStream({ client, name: "b" }, "k");
		expect(object?.contentType).toBe("text/plain");
		expect(object?.contentLength).toBe(5);
		expect(await new Response(object?.body).text()).toBe("hello");
	});

	test("null for a key that is not there", async () => {
		const client = answering(async () => {
			throw new NoSuchKey({ message: "no such key", $metadata: {} });
		});
		expect(await getStream({ client, name: "b" }, "missing")).toBeNull();
	});

	test("any other S3 error is thrown", async () => {
		const client = answering(async () => {
			throw new S3ServiceException({
				name: "AccessDenied",
				$fault: "client",
				message: "denied",
				$metadata: { httpStatusCode: 403 },
			});
		});
		await expect(getStream({ client, name: "b" }, "k")).rejects.toThrow(
			"denied",
		);
	});
});

describe("s3ErrorCode", () => {
	test("the S3 error code an SDK error carries", () => {
		const err = new S3ServiceException({
			name: "QuotaExceeded",
			$fault: "client",
			message: "over quota",
			$metadata: { httpStatusCode: 403 },
		});
		expect(s3ErrorCode(err)).toBe("QuotaExceeded");
	});

	test("null for an error that did not come from S3", () => {
		expect(s3ErrorCode(new Error("socket hang up"))).toBeNull();
		expect(s3ErrorCode("text")).toBeNull();
	});
});
