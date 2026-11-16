/**
 * Worker entrypoint, bundled to .output/entrypoints/worker.js and run as
 * `bun entrypoints/worker.js` by a worker Service. For now it logs its
 * version and a heartbeat; Batch 2 of Cloud's parity work adds pg-boss jobs
 * queued by /enqueue.
 */
const version = process.env.SERVICE_VERSION ?? "dev";
console.log(JSON.stringify({ msg: "worker-started", version }));
setInterval(() => {
	console.log(JSON.stringify({ msg: "worker-heartbeat", version }));
}, 60_000);
for (const signal of ["SIGTERM", "SIGINT"] as const)
	process.on(signal, () => {
		console.log(JSON.stringify({ msg: "worker-stopped", version }));
		process.exit(0);
	});
