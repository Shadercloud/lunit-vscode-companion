import { TestIdentity } from './runReport';

/**
 * Which tests a run asked for: class name -> the method names selected in it.
 * Absent (undefined) means "run everything the profile allows".
 */
export type TestSelection = ReadonlyMap<string, ReadonlySet<string>>;

/** Builds a TestSelection from the discovered tests an explicit run request resolved to. */
export function buildTestSelection(tests: readonly TestIdentity[]): TestSelection {
	const selection = new Map<string, Set<string>>();
	for (const test of tests) {
		let methods = selection.get(test.className);
		if (!methods) {
			methods = new Set();
			selection.set(test.className, methods);
		}
		methods.add(test.methodName);
	}
	return selection;
}

/** A Luau string literal for arbitrary text (bytes outside printable ASCII become \ddd escapes). */
function luauString(text: string): string {
	let out = '"';
	for (const byte of Buffer.from(text, 'utf8')) {
		const char = String.fromCharCode(byte);
		if (char === '"' || char === '\\') {
			out += '\\' + char;
		} else if (byte >= 0x20 && byte < 0x7f) {
			out += char;
		} else {
			out += '\\' + byte.toString().padStart(3, '0');
		}
	}
	return out + '"';
}

function luauSelection(selection: TestSelection | undefined): string {
	if (!selection) {
		return 'nil';
	}
	const classes = Array.from(selection, ([className, methods]) => {
		const names = Array.from(methods, (name) => `[${luauString(name)}] = true`).join(', ');
		return `[${luauString(className)}] = { ${names} }`;
	});
	return `{\n\t${classes.join(',\n\t')}\n}`;
}

/**
 * Pure Luau (no Lune- or Roblox-specific APIs) deciding which test classes and
 * methods a generated runner actually runs, shared by the Lune game runner
 * (luneGameScriptTemplate.ts, excluding "Studio"), the Studio bootstrap
 * (bootstrapTemplate.ts) and the live-sync job (liveSyncScriptTemplate.ts),
 * both excluding "Lune".
 *
 * Tags are read from the metadata Lunit's decorators leave on the compiled
 * class -- `cls["lunit:class"].tags` and each `cls["lunit:method:test"][name]
 * .options.tags` -- and matched case-insensitively, as discovery.ts does.
 * Lunit's own 'tags' run option can only *include* tags, never exclude them,
 * so an excluded test is removed from the class before it runs rather than
 * marked disabled (which Lunit's summary would file under "Failures").
 *
 * Defines:
 * - `lunitSourceHasClassTag(source)`: whether compiled Luau declares its class
 *   with a class-level @Tag of the excluded tag, so a runner can leave the
 *   module out without loading it at all.
 * - `lunitFilterClass(cls, className)` -> `run, classLeftOut, testsLeftOut`:
 *   applies the tag rule and the run's selection (if any) to a loaded class,
 *   removing left-out methods in place.
 * - `lunitCountTests(cls)`.
 * - `lunitYieldBetweenClasses()`: for the Studio scripts, which have the
 *   engine's `task` library (the Lune runner never calls it).
 */
export function buildLuauTestFilterHelpers(excludedTag: string, selection?: TestSelection): string {
	return `local LUNIT_EXCLUDED_TAG = ${luauString(excludedTag)}
local LUNIT_SELECTION = ${luauSelection(selection)}

local function lunitHasTag(tags, tag)
	if type(tags) ~= "table" then return false end
	local wanted = string.lower(tag)
	for _, candidate in tags do
		if type(candidate) == "string" and string.lower(candidate) == wanted then
			return true
		end
	end
	return false
end

-- roblox-ts compiles @Tag("Lune") class X {} to X = Tag("Lune")(X) or X.
local function lunitSourceHasClassTag(source)
	if type(source) ~= "string" then return false end
	for args, className in source:gmatch('Tag%(([^%)]*)%)%(%s*([%w_]+)%s*%)') do
		local tags = {}
		for tag in args:gmatch('"([^"]*)"') do table.insert(tags, tag) end
		if lunitHasTag(tags, LUNIT_EXCLUDED_TAG)
			and source:find(className .. '%s*=%s*Tag%([^%)]*%)%(%s*' .. className .. '%s*%)%s*or%s*' .. className) then
			return true
		end
	end
	return false
end

local function lunitCountTests(cls)
	local count = 0
	for _, method in cls["lunit:method:test"] or {} do
		if method.options.isTest then count += 1 end
	end
	return count
end

-- Returns run, classLeftOut, testsLeftOut. A class with no test metadata at
-- all is left to Lunit to decide; only a class this filter emptied is dropped.
local function lunitFilterClass(cls, className)
	local classMetadata = cls["lunit:class"]
	if classMetadata ~= nil and lunitHasTag(classMetadata.tags, LUNIT_EXCLUDED_TAG) then
		return false, true, 0
	end
	local selected = LUNIT_SELECTION and LUNIT_SELECTION[className]
	if LUNIT_SELECTION ~= nil and selected == nil then
		return false, false, 0
	end
	local methods = cls["lunit:method:test"]
	if methods == nil then
		return true, false, 0
	end
	local tagged, unselected = 0, {}
	local anySelectedPresent = false
	for name, method in methods do
		-- Lifecycle hooks share this table (isTest false) and always stay.
		if method.options.isTest then
			if selected ~= nil and selected[name] then
				anySelectedPresent = true
			end
			if lunitHasTag(method.options.tags, LUNIT_EXCLUDED_TAG) then
				methods[name] = nil
				tagged += 1
			elseif selected ~= nil and not selected[name] then
				table.insert(unselected, name)
			end
		end
	end
	-- A selection naming no method this class actually has (e.g. a renamed
	-- identifier) runs the whole class rather than silently nothing.
	if anySelectedPresent then
		for _, name in unselected do methods[name] = nil end
	end
	local removed = tagged + (anySelectedPresent and #unselected or 0)
	return removed == 0 or lunitCountTests(cls) > 0, false, tagged
end

-- Call between test classes: yields a frame once the run has held the thread
-- for LUNIT_YIELD_BUDGET_SECONDS, so one long stretch of classes cannot freeze
-- Studio, without paying a whole frame after every quick class.
local LUNIT_YIELD_BUDGET_SECONDS = 0.05
local lunitLastYield = os.clock()
local function lunitYieldBetweenClasses()
	if os.clock() - lunitLastYield >= LUNIT_YIELD_BUDGET_SECONDS then
		task.wait()
		lunitLastYield = os.clock()
	end
end`;
}
