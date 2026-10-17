import { defineConfig } from "drizzle-kit";

// drizzle-kit is a dev tool: `db:generate` needs no database; `db:studio`
// needs DATABASE_URL with the password inline (local only). The running app
// and the migrate entrypoint read the password from a file instead.
export default defineConfig({
	dialect: "postgresql",
	schema: "./src/server/db/schema.server.ts",
	out: "./drizzle",
	schemaFilter: ["public"],
	dbCredentials: {
		url: process.env.DATABASE_URL ?? "",
	},
});
