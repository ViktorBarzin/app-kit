/**
 * Membership re-checks and request + approve against a real Postgres
 * (TEST_DATABASE_URL) and the mock Authentik API, through AppAuth.
 */
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { ApiError } from "@viktorbarzin/runtime";
import { drizzle } from "drizzle-orm/bun-sql";

import { type AuthUser, membershipFromGroups } from "./index.js";
import { saveMemberCheck } from "./membership.js";
import { adminUrl, type Harness, startHarness } from "./testdata/harness.js";

let h: Harness<Record<never, never>>;

beforeAll(async () => {
	if (!adminUrl) return;
	h = await startHarness();
}, 30_000);

afterAll(async () => {
	await h?.stop();
});

beforeEach(() => {
	if (!h) return;
	h.mock.apiCalls.length = 0;
	h.mock.apiFailure = null;
	h.override({});
});

const db = () => drizzle({ client: h.sql });

function adminUser(sub: string, username: string): AuthUser {
	return { sub, username, via: "session", member: true, admin: true };
}

describe("membershipFromGroups", () => {
	const groups = {
		users: "App Users",
		admins: "App Admins",
		agents: "App Agents",
	};

	test("users, admins and agents are members; only admins are admins", () => {
		expect(membershipFromGroups(["App Users"], groups)).toEqual({
			member: true,
			admin: false,
		});
		expect(membershipFromGroups(["App Admins"], groups)).toEqual({
			member: true,
			admin: true,
		});
		expect(membershipFromGroups(["App Agents"], groups)).toEqual({
			member: true,
			admin: false,
		});
		expect(membershipFromGroups(["Home Server Admins"], groups)).toEqual({
			member: false,
			admin: false,
		});
	});

	test("without an agents group, agents are not members", () => {
		expect(
			membershipFromGroups(["App Agents"], {
				users: "U",
				admins: "A",
				agents: null,
			}),
		).toEqual({
			member: false,
			admin: false,
		});
	});
});

describe.skipIf(!adminUrl)("membership re-check", () => {
	test("a fresh answer is used without asking the provider", async () => {
		await saveMemberCheck(
			db(),
			"sub-fresh",
			"fresh@example.com",
			{ member: true, admin: false },
			"id_token",
		);
		expect(
			await h.appAuth.currentMembership("sub-fresh", "fresh@example.com"),
		).toEqual({
			member: true,
			admin: false,
		});
		expect(h.mock.apiCalls).toHaveLength(0);
	});

	test("a stale answer is re-asked once for concurrent callers", async () => {
		const user = h.mock.addUser({
			username: "stale@example.com",
			groups: ["App Admins"],
		});
		await saveMemberCheck(
			db(),
			user.uid,
			user.username,
			{ member: false, admin: false },
			"api",
			new Date(Date.now() - 20 * 60_000),
		);
		const answers = await Promise.all(
			Array.from({ length: 5 }, () =>
				h.appAuth.currentMembership(user.uid, user.username),
			),
		);
		expect(answers.every((a) => a.member && a.admin)).toBe(true);
		expect(h.mock.apiCalls).toHaveLength(1);
	});

	test("a user whose uid does not match the sub is not a member", async () => {
		h.mock.addUser({ username: "imposter@example.com", groups: ["App Users"] });
		expect(
			await h.appAuth.currentMembership(
				"some-other-sub",
				"imposter@example.com",
				{ maxAgeMs: 0 },
			),
		).toEqual({ member: false, admin: false });
	});

	test("an inactive user is not a member", async () => {
		const user = h.mock.addUser({
			username: "off@example.com",
			groups: ["App Users"],
			isActive: false,
		});
		expect(
			(
				await h.appAuth.currentMembership(user.uid, user.username, {
					maxAgeMs: 0,
				})
			).member,
		).toBe(false);
	});

	test("an outage keeps the last answer; with none, not a member", async () => {
		const user = h.mock.addUser({ username: "outage@example.com", groups: [] });
		await saveMemberCheck(
			db(),
			user.uid,
			user.username,
			{ member: true, admin: false },
			"api",
			new Date(0),
		);
		h.mock.apiFailure = 500;
		expect(
			(await h.appAuth.currentMembership(user.uid, user.username)).member,
		).toBe(true);
		expect(
			(await h.appAuth.currentMembership("never-seen", "nobody@example.com"))
				.member,
		).toBe(false);
	});

	test("a 403 from the provider (token missing a permission) is not a removal", async () => {
		const user = h.mock.addUser({ username: "perm@example.com", groups: [] });
		await saveMemberCheck(
			db(),
			user.uid,
			user.username,
			{ member: true, admin: false },
			"api",
			new Date(0),
		);
		h.override({
			authentik: {
				apiUrl: h.mock.apiUrl,
				readerToken: "wrong-token",
				approverToken: null,
				usersGroupPk: null,
			},
		});
		expect(
			(await h.appAuth.currentMembership(user.uid, user.username)).member,
		).toBe(true);
	});

	test.each([
		["no reader token", { readerToken: null }],
		["no API URL", { apiUrl: null }],
	] as const)("with %s a stale answer is not kept (fails closed)", async (_name, change) => {
		const user = h.mock.addUser({
			username: `unconfigured-${crypto.randomUUID()}`,
			groups: ["App Users"],
		});
		await saveMemberCheck(
			db(),
			user.uid,
			user.username,
			{ member: true, admin: true },
			"api",
			new Date(0),
		);
		h.override({
			authentik: {
				apiUrl: h.mock.apiUrl,
				readerToken: h.mock.readerToken,
				approverToken: h.mock.approverToken,
				usersGroupPk: null,
				...change,
			},
		});
		expect(await h.appAuth.currentMembership(user.uid, user.username)).toEqual({
			member: false,
			admin: false,
		});
		h.override({});
		expect(
			(await h.appAuth.currentMembership(user.uid, user.username)).member,
		).toBe(true);
		expect(await h.registry.metrics()).toMatch(
			/^app_membership_checks_total\{outcome="misconfigured"\} [1-9]/m,
		);
	});
});

