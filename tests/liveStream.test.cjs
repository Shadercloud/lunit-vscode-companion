// End to end through runViaStudio and the bridge, with a fake Studio plugin:
// streamed results reach the caller while the run is still going, a
// cancelled run has already delivered them, and the final report agrees.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LiveSyncBridge } = require('../out/liveSyncBridge');
const { CancelSource } = require('../out/cancelSignal');
const { buildConfig } = require('../out/config');
const { runViaStudio } = require('../out/studioRunner');
const { LiveResults } = require('../out/liveResults');
const { LIVE_RESULT_MARKER, LIVE_START_MARKER, RESULT_MARKER, parseResultLines } = require('../out/resultProtocol');
const { resolveVerdict } = require('../out/runReport');

const b64 = text => Buffer.from(text).toString('base64');
const result = (marker, cls, label, status) => `${marker}${b64(cls)}\t${b64(label)}\t${status}\t2\t`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const workspace = path.join(__dirname, 'fixtures', 'gameStudio');

async function setup(t) {
 const bridge = new LiveSyncBridge(0);
 bridge.start();
 await new Promise(resolve => bridge.server.on('listening', resolve));
 const url = `http://127.0.0.1:${bridge.server.address().port}`;
 t.after(() => { bridge.server.closeAllConnections(); bridge.stop(); });
 const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'lunit-live-'));
 t.after(() => fs.rmSync(storage, { recursive: true, force: true }));
 const settings = { skipCompile: true, 'studio.liveSync.syncDelaySeconds': 0 };
 const config = buildConfig(workspace, storage, (key, fallback) => (key in settings ? settings[key] : fallback));
 const plugin = {
  poll: async () => (await fetch(`${url}/poll?session=studio`)).json(),
  heartbeat: (job, lines) => fetch(`${url}/heartbeat?jobId=${job.jobId}&session=studio`, {
   method: 'POST', body: JSON.stringify({ jobId: job.jobId, phase: 'tests', lines }),
  }),
  finish: (job, output) => fetch(`${url}/result`, { method: 'POST', body: JSON.stringify({ jobId: job.jobId, output }) }),
 };
 await plugin.poll(); // the plugin is connected before the run starts
 return { bridge, config, plugin };
}

async function nextJob(plugin) {
 for (;;) {
  const job = await plugin.poll();
  if (job.jobId) return job;
  await sleep(20);
 }
}

const tests = [
 { file: path.join(workspace, 'tests', 'shared', 'math.test.ts'), className: 'MathTests', methodName: 'adds' },
 { file: path.join(workspace, 'tests', 'shared', 'math.test.ts'), className: 'MathTests', methodName: 'sums' },
 { file: path.join(workspace, 'tests', 'shared', 'math.test.ts'), className: 'MathTests', methodName: 'never' },
];

test('streamed results reach the caller before the run ends, and reconcile with the final report', async t => {
 const { bridge, config, plugin } = await setup(t);
 const live = new LiveResults(tests);
 const shown = [];
 let ended = false;
 const run = runViaStudio(config, new CancelSource().token, () => {}, bridge, undefined, undefined, undefined, {
  event: event => { for (const update of live.apply(event)) shown.push({ ...update, ended }); },
 }).then(outcome => { ended = true; return outcome; });
 const job = await nextJob(plugin);
 await plugin.heartbeat(job, [
  `${LIVE_START_MARKER}${b64('MathTests')}\t${b64('adds')}`,
  result(LIVE_RESULT_MARKER, 'MathTests', 'adds', 'passed'),
  result(LIVE_RESULT_MARKER, 'MathTests', 'sums (1, 2)', 'passed'),
  '[lunit] an ordinary log line',
 ]);
 assert.equal(ended, false);
 assert.deepEqual(shown.map(u => [u.kind, tests[u.index].methodName, u.verdict?.status]), [
  ['started', 'adds', undefined], ['verdict', 'adds', 'passed'], ['verdict', 'sums', 'passed'],
 ]);
 assert.ok(shown.every(update => update.ended === false), 'every update arrived while the run was going');
 const finalOutput = [
  result(RESULT_MARKER, 'MathTests', 'adds', 'passed'),
  result(RESULT_MARKER, 'MathTests', 'sums (1, 2)', 'passed'),
  result(RESULT_MARKER, 'MathTests', 'never', 'passed'),
 ].join('\n');
 await plugin.finish(job, finalOutput);
 const outcome = await run;
 const records = parseResultLines(outcome.output);
 const settled = tests.map((identity, index) => live.reconcile(index, records, resolveVerdict(identity, records, outcome)));
 assert.deepEqual(settled.map(s => [s.verdict.status, s.report]), [['passed', false], ['passed', false], ['passed', true]],
  'streamed results are not reported twice; the one never streamed is reported now');
});

test('a cancelled run has already delivered the results that streamed', async t => {
 const { bridge, config, plugin } = await setup(t);
 const live = new LiveResults(tests);
 const cancel = new CancelSource();
 const run = runViaStudio(config, cancel.token, () => {}, bridge, undefined, undefined, undefined, { event: event => live.apply(event) });
 const job = await nextJob(plugin);
 await plugin.heartbeat(job, [result(LIVE_RESULT_MARKER, 'MathTests', 'adds', 'failed')]);
 cancel.cancel();
 const outcome = await run;
 assert.equal(outcome.cancelled, true);
 const kept = live.reconcile(0, [], { status: 'skipped' });
 assert.deepEqual([kept.verdict.status, kept.report], ['failed', false], 'the streamed failure stands');
 assert.equal(live.reconcile(1, [], { status: 'skipped' }).verdict.status, 'skipped');
 assert.equal(bridge.hasActiveJob, false);
});

test('a run released partway keeps the streamed results and errors only the rest, with the reason', async t => {
 const { bridge, config, plugin } = await setup(t);
 bridge.heartbeatTimeoutMs = 100;
 bridge.studioRunning = async () => false;
 const live = new LiveResults(tests);
 const run = runViaStudio(config, new CancelSource().token, () => {}, bridge, undefined, undefined, undefined, { event: event => live.apply(event) });
 const job = await nextJob(plugin);
 await plugin.heartbeat(job, [result(LIVE_RESULT_MARKER, 'MathTests', 'adds', 'passed')]);
 const outcome = await run;
 assert.match(outcome.unfinishedMessage, /Roblox Studio stopped running/);
 const records = parseResultLines(outcome.output);
 const verdicts = tests.map((identity, index) => live.reconcile(index, records, resolveVerdict(identity, records, outcome)).verdict);
 assert.equal(verdicts[0].status, 'passed');
 assert.deepEqual(verdicts[1], { status: 'errored', message: outcome.unfinishedMessage });
});
