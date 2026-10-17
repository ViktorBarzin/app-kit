import type { Browser, Page } from "@playwright/test";

const control = `http://127.0.0.1:${process.env.E2E_CONTROL_PORT}`;

export async function call(
	path: string,
	body: Record<string, unknown> = {},
): Promise<unknown> {
	const res = await fetch(`${control}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok)
		throw new Error(`${path} answered ${res.status}: ${await res.text()}`);
	return res.json();
}

export async function addUser(
	username: string,
	groups: string[],
): Promise<void> {
	await call("/user", { username, groups });
}

/** Errors a page logs; a server-only module in the client bundle shows up here. */
export function collectErrors(page: Page): string[] {
	const errors: string[] = [];
	page.on("pageerror", (err) => errors.push(err.message));
	page.on("console", (msg) => {
		if (msg.type() === "error") errors.push(msg.text());
	});
	return errors;
}

/** A fresh browser context signed in as `username` through the mock provider. */
export async function signedInPage(
	browser: Browser,
	username: string,
	path = "/",
): Promise<Page> {
	const context = await browser.newContext();
	const page = await context.newPage();
	await call("/login-as", { username });
	await page.goto(`/api/auth/start?return=${encodeURIComponent(path)}`);
	return page;
}
