// Regression coverage for the "Run with Lune" game-project path: runs the
// real runner (luneRunner.ts, generating the virtual DataModel and the game
// worker) against tests/fixtures/game -- a roblox-ts --type game layout with
// tests in ReplicatedStorage, ServerScriptService and StarterPlayerScripts --
// through the parallel block scheduler.
//
// Driven from runLuau.cjs because it needs Lune on PATH (or LUNE_EXE).
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { runViaLune } = require('../out/luneRunner');
const { buildConfig } = require('../out/config');
const { CancelSource } = require('../out/cancelSignal');
const { resolveBlockVerdict } = require('../out/runReport');
const { detectLuneProject, detectOutputKind } = require('../out/luneProjectKind');
const { buildTestSelection } = require('../out/luauTestFilterTemplate');

const FIXTURE = path.join(__dirname, 'fixtures', 'game');
const LUNE = process.env.LUNE_EXE ? `"${process.env.LUNE_EXE}"` : 'lune';

function config(storageDir, settings = {}) {
	const all = { skipCompile: true, 'lune.executable': LUNE, 'lune.projectFile': 'game.project.json', ...settings };
	return buildConfig(FIXTURE, storageDir, (key, fallback) => (key in all ? all[key] : fallback));
}

async function run(storageDir, settings, options = {}) {
	let output = '';
	const outcome = await runViaLune(config(storageDir, settings), new CancelSource().token, (text) => (output += text), options);
	assert.ok(outcome.report, `no report:\n${output}`);
	return { outcome, output, report: outcome.report };
}

const ident = (className, methodName, file = `/src/${className}.test.ts`) => ({ file, className, methodName });
const status = (report, className, methodName) => resolveBlockVerdict(ident(className, methodName), report).status;
const labels = (report) => report.blocks.map((block) => block.label).sort();
const SLOW = { tags: ['Slow'] };

