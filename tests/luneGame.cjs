// Regression coverage for the "Run with Lune" game-project path: generates the
// virtual DataModel and the game runner exactly as luneRunner.ts does, then
// runs them against tests/fixtures/game -- a roblox-ts --type game layout with
// tests in ReplicatedStorage, ServerScriptService and StarterPlayerScripts.
//
// Driven from runLuau.cjs because it needs Lune on PATH.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildRojoDataModelModule } = require('../out/rojoDataModelTemplate');
const { buildLuneGameRunnerScript } = require('../out/luneGameScriptTemplate');
const { detectLuneProject, detectOutputKind } = require('../out/luneProjectKind');
const { buildTestSelection } = require('../out/luauTestFilterTemplate');

const FIXTURE = path.join(__dirname, 'fixtures', 'game');

function decodeResults(output) {
	const rows = [];
	for (const line of output.split(/\r?\n/)) {
		const marker = line.indexOf('@@LUNIT_RESULT@@');
		if (marker === -1) {
			continue;
		}
		const [cls, label, status] = line.slice(marker + '@@LUNIT_RESULT@@'.length).split('\t');
		rows.push({
			cls: Buffer.from(cls, 'base64').toString('utf8'),
			label: Buffer.from(label, 'base64').toString('utf8'),
			status,
		});
	}
	return rows;
}

function countByClass(rows) {
	const byClass = {};
	for (const row of rows) {
		byClass[row.cls] = (byClass[row.cls] || 0) + 1;
	}
	return byClass;
}

function run(scriptDir, projectFile, runnerName = 'lune-game-runner.luau', moduleFilter) {
	const result = spawnSync(
		process.env.LUNE_EXE || 'lune',
		['run', path.join(scriptDir, runnerName), projectFile, ...(moduleFilter ? [moduleFilter] : [])],
		{ cwd: FIXTURE, encoding: 'utf8' },
	);
	if (result.error) {
		throw result.error;
	}
	return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

module.exports = function runGameProjectChecks(scriptDir) {
	fs.writeFileSync(path.join(scriptDir, 'lune-rbx.luau'), buildRojoDataModelModule());
	fs.writeFileSync(
		path.join(scriptDir, 'lune-game-runner.luau'),
		buildLuneGameRunnerScript('./lune-rbx'),
	);

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

	// No slow filter: "Run with Lune (Full)", or a project without slowTags.
	const passing = run(scriptDir, 'game.project.json');
	const rows = decodeResults(passing.output);
	assert.deepStrictEqual(
		countByClass(rows),
		{ DatatypeTests: 6, ServerTests: 2, ClientTests: 2, SlowTests: 3, SlowOnlyTests: 2 },
		`unexpected results:\n${passing.output}`,
	);
	assert.ok(!passing.output.includes('slow test(s)'), passing.output);
	assert.ok(
		rows.every((row) => row.status === 'passed'),
		`a fixture test failed:\n${passing.output}`,
	);
	assert.ok(
		!passing.output.includes('must never'),
		`a Studio-tagged test or module ran:\n${passing.output}`,
	);
	assert.match(passing.output, /Left out 2 Studio-tagged test class\(es\) and 1 Studio-tagged test\(s\)/);
	assert.strictEqual(passing.code, 0, passing.output);

	// "Run with Lune" with lunit.lune.slowTags = ["Slow"]: class- and method-level
	// slow tests are left out and counted, never reported.
	fs.writeFileSync(
		path.join(scriptDir, 'lune-game-runner-slow.luau'),
		buildLuneGameRunnerScript('./lune-rbx', { tags: ['Slow'] }),
	);
	const everyday = run(scriptDir, 'game.project.json', 'lune-game-runner-slow.luau');
	const everydayRows = decodeResults(everyday.output);
	assert.deepStrictEqual(
		countByClass(everydayRows),
		{ DatatypeTests: 6, ServerTests: 2, ClientTests: 2, SlowTests: 1 },
		`slow tests must be left out:\n${everyday.output}`,
	);
	assert.ok(
		everydayRows.some((row) => row.cls === 'SlowTests' && row.label === 'quickCheck' && row.status === 'passed'),
		everyday.output,
	);
	assert.match(everyday.output, /Left out 4 slow test\(s\): run with Lune \(Full\)\./);
	assert.strictEqual(everyday.code, 0, everyday.output);

	// A class whose only tests are slow is "left out", not "no tests found".
	const onlySlow = run(scriptDir, 'game.project.json', 'lune-game-runner-slow.luau', 'slowOnly');
	assert.deepStrictEqual(decodeResults(onlySlow.output), [], onlySlow.output);
	assert.match(onlySlow.output, /Left out 2 slow test\(s\)/);
	assert.ok(!/No tests found|Every discovered test/.test(onlySlow.output), onlySlow.output);
	assert.strictEqual(onlySlow.code, 0, onlySlow.output);

	// An explicitly selected slow test runs anyway; its class's other slow test does not.
	fs.writeFileSync(
		path.join(scriptDir, 'lune-game-runner-explicit.luau'),
		buildLuneGameRunnerScript('./lune-rbx', {
			tags: ['Slow'],
			allowed: buildTestSelection([{ file: 'slowOnly.test.ts', className: 'SlowOnlyTests', methodName: 'sweepAll' }]),
		}),
	);
	const explicit = run(scriptDir, 'game.project.json', 'lune-game-runner-explicit.luau');
	const explicitRows = decodeResults(explicit.output).filter((row) => row.cls.startsWith('Slow'));
	assert.deepStrictEqual(
		explicitRows.map((row) => `${row.cls}.${row.label}:${row.status}`).sort(),
		['SlowOnlyTests.sweepAll:passed', 'SlowTests.quickCheck:passed'],
		explicit.output,
	);
	assert.match(explicit.output, /Left out 3 slow test\(s\)/);

	const broken = run(scriptDir, 'broken.project.json');
	assert.match(
		broken.output,
		/failed to load test module ReplicatedStorage\.Broken\.broken\.test: ReplicatedStorage\.Broken\.broken\.test: ReplicatedStorage\.Broken\.missingDep: .*dependency blew up on purpose/,
		`a load failure must name the dependency chain:\n${broken.output}`,
	);
	assert.strictEqual(broken.code, 1, 'a load failure must fail the run');

	console.log('Lune game-project regression checks passed');
};
