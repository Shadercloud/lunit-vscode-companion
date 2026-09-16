// Unit coverage for the worker pool (src/luneScheduler.ts): the concurrency
// bound, slot refill, exactly-once scheduling, stopping, and the worker count.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveWorkerCount, runBlocks, DEFAULT_MAX_WORKERS } = require('../out/luneScheduler');

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('bounded workers overlap blocks, refill freed slots immediately, and finish every block once', async () => {
	const blocks = ['long', 'short', 'third', 'fourth'];
	const started = [];
	const completed = [];
	const release = new Map();
	const running = runBlocks(
		blocks,
		2,
		(block) => {
			started.push(block);
			return new Promise((resolve) => release.set(block, resolve));
		},
		(block, index, result) => completed.push([block, index, result]),
	);
	await tick();
	assert.deepEqual(started, ['long', 'short'], 'no more than two blocks run at once');
	release.get('short')('s');
	await tick();
	assert.deepEqual(started, ['long', 'short', 'third'], 'the freed slot takes the next block while the long one still runs');
	assert.deepEqual(completed, [['short', 1, 's']]);
	release.get('third')('t');
	await tick();
	assert.deepEqual(started, blocks);
	release.get('fourth')('f');
	release.get('long')('l');
	await running;
	assert.deepEqual(
		completed.map(([block]) => block).sort(),
		[...blocks].sort(),
	);
	assert.equal(completed.length, blocks.length, 'each block completes exactly once');
});

test('one worker runs blocks one after another in order', async () => {
	let active = 0;
	let peak = 0;
	const completed = [];
	await runBlocks(
		['a', 'b', 'c'],
		1,
		async (block, index) => {
			active += 1;
			peak = Math.max(peak, active);
			await tick();
			active -= 1;
			return `${block}${index}`;
		},
		(_block, _index, result) => completed.push(result),
	);
	assert.equal(peak, 1);
	assert.deepEqual(completed, ['a0', 'b1', 'c2']);
});

test('more workers than blocks never starts more than there are blocks', async () => {
	let active = 0;
	let peak = 0;
	let runs = 0;
	await runBlocks(
		['a', 'b'],
		8,
		async () => {
			runs += 1;
			active += 1;
			peak = Math.max(peak, active);
			await tick();
			active -= 1;
		},
		() => undefined,
	);
	assert.equal(peak, 2);
	assert.equal(runs, 2);
	await runBlocks([], 4, async () => assert.fail('nothing to run'), () => assert.fail('nothing to complete'));
});

test('once stopped, pending blocks never start while running ones still complete', async () => {
	let stop = false;
	const started = [];
	const completed = [];
	const release = new Map();
	const running = runBlocks(
		['a', 'b', 'c', 'd'],
		2,
		(block) => {
			started.push(block);
			return new Promise((resolve) => release.set(block, resolve));
		},
		(block) => completed.push(block),
		() => stop,
	);
	await tick();
	stop = true;
	release.get('a')();
	release.get('b')();
	await running;
	assert.deepEqual(started, ['a', 'b']);
	assert.deepEqual(completed, ['a', 'b']);
});

test('the worker count comes from the override, the setting, then the machine, capped by the block count', () => {
	const count = (input) => resolveWorkerCount({ available: 8, blockCount: 100, configured: 0, ...input });
	assert.equal(count({}), 8, 'automatic: logical CPUs');
	assert.equal(count({ available: 96 }), DEFAULT_MAX_WORKERS, 'automatic never exceeds 32');
	assert.equal(count({ configured: 64, available: 96 }), 64, 'an explicit setting may exceed 32');
	assert.equal(count({ configured: 4, override: 2 }), 2, 'the per-run override wins');
	assert.equal(count({ configured: 4, override: 0 }), 4, 'a zero override means no override');
	assert.equal(count({ configured: 64, blockCount: 5 }), 5, 'never more workers than blocks');
	assert.equal(count({ blockCount: 0 }), 1);
	assert.equal(count({ configured: 1 }), 1);
	assert.equal(count({ configured: 2.9 }), 2);
	assert.equal(count({ configured: -3, available: 0 }), 1, 'nonsense settings fall back to at least one worker');
	assert.equal(count({ override: Number.NaN, configured: 3 }), 3);
});
