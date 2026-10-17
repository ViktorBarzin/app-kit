/**
 * Membership: may this subject use the app, and administer it?
 *
 * Each request re-checks group membership with the provider once the stored
 * answer is older than 15 minutes, so removing someone takes effect within
 * that window. Web sign-in requests no `offline_access`, so the provider
 * issues no refresh token; this re-check is the app's "refresh".
 *
 * The first answer comes from the verified id_token's `groups` claim at
 * sign-in (or a bearer token's), so a fresh sign-in needs no API call.
 *
 * Failure direction: when the provider cannot answer (network error, any
 * status but 200), the last answer stands. Only an answer the provider gave
 * can remove access; with no earlier answer the subject is not a member. A
 * missing API URL or reader token is different: the app could never
 * re-check, so that case fails closed and logs an ERROR on every re-check.
 */
import type { Logger } from "@viktorbarzin/log";
import { eq } from "drizzle-orm";

import {
	type AuthentikClient,
	AuthentikNotConfigured,
	AuthentikUnavailable,
} from "./authentik.js";
import type { AuthDb, GroupNames } from "./config.js";
import type { AuthMetrics } from "./metrics.js";
import {
	type AccessRequest,
	accessRequests,
	type MemberCheck,
	memberChecks,
} from "./schema.js";

export interface Membership {
	member: boolean;
	admin: boolean;
}

/** Members are in the users, admins or agents group; admins are in the admins group. */
export function membershipFromGroups(
	groups: readonly string[],
	cfg: GroupNames,
): Membership {
	const set = new Set(groups);
	const admin = set.has(cfg.admins);
	const agent = cfg.agents ? set.has(cfg.agents) : false;
	return { member: admin || agent || set.has(cfg.users), admin };
}

export async function readMemberCheck(
	db: AuthDb,
	sub: string,
): Promise<MemberCheck | null> {
	const rows = await db
		.select()
		.from(memberChecks)
		.where(eq(memberChecks.sub, sub))
		.limit(1);
	return rows[0] ?? null;
}

export async function saveMemberCheck(
	db: AuthDb,
	sub: string,
	username: string,
	membership: Membership,
	source: "id_token" | "token" | "api",
	checkedAt: Date = new Date(),
): Promise<void> {
	await db
		.insert(memberChecks)
		.values({ sub, username, ...membership, source, checkedAt })
		.onConflictDoUpdate({
			target: memberChecks.sub,
			set: { username, ...membership, source, checkedAt },
		});
}

/**
 * Record an answer that came with a verified token (`groups` claim). A token
 * without the claim says nothing about membership and changes nothing.
 */
export async function recordClaimedGroups(
	db: AuthDb,
	sub: string,
	username: string,
	groups: unknown,
	source: "id_token" | "token",
	cfg: GroupNames,
): Promise<void> {
	if (!Array.isArray(groups)) return;
	const names = groups.filter((g): g is string => typeof g === "string");
	await saveMemberCheck(
		db,
		sub,
		username,
		membershipFromGroups(names, cfg),
		source,
	);
}

export interface MembershipOptions {
	/** Re-ask when the stored answer is older than this. 0 forces a fresh answer. */
	maxAgeMs?: number;
	now?: () => number;
}

export interface MembershipChecker {
	current(
		db: AuthDb,
		sub: string,
		username: string,
		opts?: MembershipOptions,
	): Promise<Membership>;
}

export function createMembershipChecker(deps: {
	authentik: () => AuthentikClient;
	groups: () => GroupNames;
	defaultMaxAgeMs: () => number;
	metrics: () => AuthMetrics;
	log: Logger;
}): MembershipChecker {
	const inFlight = new Map<string, Promise<Membership>>();

	async function recheck(
		db: AuthDb,
		sub: string,
		username: string,
		last: MemberCheck | null,
	): Promise<Membership> {
		try {
			const user = await deps.authentik().findUser(sub, username);
			const answer =
				user?.isActive === true
					? membershipFromGroups(user.groups, deps.groups())
					: { member: false, admin: false };
			deps.metrics().membershipChecks.inc({
				outcome: answer.member ? "member" : "removed",
			});
			if (last?.member && !answer.member)
				deps.log.info("membership: no longer a member", {
					sub,
					user: username,
				});
			await saveMemberCheck(db, sub, username, answer, "api");
			return answer;
		} catch (err) {
			if (err instanceof AuthentikNotConfigured) {
				deps.metrics().membershipChecks.inc({ outcome: "misconfigured" });
				deps.log.error("membership: cannot re-check, access refused", {
					sub,
					user: username,
					error: err.message,
				});
				return { member: false, admin: false };
			}
			if (!(err instanceof AuthentikUnavailable)) throw err;
			deps.metrics().membershipChecks.inc({ outcome: "unreachable" });
			deps.log.warning("membership: cannot check, the last answer stands", {
				sub,
				user: username,
				error: err.message,
			});
			return last
				? { member: last.member, admin: last.admin }
				: { member: false, admin: false };
		}
	}

	return {
		async current(db, sub, username, opts = {}) {
			const maxAge = opts.maxAgeMs ?? deps.defaultMaxAgeMs();
			const now = opts.now ?? Date.now;
			const last = await readMemberCheck(db, sub);
			if (last && maxAge > 0 && now() - last.checkedAt.getTime() < maxAge) {
				return { member: last.member, admin: last.admin };
			}
			const pending = inFlight.get(sub);
			if (pending) return pending;
			const started = recheck(db, sub, username, last).finally(() =>
				inFlight.delete(sub),
			);
			inFlight.set(sub, started);
			return started;
		},
	};
}

export interface RequestDetails {
	sub: string;
	username: string;
	email: string | null;
	name: string | null;
}

/** File (or refresh) a pending request. An approved request is left alone. */
export async function fileAccessRequest(
	db: AuthDb,
	details: RequestDetails,
): Promise<void> {
	await db
		.insert(accessRequests)
		.values({ ...details, status: "pending" })
		.onConflictDoUpdate({
			target: accessRequests.sub,
			set: {
				username: details.username,
				email: details.email,
				name: details.name,
			},
		});
}

export async function getAccessRequest(
	db: AuthDb,
	sub: string,
): Promise<AccessRequest | null> {
	const rows = await db
		.select()
		.from(accessRequests)
		.where(eq(accessRequests.sub, sub))
		.limit(1);
	return rows[0] ?? null;
}
