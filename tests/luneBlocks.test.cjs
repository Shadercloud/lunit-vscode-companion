// Unit coverage for the parallel Lune planner (src/luneBlocks.ts): block
// shapes, @Tag("Parallel") splitting and rejection, dependency groups, the
// selection mapping, the slow/tag rules and @Only, all from synthetic module
// listings -- no Lune needed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
	matchDependencyMember,
	parallelIncompatibilities,
	planLuneRun,
	PlanError,
	resolveDependencyGroups,
} = require('../out/luneBlocks');
const { buildTestSelection } = require('../out/luauTestFilterTemplate');

const method = (name, extra = {}) => ({
	name,
	isTest: true,
	tags: [],
	lifecycles: [],
	ordered: false,
	only: false,
	disabled: false,
	...extra,
});
const hook = (name, ...lifecycles) => ({ ...method(name), isTest: false, lifecycles });
const mod = (path, className, methods, cls = {}) => ({
	path,
	class: { className, tags: [], disabled: false, methods, ...cls },
});
const listing = (modules, extra = {}) => ({ modules, loadFailures: [], excludedModules: [], ...extra });
const ident = (className, methodName, file = `/src/${className}.test.ts`) => ({ file, className, methodName });
const labels = (plan) => plan.blocks.map((block) => block.label);
const specMethods = (block, i = 0) => Object.keys(block.modules[i].spec.methods ?? {}).sort();
const unscheduledOf = (plan, className, methodName) =>
	plan.unscheduled.find((entry) => entry.test.className === className && entry.test.methodName === methodName);

test('an ordinary module is one block listing its test methods, never its hooks', () => {
	const plan = planLuneRun({
		listing: listing([
			mod('out/a.test', 'A', [method('one'), hook('setUp', 'BeforeEach'), method('two'), hook('all', 'BeforeAll')]),
			mod('out/b.test', 'B', [method('only')]),
		]),
	});
	assert.deepEqual(labels(plan), ['out/a.test', 'out/b.test']);
	assert.equal(plan.blocks[0].kind, 'module');
	assert.deepEqual(specMethods(plan.blocks[0]), ['one', 'two']);
	assert.deepEqual(plan.blocks[0].modules[0], {
		path: 'out/a.test',
		className: 'A',
		spec: { methods: { one: true, two: true } },
	});
	assert.deepEqual(
		plan.blocks[0].tests,
		[
			{ className: 'A', methodName: 'one', modulePath: 'out/a.test' },
			{ className: 'A', methodName: 'two', modulePath: 'out/a.test' },
		],
	);
	assert.deepEqual(plan.unscheduled, []);
	assert.equal(plan.counts.testModules, 2);
	// A module with no tests makes no block.
	const empty = planLuneRun({ listing: listing([mod('out/helper.test', 'Helper', [hook('x', 'BeforeEach')])]) });
	assert.deepEqual(empty.blocks, []);
});

test('a Parallel class gets one block per method and per @Each row', () => {
	const plan = planLuneRun({
		listing: listing([
			mod('out/p.test', 'P', [method('plain'), method('rows', { cases: 3 }), hook('setUp', 'BeforeEach'), method('empty', { cases: 0 })], {
				tags: ['parallel'],
			}),
		]),
	});
	// Listing order (the worker lists methods by name); a row per block.
	assert.deepEqual(labels(plan), ['out/p.test::plain', 'out/p.test::rows[1]', 'out/p.test::rows[2]', 'out/p.test::rows[3]', 'out/p.test::empty']);
	assert.ok(plan.blocks.every((block) => block.kind === 'case'));
	assert.deepEqual(plan.blocks[1].modules[0].spec, { methods: { rows: 1 } });
	assert.deepEqual(plan.blocks[3].tests, [{ className: 'P', methodName: 'rows', modulePath: 'out/p.test', caseIndex: 3 }]);
	assert.deepEqual(plan.blocks[0].tests, [{ className: 'P', methodName: 'plain', modulePath: 'out/p.test' }]);
	assert.deepEqual(plan.blocks[4].modules[0].spec, { methods: { empty: true } }, 'an empty @Each is one plain block');
	assert.equal(plan.counts.parallelClasses, 1);
	assert.equal(plan.counts.caseBlocks, 5);
	assert.equal(plan.blocks.map((b) => b.index).join(','), '1,2,3,4,5');
});

