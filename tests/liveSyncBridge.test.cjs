const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LiveSyncBridge } = require('../out/liveSyncBridge');
const { CancelSource } = require('../out/cancelSignal');

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
