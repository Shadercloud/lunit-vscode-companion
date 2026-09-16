// Unit coverage for the worker protocol (src/luneBlockProtocol.ts), the
// per-block verdicts (src/runReport.ts), the output helpers and the parallel
// settings: crashes, malformed and missing results can never become passes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
	assessBlock,
	BLOCK_MARKER,
	MODULES_MARKER,
	outputTail,
	parseBlockSummary,
	parseModuleListing,
} = require('../out/luneBlockProtocol');
const {
	blocksForTest,
	createRunReport,
	formatReportSummary,
	formatSummary,
	resolveBlockVerdict,
	summarizeReport,
	testsResolvedBy,
} = require('../out/runReport');
const { createResultLineFilter, RESULT_MARKER } = require('../out/resultProtocol');
const { createLinePrefixer } = require('../out/luneRunner');
const { buildConfig } = require('../out/config');

const b64 = (text) => Buffer.from(String(text), 'utf8').toString('base64');
const resultLine = (cls, label, status, ms = 5, error) =>
	`${RESULT_MARKER}${b64(cls)}\t${b64(label)}\t${status}\t${ms}\t${error ? b64(error) : ''}`;
const summaryLine = (summary) => `${BLOCK_MARKER}${JSON.stringify(summary)}`;
const summary = (results, failed = 0, loadFailures = []) => ({ results, failed, loadFailures, elapsedMs: 12 });
const lines = (...items) => items.join('\n') + '\n';
const done = (output, code = 0) => ({ code, output, cancelled: false, timedOut: false });

test('the module listing is decoded strictly and empty Luau tables are tolerated', () => {
	const listing = {
		modules: [
			{ path: 'out/a.test', class: { className: 'A', tags: {}, disabled: false, methods: [{ name: 't', isTest: true, tags: ['Slow'], lifecycles: {}, cases: 2, ordered: false, only: false, disabled: false }] } },
		],
		loadFailures: {},
		excludedModules: ['out/s.test'],
	};
	const parsed = parseModuleListing(`noise\n${MODULES_MARKER}${JSON.stringify(listing)}\nmore\n`);
	assert.ok('listing' in parsed, JSON.stringify(parsed));
	assert.deepEqual(parsed.listing.modules[0].class.tags, []);
	assert.deepEqual(parsed.listing.modules[0].class.methods[0], {
		name: 't',
		isTest: true,
		tags: ['Slow'],
		displayName: undefined,
		cases: 2,
		lifecycles: [],
		ordered: false,
		only: false,
		disabled: false,
	});
	assert.deepEqual(parsed.listing.loadFailures, []);
	assert.deepEqual(parsed.listing.excludedModules, ['out/s.test']);
	assert.match(parseModuleListing('no marker at all').error, /produced no module listing/);
	assert.match(parseModuleListing(`${MODULES_MARKER}{not json`).error, /not valid JSON/);
	assert.match(parseModuleListing(`${MODULES_MARKER}[1,2]`).error, /not a JSON object/);
	assert.match(parseModuleListing(`${MODULES_MARKER}{"modules":[{"path":"x"}]}`).error, /malformed module entry/);
	const failure = parseModuleListing(`${MODULES_MARKER}{"modules":{},"loadFailures":[{"path":"out/b.test","error":"boom"}]}`);
	assert.deepEqual(failure.listing.loadFailures, [{ path: 'out/b.test', error: 'boom' }]);
});

test('the block summary is decoded from the last marker line and rejected when malformed', () => {
	assert.deepEqual(parseBlockSummary(lines(summaryLine(summary(2, 1)), 'trailing')), { results: 2, failed: 1, loadFailures: [], elapsedMs: 12 });
	assert.deepEqual(parseBlockSummary(lines(summaryLine(summary(1)), summaryLine(summary(3)))).results, 3);
	assert.equal(parseBlockSummary('nothing'), undefined);
	assert.equal(parseBlockSummary(`${BLOCK_MARKER}{`), undefined);
	assert.equal(parseBlockSummary(`${BLOCK_MARKER}[]`), undefined);
	assert.equal(parseBlockSummary(summaryLine({ results: -1, failed: 0 })), undefined);
	assert.equal(parseBlockSummary(summaryLine({ results: '2', failed: 0 })), undefined);
	assert.equal(parseBlockSummary(summaryLine({ results: 2 })), undefined);
	assert.deepEqual(parseBlockSummary(summaryLine({ results: 0, failed: 0, loadFailures: [{ path: 'm', error: 'e' }] })).loadFailures, [{ path: 'm', error: 'e' }]);
});