test('a Parallel class that cannot be split is rejected with a diagnostic naming why', () => {
	const cls = {
		className: 'Bad',
		tags: ['Parallel'],
		disabled: false,
		methods: [hook('setUpAll', 'BeforeAll'), method('first', { ordered: true }), method('both', { lifecycles: ['AfterEach'] }), method('fine')],
	};
	const reasons = parallelIncompatibilities(cls);
	assert.equal(reasons.length, 3);
	assert.match(reasons[0], /@BeforeAll\/@AfterAll hook\(s\) setUpAll/);
	assert.match(reasons[1], /ordered method\(s\) first/);
	assert.match(reasons[2], /method\(s\) both that are both a @Test and a lifecycle hook/);
	assert.deepEqual(parallelIncompatibilities({ ...cls, methods: [method('a', { cases: 2 }), hook('each', 'BeforeEach', 'AfterEach')] }), []);

	const plan = planLuneRun({ listing: listing([{ path: 'out/bad.test', class: cls }, mod('out/ok.test', 'Ok', [method('t')])]) });
	assert.deepEqual(labels(plan), ['out/ok.test'], 'the rejected class runs nowhere');
	for (const name of ['first', 'both', 'fine']) {
		const entry = unscheduledOf(plan, 'Bad', name);
		assert.equal(entry.status, 'errored');
		assert.match(entry.reason, /@Tag\("Parallel"\) on class Bad \(out\/bad.test\) cannot be honoured: .*setUpAll.*; ordered method\(s\) first.*; method\(s\) both/);
	}
	assert.equal(plan.notes.length, 1);
	assert.match(plan.notes[0], /cannot be honoured/);
	assert.equal(plan.counts.parallelClasses, 0);
});

test('a disabled Parallel class is not split, and the tag is matched case-insensitively', () => {
	const plan = planLuneRun({
		listing: listing([
			mod('out/d.test', 'D', [method('a', { cases: 2 }), method('b')], { tags: ['PARALLEL'], disabled: true }),
			mod('out/e.test', 'E', [method('a', { cases: 2 })], { tags: ['PARALLEL'] }),
		]),
	});
	assert.deepEqual(labels(plan), ['out/d.test', 'out/e.test::a[1]', 'out/e.test::a[2]']);
});

test('dependency groups share one block in prerequisite order and override case splitting', () => {
	const plan = planLuneRun({
		listing: listing([
			mod('out/consumer.test', 'Consumer', [method('uses')]),
			mod('out/other.test', 'Other', [method('x')]),
			mod('out/setup.test', 'Setup', [method('a', { cases: 2 }), method('b')], { tags: ['Parallel'] }),
		]),
		dependencyGroups: [['setup.test', 'consumer.test']],
	});
	assert.deepEqual(labels(plan), ['out/setup.test -> out/consumer.test', 'out/other.test']);
	const group = plan.blocks[0];
	assert.equal(group.kind, 'group');
	assert.deepEqual(
		group.modules.map((m) => m.path),
		['out/setup.test', 'out/consumer.test'],
	);
	assert.deepEqual(specMethods(group, 0), ['a', 'b'], 'a grouped Parallel class runs whole, rows and all');
	assert.deepEqual(group.tests.map((t) => `${t.className}.${t.methodName}`), ['Setup.a', 'Setup.b', 'Consumer.uses']);
	assert.equal(plan.counts.parallelClasses, 0);
});

test('dependency group members are matched exactly, by trailing segments, or by source path', () => {
	const names = ['out/tests/a/setup.test', 'out/tests/b/setup.test', 'out/tests/consumer.test', 'ReplicatedStorage.Tests.Game.world.test'];
	assert.deepEqual(matchDependencyMember('out/tests/consumer.test', names), { match: 'out/tests/consumer.test' });
	assert.deepEqual(matchDependencyMember('consumer.test', names), { match: 'out/tests/consumer.test' });
	assert.deepEqual(matchDependencyMember('src/tests/consumer.test.ts', names), { match: 'out/tests/consumer.test' });
	assert.deepEqual(matchDependencyMember('tests\\consumer.test.tsx', names), { match: 'out/tests/consumer.test' });
	assert.deepEqual(matchDependencyMember('a/setup.test', names), { match: 'out/tests/a/setup.test' });
	assert.deepEqual(matchDependencyMember('setup.test', names), { ambiguous: ['out/tests/a/setup.test', 'out/tests/b/setup.test'] });
	assert.deepEqual(matchDependencyMember('tests/game/world.test.ts', names), { match: 'ReplicatedStorage.Tests.Game.world.test' });
	assert.deepEqual(matchDependencyMember('Game.world.test', names), { match: 'ReplicatedStorage.Tests.Game.world.test' });
	assert.deepEqual(matchDependencyMember('missing.test', names), {});
	assert.deepEqual(matchDependencyMember('test', names), {}, 'a bare extension never matches');
	assert.deepEqual(matchDependencyMember('  ', names), {});
});

