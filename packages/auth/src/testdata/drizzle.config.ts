import { defineConfig } from "drizzle-kit";

/** The package tests' migrations: `bunx drizzle-kit generate --config src/testdata/drizzle.config.ts`. */
export default defineConfig({
	dialect: "postgresql",
	schema: "./src/schema.ts",
	out: "./src/testdata/drizzle",
});