test('a block passes only when the worker exited normally with a summary that matches its results', () => {
	const ok = assessBlock(done(lines(resultLine('A', 't', 'passed'), summaryLine(summary(1)))));
	assert.equal(ok.status, 'passed');
	assert.equal(ok.records.length, 1);
	const failed = assessBlock(done(lines(resultLine('A', 't', 'failed', 1, 'nope'), summaryLine(summary(1, 1))), 1));
	assert.equal(failed.status, 'failed');
	assert.equal(failed.error, undefined);
	assert.equal(assessBlock(done(lines(resultLine('A', 't', 'failed'), summaryLine(summary(1, 0))))).status, 'failed', 'a failed result line counts even if the summary says otherwise');
	assert.equal(assessBlock(done(lines(summaryLine(summary(0, 0, [{ path: 'm', error: 'e' }]))), 1)).status, 'failed');

	const crash = assessBlock(done(lines(resultLine('A', 't', 'passed'), 'stack trace here'), 3));
	assert.equal(crash.status, 'errored');
	assert.match(crash.error, /exited with code 3\nstack trace here/);
	assert.match(assessBlock(done(lines(resultLine('A', 't', 'passed')), null)).error, /was killed or failed to start/);
	assert.match(assessBlock(done(lines(resultLine('A', 't', 'passed')), 0)).error, /exited with code 0 without reporting a block summary/);
	assert.match(assessBlock(done(lines(resultLine('A', 't', 'passed'), `${BLOCK_MARKER}{garbage`))).error, /without reporting a block summary/);
	assert.match(assessBlock(done(lines(resultLine('A', 't', 'passed'), summaryLine(summary(2))))).error, /reported 2 result\(s\) but 1 were received/);
	assert.match(assessBlock(done(lines(summaryLine(summary(0))), 2)).error, /exited with code 2/);
	assert.equal(assessBlock({ ...done(lines(resultLine('A', 't', 'passed'))), cancelled: true }).status, 'cancelled');
	assert.match(assessBlock({ ...done(''), timedOut: true }).error, /timed out/);
	assert.equal(outputTail(lines('a', resultLine('A', 't', 'passed'), '', 'b', summaryLine(summary(1)))), 'a\nb');
});

function reportWith(blocks, extra = {}) {
	const plan = {
		blocks: blocks.map((block, index) => ({ index: index + 1, kind: block.kind ?? 'module', label: block.label ?? `block${index + 1}`, modules: [], tests: block.tests })),
		unscheduled: extra.unscheduled ?? [],
		notes: [],
		counts: { excludedClasses: 0, excludedTests: 0, slowLeftOut: 0, parallelClasses: 0, caseBlocks: 0, testModules: blocks.length },
	};
	const report = createRunReport(plan, extra.workers ?? 2, false);
	blocks.forEach((block, index) => Object.assign(report.blocks[index], { status: block.status ?? 'passed', records: block.records ?? [], error: block.error, loadFailures: block.loadFailures ?? [], seconds: block.seconds, exitCode: block.exitCode ?? 0 }));
	if (extra.error) {
		report.error = extra.error;
	}
	return report;
}
const record = (className, label, status, elapsedMs = 3, error) => ({ className, label, status, elapsedMs, error });
const t = (className, methodName, modulePath = 'm', caseIndex) => ({ className, methodName, modulePath, ...(caseIndex ? { caseIndex } : {}) });
const identity = (className, methodName, displayName) => ({ file: '/x.ts', className, methodName, displayName });

