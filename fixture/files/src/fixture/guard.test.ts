import { describe, expect, test } from "bun:test";

import {
	fetchAllowed,
	hashedName,
	ownOrigins,
	SLOW_MAX_S,
	slowSeconds,
	TCP_TARGETS,
	tcpAllowed,
} from "./guard";

describe("tcpAllowed: never a port scanner", () => {
	test("the SMTP host on the SMTP ports and 443", () => {
		for (const port of [25, 465, 587, 2525, 443])
			expect(tcpAllowed("smtp.gmail.com", String(port))).toEqual({
				ok: true,
				host: "smtp.gmail.com",
				port,
			});
	});

	test("any other host is refused", () => {
		for (const host of [
			"127.0.0.1",
			"10.0.0.1",
			"kubernetes.default",
			"example.com",
			"",
		])
			expect(tcpAllowed(host, "443").ok).toBe(false);
	});

	test("any other port is refused", () => {
		for (const port of [
			"22",
			"80",
			"5432",
			"6379",
			"0",
			"-1",
			"abc",
			"443.5",
			"",
		])
			expect(tcpAllowed("smtp.gmail.com", port).ok).toBe(false);
	});

	test("the control host on 443 only", () => {
		expect(tcpAllowed("www.google.com", "443").ok).toBe(true);
		for (const port of ["25", "80", "587"])
			expect(tcpAllowed("www.google.com", port).ok).toBe(false);
	});

	test("the host list is lower case and matched case-insensitively", () => {
		expect(tcpAllowed("SMTP.Gmail.com", "587").ok).toBe(true);
		for (const host of TCP_TARGETS.keys())
			expect(host).toBe(host.toLowerCase());
		expect(
			[...(TCP_TARGETS.get("smtp.gmail.com") ?? [])].sort((a, b) => a - b),
		).toEqual([25, 443, 465, 587, 2525]);
	});
});

describe("ownOrigins", () => {
	test("CLOUD_PUBLIC_URL, every CLOUD_URL_* and FIXTURE_FETCH_ALLOW", () => {
		expect(
			[
				...ownOrigins({
					CLOUD_PUBLIC_URL: "https://app.example/",
					CLOUD_URL_API: "http://api.p-x.svc.cluster.local:3000",
					CLOUD_URL_BAD: "not a url",
					FIXTURE_FETCH_ALLOW: "http://other.p-y.svc:3000, https://b.example",
					PATH: "/usr/bin",
				}),
			].sort(),
		).toEqual([
			"http://api.p-x.svc.cluster.local:3000",
			"http://other.p-y.svc:3000",
			"https://app.example",
			"https://b.example",
		]);
	});
});

describe("fetchAllowed: never an open proxy", () => {
	const own = new Set(["http://api.p-x.svc.cluster.local:3000"]);

	test("an origin of the App's own", () => {
		expect(
			fetchAllowed("http://api.p-x.svc.cluster.local:3000/info", own).ok,
		).toBe(true);
	});

	test("a public host is refused unless the owner lists its origin", () => {
		const url = "https://p17a-abc123.viktorbarzin.me/info";
		expect(fetchAllowed(url, own).ok).toBe(false);
		expect(
			fetchAllowed(url, new Set(["https://p17a-abc123.viktorbarzin.me"])).ok,
		).toBe(true);
	});

	test("refuses everything else", () => {
		for (const url of [
			"http://p17a-abc123.viktorbarzin.me/info",
			"https://viktorbarzin.me.evil.example/",
			"https://evilviktorbarzin.me/",
			"https://example.com/",
			"http://api.p-x.svc.cluster.local:3001/info",
			"http://169.254.169.254/latest",
			"file:///etc/passwd",
			"https://user:pw@p1.viktorbarzin.me/",
			"not a url",
			"",
		])
			expect([url, fetchAllowed(url, own).ok]).toEqual([url, false]);
	});
});

describe("hashedName: hashes only what the suite sets and the cells read", () => {
	test("the suite's own names and the cells' built-in variables", () => {
		for (const name of [
			"TOKEN",
			"SESSION_SECRET",
			"FOO",
			"VITE_GREETING",
			"VITE_KEY",
			"P27_IMPORT_1",
			"P76_SECRET",
			"FIXTURE_ANYTHING",
			"SERVICE_VERSION",
			"CLOUD_INSTANCE_ID",
			"CLOUD_PUBLIC_URL",
		])
			expect([name, hashedName(name)]).toEqual([name, true]);
	});

	test("never a platform credential or system variable", () => {
		for (const name of [
			"DATABASE_URL",
			"DATABASE_PASSWORD_FILE",
			"CLOUD_EDGE_SECRET",
			"REDIS_URL",
			"S3_SECRET_ACCESS_KEY",
			"CLOUD_URL_API",
			"PATH",
			"HOSTNAME",
			"KUBERNETES_SERVICE_HOST",
			"P_NOT_A_SPEC",
		])
			expect([name, hashedName(name)]).toEqual([name, false]);
	});
});

describe("slowSeconds", () => {
	test("a whole number of seconds, capped", () => {
		expect(slowSeconds("45")).toBe(45);
		expect(slowSeconds("0")).toBe(0);
		expect(slowSeconds("9999")).toBe(SLOW_MAX_S);
		expect(SLOW_MAX_S).toBe(600);
	});

	test("anything else is null", () => {
		for (const value of [null, "", "-1", "abc", "1.5"])
			expect(slowSeconds(value)).toBeNull();
	});
});
