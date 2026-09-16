// Integration coverage for the parallel Lune runner (src/luneRunner.ts) with
// tests/fakeLune.cjs standing in for Lune: the concurrency limit and slot
// refill, exactly-once scheduling, cancellation (workers killed, pending
// blocks never started), crashes and malformed or missing results, dependency
// ordering, Parallel splitting with row aggregation, the slow rule, the
// progress hooks, and per-run generated files. No Lune needed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runViaLune } = require('../out/luneRunner');
const { buildConfig } = require('../out/config');
const { CancelSource } = require('../out/cancelSignal');
const { resolveBlockVerdict, testsResolvedBy } = require('../out/runReport');

const FAKE = path.join(__dirname, 'fakeLune.cjs');

const method = (name, extra = {}) => ({ name, isTest: true, tags: [], lifecycles: [], ordered: false, only: false, disabled: false, ...extra });
const mod = (name, className, methods, cls = {}) => ({ path: `out/${name}`, class: { className, tags: [], disabled: false, methods, ...cls } });
const listing = (modules, extra = {}) => ({ modules, loadFailures: [], excludedModules: [], ...extra });
const ident = (className, methodName) => ({ file: `/src/${className}.test.ts`, className, methodName });

function workspace(t, modules, settings = {}, extraEnv = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lunit-fake-'));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	fs.mkdirSync(path.join(root, 'node_modules', '@rbxts', 'lunit', 'scripts'), { recursive: true });
	fs.writeFileSync(path.join(root, 'node_modules', '@rbxts', 'lunit', 'scripts', 'promise.luau'), '');
	const storage = path.join(root, 'storage');
	const logDir = path.join(root, 'log');
	fs.mkdirSync(storage);
	fs.mkdirSync(logDir);
	const listingFile = path.join(root, 'listing.json');
	fs.writeFileSync(listingFile, JSON.stringify(listing(modules)));
	const all = {
		skipCompile: true,
		'lune.executable': `node "${FAKE}"`,
		env: { FAKE_LUNE_LISTING: listingFile, FAKE_LUNE_LOG: logDir, ...extraEnv },
		...settings,
	};
	const config = buildConfig(root, storage, (key, fallback) => (key in all ? all[key] : fallback));
	const read = (name) => {
		const file = path.join(logDir, name);
		return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined;
	};
	return { root, storage, config, logDir, started: (n) => read(`start-${n}`), ended: (n) => read(`end-${n}`) };
}

async function run(ws, options = {}, cancel = new CancelSource()) {
	let output = '';
	const outcome = await runViaLune(ws.config, cancel.token, (text) => (output += text), options);
	return { outcome, output, report: outcome.report };
}
const verdict = (report, className, methodName) => resolveBlockVerdict(ident(className, methodName), report);
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) {
			return;
		}
		await sleepMs(25);
	}
	assert.fail('timed out waiting');
}

const varied = [
	mod('sleep-400', 'A', [method('t')]),
	mod('b/sleep-100', 'B', [method('t')]),
	mod('c/sleep-100', 'C', [method('t')]),
	mod('d/sleep-100', 'D', [method('t')]),
	mod('e/sleep-100', 'E', [method('t')]),
];

function maxOverlap(ws, count) {
	const intervals = Array.from({ length: count }, (_, i) => [ws.started(i + 1).at, ws.ended(i + 1).at]);
	return Math.max(
		...intervals.map(([start]) => intervals.filter(([s, e]) => s <= start && start < e).length),
	);
}

