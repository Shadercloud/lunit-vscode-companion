import type { LuneRunReport } from './runReport';

/**
 * Line coverage from @rbxts/lunit's coverage transformer
 * (`@rbxts/lunit/transformer`, Lunit 4.3+). An instrumented module records
 * how often each TypeScript line ran in `_G.__lunitCoverage[file][line]`,
 * where `file` is the source path relative to the tsconfig folder. Each Lune
 * worker reports its own counts in its block summary (luauBlockTemplate.ts);
 * this module adds them up across workers. Kept free of any `vscode` import
 * so it can be unit-tested in plain Node.
 */

/** Execution count per line, per source file. */
export type CoverageCounts = Record<string, Record<number, number>>;

export interface FileLineCoverage {
	/** Source path as the transformer recorded it: relative to the tsconfig folder, `/`-separated. */
	file: string;
	/** Every line that starts a statement, in order, with how often it ran. */
	lines: { line: number; count: number }[];
	covered: number;
	total: number;
}

/** Adds `source` into `target`: counts are summed, and lines missing from either side are kept. */
export function mergeCoverage(target: CoverageCounts, source: CoverageCounts): CoverageCounts {
	for (const [file, lines] of Object.entries(source)) {
		const into = (target[file] ??= {});
		for (const [line, count] of Object.entries(lines)) {
			const key = Number(line);
			into[key] = (into[key] ?? 0) + count;
		}
	}
	return target;
}

/** The counts of every block that reported coverage, added up; undefined when none did. */
export function coverageFromReport(report: LuneRunReport | undefined): CoverageCounts | undefined {
	let total: CoverageCounts | undefined;
	for (const block of report?.blocks ?? []) {
		const counts = block.summary?.coverage;
		if (counts) {
			total = mergeCoverage(total ?? {}, counts);
		}
	}
	return total;
}

/** One entry per file, sorted by path, with its lines in order. */
export function coverageByFile(counts: CoverageCounts): FileLineCoverage[] {
	return Object.keys(counts)
		.sort()
		.map((file) => {
			const lines = Object.entries(counts[file])
				.map(([line, count]) => ({ line: Number(line), count }))
				.sort((a, b) => a.line - b.line);
			return { file, lines, covered: lines.filter((l) => l.count > 0).length, total: lines.length };
		});
}

export const NO_COVERAGE_MESSAGE =
	'[lunit] No coverage data. "Run with Lune (Coverage)" needs a build made with @rbxts/lunit/transformer ' +
	'(Lunit 4.3+): add a tsconfig.coverage.json, or change "lunit.coverage.compileCommand". ' +
	'See https://docs.kong.ly/lunit/guides/coverage.html';
