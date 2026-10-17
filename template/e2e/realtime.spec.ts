import { expect, test } from "@playwright/test";

import { app } from "../src/app.config";
import { addUser, call, signedInPage } from "./fixtures";

test("an item added in one tab shows in another within 2 s, without a reload", async ({
	browser,
}) => {
	await addUser("twotabs@example.com", [app.usersGroup]);
	const a = await signedInPage(browser, "twotabs@example.com");
	const b = await signedInPage(browser, "twotabs@example.com");
	await expect(a.getByTestId("no-items")).toBeVisible();
	await expect(b.getByTestId("no-items")).toBeVisible();
	// Let B's EventSource open before the write.
	await b.waitForTimeout(500);
	let reloaded = false;
	b.on("framenavigated", () => {
		reloaded = true;
	});

	await a.getByLabel("New item").fill("from tab A");
	await a.getByRole("button", { name: "Add" }).click();
	await expect(b.getByTestId("items")).toContainText("from tab A", {
		timeout: 2_000,
	});
	expect(reloaded).toBe(false);
});

test("after the LISTEN connection is killed, the other tab resyncs", async ({
	browser,
}) => {
	await addUser("resync@example.com", [app.usersGroup]);
	const b = await signedInPage(browser, "resync@example.com");
	await expect(b.getByTestId("no-items")).toBeVisible();
	await b.waitForTimeout(500);

	// A write that sends no NOTIFY: only a resync can bring it to the page.
	await call("/silent-item", {
		username: "resync@example.com",
		title: "written while nobody listened",
	});
	await b.waitForTimeout(500);
	await expect(b.getByTestId("no-items")).toBeVisible();

	await call("/kill-listen");
	await expect(b.getByTestId("items")).toContainText(
		"written while nobody listened",
		{ timeout: 15_000 },
	);
});
