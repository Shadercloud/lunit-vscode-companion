// Live Studio results (liveResults.ts): streamed start/result events map onto
// the requested tests as they arrive, and reconcile with the final report
// without reporting anything twice.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LiveResults } = require('../out/liveResults');
const { parseLiveLine, parseResultLines, LIVE_RESULT_MARKER, LIVE_START_MARKER, RESULT_MARKER, createResultLineFilter } = require('../out/resultProtocol');
const { resolveVerdict, formatSummary, buildSummary } = require('../out/runReport');

const b64 = text => Buffer.from(text).toString('base64');
const line = (marker, cls, label, status, ms = 3, error = '') =>
 `${marker}${b64(cls)}\t${b64(label)}\t${status}\t${ms}\t${error ? b64(error) : ''}`;
const startLine = (cls, label) => `${LIVE_START_MARKER}${b64(cls)}\t${b64(label)}`;
const live = (cls, label, status, ms, error) => parseLiveLine(line(LIVE_RESULT_MARKER, cls, label, status, ms, error));
const tests = [
 {file: '/w/a.test.ts', className: 'Math', methodName: 'adds'},
 {file: '/w/a.test.ts', className: 'Math', methodName: 'add'},
 {file: '/w/a.test.ts', className: 'Math', methodName: 'addAll'},
 {file: '/w/a.test.ts', className: 'Math', methodName: 'shown', displayName: 'shows a name'},
 {file: '/w/b.test.ts', className: 'Other', methodName: 'add'},
];
const index = (cls, method) => tests.findIndex(t => t.className === cls && t.methodName === method);

test('live lines parse, and are hidden from display like result lines', () => {
 assert.deepEqual(parseLiveLine(startLine('Math', 'adds')), {kind: 'started', className: 'Math', label: 'adds'});
 const event = live('Math', 'adds', 'failed', 12, 'boom\n  at stack');
 assert.equal(event.kind, 'result');
 assert.deepEqual(event.record, {className: 'Math', label: 'adds', status: 'failed', elapsedMs: 12, error: 'boom\n  at stack'});
 assert.equal(parseLiveLine('[lunit] something else'), undefined);
 // Live lines never count as final results.
 assert.equal(parseResultLines(line(LIVE_RESULT_MARKER, 'Math', 'adds', 'passed')).length, 0);
 const shown = [];
 const filter = createResultLineFilter(text => shown.push(text));
 filter.feed(`${startLine('Math', 'adds')}\n${line(LIVE_RESULT_MARKER, 'Math', 'adds', 'passed')}\n[lunit] kept\n`);
 assert.deepEqual(shown, ['[lunit] kept\n']);
});

test('results are reported as they arrive, before the run ends', () => {
 const results = new LiveResults(tests);
 assert.deepEqual(results.apply(parseLiveLine(startLine('Math', 'adds'))), [{kind: 'started', index: index('Math', 'adds')}]);
 assert.deepEqual(results.apply(parseLiveLine(startLine('Math', 'adds'))), [], 'started once');
 assert.deepEqual(results.apply(live('Math', 'adds', 'passed', 5)), [
  {kind: 'verdict', index: index('Math', 'adds'), verdict: {status: 'passed', elapsedMs: 5}},
 ]);
 assert.deepEqual(results.apply(live('Math', 'shows a name', 'failed', 1, 'nope')), [
  {kind: 'verdict', index: index('Math', 'shown'), verdict: {status: 'failed', message: 'nope', elapsedMs: 1}},
 ], 'display names map to their test');
 assert.deepEqual(results.apply(live('Nowhere', 'x', 'passed')), [], 'unknown tests are ignored');
});

test('@Each rows map to the right test and fold into one verdict', () => {
 const results = new LiveResults(tests);
 const add = index('Math', 'add');
 // "add (1, 2)" is a row of add -- not of adds, addAll, or Other.add.
 assert.deepEqual(results.apply(live('Math', 'add (1, 2)', 'passed', 2)), [{kind: 'verdict', index: add, verdict: {status: 'passed', elapsedMs: 2}}]);
 assert.deepEqual(results.apply(live('Math', 'addAll ([1])', 'passed', 1)).map(u => u.index), [index('Math', 'addAll')]);
 // A second passing row changes nothing visible; a failing row flips the test.
 assert.deepEqual(results.apply(live('Math', 'add (3, 4)', 'passed', 2)), []);
 const flipped = results.apply(live('Math', 'add (5, 6)', 'failed', 2, 'expected 11'));
 assert.equal(flipped.length, 1);
 assert.equal(flipped[0].verdict.status, 'failed');
 assert.equal(flipped[0].verdict.message, 'add (5, 6): expected 11');
 assert.equal(results.liveVerdict(index('Other', 'add')), undefined);
});

