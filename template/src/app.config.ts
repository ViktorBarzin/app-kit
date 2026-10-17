/**
 * This app's names. Client-safe constants only: no secrets, nothing read from
 * the environment. `bun run rename <slug> "<Display Name>"` rewrites them.
 */
export const app = {
	slug: "starter",
	displayName: "Starter",
	/** Authentik groups (the Terraform app module creates them). */
	usersGroup: "Starter Users",
	adminsGroup: "Starter Admins",
	agentsGroup: "Starter Agents",
	/** The Postgres NOTIFY channel for realtime events. */
	realtimeChannel: "starter_events",
	/** migrationLockKey("starter") from @viktorbarzin/pg. */
	migrationLockKey: -410644299707373464n,
} as const;