module.exports = async function runGameProjectChecks(scriptDir) {
	const storageDir = path.join(scriptDir, 'game-storage');
	fs.mkdirSync(storageDir, { recursive: true });

	// Detection: the fixture's compiled output resolves through the DataModel.
	assert.strictEqual(detectOutputKind(path.join(FIXTURE, 'out')), 'game');
	const ambiguous = detectLuneProject({
		workspaceRoot: FIXTURE,
		outDir: path.join(FIXTURE, 'out'),
		configuredProjectFile: '',
	});
	assert.strictEqual(ambiguous.kind, 'game');
	assert.match(
		ambiguous.blocked || '',
		/several Rojo project files/,
		'two candidate projects must ask for lunit.lune.projectFile rather than guess',
	);
	const configured = detectLuneProject({
		workspaceRoot: FIXTURE,
		outDir: path.join(FIXTURE, 'out'),
		configuredProjectFile: 'game.project.json',
	});
	assert.strictEqual(configured.projectFile, path.join(FIXTURE, 'game.project.json'));

	// A package project keeps the long-standing filesystem path untouched.
	assert.strictEqual(
		detectOutputKind(path.join(__dirname, '..', 'node_modules')),
		undefined,
		'node_modules must never decide the project kind',
	);
	const packageLike = detectLuneProject({
		workspaceRoot: path.join(__dirname, '..'),
		outDir: path.join(__dirname, '..', 'out'),
		configuredProjectFile: '',
	});
	assert.strictEqual(packageLike.kind, 'package');
	assert.strictEqual(packageLike.blocked, undefined);

	// "Run with Lune" with lunit.lune.slowTags = ["Slow"]: one block per
	// module, the Parallel class split per case, Studio-tagged classes and
	// tests left out, slow tests left out and counted.
	const everyday = await run(storageDir, {}, { slow: SLOW });
	assert.deepStrictEqual(
		labels(everyday.report),
		[
			'ReplicatedStorage.Shared.datatypes.test',
			'ReplicatedStorage.Shared.parallelRows.test::plain',
			'ReplicatedStorage.Shared.parallelRows.test::rows[1]',
			'ReplicatedStorage.Shared.parallelRows.test::rows[2]',
			'ReplicatedStorage.Shared.parallelRows.test::rows[3]',
			'ServerScriptService.Server.group.consumer.test',
			'ServerScriptService.Server.group.setup.test',
			'ServerScriptService.Server.server.test',
			'ServerScriptService.Server.slow.test',
			'StarterPlayer.StarterPlayerScripts.Client.client.test',
		],
		everyday.output,
	);
	for (const name of ['absoluteImports', 'relativeImports', 'datatypeIdentity', 'datatypePrecision', 'jsonModules', 'ignoredPaths']) {
		assert.strictEqual(status(everyday.report, 'DatatypeTests', name), 'passed', `${name}:\n${everyday.output}`);
	}
	assert.strictEqual(status(everyday.report, 'DatatypeTests', 'needsEngine'), 'skipped', 'method-level Studio tag');
	assert.strictEqual(status(everyday.report, 'TaggedTests', 'needsEngine'), 'skipped', 'class-level Studio tag in the metadata');
	assert.strictEqual(status(everyday.report, 'ServerTests', 'runsFromServerScriptService'), 'passed', everyday.output);
	assert.strictEqual(status(everyday.report, 'ServerTests', 'sharesModuleIdentity'), 'passed', everyday.output);
	assert.strictEqual(status(everyday.report, 'ClientTests', 'runsFromStarterPlayerScripts'), 'passed', everyday.output);
	assert.strictEqual(status(everyday.report, 'ClientTests', 'unmappedServicesAreStubs'), 'passed', everyday.output);
	assert.strictEqual(status(everyday.report, 'SlowTests', 'quickCheck'), 'passed', everyday.output);
	assert.strictEqual(status(everyday.report, 'SlowTests', 'sweep'), 'skipped');
	assert.strictEqual(status(everyday.report, 'SlowTests', 'longSweep'), 'skipped');
	assert.strictEqual(status(everyday.report, 'SlowOnlyTests', 'sweepAll'), 'skipped');
	assert.strictEqual(status(everyday.report, 'ParallelRowTests', 'plain'), 'passed', everyday.output);
	const rows = resolveBlockVerdict(ident('ParallelRowTests', 'rows'), everyday.report);
	assert.strictEqual(rows.status, 'failed', everyday.output);
	assert.match(rows.message, /^rows \(2, 2, 5\): .*2 \+ 2 should be 5/);
	assert.strictEqual(status(everyday.report, 'ParallelRowTests', 'sweep'), 'skipped');
	assert.strictEqual(status(everyday.report, 'SetupTests', 'registersTheFixture'), 'passed', everyday.output);
	assert.strictEqual(status(everyday.report, 'ConsumerTests', 'seesTheFixture'), 'failed', 'a fresh VM without the group');
	assert.strictEqual(everyday.report.excludedClasses, 2, 'the source-tagged module and the metadata-tagged class');
	assert.strictEqual(everyday.report.excludedTests, 1);
	assert.strictEqual(everyday.report.slowLeftOut, 5);
	assert.match(everyday.output, /Left out 2 Studio-tagged test class\(es\) and 1 Studio-tagged test\(s\): run them with the Studio profile\./);
	assert.ok(!everyday.output.includes('must never'), `a Studio-tagged test or module ran:\n${everyday.output}`);
	assert.ok(!everyday.output.includes('lifecycle hook was removed'), everyday.output);

	// "Run with Lune (Full)": slow tests run too.
	const full = await run(storageDir, {});
	assert.strictEqual(full.report.slowLeftOut, 0);
	for (const [cls, name] of [['SlowTests', 'sweep'], ['SlowTests', 'longSweep'], ['SlowOnlyTests', 'sweepAll'], ['SlowOnlyTests', 'sweepAgain'], ['ParallelRowTests', 'sweep']]) {
		assert.strictEqual(status(full.report, cls, name), 'passed', `${cls}.${name}:\n${full.output}`);
	}
	assert.ok(!full.output.includes('slow test'), full.output);

	// A class whose only tests are slow is "left out", not "no tests found".
	const onlySlow = await run(storageDir, {}, { slow: SLOW, selection: [ident('SlowOnlyTests', 'sweepAll'), ident('SlowOnlyTests', 'sweepAgain')] });
	assert.deepStrictEqual(onlySlow.report.blocks, []);
	assert.match(onlySlow.output, /nothing to run under this profile: 2 slow test\(s\) left out/);
	assert.ok(!/No tests found|Every discovered test/.test(onlySlow.output), onlySlow.output);
	assert.strictEqual(onlySlow.outcome.code, 0);

	// An explicitly selected slow test runs anyway; its class's other slow test does not.
	const explicit = await run(storageDir, {}, {
		slow: { tags: ['Slow'], allowed: buildTestSelection([ident('SlowOnlyTests', 'sweepAll')]) },
		selection: [ident('SlowOnlyTests', 'sweepAll')],
	});
	assert.deepStrictEqual(labels(explicit.report), ['ServerScriptService.Server.slowOnly.test']);
	assert.deepStrictEqual(explicit.report.blocks[0].tests.map((test) => test.methodName), ['sweepAll']);
	assert.strictEqual(status(explicit.report, 'SlowOnlyTests', 'sweepAll'), 'passed', explicit.output);

	// A dependency group named by full name and by a trailing part.
	const grouped = await run(storageDir, { 'lune.parallel.dependencyGroups': [['ServerScriptService.Server.group.setup.test', 'group/consumer.test']] }, { slow: SLOW });
	assert.ok(labels(grouped.report).includes('ServerScriptService.Server.group.setup.test -> ServerScriptService.Server.group.consumer.test'), grouped.output);
	assert.strictEqual(status(grouped.report, 'ConsumerTests', 'seesTheFixture'), 'passed', grouped.output);

	// A module whose dependency errors at load names the chain that reached it.
	const broken = await run(storageDir, { 'lune.projectFile': 'broken.project.json' }, { slow: SLOW, selection: [ident('Broken', 'anything', '/src/broken.test.ts')] });
	assert.match(
		broken.output,
		/failed to load test module ReplicatedStorage\.Broken\.broken\.test: ReplicatedStorage\.Broken\.broken\.test: ReplicatedStorage\.Broken\.missingDep: .*dependency blew up on purpose/,
		`a load failure must name the dependency chain:\n${broken.output}`,
	);
	const brokenVerdict = resolveBlockVerdict(ident('Broken', 'anything', '/src/broken.test.ts'), broken.report);
	assert.strictEqual(brokenVerdict.status, 'errored');
	assert.match(brokenVerdict.message, /ReplicatedStorage\.Broken\.broken\.test failed to load: .*dependency blew up on purpose/);

	console.log('Lune game-project regression checks passed');
};
