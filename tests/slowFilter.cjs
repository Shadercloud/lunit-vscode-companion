// Unit coverage for the slow-tag rule in luauTestFilterTemplate.ts, run in Lune
// against hand-built class metadata: class-level and method-level tags,
// case-insensitive matching, a class whose only tests are slow, explicitly
// allowed slow tests, and precedence of the profile's excluded tag.
//
// Driven from runLuau.cjs because it needs Lune on PATH.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildLuauTestFilterHelpers, buildTestSelection } = require('../out/luauTestFilterTemplate');
const { buildLuneRunnerScript } = require('../out/luneScriptTemplate');

// Prints one "name: run classLeftOut testsLeftOut slowLeftOut | remaining tests" line per case.
const CASES = String.raw`
local function class(classTags, methods)
	local cls = {}
	if classTags then cls["lunit:class"] = { tags = classTags } end
	cls["lunit:method:test"] = methods
	return cls
end

local function test(tags) return { options = { isTest = true, tags = tags } } end
local hook = { options = { isTest = false } }

local function check(name, cls, className)
	local run, classLeftOut, testsLeftOut, slowLeftOut = lunitFilterClass(cls, className)
	local remaining = {}
	for method, entry in cls["lunit:method:test"] or {} do
		table.insert(remaining, method .. (entry.options.isTest and "" or "(hook)"))
	end
	table.sort(remaining)
	print(name .. ": " .. tostring(run) .. " " .. tostring(classLeftOut) .. " " .. testsLeftOut .. " " .. slowLeftOut
		.. " | " .. table.concat(remaining, ","))
end

check("method", class(nil, { quick = test(), sweep = test({ "Slow" }), setUp = hook }), "Method")
check("methodCase", class(nil, { quick = test(), sweep = test({ "sLoW" }) }), "MethodCase")
check("classLevel", class({ "SLOW" }, { a = test(), b = test({ "Other" }), setUp = hook }), "ClassLevel")
check("onlySlow", class(nil, { a = test({ "Slow" }), b = test({ "slow" }) }), "OnlySlow")
check("allowedMethod", class(nil, { quick = test(), sweep = test({ "Slow" }), long = test({ "Slow" }) }), "AllowedMethod")
check("allowedClassLevel", class({ "Slow" }, { a = test(), b = test() }), "AllowedClassLevel")
check("excludedWins", class(nil, { both = test({ "Slow", "Studio" }), quick = test() }), "ExcludedWins")
check("secondTag", class(nil, { quick = test(), soak = test({ "Soak" }) }), "SecondTag")
`;

function runCases(scriptDir, name, helpers) {
	const scriptPath = path.join(scriptDir, name);
	fs.writeFileSync(scriptPath, `${helpers}\n${CASES}`);
	const result = spawnSync(process.env.LUNE_EXE || 'lune', ['run', scriptPath], { encoding: 'utf8' });
	if (result.error) {
		throw result.error;
	}
	const output = `${result.stdout}${result.stderr}`;
	assert.strictEqual(result.status, 0, output);
	return Object.fromEntries(
		output
			.split(/\r?\n/)
			.filter((line) => line.includes(': '))
			.map((line) => line.split(': ')),
	);
}

module.exports = function runSlowFilterChecks(scriptDir) {
	const slow = runCases(
		scriptDir,
		'slow-filter.luau',
		buildLuauTestFilterHelpers('Studio', undefined, {
			tags: ['Slow', 'soak'],
			allowed: buildTestSelection([
				{ file: 'a.test.ts', className: 'AllowedMethod', methodName: 'sweep' },
				{ file: 'a.test.ts', className: 'AllowedClassLevel', methodName: 'b' },
			]),
		}),
	);
	assert.deepStrictEqual(slow, {
		method: 'true false 0 1 | quick,setUp(hook)',
		methodCase: 'true false 0 1 | quick',
		// Every test of a class-level slow class is slow; the hook stays.
		classLevel: 'false false 0 2 | setUp(hook)',
		// Emptied by the slow rule: not run, and not a left-out class either.
		onlySlow: 'false false 0 2 | ',
		// The explicitly selected slow test runs; its unselected sibling does not.
		allowedMethod: 'true false 0 1 | quick,sweep',
		allowedClassLevel: 'true false 0 1 | b',
		// A test the profile excludes by tag counts as that, not as slow.
		excludedWins: 'true false 1 0 | quick',
		secondTag: 'true false 0 1 | quick',
	});

	// No slow tags (the Full profile, or a project without the setting): nothing changes.
	const none = runCases(scriptDir, 'no-slow-filter.luau', buildLuauTestFilterHelpers('Studio'));
	assert.deepStrictEqual(none, {
		method: 'true false 0 0 | quick,setUp(hook),sweep',
		methodCase: 'true false 0 0 | quick,sweep',
		classLevel: 'true false 0 0 | a,b,setUp(hook)',
		onlySlow: 'true false 0 0 | a,b',
		allowedMethod: 'true false 0 0 | long,quick,sweep',
		allowedClassLevel: 'true false 0 0 | a,b',
		excludedWins: 'true false 1 0 | quick',
		secondTag: 'true false 0 0 | quick,soak',
	});

	// The package Lune worker applies no rule of its own (the planner decides); it must still compile.
	const packageScript = path.join(scriptDir, 'package-runner-compile.luau');
	fs.writeFileSync(
		packageScript,
		`local luau = require("@lune/luau")\nlocal source = ${JSON.stringify(buildLuneRunnerScript('./promise'))}\nluau.compile(source)\nprint("compiled")`,
	);
	const compiled = spawnSync(process.env.LUNE_EXE || 'lune', ['run', packageScript], { encoding: 'utf8' });
	assert.strictEqual(compiled.status, 0, `${compiled.stdout}${compiled.stderr}`);

	console.log('Slow-tag filter checks passed');
};
