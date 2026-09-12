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

function run(scriptDir, projectFile) {
	const result = spawnSync(
		process.env.LUNE_EXE || 'lune',
		['run', path.join(scriptDir, 'lune-game-runner.luau'), projectFile],
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

	const passing = run(scriptDir, 'game.project.json');
	const rows = decodeResults(passing.output);
	const byClass = {};
	for (const row of rows) {
		byClass[row.cls] = (byClass[row.cls] || 0) + 1;
	}
	assert.deepStrictEqual(
		byClass,
		{ DatatypeTests: 6, ServerTests: 2, ClientTests: 2 },
		`unexpected results:\n${passing.output}`,
	);
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

	const broken = run(scriptDir, 'broken.project.json');
	assert.match(
		broken.output,
		/failed to load test module ReplicatedStorage\.Broken\.broken\.test: ReplicatedStorage\.Broken\.broken\.test: ReplicatedStorage\.Broken\.missingDep: .*dependency blew up on purpose/,
		`a load failure must name the dependency chain:\n${broken.output}`,
	);
	assert.strictEqual(broken.code, 1, 'a load failure must fail the run');

	console.log('Lune game-project regression checks passed');
};
