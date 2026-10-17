/** Identity metrics, registered once per registry and prefix. */
import { getRegistry } from "@viktorbarzin/metrics";
import client, { type Counter, type Registry } from "prom-client";

export interface AuthMetrics {
	/** Re-checks: member, removed, unreachable (last answer stood), misconfigured (refused). */
	membershipChecks: Counter<"outcome">;
	/** Bearer-token verifications: ok, or why one was refused. */
	tokenVerifications: Counter<"outcome">;
	csrfRejections: Counter<string>;
	/** Sign-ins: member, pending, or guest (sent back with prompt=login). */
	signIns: Counter<"outcome">;
}

function counter<L extends string>(
	registry: Registry,
	name: string,
	help: string,
	labelNames: readonly L[],
): Counter<L> {
	const existing = registry.getSingleMetric(name);
	if (existing) return existing as Counter<L>;
	return new client.Counter({ name, help, labelNames, registers: [registry] });
}

export function authMetrics(
	opts: { registry?: Registry; prefix?: string } = {},
): AuthMetrics {
	const registry = opts.registry ?? getRegistry();
	const p = opts.prefix ?? "auth";
	return {
		membershipChecks: counter(
			registry,
			`${p}_membership_checks_total`,
			"Membership re-checks against the identity provider by outcome.",
			["outcome"],
		),
		tokenVerifications: counter(
			registry,
			`${p}_api_token_verifications_total`,
			"Bearer-token verifications by outcome.",
			["outcome"],
		),
		csrfRejections: counter(
			registry,
			`${p}_csrf_rejections_total`,
			"Requests refused by the CSRF origin check.",
			[],
		),
		signIns: counter(
			registry,
			`${p}_sign_ins_total`,
			"OIDC sign-ins completed by outcome.",
			["outcome"],
		),
	};
}
