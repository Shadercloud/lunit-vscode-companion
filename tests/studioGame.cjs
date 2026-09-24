// Regression coverage for the "Run in Roblox Studio" standalone fallback on a
// roblox-ts --type game project (tests/fixtures/gameStudio: two source roots,
// src/ and tests/, compiled for dev.project.json). With no live-synced Studio
// connected, the runner must build the temporary place from the project's own
// Rojo file, so a compiled test's `TS.import(script, script.Parent.Parent.
// Parent, "Common", ...)` finds the source folder beside it. The old
// package-style layout is built too, as the negative control: there the same
// import waits on a "Common" sibling that does not exist.
//
// Runs the real runner up to the point where Studio would launch (the
// configured executable does not exist), then runs the generated bootstrap
// script against the built .rbxl under Lune. Driven from runLuau.cjs because
// it needs Lune (LUNE_EXE) and Rojo (ROJO_EXE, else `rojo` on PATH).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runViaStudio, writePackageLayoutProjectFile, writeStudioBootstrapScript } = require('../out/studioRunner');
const { detectStudioProject, findRojoFlags } = require('../out/studioProjectKind');
const { buildConfig } = require('../out/config');
const { CancelSource } = require('../out/cancelSignal');

const FIXTURE = path.join(__dirname, 'fixtures', 'gameStudio');
const PACKAGE_FIXTURE = path.join(__dirname, 'fixtures', 'package');
const HARNESS = path.join(__dirname, 'studioGame.luau');
const CLI = path.join(__dirname, '..', 'out', 'cli.js');
const LUNE = process.env.LUNE_EXE || 'lune';
const ROJO = process.env.ROJO_EXE || 'rojo';
// Deliberately a template: ${projectFile} is filled in per run by the runner.
const BUILD_PLACE = `"${ROJO}" build "\${projectFile}" --output "\${placeFile}"`;

function config(root, storageDir, settings = {}) {
	const all = {
		skipCompile: true,
		compileCommand: 'npm run build',
		'studio.liveSync.enabled': false,
		'studio.buildPlaceCommand': BUILD_PLACE,
		'studio.executablePath': path.join(storageDir, 'no-such-studio.exe'),
		...settings,
	};
	return buildConfig(root, storageDir, (key, fallback) => (key in all ? all[key] : fallback));
}

async function runStudio(cfg) {
	let output = '';
	const outcome = await runViaStudio(cfg, new CancelSource().token, (text) => (output += text));
	return { outcome, output };
}

function decodeResults(output) {
	const rows = [];
	for (const line of output.split(/\r?\n/)) {
		const marker = line.indexOf('@@LUNIT_RESULT@@');
		if (marker === -1) {
			continue;
		}
		const [cls, label, status] = line.slice(marker + '@@LUNIT_RESULT@@'.length).split('\t');
		rows.push(`${Buffer.from(cls, 'base64').toString('utf8')}.${Buffer.from(label, 'base64').toString('utf8')}:${status}`);
	}
	return rows.sort();
}

/** Runs the bootstrap script against the built place under Lune. */
function harness(placeFile, bootstrapScript) {
	const result = spawnSync(LUNE, ['run', HARNESS, placeFile, bootstrapScript], { encoding: 'utf8' });
	if (result.error) {
		throw result.error;
	}
	const output = `${result.stdout}${result.stderr}`;
	assert.equal(result.status, 0, output);
	const modules = output
		.split(/\r?\n/)
		.filter((line) => line.startsWith('@@MODULE@@ '))
		.map((line) => line.slice('@@MODULE@@ '.length))
		.sort();
	return { output, rows: decodeResults(output), modules };
}

function rojoBuild(cwd, projectFile, placeFile) {
	const result = spawnSync(ROJO, ['build', projectFile, '--output', placeFile], { cwd, encoding: 'utf8' });
	if (result.error) {
		throw result.error;
	}
	assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
}

