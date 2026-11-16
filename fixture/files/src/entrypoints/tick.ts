/**
 * Cron entrypoint, bundled to .output/entrypoints/tick.js and run as
 * `bun entrypoints/tick.js [seconds]`: sleeps the optional whole number of
 * seconds (0 by default), then one log line, exit 0. A long sleep keeps a
 * run going past its next start, for the cron overlap test.
 */
const arg = process.argv[2];
if (arg !== undefined && !/^[0-9]+$/.test(arg)) {
	console.error(
		`tick: the argument must be a whole number of seconds (got "${arg}")`,
	);
	process.exit(2);
}
const slept = arg === undefined ? 0 : Number(arg);
setTimeout(() => {
	console.log(
		JSON.stringify({
			msg: "tick",
			at: new Date().toISOString(),
			version: process.env.SERVICE_VERSION ?? "dev",
			slept,
		}),
	);
}, slept * 1000);
