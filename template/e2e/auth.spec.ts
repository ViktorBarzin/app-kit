import { expect, test } from "@playwright/test";

import { app } from "../src/app.config";
import { addUser, collectErrors, signedInPage } from "./fixtures";

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
