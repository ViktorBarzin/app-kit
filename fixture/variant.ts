/**
 * The fixture variant of the template: `files/` is copied over the
 * exported template, then each edit replaces one exact text in one file.
 * An edit whose text is not in the template exactly once stops the export,
 * so a template change that moves an anchor is caught, not skipped.
 * scripts/export-template.ts applies it with `--variant fixture`.
 */
export interface TemplateEdit {
	path: string;
	find: string;
	replace: string;
}

export interface TemplateVariant {
	/** The Forgejo repo the variant is pushed to, `owner/name`. */
	repo: string;
	/** The directory copied over the template, relative to this file. */
	files: string;
	edits: TemplateEdit[];
}

export const fixtureVariant: TemplateVariant = {
	repo: "viktor/app-template-fixture",
	files: "files",
	edits: [
		{
			// Nitro's WebSocket support and the fixture's routes.
			path: "vite.config.ts",
			find: 'import { defineConfig } from "vite";\n',
			replace:
				'import { defineConfig } from "vite";\n\nimport { fixtureNitro } from "./src/fixture/nitro-config.ts";\n',
		},
		{
			path: "vite.config.ts",
			find: 'preset: "bun",\n',
			replace: 'preset: "bun",\n\t\t\t...fixtureNitro,\n',
		},
		{
			// The build env test: a plain env var reaches the bundle, a secret never does.
			path: "Dockerfile",
			find: "RUN bun run build\n",
			replace:
				"# Fixture: the build env test reads these two in the client bundle.\nARG VITE_GREETING\nARG VITE_KEY\nRUN bun run build\n",
		},
		{
			path: "src/routes/__root.tsx",
			find: 'import { Telemetry } from "#/components/telemetry";\n',
			replace:
				'import { Telemetry } from "#/components/telemetry";\nimport { buildEnv } from "#/fixture/build-env";\n',
		},
		{
			path: "src/routes/__root.tsx",
			find: "{ title: app.displayName },\n",
			replace:
				'{ title: app.displayName },\n\t\t\t{\n\t\t\t\tname: "fixture-build-env",\n\t\t\t\tcontent: [buildEnv.greeting, buildEnv.key].join("|"),\n\t\t\t},\n',
		},
		{
			// /unhealthy and the knob make the template's /healthz answer 500.
			path: "src/routes/healthz.ts",
			find: 'import { connectionBudget } from "#/server/env.server";\n',
			replace:
				'import { HEALTHZ_FAILS_AT_BOOT } from "#/fixture/knobs";\nimport { fixtureHealthy } from "#/fixture/routes";\nimport { connectionBudget } from "#/server/env.server";\n',
		},
		{
			path: "src/routes/healthz.ts",
			find: "\t\t\t\tconnectionBudget();\n",
			replace:
				'\t\t\t\tconnectionBudget();\n\t\t\t\tif (!fixtureHealthy(HEALTHZ_FAILS_AT_BOOT))\n\t\t\t\t\treturn Response.json({ status: "unhealthy" }, { status: 500 });\n',
		},
		{
			// worker.js, tick.js and seed.js next to migrate.js in the image.
			path: "package.json",
			find: 'src/entrypoints/migrate.ts"',
			replace:
				'src/entrypoints/migrate.ts src/entrypoints/worker.ts src/entrypoints/tick.ts src/entrypoints/seed.ts"',
		},
	],
};

export const VARIANTS: Record<string, TemplateVariant> = {
	fixture: fixtureVariant,
};