test('blocks overlap up to the worker limit and a freed slot takes the next block at once', async (t) => {
	const ws = workspace(t, varied, { 'lune.parallel.workers': 2 });
	const { outcome, output, report } = await run(ws);
	assert.equal(outcome.code, 0, output);
	assert.equal(report.workers, 2);
	assert.equal(report.blocks.length, 5);
	assert.ok(maxOverlap(ws, 5) <= 2, 'never more than two workers alive');
	assert.ok(ws.started(3).at < ws.ended(1).at, 'the third block started while the long first block was still running');
	for (const cls of ['A', 'B', 'C', 'D', 'E']) {
		assert.deepEqual(verdict(report, cls, 't'), { status: 'passed', elapsedMs: 1 });
	}
	assert.match(output, /\[lunit\] 5 blocks on 2 workers\./);
	assert.match(output, /\[#1\] fake lune: running out\/sleep-400/);
	assert.match(output, /\[lunit\] #1 PASS out\/sleep-400 \(\d+\.\d s\)/);
	assert.match(output, /\[lunit\] 5 blocks on 2 workers in \d+\.\d s wall time/);
	assert.match(output, /\[lunit\] longest block \d+\.\d s: #1 out\/sleep-400; 0 blocks over 10 s\./);
	assert.ok(report.wallSeconds > 0);
	assert.deepEqual(fs.readdirSync(path.join(ws.storage, 'lune-runs')), [], 'the run directory is cleaned up');
});

test('one worker runs the blocks one after another, each exactly once, in plan order', async (t) => {
	const ws = workspace(t, varied, { 'lune.parallel.workers': 3 });
	const { report } = await run(ws, { workers: 1 });
	assert.equal(report.workers, 1, 'the per-run override wins over the setting');
	assert.equal(maxOverlap(ws, 5), 1);
	for (let i = 1; i < 5; i++) {
		assert.ok(ws.ended(i).at <= ws.started(i + 1).at, `block ${i + 1} waited for block ${i}`);
	}
	const jobs = Array.from({ length: 5 }, (_, i) => ws.started(i + 1).jobFile);
	assert.equal(new Set(jobs).size, 5, 'each block ran once with its own job file');
	assert.equal(fs.readdirSync(ws.logDir).filter((name) => name.startsWith('start-')).length, 5);
	const { report: configured } = await run(workspace(t, varied, { 'lune.parallel.workers': 3 }));
	assert.equal(configured.workers, 3);
});

test('a crash, a missing or malformed summary, or a result count mismatch errors the whole block', async (t) => {
	const ws = workspace(t, [
		mod('crash', 'Crash', [method('a'), method('b')]),
		mod('nosummary', 'NoSummary', [method('t')]),
		mod('badsummary', 'BadSummary', [method('t')]),
		mod('mismatch', 'Mismatch', [method('t')]),
		mod('ok', 'Ok', [method('t'), method('failx')]),
	]);
	const { outcome, output, report } = await run(ws);
	assert.equal(outcome.code, 1);
	assert.deepEqual(report.blocks.map((b) => b.status), ['errored', 'errored', 'errored', 'errored', 'failed']);
	const crashed = verdict(report, 'Crash', 'a');
	assert.equal(crashed.status, 'errored', 'the passed record printed before the crash is not trusted');
	assert.match(crashed.message, /block #1 \(out\/crash\): the Lune worker exited with code 3/);
	assert.match(verdict(report, 'Crash', 'b').message, /exited with code 3/);
	assert.match(verdict(report, 'NoSummary', 't').message, /exited with code 0 without reporting a block summary/);
	assert.match(verdict(report, 'BadSummary', 't').message, /without reporting a block summary/);
	assert.match(verdict(report, 'Mismatch', 't').message, /reported 2 result\(s\) but 1 were received/);
	assert.deepEqual(verdict(report, 'Ok', 't'), { status: 'passed', elapsedMs: 1 });
	assert.deepEqual(verdict(report, 'Ok', 'failx'), { status: 'failed', message: 'failx went wrong', elapsedMs: 1 });
	assert.match(output, /\[lunit\] #1 ERROR out\/crash \(\d+\.\d s\): the Lune worker exited with code 3/);
	assert.match(output, /\[lunit\] #5 FAIL out\/ok/);
	assert.match(output, /: 0 passed, 1 failed, 4 errored\./, 'block counts');
});

test('cancelling kills the running worker, starts nothing else, and reports the rest as not run', async (t) => {
	const ws = workspace(t, [mod('hang', 'Hang', [method('t')]), mod('ok', 'Ok', [method('t')]), mod('b/ok', 'Other', [method('t')])], {
		'lune.parallel.workers': 1,
	});
	const cancel = new CancelSource();
	const done = [];
	const running = run(
		ws,
		{
			hooks: {
				onBlockStart: async (block) => {
					if (block.index === 1) {
						await waitFor(() => ws.started(1) !== undefined);
						cancel.cancel();
					}
				},
				onBlockDone: (block) => done.push([block.index, block.status]),
			},
		},
		cancel,
	);
	const { outcome, output, report } = await running;
	assert.equal(outcome.cancelled, true);
	assert.deepEqual(report.blocks.map((b) => b.status), ['cancelled', 'cancelled', 'cancelled']);
	assert.equal(ws.started(2), undefined, 'pending blocks never started');
	assert.equal(ws.started(3), undefined);
	assert.deepEqual(done, [[1, 'cancelled']]);
	const pid = ws.started(1).pid;
	await waitFor(() => {
		try {
			process.kill(pid, 0);
			return false;
		} catch {
			return true;
		}
	});
	assert.deepEqual(verdict(report, 'Hang', 't'), { status: 'skipped', message: 'the run was cancelled before this test finished' });
	assert.equal(verdict(report, 'Ok', 't').status, 'skipped');
	assert.match(output, /\[lunit\] #1 CANCELLED out\/hang/);
	assert.match(output, /run cancelled; 2 block\(s\) did not run/);
	assert.match(output, /3 not run\./);
});

test('a pre-cancelled run stops at discovery', async (t) => {
	const ws = workspace(t, [mod('ok', 'Ok', [method('t')])]);
	const cancel = new CancelSource();
	cancel.cancel();
	const { outcome } = await run(ws, {}, cancel);
	assert.equal(outcome.cancelled, true);
	assert.equal(outcome.report, undefined);
	assert.equal(ws.started(1), undefined);
});

test('a dependency group runs its modules in order inside one worker, prerequisites first', async (t) => {
	const modules = [
		mod('ok-consumer', 'Consumer', [method('uses')]),
		mod('ok-other', 'Other', [method('x')]),
		mod('ok-setup', 'Setup', [method('a'), method('b')]),
	];
	const ws = workspace(t, modules, { 'lune.parallel.dependencyGroups': [['ok-setup', 'ok-consumer']] });
	const { report, outcome } = await run(ws);
	assert.equal(outcome.code, 0);
	assert.deepEqual(report.blocks.map((b) => b.label), ['out/ok-setup -> out/ok-consumer', 'out/ok-other']);
	assert.deepEqual(ws.started(1).modules, ['out/ok-setup', 'out/ok-consumer']);
	assert.deepEqual(verdict(report, 'Consumer', 'uses'), { status: 'passed', elapsedMs: 1 });

	const selected = workspace(t, modules, { 'lune.parallel.dependencyGroups': [['ok-setup', 'ok-consumer']] });
	const one = await run(selected, { selection: [ident('Consumer', 'uses')] });
	assert.equal(one.report.blocks.length, 1);
	assert.deepEqual(selected.started(1).modules, ['out/ok-setup', 'out/ok-consumer']);
	assert.match(one.output, /dependency group out\/ok-setup -> out\/ok-consumer: out\/ok-setup run in full before the selected tests in out\/ok-consumer/);
	assert.deepEqual(one.report.blocks[0].tests.map((test) => `${test.className}.${test.methodName}`), ['Setup.a', 'Setup.b', 'Consumer.uses']);
	assert.equal(verdict(one.report, 'Setup', 'b').status, 'passed', 'the prerequisite that ran is reported');
	assert.match(verdict(one.report, 'Other', 'x').message, /no compiled test class named "Other"/, 'a test outside the selection did not run');
});

test('a bad dependency group stops the run before anything is scheduled', async (t) => {
	const ws = workspace(t, [mod('ok', 'Ok', [method('t')]), mod('b/ok', 'B', [method('t')])], {
		'lune.parallel.dependencyGroups': [['nope', 'ok']],
	});
	const { outcome, output, report } = await run(ws);
	assert.equal(outcome.code, 1);
	assert.deepEqual(report.blocks, []);
	assert.match(report.error, /lunit\.lune\.parallel\.dependencyGroups: no test module matches "nope"\. Modules found: out\/ok, out\/b\/ok/);
	assert.equal(ws.started(1), undefined);
	assert.equal(verdict(report, 'Ok', 't').status, 'errored');
	assert.match(output, /no test module matches "nope"/);
});

test('a failed discovery step is an explicit error for every test', async (t) => {
	const ws = workspace(t, [mod('ok', 'Ok', [method('t')])], {}, { FAKE_LUNE_DISCOVERY_FAILS: '1' });
	const { outcome, output, report } = await run(ws);
	assert.equal(outcome.code, 2);
	assert.match(report.error, /test discovery failed \(Lune exited with code 2\): the discovery step produced no module listing/);
	assert.match(output, /discovery exploded/);
	assert.match(verdict(report, 'Ok', 't').message, /test discovery failed/);
});

test('a Parallel class is split per method and row, and rows aggregate onto the method as they finish', async (t) => {
	const ws = workspace(t, [mod('ok-rows', 'Rows', [method('plain'), method('mixed', { cases: 3 })], { tags: ['Parallel'] })], {
		'lune.parallel.workers': 2,
	});
	const events = [];
	const resolvedMixedAt = [];
	const { report, outcome, output } = await run(ws, {
		hooks: {
			onPlan: (r) => events.push(`plan:${r.blocks.length}`),
			onBlockStart: (block) => events.push(`start:${block.index}`),
			onBlockDone: (block, r) => {
				events.push(`done:${block.index}:${block.status}`);
				if (testsResolvedBy(r, block).some((test) => test.methodName === 'mixed')) {
					resolvedMixedAt.push(block.index);
				}
			},
		},
	});
	assert.equal(outcome.code, 1);
	assert.deepEqual(report.blocks.map((b) => b.label), ['out/ok-rows::plain', 'out/ok-rows::mixed[1]', 'out/ok-rows::mixed[2]', 'out/ok-rows::mixed[3]']);
	assert.deepEqual(verdict(report, 'Rows', 'plain'), { status: 'passed', elapsedMs: 1 });
	const mixed = verdict(report, 'Rows', 'mixed');
	assert.equal(mixed.status, 'failed', 'one failed row fails the method');
	assert.equal(mixed.message, 'mixed (row 2): mixed (row 2) went wrong');
	assert.equal(mixed.elapsedMs, 3);
	assert.equal(events[0], 'plan:4');
	for (let index = 1; index <= 4; index++) {
		assert.ok(events.indexOf(`start:${index}`) > 0 && events.indexOf(`start:${index}`) < events.findIndex((e) => e.startsWith(`done:${index}:`)));
	}
	assert.equal(resolvedMixedAt.length, 1, 'the method resolves exactly once');
	const lastRowDone = Math.max(...[2, 3, 4].map((i) => events.findIndex((e) => e.startsWith(`done:${i}:`))));
	assert.equal(events[lastRowDone], `done:${resolvedMixedAt[0]}:${report.blocks[resolvedMixedAt[0] - 1].status}`, 'and only when its last row block is done');
	assert.match(output, /1 @Tag\("Parallel"\) class\(es\) split into 4 case block\(s\)/);
	assert.equal(new Set([1, 2, 3, 4].map((i) => ws.started(i).pid)).size, 4, 'each case ran in its own process');
});

test('slow tests are left out unless the run is Full or names them, and the report says so', async (t) => {
	const modules = [mod('ok', 'S', [method('quick'), method('sweep', { tags: ['Slow'] })])];
	const everyday = await run(workspace(t, modules), { slow: { tags: ['Slow'] } });
	assert.deepEqual(everyday.report.blocks[0].tests.map((test) => test.methodName), ['quick']);
	assert.equal(everyday.report.slowLeftOut, 1);
	assert.deepEqual(verdict(everyday.report, 'S', 'sweep'), {
		status: 'skipped',
		message: 'slow test left out of this profile: run it with Lune (Full), or run it directly',
	});
	const full = await run(workspace(t, modules));
	assert.deepEqual(full.report.blocks[0].tests.map((test) => test.methodName), ['quick', 'sweep']);
	assert.equal(verdict(full.report, 'S', 'sweep').status, 'passed');
	const allowed = new Map([['S', new Set(['sweep'])]]);
	const explicit = await run(workspace(t, modules), { slow: { tags: ['Slow'], allowed }, selection: [ident('S', 'sweep')] });
	assert.deepEqual(explicit.report.blocks[0].tests.map((test) => test.methodName), ['sweep']);
	assert.equal(verdict(explicit.report, 'S', 'sweep').status, 'passed');
});

test('a selection runs only the named tests and reports what it could not find', async (t) => {
	const ws = workspace(t, [mod('ok', 'A', [method('one'), method('two')]), mod('b/ok', 'B', [method('x')])]);
	const { report } = await run(ws, { selection: [ident('A', 'two'), ident('Missing', 'z')] });
	assert.deepEqual(report.blocks.map((b) => b.label), ['out/ok']);
	assert.deepEqual(report.blocks[0].tests.map((test) => test.methodName), ['two']);
	assert.equal(ws.started(2), undefined);
	assert.match(verdict(report, 'Missing', 'z').message, /no compiled test class named "Missing"/);
	assert.equal(verdict(report, 'A', 'two').status, 'passed');
});

test('an empty plan explains itself', async (t) => {
	const ws = workspace(t, [mod('ok', 'S', [method('sweep', { tags: ['Slow'] })])]);
	const { outcome, output, report } = await run(ws, { slow: { tags: ['Slow'] } });
	assert.equal(outcome.code, 0);
	assert.deepEqual(report.blocks, []);
	assert.match(output, /nothing to run under this profile: 1 slow test\(s\) left out/);
	const none = await run(workspace(t, []));
	assert.match(none.output, /No tests found in "/);
});

test('single-process mode runs every module in one worker, as before parallel blocks', async (t) => {
	const ws = workspace(t, [mod('ok', 'A', [method('t')]), mod('b/ok', 'B', [method('t', { cases: 2 })], { tags: ['Parallel'] }), mod('c/ok', 'C', [method('t')])], {
		'lune.parallel.enabled': false,
	});
	const { report, output } = await run(ws);
	assert.equal(report.singleProcess, true);
	assert.equal(report.blocks.length, 1);
	assert.equal(report.blocks[0].kind, 'all');
	assert.deepEqual(ws.started(1).modules, ['out/ok', 'out/b/ok', 'out/c/ok']);
	assert.match(output, /every module in one Lune process/);
	assert.equal(verdict(report, 'B', 't').status, 'passed');
});

test('concurrent runs keep their generated files apart and clean up after themselves', async (t) => {
	const ws = workspace(t, [mod('sleep-150', 'A', [method('t')]), mod('b/sleep-150', 'B', [method('t')])]);
	const otherLog = path.join(ws.root, 'log2');
	fs.mkdirSync(otherLog);
	const other = { ...ws.config, env: { ...ws.config.env, FAKE_LUNE_LOG: otherLog } };
	const [first, second] = await Promise.all([
		run(ws),
		(async () => {
			let output = '';
			const outcome = await runViaLune(other, new CancelSource().token, (text) => (output += text));
			return { outcome, output };
		})(),
	]);
	assert.equal(first.outcome.code, 0, first.output);
	assert.equal(second.outcome.code, 0, second.output);
	const firstJob = ws.started(1).jobFile;
	const secondJob = JSON.parse(fs.readFileSync(path.join(otherLog, 'start-1'), 'utf8')).jobFile;
	assert.notEqual(path.dirname(firstJob), path.dirname(secondJob), 'each run has its own directory of generated files');
	assert.deepEqual(fs.readdirSync(path.join(ws.storage, 'lune-runs')), []);
});