test('invalid dependency groups fail before scheduling instead of dropping coverage', () => {
	const known = ['out/a.test', 'out/b.test', 'out/x/c.test', 'out/y/c.test'];
	const id = (name) => name;
	assert.throws(() => resolveDependencyGroups([['a.test', 'missing.test']], known, id), (err) => err instanceof PlanError && /no test module matches "missing.test"\. Modules found: out\/a.test, out\/b.test/.test(err.message));
	assert.throws(() => resolveDependencyGroups([['a.test', 'c.test']], known, id), /"c.test" matches several test modules \(out\/x\/c.test, out\/y\/c.test\)/);
	assert.throws(() => resolveDependencyGroups([['a.test', 'a.test']], known, id), /listed twice in group 1/);
	assert.throws(() => resolveDependencyGroups([['a.test', 'b.test'], ['x/c.test', 'b.test']], known, id), /belongs to groups 1 and 2/);
	assert.throws(() => resolveDependencyGroups([['a.test']], known, id), /needs at least two modules/);
	assert.throws(() => resolveDependencyGroups([['a.test', '']], known, id), /needs at least two modules/);
	assert.throws(() => resolveDependencyGroups(['a.test'], known, id), /must be an array of module names/);
	assert.deepEqual(resolveDependencyGroups(undefined, known, id), []);
	assert.deepEqual(resolveDependencyGroups([['b.test', 'out/a.test']], known, id), [
		{ members: ['out/b.test', 'out/a.test'], label: 'out/b.test -> out/a.test' },
	]);
	// Through the planner: a PlanError, nothing scheduled.
	assert.throws(
		() => planLuneRun({ listing: listing([mod('out/a.test', 'A', [method('t')])]), dependencyGroups: [['a.test', 'nope']] }),
		PlanError,
	);
});

test('a selection names its tests, and unknown classes or methods are explicit errors', () => {
	const plan = planLuneRun({
		listing: listing([
			mod('out/a.test', 'A', [method('one'), method('two')]),
			mod('out/b.test', 'B', [method('x')]),
		], { loadFailures: [{ path: 'out/broken.test', error: 'blew up' }] }),
		selection: [ident('A', 'two'), ident('Missing', 'x'), ident('A', 'gone'), ident('Broken', 'x', '/src/broken.test.ts')],
	});
	assert.deepEqual(labels(plan), ['out/a.test']);
	assert.deepEqual(specMethods(plan.blocks[0]), ['two']);
	assert.match(unscheduledOf(plan, 'Missing', 'x').reason, /no compiled test class named "Missing"/);
	assert.equal(unscheduledOf(plan, 'Missing', 'x').status, 'errored');
	assert.match(unscheduledOf(plan, 'A', 'gone').reason, /has no @Test method named "gone"/);
	assert.match(unscheduledOf(plan, 'Broken', 'x').reason, /out\/broken.test failed to load: blew up/);
});

test('a class name defined in two modules is told apart by the source file name', () => {
	const modules = [
		mod('out/a/Util.test', 'Util', [method('t')]),
		mod('out/b/Util.test', 'Util', [method('t')]),
		mod('ReplicatedStorage.Tests.C.Util.test', 'Util', [method('t')]),
	];
	const one = planLuneRun({ listing: listing(modules), selection: [ident('Util', 't', '/src/b/Util.test.ts')] });
	assert.deepEqual(labels(one), ['out/b/Util.test']);
	const game = planLuneRun({ listing: listing(modules), selection: [ident('Util', 't', '/ws/tests/c/Util.test.ts')] });
	assert.deepEqual(labels(game), ['ReplicatedStorage.Tests.C.Util.test'], 'DataModel names match a source path case-insensitively');
	const both = planLuneRun({ listing: listing(modules), selection: [ident('Util', 't', '/src/z/Util.test.ts')] });
	assert.deepEqual(labels(both), ['out/a/Util.test', 'out/b/Util.test', 'ReplicatedStorage.Tests.C.Util.test'], 'no tiebreak: every candidate runs');
});