describe.skipIf(!adminUrl)("request + approve", () => {
	async function admin(name: string) {
		const user = h.mock.addUser({ username: name, groups: ["App Admins"] });
		await saveMemberCheck(
			db(),
			user.uid,
			user.username,
			{ member: true, admin: true },
			"id_token",
		);
		return adminUser(user.uid, user.username);
	}

	test("an admin approves: the approver token adds the user to the users group", async () => {
		const boss = await admin("boss@example.com");
		const asker = h.mock.addUser({ username: "asker@example.com", groups: [] });
		await h.sql`insert into access_requests (sub, username, email, name, status)
			values (${asker.uid}, ${asker.username}, ${asker.email}, 'Asker', 'pending')`;

		const pending = await h.appAuth.listPendingRequests(boss);
		expect(pending.map((p) => p.username)).toContain("asker@example.com");

		h.mock.apiCalls.length = 0;
		await h.appAuth.approveRequest(boss, asker.uid);
		expect(asker.groups).toEqual(["App Users"]);
		expect(h.mock.apiCalls.find((c) => c.path.endsWith("/add_user/"))).toEqual({
			method: "POST",
			path: `/core/groups/${h.mock.usersGroupPk}/add_user/`,
			token: h.mock.approverToken,
		});
		expect(
			await h.appAuth.currentMembership(asker.uid, asker.username),
		).toEqual({ member: true, admin: false });
		const after = await h.appAuth.listPendingRequests(boss);
		expect(after.map((p) => p.username)).not.toContain("asker@example.com");
		const [row] =
			await h.sql`select status, decided_by from access_requests where sub = ${asker.uid}`;
		expect(row).toEqual({ status: "approved", decided_by: "boss@example.com" });
	});

	test("a configured users group pk skips the group lookup", async () => {
		const boss = await admin("boss-pk@example.com");
		const asker = h.mock.addUser({
			username: "asker-pk@example.com",
			groups: [],
		});
		await h.sql`insert into access_requests (sub, username, status) values (${asker.uid}, ${asker.username}, 'pending')`;
		h.override({
			authentik: {
				apiUrl: h.mock.apiUrl,
				readerToken: h.mock.readerToken,
				approverToken: h.mock.approverToken,
				usersGroupPk: h.mock.usersGroupPk,
			},
		});
		h.mock.apiCalls.length = 0;
		await h.appAuth.approveRequest(boss, asker.uid);
		expect(h.mock.apiCalls.some((c) => c.path === "/core/groups/")).toBe(false);
	});

	test("a non-admin cannot list or approve", async () => {
		const member = h.mock.addUser({
			username: "member2@example.com",
			groups: ["App Users"],
		});
		await saveMemberCheck(
			db(),
			member.uid,
			member.username,
			{ member: true, admin: false },
			"id_token",
		);
		const user = { ...adminUser(member.uid, member.username), admin: false };
		await expect(h.appAuth.listPendingRequests(user)).rejects.toMatchObject({
			status: 403,
			code: "forbidden",
		});
		await expect(
			h.appAuth.approveRequest(user, "anything"),
		).rejects.toBeInstanceOf(ApiError);
	});

	test("an admin removed at the provider loses admin within adminRecheckMaxAgeMs", async () => {
		const boss = await admin("demoted@example.com");
		const remote = h.mock.users.get("demoted@example.com");
		if (remote) remote.groups = ["App Users"];
		await h.sql`update member_checks set checked_at = now() - interval '2 minutes' where sub = ${boss.sub}`;
		await expect(h.appAuth.requireAdmin(boss)).rejects.toMatchObject({
			status: 403,
		});
	});

	test("approving someone whose account is gone is a conflict, and nothing is added", async () => {
		const boss = await admin("boss2@example.com");
		await h.sql`insert into access_requests (sub, username, status) values ('ghost-sub', 'ghost@example.com', 'pending')`;
		await expect(
			h.appAuth.approveRequest(boss, "ghost-sub"),
		).rejects.toMatchObject({ status: 409 });
		expect(h.mock.apiCalls.some((c) => c.path.endsWith("/add_user/"))).toBe(
			false,
		);
		await expect(
			h.appAuth.approveRequest(boss, "nobody"),
		).rejects.toMatchObject({ status: 404 });
	});

	test("a provider outage during approval is a 502 and leaves the request pending", async () => {
		const boss = await admin("boss3@example.com");
		const asker = h.mock.addUser({
			username: "asker3@example.com",
			groups: [],
		});
		await h.sql`insert into access_requests (sub, username, status) values (${asker.uid}, ${asker.username}, 'pending')`;
		h.mock.apiFailure = 503;
		await expect(
			h.appAuth.approveRequest(boss, asker.uid),
		).rejects.toMatchObject({ status: 502 });
		h.mock.apiFailure = null;
		const pending = await h.appAuth.listPendingRequests(boss);
		expect(pending.map((p) => p.sub)).toContain(asker.uid);
	});

	test("the dev user is an admin without asking anyone", async () => {
		await h.appAuth.requireAdmin({
			sub: null,
			username: "dev",
			via: "dev",
			member: true,
			admin: true,
		});
		await expect(
			h.appAuth.requireAdmin({
				sub: null,
				username: "x",
				via: "session",
				member: true,
				admin: true,
			}),
		).rejects.toMatchObject({ status: 403 });
	});
});

describe.skipIf(!adminUrl)("accessStatus", () => {
	test("signed out, pending with a request, then member after a recheck", async () => {
		expect(await h.appAuth.accessStatus(new Request(`${h.origin}/`))).toEqual({
			signedIn: false,
			username: null,
			member: false,
			admin: false,
			requestedAt: null,
		});
		const user = h.mock.addUser({
			username: "waiting@example.com",
			groups: [],
		});
		const { jar } = await h.signIn("waiting@example.com");
		const request = () =>
			new Request(`${h.origin}/`, { headers: { cookie: jar.header() } });
		const pending = await h.appAuth.accessStatus(request());
		expect(pending).toMatchObject({
			signedIn: true,
			username: "waiting@example.com",
			member: false,
		});
		expect(pending.requestedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		user.groups = ["App Users"];
		expect((await h.appAuth.accessStatus(request())).member).toBe(false);
		const rechecked = await h.appAuth.accessStatus(request(), {
			recheck: true,
		});
		expect(rechecked).toMatchObject({ member: true, requestedAt: null });
	});
});
