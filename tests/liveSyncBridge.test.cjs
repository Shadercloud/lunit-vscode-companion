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
 return {
  bridge,
  poll: async () => (await fetch(url + '/poll')).json(),
  result: async (job, output = 'done') => fetch(url + '/result', {
   method: 'POST', body: JSON.stringify({jobId: job.jobId, output}),
  }),
 };
}
for (const mode of ['cancel', 'timeout']) {
 test(`${mode}: delivered job drains before subsequent run`, async t => {
  const {bridge, poll, result} = await fixture(t);
  const cancel = new CancelSource();
  const promise = bridge.runJob('code', mode === 'timeout' ? 100 : 5000, cancel.token);
  const rejected = assert.rejects(promise, mode === 'timeout' ? /timed out/ : /cancelled/);
  const job = await poll();
  assert.equal(job.code, 'code');
  assert.equal((await poll()).jobId, null);
  if (mode === 'cancel') cancel.cancel();
  await rejected;
  assert.equal(bridge.isPluginConnected, true);
  await assert.rejects(bridge.runJob('next', 5000), /cleanup acknowledgement/);
  await result({jobId: 'unrelated'});
  await assert.rejects(bridge.runJob('next', 5000), /cleanup acknowledgement/);
  await result(job);
  const next = bridge.runJob('next', 5000);
  await result(await poll());
  assert.equal(await next, 'done');
 });
}
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