test('selecting a test in a dependency group runs its prerequisites in full and says so', () => {
	const modules = [
		mod('out/a.test', 'A', [method('a1'), method('a2')]),
		mod('out/b.test', 'B', [method('b1'), method('b2')]),
		mod('out/c.test', 'C', [method('c1')]),
		mod('out/solo.test', 'Solo', [method('s')]),
	];
	const groups = [['a.test', 'b.test', 'c.test']];
	const plan = planLuneRun({ listing: listing(modules), dependencyGroups: groups, selection: [ident('B', 'b2')] });
	assert.deepEqual(labels(plan), ['out/a.test -> out/b.test']);
	assert.deepEqual(specMethods(plan.blocks[0], 0), ['a1', 'a2'], 'the prerequisite runs in full');
	assert.deepEqual(specMethods(plan.blocks[0], 1), ['b2'], 'the selected module runs the selection');
	assert.deepEqual(plan.blocks[0].tests.map((t) => t.methodName), ['a1', 'a2', 'b2']);
	assert.deepEqual(plan.notes, [
		'[lunit] dependency group out/a.test -> out/b.test -> out/c.test: out/a.test run in full before the selected tests in out/b.test, in the same Lune process.',
	]);
	// Selecting the first member alone needs no closure and no note.
	const first = planLuneRun({ listing: listing(modules), dependencyGroups: groups, selection: [ident('A', 'a2'), ident('Solo', 's')] });
	assert.deepEqual(labels(first), ['out/a.test', 'out/solo.test']);
	assert.deepEqual(specMethods(first.blocks[0]), ['a2']);
	assert.deepEqual(first.notes, []);
	// Two selected members: everything up to the last one, the earlier one in full.
	const two = planLuneRun({ listing: listing(modules), dependencyGroups: groups, selection: [ident('A', 'a2'), ident('C', 'c1')] });
	assert.deepEqual(two.blocks[0].modules.map((m) => m.path), ['out/a.test', 'out/b.test', 'out/c.test']);
	assert.deepEqual(specMethods(two.blocks[0], 0), ['a1', 'a2']);
	assert.deepEqual(specMethods(two.blocks[0], 1), ['b1', 'b2']);
	assert.deepEqual(specMethods(two.blocks[0], 2), ['c1']);
	// A run-all keeps the whole group.
	const all = planLuneRun({ listing: listing(modules), dependencyGroups: groups });
	assert.deepEqual(labels(all), ['out/a.test -> out/b.test -> out/c.test', 'out/solo.test']);
	assert.deepEqual(all.notes, []);
});

test('the slow rule leaves slow tests out unless the run is Full or names them directly', () => {
	const modules = [
		mod('out/s.test', 'S', [method('quick'), method('sweep', { tags: ['slow'] }), method('rows', { cases: 2, tags: ['Slow'] })], { tags: ['Parallel'] }),
		mod('out/c.test', 'C', [method('a'), method('b')], { tags: ['SLOW'] }),
	];
	const everyday = planLuneRun({ listing: listing(modules), slow: { tags: ['Slow'] } });
	assert.deepEqual(labels(everyday), ['out/s.test::quick']);
	assert.equal(everyday.counts.slowLeftOut, 4);
	assert.equal(unscheduledOf(everyday, 'C', 'a').status, 'skipped');
	assert.match(unscheduledOf(everyday, 'S', 'rows').reason, /slow test left out/);
	const explicit = planLuneRun({
		listing: listing(modules),
		slow: { tags: ['Slow'], allowed: buildTestSelection([ident('S', 'rows'), ident('C', 'b')]) },
		selection: [ident('S', 'rows'), ident('C', 'b')],
	});
	assert.deepEqual(labels(explicit), ['out/s.test::rows[1]', 'out/s.test::rows[2]', 'out/c.test']);
	assert.deepEqual(specMethods(explicit.blocks[2]), ['b']);
	assert.equal(explicit.counts.slowLeftOut, 0);
	const full = planLuneRun({ listing: listing(modules) });
	assert.deepEqual(labels(full), ['out/s.test::quick', 'out/s.test::sweep', 'out/s.test::rows[1]', 'out/s.test::rows[2]', 'out/c.test']);
	assert.equal(full.counts.slowLeftOut, 0);
});

test("the profile's excluded tag leaves classes and methods out, counted for the closing note", () => {
	const modules = [
		mod('out/t.test', 'T', [method('engine', { tags: ['studio'] }), method('pure')]),
		mod('out/u.test', 'U', [method('a')], { tags: ['Studio'] }),
		mod('out/v.test', 'V', [method('a')]),
	];
	const plan = planLuneRun({ listing: listing(modules, { excludedModules: ['out/w.test'] }), excludedTag: 'Studio' });
	assert.deepEqual(labels(plan), ['out/t.test', 'out/v.test']);
	assert.deepEqual(specMethods(plan.blocks[0]), ['pure']);
	assert.equal(plan.counts.excludedClasses, 2, 'the source-tagged module and the metadata-tagged class');
	assert.equal(plan.counts.excludedTests, 1);
	assert.equal(unscheduledOf(plan, 'U', 'a').status, 'skipped');
	assert.match(unscheduledOf(plan, 'T', 'engine').reason, /tagged "Studio"/);
	// The package runner applies no tag rule.
	const none = planLuneRun({ listing: listing(modules) });
	assert.deepEqual(specMethods(none.blocks[0]), ['engine', 'pure']);
	assert.equal(none.blocks.length, 3);
	// Selecting only excluded tests counts them once, for that selection.
	const selected = planLuneRun({ listing: listing(modules), excludedTag: 'Studio', selection: [ident('T', 'engine'), ident('V', 'a')] });
	assert.deepEqual(labels(selected), ['out/v.test']);
	assert.equal(selected.counts.excludedTests, 1);
	assert.equal(selected.counts.excludedClasses, 0);
});

