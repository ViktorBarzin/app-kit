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
	/**
	 * Telemetry (app-kit ADR-0002, infra ADR-0041): pageviews, replay and
	 * product events go to Rybbit, errors to GlitchTip. On by default for new
	 * apps; set `enabled: false` here, or TELEMETRY=off in the environment,
	 * to opt out.
	 */
	telemetry: {
		enabled: true,
		/** The Rybbit site the first-party apps share. */
		siteId: "1",
		/** The browser sends only from this domain and its subdomains. */
		productionHosts: ["viktorbarzin.me"],
	},
	/** migrationLockKey("starter") from @viktorbarzin/pg. */
	migrationLockKey: -410644299707373464n,
} as const;
