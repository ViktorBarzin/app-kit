/**
 * The few Authentik API calls an app makes (base `<apiUrl>/api/v3`):
 *
 * - find a user and their groups (reader token):
 *   `GET /core/users/?username=<u>&include_groups=true`
 * - find the users group's pk by name (reader token), when it is not configured:
 *   `GET /core/groups/?name=<n>`
 * - add a user to the users group (approver token):
 *   `POST /core/groups/<group_pk>/add_user/` with `{"pk": <user_pk>}`
 *
 * Users are keyed on `sub` and never authorized by name: a username lookup
 * only counts when the user's `uid` equals the `sub` the app holds (the
 * provider's sub_mode hashed_user_id makes `sub` the user's `uid`).
 */
import type { Logger } from "@viktorbarzin/log";

import { type AuthentikSettings, DEFAULTS } from "./config.js";

/** The provider did not give an answer this module can believe. */
export class AuthentikUnavailable extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AuthentikUnavailable";
	}
}

/**
 * The app cannot ask at all: no API URL or token configured. A configuration
 * error, not an outage, so callers that keep the last answer through an
 * outage must not keep it through this.
 */
export class AuthentikNotConfigured extends AuthentikUnavailable {
	constructor(message: string) {
		super(message);
		this.name = "AuthentikNotConfigured";
	}
}

export interface AuthentikUser {
	pk: number;
	uid: string;
	username: string;
	isActive: boolean;
	groups: string[];
}

export interface AuthentikClient {
	findUser(sub: string, username: string): Promise<AuthentikUser | null>;
	usersGroupPk(): Promise<string>;
	addToUsersGroup(userPk: number): Promise<void>;
}

export function createAuthentikClient(
	cfg: AuthentikSettings & { usersGroup: string; logger?: Logger },
): AuthentikClient {
	const apiUrl = cfg.apiUrl?.replace(/\/+$/, "") ?? null;
	const timeoutMs = cfg.timeoutMs ?? DEFAULTS.authentikTimeoutMs;

	async function call(
		token: string | null,
		path: string,
		init: RequestInit = {},
	): Promise<Response> {
		if (!apiUrl)
			throw new AuthentikNotConfigured("no Authentik API URL configured");
		if (!token)
			throw new AuthentikNotConfigured("no Authentik API token configured");
		const headers = new Headers(init.headers);
		headers.set("authorization", `Bearer ${token}`);
		headers.set("accept", "application/json");
		try {
			return await fetch(`${apiUrl}/api/v3${path}`, {
				...init,
				headers,
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (err) {
			throw new AuthentikUnavailable(`unreachable: ${String(err)}`);
		}
	}

	async function readResults(
		response: Response,
		what: string,
	): Promise<unknown[]> {
		// Any status but 200 is "cannot say": a token missing a permission
		// answers 403, and reading that as "not a member" would lock people out.
		if (response.status !== 200) {
			throw new AuthentikUnavailable(`${what} answered ${response.status}`);
		}
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			throw new AuthentikUnavailable(`${what} did not answer JSON`);
		}
		const results = (body as { results?: unknown })?.results;
		if (!Array.isArray(results)) {
			throw new AuthentikUnavailable(
				`${what} answered something other than a list`,
			);
		}
		return results;
	}

	async function usersGroupPk(): Promise<string> {
		if (cfg.usersGroupPk) return cfg.usersGroupPk;
		const query = new URLSearchParams({ name: cfg.usersGroup });
		const response = await call(cfg.readerToken, `/core/groups/?${query}`);
		for (const raw of await readResults(response, "group lookup")) {
			const group = raw as { name?: unknown; pk?: unknown };
			if (group.name === cfg.usersGroup && typeof group.pk === "string")
				return group.pk;
		}
		throw new AuthentikUnavailable(`group "${cfg.usersGroup}" was not found`);
	}

	return {
		async findUser(sub, username) {
			const query = new URLSearchParams({ username, include_groups: "true" });
			const response = await call(cfg.readerToken, `/core/users/?${query}`);
			for (const raw of await readResults(response, "user lookup")) {
				const found = raw as Record<string, unknown>;
				if (found.username !== username || found.uid !== sub) continue;
				if (typeof found.pk !== "number") continue;
				const groups = Array.isArray(found.groups_obj)
					? found.groups_obj
							.map((group) => (group as { name?: unknown })?.name)
							.filter((name): name is string => typeof name === "string")
					: [];
				return {
					pk: found.pk,
					uid: sub,
					username,
					isActive: found.is_active === true,
					groups,
				};
			}
			return null;
		},
		usersGroupPk,
		async addToUsersGroup(userPk) {
			const groupPk = await usersGroupPk();
			const response = await call(
				cfg.approverToken,
				`/core/groups/${encodeURIComponent(groupPk)}/add_user/`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ pk: userPk }),
				},
			);
			if (response.status !== 204 && response.status !== 200) {
				cfg.logger?.warning("adding a user to the users group failed", {
					status: response.status,
					group: cfg.usersGroup,
				});
				throw new AuthentikUnavailable(`add_user answered ${response.status}`);
			}
		},
	};
}
