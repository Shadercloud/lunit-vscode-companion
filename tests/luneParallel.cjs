// Regression coverage for the parallel Lune profile against a real Lune and
// the real @rbxts/lunit (tests/fixtures/package): per-case blocks for a
// @Tag("Parallel") class with @Each rows and BeforeEach/AfterEach in fresh
// VMs, rejected Parallel classes, dependency groups sharing one VM, the
// dependency closure of a selection, @Only, the slow rule, load failures,
// single-process mode, the streamed block output and the closing summary.
//
// Driven from runLuau.cjs because it needs Lune on PATH (or LUNE_EXE).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runViaLune } = require('../out/luneRunner');
const { buildConfig } = require('../out/config');
const { CancelSource } = require('../out/cancelSignal');
const { resolveBlockVerdict } = require('../out/runReport');
const { buildTestSelection } = require('../out/luauTestFilterTemplate');
const { createResultLineFilter } = require('../out/resultProtocol');

const FIXTURE = path.join(__dirname, 'fixtures', 'package');
const LUNE = process.env.LUNE_EXE ? `"${process.env.LUNE_EXE}"` : 'lune';

function config(storageDir, settings = {}) {
	const all = { skipCompile: true, 'lune.executable': LUNE, ...settings };
	return buildConfig(FIXTURE, storageDir, (key, fallback) => (key in all ? all[key] : fallback));
}

// Output goes through the same display filter the Test Explorer and the
// command line apply, so `output` is what a user sees.
async function run(storageDir, settings, options = {}) {
	let output = '';
	const display = createResultLineFilter((text) => (output += text));
	const outcome = await runViaLune(config(storageDir, settings), new CancelSource().token, (chunk) => display.feed(chunk), options);
	display.flush();
	assert.ok(outcome.report, `no report:\n${output}`);
	return { outcome, output, report: outcome.report };
}

const ident = (className, methodName, file = `/src/tests/${className}.test.ts`) => ({ file, className, methodName });
const verdict = (report, className, methodName) => resolveBlockVerdict(ident(className, methodName), report);
const labels = (report) => report.blocks.map((block) => block.label).sort();
const SLOW = { tags: ['Slow'] };

