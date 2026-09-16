// Regression coverage for the command line's standalone Lune route (cli.ts)
// on the package fixture: it copies the fixture to a temporary workspace with
// a .vscode/settings.json (skip compile, the Lune executable, slow tags, a
// dependency group), then runs the real CLI with --workers, --full, --json and
// a filter, checking the printed verdicts and the block/worker summary.
//
// Driven from runLuau.cjs because it needs Lune on PATH (or LUNE_EXE).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const FIXTURE = path.join(__dirname, 'fixtures', 'package');
const CLI = path.join(__dirname, '..', 'out', 'cli.js');

function cli(workspace, args) {
	const result = spawnSync(process.execPath, [CLI, '--standalone', '--workspace', workspace, ...args], { encoding: 'utf8' });
	if (result.error) {
		throw result.error;
	}
	return { code: result.status, stdout: result.stdout, stderr: result.stderr, output: `${result.stdout}${result.stderr}` };
}

module.exports = function runCliChecks(scriptDir) {
	const workspace = path.join(scriptDir, 'cli-workspace');
	fs.cpSync(FIXTURE, workspace, { recursive: true });
	fs.mkdirSync(path.join(workspace, '.vscode'), { recursive: true });
	const executable = process.env.LUNE_EXE ? `"${process.env.LUNE_EXE}"` : 'lune';
	fs.writeFileSync(
		path.join(workspace, '.vscode', 'settings.json'),
		JSON.stringify(
			{
				'lunit.skipCompile': true,
				'lunit.lune.executable': executable,
				'lunit.lune.slowTags': ['Slow'],
				'lunit.lune.parallel.dependencyGroups': [['setup.test', 'consumer.test']],
			},
			null,
			2,
		),
	);

	// --lune: the everyday profile, two workers.
	const everyday = cli(workspace, ['--lune', '--workers', '2']);
	assert.equal(everyday.code, 1, everyday.output);
	const lines = everyday.stdout.split(/\r?\n/);
	const verdictOf = (cls, method) => lines.find((line) => line.includes(` > ${cls} > ${method}`));
	assert.match(verdictOf('OrderedTests', 'second'), /^PASS  src\/tests\/ordered.test.ts > OrderedTests > second/);
	assert.match(verdictOf('RowTests', 'plain'), /^PASS /);
	assert.match(verdictOf('RowTests', 'rows'), /^FAIL  src\/tests\/rows.test.ts > RowTests > rows/);
	assert.ok(lines.some((line) => /^\s+rows \(2, 2, 5\): /.test(line)), 'the failing row is named under the item');
	assert.match(verdictOf('ConsumerTests', 'seesTheFixture'), /^PASS /, 'the dependency group ran setup first');
	assert.match(verdictOf('BadParallelTests', 'first'), /^ERR   /);
	assert.ok(lines.some((line) => /cannot be honoured: suite-level @BeforeAll/.test(line)));
	assert.match(verdictOf('FocusedTests', 'shadowed'), /^SKIP /);
	assert.match(verdictOf('BrokenTests', 'anything'), /^ERR   /);
	assert.ok(lines.some((line) => /out\/tests\/broken.test failed to load: .*cannot be loaded on purpose/.test(line)));
	assert.equal(verdictOf('RowTests', 'sweep'), undefined, 'a slow test is left out, not reported');
	// 14 discovered tests minus the slow one: ordered 2 + plain + setup + consumer + focused pass,
	// rows fails, shadowed is skipped, the two rejected classes (4) and the broken module (1) error.
	assert.match(everyday.stdout, /\[lunit\] 13 tests via Lune: 6 passed, 1 failed, 1 skipped, 5 errored\./, everyday.stdout);
	assert.match(everyday.stdout, /\[lunit\] 7 block\(s\) on 2 worker\(s\), \d+\.\d s wall time; longest block \d+\.\d s \(#\d+ out\/tests\/.*\)\./);
	assert.match(everyday.stdout, /\[lunit\] Left out 1 slow test\(s\): add --full to run them with Lune\./);
	assert.match(everyday.output, /\[lunit\] 7 blocks on 2 workers; 2 @Tag\("Parallel"\) class\(es\) split into 5 case block\(s\)\./);
	assert.match(everyday.output, /\[lunit\] #\d+ PASS out\/tests\/group\/setup.test -> out\/tests\/group\/consumer.test/);
	assert.ok(!everyday.output.includes('@@LUNIT_'), 'machine-only lines never reach the terminal');

	// --full --json with a filter: the slow case runs, the summary is machine-readable.
	const full = cli(workspace, ['--full', '--json', 'Row']);
	assert.equal(full.code, 1, full.output);
	const summary = JSON.parse(full.stdout);
	assert.deepEqual(
		summary.tests.map((test) => `${test.className}.${test.methodName}:${test.status}`).sort(),
		['RowTests.plain:passed', 'RowTests.rows:failed', 'RowTests.sweep:passed'],
	);
	assert.deepEqual(summary.counts, { passed: 2, failed: 1, skipped: 0, errored: 0 });
	assert.equal(summary.lune.blocks, 5);
	assert.ok(summary.lune.workers >= 1 && summary.lune.wallSeconds > 0);
	assert.equal(summary.slowLeftOut, undefined);
	assert.match(summary.tests.find((test) => test.methodName === 'rows').message, /^rows \(2, 2, 5\): /);

	// Selecting the dependent test by filter pulls in its prerequisite and reports it.
	const closure = cli(workspace, ['--lune', 'consumer']);
	assert.equal(closure.code, 0, closure.output);
	assert.match(closure.stdout, /^PASS  src\/tests\/group\/setup.test.ts > SetupTests > registersTheFixture/m);
	assert.match(closure.stdout, /^PASS  src\/tests\/group\/consumer.test.ts > ConsumerTests > seesTheFixture/m);
	assert.match(closure.output, /run in full before the selected tests in out\/tests\/group\/consumer.test/);

	// --workers is validated and Lune-only.
	assert.match(cli(workspace, ['--studio', '--workers', '2']).stderr, /--workers applies to the Lune profile/);
	assert.match(cli(workspace, ['--lune', '--workers', '0']).stderr, /--workers must be a positive integer/);
	assert.equal(cli(workspace, ['--lune', '--workers', 'x']).code, 2);

	console.log('Command-line Lune regression checks passed');
};