module.exports = async function runStudioGameChecks(scriptDir) {
	const workspace = path.join(scriptDir, 'studio-game');
	fs.cpSync(FIXTURE, workspace, { recursive: true });
	const outDir = path.join(workspace, 'out');
	const devProject = path.join(workspace, 'dev.project.json');

	// --- Which Rojo project to build from ------------------------------------

	assert.deepEqual(findRojoFlags('npm run build', workspace), ['dev.project.json'], 'follows npm run into package.json scripts');
	assert.deepEqual(findRojoFlags('npx rbxtsc --type game --rojo=other.project.json', workspace), ['other.project.json']);
	assert.deepEqual(findRojoFlags('npm run build:all', workspace), ['dev.project.json', 'lobby.project.json'], 'follows concurrently npm: shorthands');
	assert.deepEqual(findRojoFlags('npm run place', workspace), ['dev.project.json']);
	assert.deepEqual(findRojoFlags('npx rbxtsc', workspace), []);

	const detect = (overrides = {}) =>
		detectStudioProject({ workspaceRoot: workspace, outDir, compileCommand: 'npm run build', configuredProjectFile: '', ...overrides });

	const viaFlag = detect();
	assert.equal(viaFlag.kind, 'game');
	assert.equal(viaFlag.projectFile, devProject);
	assert.equal(viaFlag.blocked, undefined);
	assert.match(viaFlag.reason, /--rojo dev\.project\.json/);

	const ambiguous = detect({ compileCommand: 'npm run build:all' });
	assert.match(ambiguous.blocked || '', /several rbxtsc --rojo flags \(dev\.project\.json, lobby\.project\.json\)/);
	assert.match(ambiguous.blocked || '', /lunit\.studio\.rojoProject/);

	const configured = detect({ compileCommand: 'npm run build:all', configuredProjectFile: 'dev.project.json' });
	assert.equal(configured.projectFile, devProject, 'the setting wins over the compile command');
	assert.equal(configured.blocked, undefined);

	const missing = detect({ configuredProjectFile: 'nope.project.json' });
	assert.match(missing.blocked || '', /lunit\.studio\.rojoProject points at .*nope\.project\.json, which does not exist/);

	const fromOutput = detect({ compileCommand: 'npx rbxtsc' });
	assert.equal(fromOutput.kind, 'game', 'no --rojo flag, but the compiled output resolves through the DataModel');
	assert.equal(fromOutput.projectFile, devProject, 'the one Rojo project at the root');

	const viaLuneSetting = detect({ compileCommand: 'npx rbxtsc', luneProjectFile: 'dev.project.json' });
	assert.equal(viaLuneSetting.projectFile, devProject);
	assert.match(viaLuneSetting.reason, /lunit\.lune\.projectFile/);

	const packageFixture = detectStudioProject({
		workspaceRoot: PACKAGE_FIXTURE,
		outDir: path.join(PACKAGE_FIXTURE, 'out'),
		compileCommand: 'npx rbxtsc',
		configuredProjectFile: '',
	});
	assert.equal(packageFixture.kind, 'package', 'script-relative output keeps the package layout');
	assert.equal(packageFixture.blocked, undefined);

	const publishedPackage = path.join(scriptDir, 'studio-published-package');
	fs.mkdirSync(publishedPackage, { recursive: true });
	fs.writeFileSync(path.join(publishedPackage, 'package.json'), JSON.stringify({ name: '@rbxts/thing', main: 'out/init.lua', types: 'out/index.d.ts' }));
	const published = detectStudioProject({
		workspaceRoot: publishedPackage,
		outDir: path.join(publishedPackage, 'out'),
		compileCommand: 'npx rbxtsc',
		configuredProjectFile: '',
	});
	assert.equal(published.kind, 'package', 'package.json main under out/ is a real rbxts package');
	assert.match(published.reason, /entry point/);

	const emptyProject = path.join(scriptDir, 'studio-empty');
	fs.mkdirSync(emptyProject, { recursive: true });
	const empty = detectStudioProject({ workspaceRoot: emptyProject, outDir: path.join(emptyProject, 'out'), compileCommand: 'npx rbxtsc', configuredProjectFile: '' });
	assert.equal(empty.kind, 'package', 'nothing to judge by keeps the long-standing layout');
	fs.writeFileSync(path.join(emptyProject, 'default.project.json'), '{"name":"x","tree":{"$className":"DataModel"}}');
	const defaulted = detectStudioProject({ workspaceRoot: emptyProject, outDir: path.join(emptyProject, 'out'), compileCommand: 'npx rbxtsc', configuredProjectFile: '' });
	assert.equal(defaulted.kind, 'game');
	assert.equal(defaulted.projectFile, path.join(emptyProject, 'default.project.json'));

	// --- The fallback place, built from dev.project.json ---------------------

	const storageDir = path.join(scriptDir, 'studio-game-storage');
	fs.mkdirSync(storageDir, { recursive: true });
	const cfg = config(workspace, storageDir);
	const game = await runStudio(cfg);
	assert.match(game.output, /building the Studio place from that Rojo project/, game.output);
	assert.match(game.output, new RegExp(`> "${ROJO.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}" build "${devProject.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}"`), game.output);
	assert.match(game.output, /configured Studio executable does not exist/, `the run must get as far as launching Studio:\n${game.output}`);
	assert.ok(fs.existsSync(cfg.studio.placeFile), 'the place was built');
	assert.ok(!fs.existsSync(cfg.studio.projectFile), 'no package-style project is generated for a game project');
	assert.equal(game.outcome.error, undefined);

	const built = harness(cfg.studio.placeFile, cfg.studio.bootstrapScript);
	assert.deepEqual(
		built.modules,
		['ReplicatedStorage.Tests.Common.math.test', 'StarterPlayer.StarterPlayerScripts.Tests.Common.greeter.test'],
		`the tests sit where dev.project.json puts them:\n${built.output}`,
	);
	assert.deepEqual(built.rows, ['GreeterTests.greetsByName:passed', 'MathTests.addsNumbers:passed'], built.output);
	assert.doesNotMatch(built.output, /failed to load test module/, built.output);
	assert.doesNotMatch(built.output, /is not a child of/, `an import waited on a missing sibling:\n${built.output}`);

	// --- Negative control: the same output relocated into the package layout --

	const legacyStorage = path.join(scriptDir, 'studio-game-legacy-storage');
	fs.mkdirSync(legacyStorage, { recursive: true });
	const legacyCfg = config(workspace, legacyStorage);
	const legacyProject = writePackageLayoutProjectFile(legacyCfg);
	const legacyBootstrap = writeStudioBootstrapScript(legacyCfg, 'package');
	rojoBuild(workspace, legacyProject, legacyCfg.studio.placeFile);
	const legacy = harness(legacyCfg.studio.placeFile, legacyBootstrap);
	assert.deepEqual(legacy.rows, [], `no test can load in the package layout:\n${legacy.output}`);
	assert.match(
		legacy.output,
		/failed to load test module "ReplicatedStorage\.rbxts_include\.node_modules\.@rbxts\.hearth-fixture\.tests\.shared\.math\.test": .*Common is not a child of ReplicatedStorage\.rbxts_include\.node_modules\.@rbxts\.hearth-fixture/,
		`the relocated test's relative import must miss its sibling:\n${legacy.output}`,
	);

	// --- No project file to build from: exit code 2 and the remedy ------------

	const blockedWorkspace = path.join(scriptDir, 'studio-game-blocked');
	fs.cpSync(FIXTURE, blockedWorkspace, { recursive: true });
	fs.rmSync(path.join(blockedWorkspace, 'dev.project.json'));
	const blockedStorage = path.join(scriptDir, 'studio-game-blocked-storage');
	fs.mkdirSync(blockedStorage, { recursive: true });
	const blockedCfg = config(blockedWorkspace, blockedStorage, { compileCommand: 'npx rbxtsc' });
	const blocked = await runStudio(blockedCfg);
	assert.equal(blocked.outcome.code, 2, blocked.output);
	assert.match(blocked.outcome.error || '', /no Rojo project file was found at the workspace root/);
	assert.match(blocked.outcome.error || '', /connect Rojo/);
	assert.match(blocked.outcome.error || '', /"rojo serve"/);
	assert.match(blocked.outcome.error || '', /"lunit\.studio\.rojoProject"/);
	assert.ok(!fs.existsSync(blockedCfg.studio.placeFile), 'no place is built that could not resolve requires');
	assert.doesNotMatch(blocked.output, /> "/, `nothing should have been run:\n${blocked.output}`);

	// A build failure is the same outcome: code 2 and the remedy.
	const brokenStorage = path.join(scriptDir, 'studio-game-broken-storage');
	fs.mkdirSync(brokenStorage, { recursive: true });
	fs.writeFileSync(path.join(workspace, 'broken.project.json'), '{"name": "broken", "tree": ');
	const broken = await runStudio(config(workspace, brokenStorage, { 'studio.rojoProject': 'broken.project.json' }));
	assert.equal(broken.outcome.code, 2, broken.output);
	assert.match(broken.outcome.error || '', /"rojo build" failed .*broken\.project\.json/);
	assert.match(broken.outcome.error || '', /lunit\.studio\.rojoProject/);

	// The command line reports it as "could not run" (exit code 2), not as failures.
	fs.mkdirSync(path.join(blockedWorkspace, '.vscode'), { recursive: true });
	fs.writeFileSync(
		path.join(blockedWorkspace, '.vscode', 'settings.json'),
		JSON.stringify(
			{
				'lunit.skipCompile': true,
				'lunit.compileCommand': 'npx rbxtsc',
				'lunit.studio.liveSync.enabled': false,
				'lunit.studio.buildPlaceCommand': BUILD_PLACE,
				'lunit.studio.executablePath': path.join(blockedStorage, 'no-such-studio.exe'),
			},
			null,
			2,
		),
	);
	const cli = spawnSync(process.execPath, [CLI, '--standalone', '--workspace', blockedWorkspace, '--studio'], { encoding: 'utf8' });
	if (cli.error) {
		throw cli.error;
	}
	const cliOutput = `${cli.stdout}${cli.stderr}`;
	assert.equal(cli.status, 2, cliOutput);
	assert.match(cliOutput, /lunit\.studio\.rojoProject/, cliOutput);
	assert.match(cliOutput, /run via Roblox Studio did not complete/, cliOutput);

	console.log('Studio game-project fallback regression checks passed');
};
