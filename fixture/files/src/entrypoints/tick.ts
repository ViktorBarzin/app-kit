/**
 * Cron entrypoint, bundled to .output/entrypoints/tick.js and run as
 * `bun entrypoints/tick.js`: one log line, exit 0.
 */
console.log(
	JSON.stringify({
		msg: "tick",
		at: new Date().toISOString(),
		version: process.env.SERVICE_VERSION ?? "dev",
	}),
);
