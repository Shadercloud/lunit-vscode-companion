const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
	hasSlowTag,
	partitionSlowTests,
	runProfileSpecs,
	slowLeftOutMessage,
	slowTestFilterFor,
} = require('../out/runProfiles');
const { buildConfig } = require('../out/config');

const ids = (settings) => runProfileSpecs(settings).map((spec) => spec.id);

test('the Full profile is registered only when lunit.lune.slowTags names a tag', () => {
	assert.deepEqual(ids({ studioEnabled: true, slowTags: [] }), ['lune', 'studio']);
	assert.deepEqual(ids({ studioEnabled: true, slowTags: ['Slow'] }), ['lune', 'luneFull', 'studio']);
	assert.deepEqual(ids({ studioEnabled: false, slowTags: ['Slow'] }), ['lune', 'luneFull']);

	const specs = runProfileSpecs({ studioEnabled: true, slowTags: ['Slow'] });
	assert.deepEqual(
		specs.map(({ label, via, includeSlow, isDefault }) => ({ label, via, includeSlow, isDefault })),
		[
			{ label: 'Run with Lune', via: 'lune', includeSlow: false, isDefault: true },
			{ label: 'Run with Lune (Full)', via: 'lune', includeSlow: true, isDefault: false },
			{ label: 'Run in Roblox Studio', via: 'studio', includeSlow: false, isDefault: false },
		],
	);
});

test('lunit.lune.slowTags defaults to empty and ignores blank or non-string entries', () => {
	const read = (settings) => buildConfig('/ws', '/storage', (key, fallback) => (key in settings ? settings[key] : fallback));
	assert.deepEqual(read({}).lune.slowTags, []);
	assert.deepEqual(read({ 'lune.slowTags': [' Slow ', '', 3, 'Soak'] }).lune.slowTags, ['Slow', 'Soak']);
	assert.deepEqual(read({ 'lune.slowTags': 'Slow' }).lune.slowTags, []);
	assert.deepEqual(ids({ studioEnabled: true, slowTags: read({ 'lune.slowTags': [''] }).lune.slowTags }), ['lune', 'studio']);
});

test('slow tags match class or method tags case-insensitively', () => {
	assert.equal(hasSlowTag(['Lune', 'SLOW'], ['Slow']), true);
	assert.equal(hasSlowTag(['Lune'], ['Slow']), false);
	assert.equal(hasSlowTag(['Slow'], []), false);
});

const tests = [
	{ id: 'quick', tags: ['Lune'] },
	{ id: 'classSlow', tags: ['Slow', 'Lune'] }, // class-level tag, as effective tags
	{ id: 'methodSlow', tags: ['Lune', 'slow'] },
];
const partition = (includeSlow, explicit = []) =>
	partitionSlowTests(tests, ['Slow'], includeSlow, (t) => ({ tags: t.tags, explicit: explicit.includes(t.id) }));
const idsOf = (items) => items.map((t) => t.id);

test('Run with Lune leaves out slow tests that were not selected directly', () => {
	const result = partition(false);
	assert.deepEqual(idsOf(result.run), ['quick']);
	assert.deepEqual(idsOf(result.leftOut), ['classSlow', 'methodSlow']);
	assert.deepEqual(result.explicitSlow, []);
	assert.equal(slowLeftOutMessage(result.leftOut.length), 'Left out 2 slow test(s): run with Lune (Full).');
});

test('an explicitly selected slow test runs under Run with Lune', () => {
	const result = partition(false, ['methodSlow']);
	assert.deepEqual(idsOf(result.run), ['quick', 'methodSlow']);
	assert.deepEqual(idsOf(result.leftOut), ['classSlow']);
	assert.deepEqual(idsOf(result.explicitSlow), ['methodSlow']);

	const filter = slowTestFilterFor(['Slow'], false, [{ file: 'a.ts', className: 'Sweeps', methodName: 'methodSlow' }]);
	assert.deepEqual(filter.tags, ['Slow']);
	assert.deepEqual([...filter.allowed.get('Sweeps')], ['methodSlow']);
});

test('a class whose only tests are slow leaves nothing to run, without an error', () => {
	const onlySlow = partitionSlowTests(tests.slice(1), ['Slow'], false, (t) => ({ tags: t.tags, explicit: false }));
	assert.deepEqual(onlySlow.run, []);
	assert.equal(onlySlow.leftOut.length, 2);
});

test('Run with Lune (Full), or no slowTags, runs everything and passes no filter to the runner', () => {
	assert.deepEqual(idsOf(partition(true).run), ['quick', 'classSlow', 'methodSlow']);
	assert.deepEqual(partition(true).leftOut, []);
	assert.equal(slowTestFilterFor(['Slow'], true, []), undefined);
	assert.equal(slowTestFilterFor([], false, []), undefined);
	assert.deepEqual(slowTestFilterFor(['Slow'], false, []), { tags: ['Slow'], allowed: undefined });
});