module.exports = async function runParallelChecks(scriptDir) {
	const storageDir = path.join(scriptDir, 'package-storage');
	fs.mkdirSync(storageDir, { recursive: true });

	// Run with Lune, everything: one block per module, Parallel classes split
	// per case, rejected classes and load failures called out.
	const everyday = await run(storageDir, {}, { slow: SLOW });
	assert.deepEqual(
		labels(everyday.report),
		[
			'out/tests/focused.test::focused',
			'out/tests/group/consumer.test',
			'out/tests/group/setup.test',
			'out/tests/ordered.test',
			'out/tests/rows.test::plain',
			'out/tests/rows.test::rows[1]',
			'out/tests/rows.test::rows[2]',
			'out/tests/rows.test::rows[3]',
		],
		everyday.output,
	);
	assert.equal(verdict(everyday.report, 'OrderedTests', 'first').status, 'passed', everyday.output);
	assert.equal(verdict(everyday.report, 'OrderedTests', 'second').status, 'passed', 'ordered methods share one instance and one BeforeAll');
	assert.equal(verdict(everyday.report, 'RowTests', 'plain').status, 'passed', everyday.output);
	const rows = verdict(everyday.report, 'RowTests', 'rows');
	assert.equal(rows.status, 'failed', 'the third row fails on purpose, so the method fails');
	assert.match(rows.message, /^rows \(2, 2, 5\): /, 'the failing row is identified');
	assert.ok(!/rows \(1, 2, 3\)/.test(rows.message), 'passing rows are not listed as failures');
	assert.equal(verdict(everyday.report, 'RowTests', 'sweep').status, 'skipped', 'slow');
	assert.equal(everyday.report.slowLeftOut, 1);
	assert.equal(verdict(everyday.report, 'SetupTests', 'registersTheFixture').status, 'passed');
	assert.equal(verdict(everyday.report, 'ConsumerTests', 'seesTheFixture').status, 'failed', 'without a dependency group each module gets a fresh VM');
	assert.equal(verdict(everyday.report, 'FocusedTests', 'focused').status, 'passed');
	assert.match(verdict(everyday.report, 'FocusedTests', 'shadowed').message, /focused with @Only \(focused\)/);
	for (const name of ['first', 'second']) {
		const bad = verdict(everyday.report, 'BadParallelTests', name);
		assert.equal(bad.status, 'errored');
		assert.match(bad.message, /@Tag\("Parallel"\) on class BadParallelTests \(out\/tests\/badParallel.test\) cannot be honoured: suite-level @BeforeAll\/@AfterAll hook\(s\) setUpAll .*; ordered method\(s\) first/);
	}
	assert.match(verdict(everyday.report, 'HookTestTests', 'plain').message, /method\(s\) both that are both a @Test and a lifecycle hook/);
	assert.match(everyday.output, /failed to load test module ".*out\/tests\/broken.test": .*cannot be loaded on purpose/);
	const broken = resolveBlockVerdict(ident('BrokenTests', 'anything', '/src/tests/broken.test.ts'), (await run(storageDir, {}, { selection: [ident('BrokenTests', 'anything', '/src/tests/broken.test.ts')] })).report);
	assert.equal(broken.status, 'errored');
	assert.match(broken.message, /out\/tests\/broken.test failed to load: .*cannot be loaded on purpose/);
	assert.equal(everyday.outcome.code, 1);
	assert.match(everyday.output, /\[lunit\] 8 blocks on \d+ workers; 2 @Tag\("Parallel"\) class\(es\) split into 5 case block\(s\)\./);
	assert.match(everyday.output, /\[#\d+\] .*RowTests/, 'worker output is prefixed with its block id');
	assert.match(everyday.output, /\[lunit\] #\d+ FAIL out\/tests\/rows.test::rows\[3\]/);
	assert.match(everyday.output, /\[lunit\] 8 blocks on \d+ workers in \d+\.\d s wall time \(compile 0\.0 s, discovery \d+\.\d s\): 6 passed, 2 failed\./);
	assert.match(everyday.output, /\[lunit\] longest block \d+\.\d s: #\d+ out\/tests\/.*; 0 blocks over 10 s\./);
	assert.ok(everyday.report.blocks.every((block) => block.seconds !== undefined && block.exitCode !== null));
	assert.ok(!everyday.output.includes('@@LUNIT_'), 'machine-only lines never reach the displayed output');

	// A dependency group: both modules in one VM, prerequisite first.
	const groups = { 'lune.parallel.dependencyGroups': [['setup.test', 'tests/group/consumer.test.ts']] };
	const grouped = await run(storageDir, groups, { slow: SLOW });
	assert.ok(labels(grouped.report).includes('out/tests/group/setup.test -> out/tests/group/consumer.test'), grouped.output);
	assert.equal(grouped.report.blocks.length, 7);
	assert.equal(verdict(grouped.report, 'ConsumerTests', 'seesTheFixture').status, 'passed', grouped.output);
	assert.equal(verdict(grouped.report, 'SetupTests', 'registersTheFixture').status, 'passed');

	// Selecting the dependent test pulls in its prerequisite, in full, and says so.
	const closure = await run(storageDir, groups, { slow: SLOW, selection: [ident('ConsumerTests', 'seesTheFixture')] });
	assert.deepEqual(labels(closure.report), ['out/tests/group/setup.test -> out/tests/group/consumer.test']);
	assert.match(closure.output, /dependency group out\/tests\/group\/setup.test -> out\/tests\/group\/consumer.test: out\/tests\/group\/setup.test run in full before the selected tests in out\/tests\/group\/consumer.test/);
	assert.equal(verdict(closure.report, 'ConsumerTests', 'seesTheFixture').status, 'passed', closure.output);
	assert.equal(verdict(closure.report, 'SetupTests', 'registersTheFixture').status, 'passed', 'the prerequisite that ran is reported too');
	assert.equal(closure.outcome.code, 0);

	// Selecting a parameterized method runs every one of its rows.
	const method = await run(storageDir, {}, { slow: SLOW, selection: [ident('RowTests', 'rows')] });
	assert.deepEqual(labels(method.report), ['out/tests/rows.test::rows[1]', 'out/tests/rows.test::rows[2]', 'out/tests/rows.test::rows[3]']);
	assert.equal(verdict(method.report, 'RowTests', 'rows').status, 'failed');

	// Run with Lune (Full), one worker: the slow case runs too, serially.
	const full = await run(storageDir, {}, { workers: 1 });
	assert.equal(full.report.workers, 1);
	assert.ok(labels(full.report).includes('out/tests/rows.test::sweep'));
	assert.equal(verdict(full.report, 'RowTests', 'sweep').status, 'passed', full.output);
	assert.equal(full.report.slowLeftOut, 0);
	assert.match(full.output, /9 blocks on 1 worker; 2 @Tag\("Parallel"\) class\(es\) split into 6 case block\(s\)\./);

	// Explicitly selecting the slow test runs it under the everyday profile.
	const explicit = await run(storageDir, {}, {
		slow: { tags: ['Slow'], allowed: buildTestSelection([ident('RowTests', 'sweep')]) },
		selection: [ident('RowTests', 'sweep')],
	});
	assert.deepEqual(labels(explicit.report), ['out/tests/rows.test::sweep']);
	assert.equal(verdict(explicit.report, 'RowTests', 'sweep').status, 'passed');

	// Single-process mode: everything in one VM, groups first, the Parallel
	// tag ignored, rows aggregated, module order otherwise as discovered.
	const single = await run(storageDir, { 'lune.parallel.enabled': false, ...groups }, { slow: SLOW });
	assert.equal(single.report.singleProcess, true);
	assert.equal(single.report.blocks.length, 1);
	assert.equal(single.report.blocks[0].kind, 'all');
	assert.deepEqual(
		single.report.blocks[0].tests.map((test) => `${test.className}.${test.methodName}`),
		[
			'SetupTests.registersTheFixture',
			'ConsumerTests.seesTheFixture',
			'BadParallelTests.first',
			'BadParallelTests.second',
			'FocusedTests.focused',
			'HookTestTests.both',
			'HookTestTests.plain',
			'OrderedTests.first',
			'OrderedTests.second',
			'RowTests.plain',
			'RowTests.rows',
		],
		single.output,
	);
	assert.equal(verdict(single.report, 'ConsumerTests', 'seesTheFixture').status, 'passed', single.output);
	assert.equal(verdict(single.report, 'BadParallelTests', 'first').status, 'passed', 'no case splitting, so nothing to reject');
	assert.equal(verdict(single.report, 'RowTests', 'rows').status, 'failed');
	assert.equal(verdict(single.report, 'RowTests', 'plain').status, 'passed');
	assert.match(single.output, /1 block in one Lune process in/);
	const singleNoGroup = await run(storageDir, { 'lune.parallel.enabled': false }, { slow: SLOW });
	assert.equal(verdict(singleNoGroup.report, 'ConsumerTests', 'seesTheFixture').status, 'failed', 'discovery order runs consumer before setup');

	assert.deepEqual(fs.readdirSync(path.join(storageDir, 'lune-runs')), [], 'run directories are cleaned up');
	console.log('Parallel Lune (package project, real Lunit) regression checks passed');
};
