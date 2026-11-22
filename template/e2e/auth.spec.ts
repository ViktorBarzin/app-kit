import { expect, test } from "@playwright/test";

import { app } from "../src/app.config";
import { addUser, call, collectErrors, signedInPage } from "./fixtures";

test("a signed-out visitor sees the home page with a sign-in link", async ({
	page,
}) => {
	const errors = collectErrors(page);
	await addUser("newcomer@example.com", [app.usersGroup]);
	await call("/login-as", { username: "newcomer@example.com" });
	const home = await page.goto("/");
	expect(home?.status()).toBe(200);
	await expect(
		page.getByRole("heading", { name: app.displayName }),
	).toBeVisible();
	const signIn = page.getByRole("link", { name: "Sign in" });
	await expect(signIn).toHaveAttribute("href", "/api/auth/start?return=%2F");
	await signIn.click();
	await expect(page.getByTestId("username")).toHaveText("newcomer@example.com");
	expect(errors).toEqual([]);
});

test("a member signs in through the provider and sees the list", async ({
	browser,
}) => {
	await addUser("member@example.com", [app.usersGroup]);
	const page = await signedInPage(browser, "member@example.com");
	const errors = collectErrors(page);
	await expect(page.getByTestId("username")).toHaveText("member@example.com");
	await expect(page.getByTestId("no-items")).toBeVisible();
	await page.getByLabel("New item").fill("hello");
	await page.getByRole("button", { name: "Add" }).click();
	await expect(page.getByTestId("items")).toContainText("hello");
	expect(errors).toEqual([]);
});

test("the header keeps the title and a long email apart on a phone", async ({
	browser,
}) => {
	const email = "a-long-family-member-name@example.com";
	await addUser(email, [app.usersGroup]);
	const page = await signedInPage(browser, email);
	await page.setViewportSize({ width: 390, height: 800 });
	const user = page.getByTestId("username");
	await expect(user).toHaveText(email);
	const title = await page
		.getByRole("heading", { name: app.displayName })
		.boundingBox();
	const name = await user.boundingBox();
	if (!title || !name) throw new Error("header not laid out");
	// Side by side with a gap, or the email on a line of its own below.
	const apart =
		name.x >= title.x + title.width + 8 || name.y >= title.y + title.height;
	expect(apart).toBe(true);
	expect(name.x + name.width).toBeLessThanOrEqual(390);
});

test("a non-member waits on /pending until an admin approves", async ({
	browser,
}) => {
	await addUser("asker@example.com", []);
	const asker = await signedInPage(browser, "asker@example.com");
	await expect(asker).toHaveURL(/\/pending$/);
	await expect(asker.getByTestId("access-pending")).toContainText(
		"asker@example.com",
	);

	await addUser("boss@example.com", [app.adminsGroup]);
	const boss = await signedInPage(
		browser,
		"boss@example.com",
		"/admin/requests",
	);
	const request = boss
		.getByTestId("access-request")
		.filter({ hasText: "asker@example.com" });
	await expect(request).toBeVisible();
	await request.getByRole("button", { name: "Approve" }).click();
	await expect(
		boss.getByTestId("access-request").filter({ hasText: "asker@example.com" }),
	).toHaveCount(0);

	await asker.getByRole("button", { name: "Check again" }).click();
	await expect(asker.getByTestId("access-granted")).toBeVisible();
	await asker.getByRole("link", { name: `Open ${app.displayName}` }).click();
	await expect(asker.getByTestId("username")).toHaveText("asker@example.com");
});

test("the approval page refuses a member who is not an admin", async ({
	browser,
}) => {
	await addUser("plain@example.com", [app.usersGroup]);
	const page = await signedInPage(
		browser,
		"plain@example.com",
		"/admin/requests",
	);
	await expect(page.getByRole("alert")).toContainText("admins only");
});