test('per-block verdicts: passes, failures, @Each rows across blocks, and every way to be errored or skipped', () => {
	const report = reportWith(
		[
			{ tests: [t('A', 'one'), t('A', 'two')], records: [record('A', 'one', 'passed', 4), record('A', 'two', 'failed', 2, 'boom')] },
			{ tests: [t('P', 'rows', 'p', 1)], kind: 'case', records: [record('P', 'rows (1, 2)', 'passed')] },
			{ tests: [t('P', 'rows', 'p', 2)], kind: 'case', records: [record('P', 'rows (3, 4)', 'failed', 3, 'wrong')] },
			{ tests: [t('C', 'crashed')], status: 'errored', error: 'the Lune worker exited with code 3', exitCode: 3, records: [record('C', 'crashed', 'passed')] },
			{ tests: [t('L', 'lost')], records: [], exitCode: 0 },
			{ tests: [t('M', 'x', 'missing-mod')], loadFailures: [{ path: 'missing-mod', error: 'cannot load' }] },
			{ tests: [t('N', 'never')], status: 'cancelled' },
			{ tests: [t('S', 'skipped')], records: [record('S', 'skipped', 'skipped', 0, 'disabled for now')] },
			{ tests: [t('D', 'named')], records: [record('D', 'Pretty name', 'passed')] },
		],
		{ unscheduled: [{ test: { className: 'U', methodName: 'u' }, status: 'errored', reason: 'not compiled' }, { test: { className: 'V', methodName: 'v' }, status: 'skipped', reason: 'Studio only' }] },
	);
	assert.deepEqual(resolveBlockVerdict(identity('A', 'one'), report), { status: 'passed', elapsedMs: 4 });
	assert.deepEqual(resolveBlockVerdict(identity('A', 'two'), report), { status: 'failed', message: 'boom', elapsedMs: 2 });
	const rows = resolveBlockVerdict(identity('P', 'rows'), report);
	assert.equal(rows.status, 'failed', 'any failed row fails the item');
	assert.equal(rows.message, 'rows (3, 4): wrong', 'the failing row is identified');
	assert.equal(rows.elapsedMs, 6);
	assert.equal(blocksForTest(report, { className: 'P', methodName: 'rows' }).length, 2);
	const crashed = resolveBlockVerdict(identity('C', 'crashed'), report);
	assert.equal(crashed.status, 'errored', 'a passed record from a crashed worker is not trusted');
	assert.match(crashed.message, /block #4 \(block4\): the Lune worker exited with code 3/);
	const lost = resolveBlockVerdict(identity('L', 'lost'), report);
	assert.equal(lost.status, 'errored');
	assert.match(lost.message, /block #5 \(block5, exit code 0\) finished without reporting a result/);
	assert.match(resolveBlockVerdict(identity('M', 'x'), report).message, /failed to load missing-mod: cannot load/);
	assert.deepEqual(resolveBlockVerdict(identity('N', 'never'), report), { status: 'skipped', message: 'the run was cancelled before this test finished' });
	assert.deepEqual(resolveBlockVerdict(identity('S', 'skipped'), report), { status: 'skipped', message: 'disabled for now' });
	assert.equal(resolveBlockVerdict(identity('D', 'named', 'Pretty name'), report).status, 'passed', '@DisplayName labels match');
	assert.deepEqual(resolveBlockVerdict(identity('U', 'u'), report), { status: 'errored', message: 'not compiled' });
	assert.deepEqual(resolveBlockVerdict(identity('V', 'v'), report), { status: 'skipped', message: 'Studio only' });
	assert.match(resolveBlockVerdict(identity('Z', 'z'), report).message, /no compiled test class named "Z" with a @Test method "z"/);
	const broken = reportWith([], { error: 'discovery failed' });
	assert.deepEqual(resolveBlockVerdict(identity('A', 'one'), broken), { status: 'errored', message: 'discovery failed' });
});

test('a test spread over several blocks is resolved only once its last block finishes', () => {
	const report = reportWith([
		{ tests: [t('P', 'rows', 'p', 1), t('P', 'plain')], status: 'passed' },
		{ tests: [t('P', 'rows', 'p', 2)], status: 'pending' },
		{ tests: [t('Q', 'q')], status: 'running' },
	]);
	assert.deepEqual(testsResolvedBy(report, report.blocks[0]), [{ className: 'P', methodName: 'plain' }]);
	assert.equal(resolveBlockVerdict(identity('P', 'rows'), report).status, 'skipped', 'still open: reported as not finished');
	report.blocks[1].status = 'passed';
	assert.deepEqual(testsResolvedBy(report, report.blocks[1]), [{ className: 'P', methodName: 'rows' }]);
	assert.deepEqual(testsResolvedBy(report, report.blocks[2]), []);
});

test('the closing summary reports wall time, workers, the longest block and blocks over ten seconds', () => {
	const report = reportWith(
		[
			{ label: 'quick', tests: [], seconds: 1.2 },
			{ label: 'slow', tests: [], seconds: 24.5 },
			{ label: 'mid', tests: [], seconds: 10.4, status: 'failed' },
			{ label: 'dead', tests: [], seconds: 0.3, status: 'errored' },
			{ label: 'never', tests: [], status: 'cancelled' },
		],
		{ workers: 4 },
	);
	report.wallSeconds = 31.7;
	report.compileSeconds = 8;
	report.discoverySeconds = 1.5;
	report.excludedClasses = 2;
	report.excludedTests = 1;
	const timing = summarizeReport(report);
	assert.deepEqual(timing, {
		blocks: 5,
		workers: 4,
		wallSeconds: 31.7,
		passed: 2,
		failed: 1,
		errored: 1,
		cancelled: 1,
		longest: { label: '#2 slow', seconds: 24.5 },
		long: [
			{ label: '#2 slow', seconds: 24.5 },
			{ label: '#3 mid', seconds: 10.4 },
		],
	});
	const text = formatReportSummary(report);
	assert.equal(text[0], '[lunit] 5 blocks on 4 workers in 31.7 s wall time (compile 8.0 s, discovery 1.5 s): 2 passed, 1 failed, 1 errored, 1 not run.');
	assert.equal(text[1], '[lunit] longest block 24.5 s: #2 slow; 2 blocks over 10 s: #2 slow (24.5 s), #3 mid (10.4 s).');
	assert.equal(text[2], '[lunit] Left out 2 Studio-tagged test class(es) and 1 Studio-tagged test(s): run them with the Studio profile.');
	const single = reportWith([{ label: 'all', tests: [], seconds: 3 }], { workers: 1 });
	single.singleProcess = true;
	single.wallSeconds = 3.5;
	assert.match(formatReportSummary(single)[0], /1 block in one Lune process in 3\.5 s wall time/);
	assert.match(formatReportSummary(single)[1], /0 blocks over 10 s\.$/);
	// The CLI summary carries the same timing.
	const printed = formatSummary({ via: 'lune', cancelled: false, tests: [], counts: { passed: 0, failed: 0, skipped: 0, errored: 0 }, lune: timing }, '/ws');
	assert.match(printed, /5 block\(s\) on 4 worker\(s\), 31\.7 s wall time; longest block 24\.5 s \(#2 slow\)\./);
});

test('machine-only lines never reach the display, and worker lines carry their block prefix', () => {
	const shown = [];
	const filter = createResultLineFilter((text) => shown.push(text));
	filter.feed(`hello\n${MODULES_MARKER}{}\nmid`);
	filter.feed(`dle\n${BLOCK_MARKER}{}\n${RESULT_MARKER}x\ttail`);
	filter.flush();
	assert.deepEqual(shown, ['hello\n', 'middle\n']);

	const prefixed = [];
	const prefixer = createLinePrefixer('[#3] ', (text) => prefixed.push(text));
	prefixer.feed('one\ntw');
	prefixer.feed('o\nthree');
	assert.deepEqual(prefixed, ['[#3] one\n', '[#3] two\n']);
	prefixer.flush();
	assert.deepEqual(prefixed, ['[#3] one\n', '[#3] two\n', '[#3] three\n']);
	prefixer.flush();
	assert.equal(prefixed.length, 3);
});

test('the parallel settings default to enabled, automatic workers and no groups, and never drop a malformed group silently', () => {
	const read = (settings) => buildConfig('/ws', '/storage', (key, fallback) => (key in settings ? settings[key] : fallback)).lune.parallel;
	assert.deepEqual(read({}), { enabled: true, workers: 0, dependencyGroups: [] });
	assert.deepEqual(read({ 'lune.parallel.enabled': false, 'lune.parallel.workers': 64 }), { enabled: false, workers: 64, dependencyGroups: [] });
	assert.equal(read({ 'lune.parallel.workers': 2.7 }).workers, 2);
	assert.equal(read({ 'lune.parallel.workers': -1 }).workers, 0);
	assert.equal(read({ 'lune.parallel.workers': '8' }).workers, 0);
	assert.deepEqual(read({ 'lune.parallel.dependencyGroups': [[' a.test ', 'b.test', ''], 'lonely', [1, 'c']] }).dependencyGroups, [['a.test', 'b.test'], ['lonely'], ['1', 'c']]);
	assert.deepEqual(read({ 'lune.parallel.dependencyGroups': 'nope' }).dependencyGroups, []);
});
