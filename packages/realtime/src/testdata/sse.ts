/** Read an SSE body in tests. */
export async function readUntil(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	done: (text: string) => boolean,
	timeoutMs = 2_000,
): Promise<string> {
	const decoder = new TextDecoder();
	let text = "";
	const deadline = Date.now() + timeoutMs;
	while (!done(text)) {
		const left = deadline - Date.now();
		if (left <= 0) throw new Error(`timed out; got ${JSON.stringify(text)}`);
		const next = await Promise.race([
			reader.read(),
			Bun.sleep(left).then(() => ({ done: true as const, value: undefined })),
		]);
		if (next.done) break;
		text += decoder.decode(next.value);
	}
	return text;
}

export function bodyReader(
	res: Response,
): ReadableStreamDefaultReader<Uint8Array> {
	if (!res.body) throw new Error("no body");
	return res.body.getReader();
}