test('@Only focuses a class in a run-all, and a selection decides for itself', () => {
	const modules = [mod('out/f.test', 'F', [method('focused', { only: true }), method('other'), method('third')], { tags: ['Parallel'] })];
	const all = planLuneRun({ listing: listing(modules) });
	assert.deepEqual(labels(all), ['out/f.test::focused']);
	assert.match(unscheduledOf(all, 'F', 'other').reason, /focused with @Only \(focused\)/);
	assert.equal(unscheduledOf(all, 'F', 'other').status, 'skipped');
	// Selecting a non-focused test on its own runs it: the @Only sibling is removed from the class.
	const other = planLuneRun({ listing: listing(modules), selection: [ident('F', 'other')] });
	assert.deepEqual(labels(other), ['out/f.test::other']);
	assert.deepEqual(other.unscheduled, []);
	// Selecting the class (every method) honours the focus, as Lunit would.
	const cls = planLuneRun({ listing: listing(modules), selection: [ident('F', 'focused'), ident('F', 'other'), ident('F', 'third')] });
	assert.deepEqual(labels(cls), ['out/f.test::focused']);
	assert.equal(unscheduledOf(cls, 'F', 'third').status, 'skipped');
	// An ordinary (unsplit) class is narrowed the same way.
	const plain = planLuneRun({ listing: listing([mod('out/g.test', 'G', [method('focused', { only: true }), method('other')])]) });
	assert.deepEqual(specMethods(plain.blocks[0]), ['focused']);
});

test('single-process isolation keeps every module in one block, groups first', () => {
	const modules = [
		mod('out/b.test', 'B', [method('b')]),
		mod('out/p.test', 'P', [method('p', { cases: 2 })], { tags: ['Parallel'] }),
		mod('out/a.test', 'A', [method('a')]),
		mod('out/x.test', 'X', [method('x', { tags: ['Studio'] })]),
	];
	const plan = planLuneRun({ listing: listing(modules), isolation: 'single', dependencyGroups: [['a.test', 'b.test']], excludedTag: 'Studio' });
	assert.equal(plan.blocks.length, 1);
	assert.equal(plan.blocks[0].kind, 'all');
	assert.deepEqual(plan.blocks[0].modules.map((m) => m.path), ['out/a.test', 'out/b.test', 'out/p.test']);
	assert.deepEqual(plan.blocks[0].modules[2].spec, { methods: { p: true } }, 'the Parallel tag is ignored: the class runs whole');
	assert.equal(plan.counts.parallelClasses, 0);
	assert.deepEqual(plan.blocks[0].tests.map((t) => t.methodName), ['a', 'b', 'p']);
	const selected = planLuneRun({ listing: listing(modules), isolation: 'single', dependencyGroups: [['a.test', 'b.test']], selection: [ident('B', 'b')] });
	assert.deepEqual(selected.blocks[0].modules.map((m) => m.path), ['out/a.test', 'out/b.test']);
	assert.match(selected.notes[0], /out\/a.test run in full before the selected tests in out\/b.test/);
	const nothing = planLuneRun({ listing: listing(modules), isolation: 'single', selection: [ident('X', 'x')], excludedTag: 'Studio' });
	assert.deepEqual(nothing.blocks, []);
});

test('module display names apply to labels, notes and group matching', () => {
	const plan = planLuneRun({
		listing: listing([mod('C:/ws/out/a.test', 'A', [method('a')]), mod('C:/ws/out/b.test', 'B', [method('b', { cases: 1 })], { tags: ['Parallel'] })]),
		dependencyGroups: [['out/a.test', 'b.test']],
		displayName: (p) => p.replace('C:/ws/', ''),
	});
	assert.deepEqual(labels(plan), ['out/a.test -> out/b.test']);
	assert.deepEqual(plan.blocks[0].modules.map((m) => m.path), ['C:/ws/out/a.test', 'C:/ws/out/b.test'], 'workers still get the real path');
});
