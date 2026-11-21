/**
 * /upload's request body as one stream of the file's bytes: the raw body,
 * or the field `file` of a multipart form, parsed as it arrives by
 * @fastify/busboy, so a 100 MiB form never sits in memory whole.
 * (Request.formData() in Bun reads the whole body first.)
 */
import { once } from "node:events";
import type { Readable } from "node:stream";
import Busboy, { type BusboyInstance } from "@fastify/busboy";

export interface UploadSource {
	stream: ReadableStream<Uint8Array>;
	/** The type the client gave the file, or null. */
	contentType: string | null;
}

export class UploadRequestError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

const isMultipart = (contentType: string) =>
	/^multipart\/form-data\s*;/i.test(contentType);

/**
 * The file's bytes and type. A multipart body without a field `file` throws
 * UploadRequestError `no_file`; one that cannot be parsed, `bad_multipart`.
 * A form longer than `maxBytes` errors the stream once it passes it.
 */
export async function uploadSource(
	request: Request,
	maxBytes: number,
): Promise<UploadSource> {
	const contentType = request.headers.get("content-type") ?? "";
	if (!isMultipart(contentType))
		return {
			stream:
				request.body ??
				new ReadableStream<Uint8Array>({
					start: (controller) => controller.close(),
				}),
			contentType: contentType.trim() === "" ? null : contentType,
		};
	return multipartFile(request, contentType, maxBytes);
}

function multipartFile(
	request: Request,
	contentType: string,
	maxBytes: number,
): Promise<UploadSource> {
	return new Promise<UploadSource>((resolve, reject) => {
		let busboy: BusboyInstance;
		try {
			busboy = new Busboy({
				headers: { "content-type": contentType },
				limits: { files: 1, fields: 20, parts: 30, fileSize: maxBytes },
			});
		} catch (err) {
			reject(new UploadRequestError("bad_multipart", String(err)));
			return;
		}
		let file: Readable | null = null;
		busboy.on("file", (field, stream, _name, _encoding, mimeType) => {
			if (field !== "file" || file !== null) {
				stream.resume();
				return;
			}
			file = stream;
			stream.on("limit", () =>
				stream.destroy(
					new UploadRequestError(
						"body_too_large",
						`a file is at most ${maxBytes} bytes`,
					),
				),
			);
			resolve({
				stream: webStream(stream),
				contentType: mimeType || null,
			});
		});
		busboy.on("finish", () => {
			if (file === null)
				reject(
					new UploadRequestError("no_file", "the form has no field `file`"),
				);
		});
		busboy.on("error", (err: unknown) => {
			const failure = new UploadRequestError(
				"bad_multipart",
				err instanceof Error ? err.message : String(err),
			);
			if (file === null) reject(failure);
			else file.destroy(failure);
		});
		void pump(request.body, busboy);
	});
}

/** A Node stream as a web one, read only as fast as it is consumed. */
function webStream(file: Readable): ReadableStream<Uint8Array> {
	const chunks: AsyncIterator<unknown> = file[Symbol.asyncIterator]();
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			const { done, value } = await chunks.next();
			if (done) controller.close();
			else if (value instanceof Uint8Array) controller.enqueue(value);
			else
				controller.error(
					new Error("the multipart parser gave a chunk that is not bytes"),
				);
		},
		cancel(reason) {
			file.destroy(reason instanceof Error ? reason : undefined);
		},
	});
}

/** Feeds the body to busboy, waiting whenever it asks to (backpressure). */
async function pump(
	body: ReadableStream<Uint8Array> | null,
	busboy: BusboyInstance,
): Promise<void> {
	try {
		if (body)
			for await (const chunk of body)
				if (!busboy.write(chunk)) await once(busboy, "drain");
		busboy.end();
	} catch (err) {
		busboy.destroy(err instanceof Error ? err : new Error(String(err)));
	}
}
