/**
 * One-off job entrypoint, bundled to .output/entrypoints/seed.js and run as
 * `bun entrypoints/seed.js`: one log line, exit 0.
 */
console.log(
	JSON.stringify({
		msg: "seed-ran",
		version: process.env.SERVICE_VERSION ?? "dev",
	}),
);
