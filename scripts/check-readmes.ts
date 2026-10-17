/**
 * Typecheck the ```ts examples in packages/*\/README.md against the packages
 * as built in this commit:
 *
 *   bun scripts/check-readmes.ts      (after `bun run build`)
 *
 * Each block becomes one file in template/.readme-check/ (the template
 * workspace resolves every @viktorbarzin package and their peers), which tsc
 * checks with the template's tsconfig. Names an example uses without
 * defining (the request, the pool) are declared in an HTML comment right
 * before the block, which Markdown does not render:
 *
 *   <!-- typecheck-preamble
 *   declare const request: Request;
 *   -->
 *   ```ts
 *   ...
 */
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const TEMPLATE = join(ROOT, "template");
const OUT = join(TEMPLATE, ".readme-check");

export interface Block {
	preamble: string;
	code: string;
	/** 1-based line of the block's first code line in the README. */
	line: number;
}

export function extractBlocks(markdown: string): Block[] {
	const lines = markdown.split("\n");
	const blocks: Block[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (lines[i]?.trim() !== "```ts") continue;
		let preamble = "";
		if (lines[i - 1]?.trim() === "-->") {
			let start = i - 2;
			while (start >= 0 && lines[start]?.trim() !== "<!-- typecheck-preamble")
				start--;
			if (start >= 0) preamble = lines.slice(start + 1, i - 1).join("\n");
		}
		let end = i + 1;
		while (end < lines.length && lines[end]?.trim() !== "```") end++;
		blocks.push({
			preamble,
			code: lines.slice(i + 1, end).join("\n"),
			line: i + 2,
		});
		i = end;
	}
	return blocks;
}

/** One module: the block's imports, the preamble, the rest of the block. */
export function snippetFile(block: Block): string {
	const imports: string[] = [];
	const body: string[] = [];
	let inImport = false;
	for (const line of block.code.split("\n")) {
		if (inImport || /^import\s/.test(line)) {
			imports.push(line);
			inImport = !/;\s*$/.test(line);
		} else body.push(line);
	}
	return `${[...imports, block.preamble, ...body].join("\n")}\nexport {};\n`;
}

async function main(): Promise<number> {
	await rm(OUT, { recursive: true, force: true });
	await mkdir(OUT, { recursive: true });
	const written: string[] = [];
	try {
		for (const pkg of (await readdir(join(ROOT, "packages"))).sort()) {
			const readme = await readFile(
				join(ROOT, "packages", pkg, "README.md"),
				"utf8",
			).catch(() => null);
			if (readme === null) continue;
			for (const block of extractBlocks(readme)) {
				const name = `${pkg}-README-line-${block.line}.tsx`;
				await writeFile(join(OUT, name), snippetFile(block));
				written.push(name);
			}
		}
		await writeFile(
			join(OUT, "tsconfig.json"),
			JSON.stringify({
				extends: "../tsconfig.json",
				compilerOptions: { noUnusedLocals: false, noUnusedParameters: false },
				include: ["./*.tsx"],
				exclude: [],
			}),
		);
		const tsc = Bun.spawnSync(
			[join(TEMPLATE, "node_modules/.bin/tsc"), "-p", OUT],
			{ cwd: TEMPLATE, stdout: "pipe", stderr: "pipe" },
		);
		process.stdout.write(tsc.stdout.toString());
		process.stderr.write(tsc.stderr.toString());
		if (tsc.exitCode !== 0) {
			console.error(
				"check-readmes: a README example does not typecheck (file names give the README and line)",
			);
			return 1;
		}
		console.log(`check-readmes: ${written.length} README examples typecheck`);
		return 0;
	} finally {
		await rm(OUT, { recursive: true, force: true });
	}
}

if (import.meta.main) process.exit(await main());