test('a retried test: the latest try stands', () => {
 const results = new LiveResults(tests);
 results.apply(live('Math', 'adds', 'failed', 1, 'flaky'));
 const retried = results.apply(live('Math', 'adds', 'passed', 1));
 assert.deepEqual(retried, [{kind: 'verdict', index: index('Math', 'adds'), verdict: {status: 'passed', elapsedMs: 1}}]);
});

test('streamed and final results reconcile without duplicates; the final word wins when they differ', () => {
 const results = new LiveResults(tests);
 results.apply(live('Math', 'adds', 'passed', 4));
 results.apply(live('Math', 'add (1, 2)', 'passed', 4));
 results.apply(live('Math', 'add (3, 4)', 'passed', 4));
 const final = [
  line(RESULT_MARKER, 'Math', 'adds', 'passed', 4),
  // add errored in teardown after both rows had reported passed.
  line(RESULT_MARKER, 'Math', 'add (1, 2)', 'passed', 4),
  line(RESULT_MARKER, 'Math', 'add (3, 4)', 'failed', 4, 'teardown failed'),
  line(RESULT_MARKER, 'Math', 'addAll', 'passed', 1),
 ].join('\n');
 const records = parseResultLines(final);
 const outcome = {code: 1, output: final, timedOut: false, cancelled: false};
 const settle = method => results.reconcile(index('Math', method), records, resolveVerdict(tests[index('Math', method)], records, outcome));
 assert.deepEqual(settle('adds'), {verdict: {status: 'passed', elapsedMs: 4}, report: false}, 'same as streamed: not reported again');
 const add = settle('add');
 assert.equal(add.report, true);
 assert.equal(add.verdict.status, 'failed');
 assert.match(add.verdict.message, /add \(3, 4\): teardown failed/);
 assert.match(add.verdict.message, /final result \(failed\) replaces the result reported while the run was going \(passed\)/);
 assert.deepEqual(settle('addAll'), {verdict: {status: 'passed', elapsedMs: 1}, report: true}, 'never streamed: reported now');
});

test('a cancelled or released run keeps the streamed results; only the rest get the fallback', () => {
 const results = new LiveResults(tests);
 results.apply(live('Math', 'adds', 'passed', 4));
 results.apply(live('Math', 'shows a name', 'failed', 1, 'nope'));
 const skipped = {status: 'skipped'};
 assert.deepEqual(results.reconcile(index('Math', 'adds'), [], skipped), {verdict: {status: 'passed', elapsedMs: 4}, report: false});
 assert.equal(results.reconcile(index('Math', 'shown'), [], skipped).verdict.status, 'failed');
 assert.deepEqual(results.reconcile(index('Math', 'addAll'), [], skipped), {verdict: skipped, report: true});
 const released = {code: 1, output: '', timedOut: false, cancelled: false, unfinishedMessage: 'run released after Math > addAll ran 120s+ without a heartbeat'};
 const reason = results.reconcile(index('Math', 'addAll'), [], resolveVerdict(tests[index('Math', 'addAll')], [], released));
 assert.deepEqual(reason.verdict, {status: 'errored', message: released.unfinishedMessage});
});

test('the CLI summary leaves out lines already printed live, and a cancelled run says what reported', () => {
 const entries = [
  {...tests[0], status: 'passed', elapsedMs: 4, streamed: true},
  {...tests[2], status: 'failed', message: 'late failure', streamed: false},
 ];
 const printed = formatSummary(buildSummary('studio', entries, false), '/w');
 assert.doesNotMatch(printed, /PASS {2}a\.test\.ts > Math > adds/);
 assert.match(printed, /FAIL {2}a\.test\.ts > Math > addAll/);
 assert.match(printed, /2 tests via Roblox Studio: 1 passed, 1 failed/);
 const cancelled = formatSummary(buildSummary('studio', [entries[0], {...tests[1], status: 'skipped'}], true), '/w');
 assert.match(cancelled, /cancelled after 1 test\(s\) reported: 1 passed, 0 failed, 0 skipped/);
});
