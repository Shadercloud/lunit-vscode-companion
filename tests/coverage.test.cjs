// Unit coverage for line coverage (src/coverage.ts): counts from several Lune
// workers are added up per line, and the per-file view is sorted and counted.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { coverageByFile, coverageFromReport, mergeCoverage } = require('../out/coverage');

test('merging sums counts per line and keeps lines from both sides', () => {
	const target = { 'src/a.ts': { 1: 1, 2: 0 } };
	mergeCoverage(target, { 'src/a.ts': { 2: 3, 5: 0 }, 'src/b.ts': { 4: 1 } });
	assert.deepEqual(target, { 'src/a.ts': { 1: 1, 2: 3, 5: 0 }, 'src/b.ts': { 4: 1 } });
});

test('a report adds up the coverage of every block that has some, and is undefined without any', () => {
	const block = (coverage) => ({ summary: coverage ? { results: 1, failed: 0, loadFailures: [], elapsedMs: 1, coverage } : undefined });
	assert.equal(coverageFromReport(undefined), undefined);
	assert.equal(coverageFromReport({ blocks: [block(), block()] }), undefined);
	assert.deepEqual(
		coverageFromReport({ blocks: [block({ 'src/a.ts': { 1: 1, 2: 0 } }), block(), block({ 'src/a.ts': { 2: 1 } })] }),
		{ 'src/a.ts': { 1: 1, 2: 1 } },
	);
});

test('files are sorted by path, lines by number, and covered lines are counted', () => {
	assert.deepEqual(coverageByFile({ 'src/b.ts': { 10: 0, 2: 4 }, 'src/a.ts': { 1: 0 } }), [
		{ file: 'src/a.ts', lines: [{ line: 1, count: 0 }], covered: 0, total: 1 },
		{ file: 'src/b.ts', lines: [{ line: 2, count: 4 }, { line: 10, count: 0 }], covered: 1, total: 2 },
	]);
});
