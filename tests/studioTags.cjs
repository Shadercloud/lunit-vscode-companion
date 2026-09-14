// Regression coverage for the Studio profile's tag rule: both Studio-side
// scripts (the build+launch bootstrap and the live-sync job) must run the
// untagged tests in tests/fixtures/game and leave @Tag("Lune") ones out --
// class-level and method-level, for a whole-tree run and an explicit selection.
//
// Driven from runLuau.cjs because it needs Lune on PATH.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildStudioBootstrapScript } = require('../out/bootstrapTemplate');
const { buildLiveSyncJobScript } = require('../out/liveSyncScriptTemplate');
const { buildTestSelection } = require('../out/luauTestFilterTemplate');

const FIXTURE = path.join(__dirname, 'fixtures', 'game');
const HARNESS = path.join(__dirname, 'studioTags.luau');

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

function run(scriptDir, kind, name, code) {
	const scriptPath = path.join(scriptDir, name);
	fs.writeFileSync(scriptPath, code);
	const result = spawnSync(process.env.LUNE_EXE || 'lune', ['run', HARNESS, FIXTURE, scriptPath, kind], {
		encoding: 'utf8',
	});
	if (result.error) {
		throw result.error;
	}
	const output = `${result.stdout}${result.stderr}`;
	assert.strictEqual(result.status, 0, output);
	return { output, rows: decodeResults(output) };
}

// Everything the Test Explorer would send for "run these", including tests the
// Studio profile must still leave out if they somehow end up in the request.
const SELECTION = buildTestSelection([
	{ file: 'server.test.ts', className: 'ServerTests', methodName: 'runsFromServerScriptService' },
	{ file: 'mixedTags.test.ts', className: 'MixedTagTests', methodName: 'runsInStudio' },
	{ file: 'mixedTags.test.ts', className: 'MixedTagTests', methodName: 'runsOnlyUnderLune' },
	{ file: 'luneOnly.test.ts', className: 'LuneOnlyTests', methodName: 'mustNotRunInStudio' },
]);

const RUN_ALL_ROWS = [
	'MixedTagTests.runsInStudio:passed',
	'ServerTests.runsFromServerScriptService:passed',
	'ServerTests.sharesModuleIdentity:passed',
	// A @Tag("Studio") class belongs in Studio; this fixture's test throws by
	// design (it guards the Lune profile), so here it simply reports a failure.
	'TaggedTests.needsEngine:failed',
];
const SELECTED_ROWS = ['MixedTagTests.runsInStudio:passed', 'ServerTests.runsFromServerScriptService:passed'];

function assertNoLuneTestRan(output) {
	assert.ok(!output.includes('must never run in Roblox Studio'), `a Lune-tagged test ran in Studio:\n${output}`);
	assert.ok(!output.includes('lifecycle hook was removed'), `the tag filter removed a lifecycle hook:\n${output}`);
}

module.exports = function runStudioTagChecks(scriptDir) {
	const scenarios = [
		['bootstrap', 'bootstrap-all.luau', buildStudioBootstrapScript(), RUN_ALL_ROWS],
		['bootstrap', 'bootstrap-selected.luau', buildStudioBootstrapScript(SELECTION), SELECTED_ROWS],
		['job', 'job-all.luau', buildLiveSyncJobScript(), RUN_ALL_ROWS],
		['job', 'job-selected.luau', buildLiveSyncJobScript({ selection: SELECTION }), SELECTED_ROWS],
	];
	for (const [kind, name, code, expected] of scenarios) {
		const { output, rows } = run(scriptDir, kind, name, code);
		assert.deepStrictEqual(rows, expected, `${name}: unexpected results:\n${output}`);
		assertNoLuneTestRan(output);
		// LuneOnlyTests (source) and MetadataOnlyTests (metadata) are left out as
		// classes; runsOnlyUnderLune as a single method.
		assert.match(output, /left out 2 Lune-tagged test class\(es\) and 1 Lune-tagged test\(s\)/, `${name}:\n${output}`);
		if (kind === 'job') {
			assert.ok(!output.includes('[lunit] ERROR:'), `${name}:\n${output}`);
		}
	}

	// The job stops starting classes once the live-sync timeout has passed.
	const late = run(scriptDir, 'job', 'job-deadline.luau', buildLiveSyncJobScript({ deadlineSeconds: 0 }));
	assert.deepStrictEqual(late.rows, [], late.output);
	assert.match(late.output, /ERROR: stopped after 0 s, the live-sync timeout; \d+ test module\(s\) not run\./);

	console.log('Studio tag-rule regression checks passed');
};
