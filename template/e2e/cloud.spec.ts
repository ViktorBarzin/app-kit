/**
 * Cloud mode in a real browser, through the fake edge in e2e/cloud-stack.ts:
 * sign-in through the edge's links, the owner-only admin page, no
 * access-request pages, and on a nano database (realtime off) a write still
 * shows in this tab and reaches another by refetching.
 */
import { type Browser, expect, type Page, test } from "@playwright/test";

import { app } from "../src/app.config";
import { collectErrors } from "./fixtures";

const control = `http://127.0.0.1:${process.env.E2E_CLOUD_CONTROL_PORT}`;

async function call(path: string, body: Record<string, unknown> = {}) {
	const res = await fetch(`${control}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`${path} answered ${res.status}`);
	return res.json();
}

/**
 * A fresh browser context that the edge signs in as `email` on its first
 * visit. `streams` collects any request the page makes to /api/events.
 */
async function visitAs(
	browser: Browser,
	email: string,
	path = "/",
	streams?: string[],
): Promise<Page> {
	const page = await (await browser.newContext()).newPage();
	if (streams)
		page.on("request", (request) => {
			if (new URL(request.url()).pathname === "/api/events")
				streams.push(request.url());
		});
	await call("/login-as", { email });
	await page.goto(path);
	return page;
}

test("a signed-out visitor goes through the edge's sign-in and comes back", async ({
	browser,
}) => {
	const page = await (await browser.newContext()).newPage();
	const errors = collectErrors(page);
	const signIns: string[] = [];
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (url.pathname === "/oauth2/start")
			signIns.push(`${url.pathname}${url.search}`);
	});
	await call("/login-as", { email: "visitor@example.com" });
	await page.goto("/");
	await expect(page.getByTestId("username")).toHaveText("visitor");
	expect(signIns).toEqual(["/oauth2/start?rd=%2F"]);
	expect(errors).toEqual([]);
});

test("sign-out goes through the edge and signs the visitor out", async ({
	browser,
}) => {
	const page = await visitAs(browser, "leaver@example.com");
	await expect(page.getByTestId("username")).toHaveText("leaver");
	await call("/login-as", { email: null });
	await page.getByRole("link", { name: "Sign out" }).click();
	// Back on the home page, signed out: the app sends the browser to sign-in.
	await expect(
		page.getByRole("heading", { name: "Sign-in page" }),
	).toBeVisible();
	expect(new URL(page.url()).pathname).toBe("/oauth2/start");
});

test("the owner has the admin page; anyone else is refused", async ({
	browser,
}) => {
	const owner = await visitAs(browser, "owner@example.com");
	await expect(owner.getByTestId("username")).toHaveText("owner");
	await owner.getByRole("link", { name: "Admin" }).click();
	await expect(owner.getByTestId("admin-home")).toBeVisible();
	await expect(owner.getByTestId("cloud-access")).toBeVisible();
	await expect(owner.getByText("Access requests")).toHaveCount(0);

	const guest = await visitAs(browser, "guest@example.com");
	await expect(guest.getByTestId("username")).toHaveText("guest");
	await expect(guest.getByRole("link", { name: "Admin" })).toHaveCount(0);
	await guest.goto("/admin");
	await expect(guest.getByRole("alert")).toContainText("admins only");
	await expect(guest.getByTestId("admin-home")).toHaveCount(0);
});

test("the pending and access-request pages are not used on Cloud", async ({
	browser,
}) => {
	const owner = await visitAs(browser, "owner@example.com", "/pending");
	await expect(owner.getByTestId("username")).toHaveText("owner");
	expect(new URL(owner.url()).pathname).toBe("/");
	await owner.goto("/admin/requests");
	await expect(owner.getByTestId("admin-home")).toBeVisible();
	expect(new URL(owner.url()).pathname).toBe("/admin");
});

test("with realtime off, a write shows in this tab and reaches another by refetching", async ({
	browser,
}) => {
	const streams: string[] = [];
	const a = await visitAs(browser, "writer@example.com", "/", streams);
	const b = await visitAs(browser, "writer@example.com", "/", streams);
	await expect(a.getByTestId("no-items")).toBeVisible();
	await expect(b.getByTestId("no-items")).toBeVisible();

	await a.getByLabel("New item").fill("written on a nano database");
	await a.getByRole("button", { name: "Add" }).click();
	await expect(a.getByTestId("items")).toContainText(
		"written on a nano database",
	);
	await expect(b.getByTestId("items")).toContainText(
		"written on a nano database",
		{ timeout: app.pollMs + 5_000 },
	);
	expect(streams).toEqual([]);
	expect(await call("/connections")).toEqual({ listen: 0 });
});
