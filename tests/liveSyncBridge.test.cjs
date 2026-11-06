const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LiveSyncBridge } = require('../out/liveSyncBridge');
const { CancelSource } = require('../out/cancelSignal');
const { once } = require('node:events');
const { discoverBridges, matchingBridges } = require('../out/bridgeDiscovery');
const path = require('node:path');

async function fixture(t) {
 const bridge = new LiveSyncBridge(0);
 bridge.start();
 await new Promise(resolve => bridge.server.on('listening', resolve));
 const url = `http://127.0.0.1:${bridge.server.address().port}`;
 t.after(() => { bridge.server.closeAllConnections(); bridge.stop(); });
 const session = s => (s ? `?session=${s}` : '');
 return {
  bridge,
  url,
  poll: async s => (await fetch(url + '/poll' + session(s))).json(),
  heartbeat: async (job, s) => (await fetch(`${url}/heartbeat?jobId=${job.jobId}${s ? `&session=${s}` : ''}`)).json(),
  cancelAll: async () => (await fetch(url + '/cancel', {method: 'POST'})).json(),
  result: async (job, output = 'done') => fetch(url + '/result', {
   method: 'POST', body: JSON.stringify({jobId: job.jobId, output}),
  }),
 };
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// A Studio job that never returns (a hung require) must never hold the lock:
// however the wait ends, the next run starts at once, and the plugin is told
// to abandon the old job.
for (const mode of ['cancel', 'timeout']) {
 test(`${mode}: a hung delivered job releases the lock at once`, async t => {
  const {bridge, poll, heartbeat, result} = await fixture(t);
  const cancel = new CancelSource();
  const promise = bridge.runJob('code', mode === 'timeout' ? 100 : 5000, cancel.token);
  const rejected = assert.rejects(promise, mode === 'timeout' ? /timed out.*released/ : /cancelled/);
  const job = await poll('studio');
  assert.equal(job.code, 'code');
  assert.equal((await poll('studio')).jobId, null);
  assert.deepEqual(await heartbeat(job, 'studio'), {active: true});
  if (mode === 'cancel') cancel.cancel();
  await rejected;
  assert.equal(bridge.hasActiveJob, false);
  assert.deepEqual(await heartbeat(job, 'studio'), {active: false}, 'the plugin must learn to abandon the job');
  const next = bridge.runJob('next', 5000);
  // A late result for the abandoned job is ignored, not taken as the next one's.
  await result(job, 'stale');
  const delivered = await poll('studio');
  assert.equal(delivered.code, 'next');
  await result(delivered);
  assert.equal(await next, 'done');
 });
}

test('a run started while another is held is refused with a way out', async t => {
 const {bridge, poll} = await fixture(t);
 const first = bridge.runJob('code', 5000);
 const firstRejected = assert.rejects(first, /cancelled and released/);
 await poll('studio');
 await assert.rejects(bridge.runJob('next', 5000), /lunit-cli --cancel/);
 bridge.abandonCurrentJob('cancelled and released');
 await firstRejected;
});

test('POST /cancel (lunit-cli --cancel) releases a hung job and the next run starts cleanly', async t => {
 const {bridge, poll, cancelAll, heartbeat, result} = await fixture(t);
 const hung = bridge.runJob('hung', 5000);
 const rejected = assert.rejects(hung, /lunit-cli --cancel/);
 const job = await poll('studio');
 assert.deepEqual(await cancelAll(), {releasedJob: true, cancelledRuns: 0});
 await rejected;
 assert.deepEqual(await heartbeat(job, 'studio'), {active: false});
 assert.deepEqual(await cancelAll(), {releasedJob: false, cancelledRuns: 0});
 const next = bridge.runJob('next', 5000);
 await result(await poll('studio'));
 assert.equal(await next, 'done');
});

test('POST /cancel also cancels a CLI run waiting on a hung job', async t => {
 const {bridge, url, poll, cancelAll} = await fixture(t);
 let seenCancel = false;
 bridge.runHandler = async (request, onOutput, cancel) => {
  cancel.onCancellationRequested(() => { seenCancel = true; });
  try {
   await bridge.runJob('hung', 5000, cancel);
  } catch (err) {
   return {via: 'studio', cancelled: true, tests: [], counts: {passed: 0, failed: 0, skipped: 0, errored: 0}, error: String(err)};
  }
 };
 const response = fetch(url + '/run', {method: 'POST', body: JSON.stringify({cwd: '/x', via: 'studio', filters: []})});
 while (!bridge.hasActiveJob) await sleep(5);
 await poll('studio');
 assert.deepEqual(await cancelAll(), {releasedJob: true, cancelledRuns: 1});
 assert.equal(seenCancel, true);
 assert.equal(bridge.hasActiveJob, false);
 assert.match(await (await response).text(), /@@LUNIT_SUMMARY@@/);
});

test('a Studio restart (new plugin session) releases a job the old session held', async t => {
 const {bridge, poll, result} = await fixture(t);
 const held = bridge.runJob('code', 30000);
 const rejected = assert.rejects(held, /new plugin session/);
 await poll('old-studio');
 // The new session polls while the old one is still heartbeating: a second
 // Studio on the same window, not a restart -- the job stays.
 await poll('new-studio');
 assert.equal(bridge.hasActiveJob, true);
 await sleep(2700);
 // The old session has gone quiet; the new session's poll releases it.
 const afterRestart = await poll('new-studio');
 assert.equal(afterRestart.jobId, null);
 await rejected;
 const next = bridge.runJob('next', 5000);
 const delivered = await poll('new-studio');
 assert.equal(delivered.code, 'next');
 await result(delivered);
 assert.equal(await next, 'done');
});

test('a delivered job whose Studio stops sending heartbeats is released', async t => {
 const {bridge, poll, heartbeat, result} = await fixture(t);
 bridge.heartbeatTimeoutMs = 150;
 const kept = bridge.runJob('busy', 5000);
 const job = await poll('studio');
 for (let i = 0; i < 6; i++) {
  await sleep(50);
  assert.deepEqual(await heartbeat(job, 'studio'), {active: true}, 'heartbeats keep a long job alive');
 }
 await result(job);
 assert.equal(await kept, 'done');
 const lost = bridge.runJob('lost', 5000);
 const rejected = assert.rejects(lost, /stopped responding/);
 await poll('studio');
 await rejected;
 assert.equal(bridge.hasActiveJob, false);
 // An old plugin (no session id) is never timed out by heartbeat.
 const legacy = bridge.runJob('legacy', 5000);
 const legacyJob = await poll();
 await sleep(300);
 assert.equal(bridge.hasActiveJob, true);
 await result(legacyJob);
 assert.equal(await legacy, 'done');
});
test('pre-cancelled and undelivered jobs never execute', async t => {
 const {bridge, poll} = await fixture(t);
 const cancel = new CancelSource();
 cancel.cancel();
 await assert.rejects(bridge.runJob('code', 5000, cancel.token), /cancelled/);
 const pending = new CancelSource();
 const promise = bridge.runJob('code', 5000, pending.token);
 pending.cancel();
 await assert.rejects(promise, /cancelled/);
 assert.equal((await poll()).jobId, null);
 await assert.rejects(bridge.runJob('code', 5), /timed out/);
 assert.equal((await poll()).jobId, null);
});

test('port conflict is reported once and recovers when the owner releases the port', async t => {
 const {bridge: owner} = await fixture(t);
 const port = owner.server.address().port;
 const errors = [];
 const bridge = new LiveSyncBridge(port, err => errors.push(err), 20);
 t.after(() => bridge.stop());
 bridge.start();
 await once(bridge.server, 'error');
 assert.equal(bridge.isPluginConnected, false);
 assert.match(bridge.connectionError, new RegExp(`Port ${port} is already in use`));
 await once(bridge.server, 'error');
 assert.equal(errors.length, 1, 'retries must not flood the output log');
 const recovered = once(bridge.server, 'listening');
 const released = once(owner.server, 'close');
 owner.server.close();
 await released;
 await recovered;
 assert.equal(bridge.connectionError, undefined);
 assert.equal(bridge.isPluginConnected, false, 'listening alone is not a Studio heartbeat');
 await fetch(`http://127.0.0.1:${port}/poll`);
 assert.equal(bridge.isPluginConnected, true);
 bridge.server.closeAllConnections();
 bridge.stop();
 assert.equal(bridge.isPluginConnected, false);
});

test('stopping a bridge cancels port-conflict retries', async t => {
 const {bridge: owner} = await fixture(t);
 const bridge = new LiveSyncBridge(owner.server.address().port, undefined, 20);
 t.after(() => bridge.stop());
 bridge.start();
 const server = bridge.server;
 await once(server, 'error');
 bridge.stop();
 assert.equal(bridge.retryTimer, undefined);
 await new Promise(resolve => setTimeout(resolve, 60));
 assert.equal(server.listening, false);
 assert.equal(bridge.connectionError, undefined);
});

test('two windows are discoverable without heartbeats and only the selected window gets jobs', async t => {
 const {bridge: owner} = await fixture(t);
 const basePort = owner.server.address().port;
 const root = path.resolve('example-project');
 const second = new LiveSyncBridge(basePort, undefined, 0, [{name: 'Project', path: root}]);
 second.runHandler = async () => { throw new Error('discovery must not execute tests'); };
 t.after(() => { second.server?.closeAllConnections(); second.stop(); });
 second.start();
 // Port allocation handles expected EADDRINUSE events internally.
 await new Promise(resolve => second.server.on('listening', resolve));
 const bridges = await discoverBridges(basePort);
 assert.equal(bridges.length >= 2, true);
 const target = matchingBridges(bridges, path.join(root, 'src'))[0];
 assert.ok(target);
 assert.notEqual(target.port, basePort);
 assert.equal(owner.isPluginConnected, false);
 assert.equal(second.isPluginConnected, false);
 const url = `http://127.0.0.1:${target.port}`;
 const stale = await fetch(url + '/poll?instanceId=closed-window');
 assert.equal(stale.status, 409);
 assert.equal(second.isPluginConnected, false);
 const jobPromise = second.runJob('selected code', 5000);
 const query = `?instanceId=${target.instanceId}`;
 const job = await (await fetch(url + '/poll' + query)).json();
 assert.equal(job.code, 'selected code');
 assert.equal(owner.isPluginConnected, false);
 assert.equal(second.isPluginConnected, true);
 await fetch(url + '/result' + query, {method: 'POST', body: JSON.stringify({jobId: job.jobId, output: 'selected result'})});
 assert.equal(await jobPromise, 'selected result');
 assert.equal((await fetch(url + '/run?instanceId=closed-window', {method:'POST'})).status, 409);
});

test('CLI prefers the most specific workspace and exposes duplicate-window ambiguity', () => {
 const root = path.resolve('projects');
 const bridge = (port, dir) => ({port, instanceId: String(port), acceptsRuns: true, workspaces:[{name:'Project', path:dir}]});
 const parent = bridge(1, root);
 const child = bridge(2, path.join(root, 'game'));
 assert.deepEqual(matchingBridges([parent, child], path.join(root, 'game', 'src')), [child]);
 assert.deepEqual(matchingBridges([child], path.join(root, 'game-other')), []);
 const duplicate = bridge(3, path.join(root, 'game'));
 assert.deepEqual(matchingBridges([child, duplicate], path.join(root, 'game')), [child, duplicate]);
});
