/**
 * The Bun this app needs (package.json packageManager, the @viktorbarzin
 * packages' engines). No imports, so scripts can use it before `bun install`.
 */
export const MIN_BUN_VERSION = "1.4.3";

function parts(version: string): number[] {
	return (version.split(/[-+]/)[0] ?? "")
		.split(".")
		.map((part) => Number.parseInt(part, 10) || 0);
}

export function bunVersionAtLeast(version: string, min: string): boolean {
	const have = parts(version);
	const need = parts(min);
	for (let i = 0; i < Math.max(have.length, need.length); i++) {
		const a = have[i] ?? 0;
		const b = need[i] ?? 0;
		if (a !== b) return a > b;
	}
	return true;
}

/** Throws when `version` is older than MIN_BUN_VERSION. */
export function assertBunVersion(version: string): void {
	if (!bunVersionAtLeast(version, MIN_BUN_VERSION))
		throw new Error(
			`Bun ${MIN_BUN_VERSION} or newer is required (this is Bun ${version}). On the devvm, ~/.bun/bin/bun is older and comes first on PATH; run /usr/local/bin/bun.`,
		);
}
