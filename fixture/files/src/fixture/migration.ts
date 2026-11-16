/**
 * The fixture's part of the migrate step (the variant edits the template's
 * src/entrypoints/migrate.ts to call it): prints MIGRATION_LOG and exits
 * with MIGRATION_EXIT before the real migrations, as knobs.ts sets them.
 */

export interface MigrationKnobs {
	/** A line to print first; empty prints nothing. */
	log: string;
	/** Not 0: exit with it, and run no migration. */
	exit: number;
}

/** Runs the template's migrations unless the knobs say to fail; the exit code. */
export async function runFixtureMigration(
	migrate: () => Promise<number>,
	knobs: MigrationKnobs,
	print: (line: string) => void,
): Promise<number> {
	if (knobs.log !== "") print(knobs.log);
	if (knobs.exit !== 0) {
		print(
			`fixture migration failed on purpose: MIGRATION_EXIT is ${knobs.exit} in src/fixture/knobs.ts`,
		);
		return knobs.exit;
	}
	return migrate();
}
