import { BLOCK_MARKER, MODULES_MARKER } from './luneBlockProtocol';

/**
 * Lune-only Luau (it needs `@lune/serde` and `@lune/fs`) shared by the two
 * generated Lune runners, on top of luauEmitHelpers.ts. It implements the
 * worker side of luneBlockProtocol.ts:
 *
 * - `lunitDescribeClass(cls, className)`: the compiled Lunit metadata of one
 *   loaded class, in the shape the planner (luneBlocks.ts) reads.
 * - `lunitEmitModules(listing)`: the `--list` step's one-line JSON answer.
 * - `lunitReadJob(path)`: decodes a worker job file, exiting 2 if it cannot.
 * - `lunitApplyJob(cls, spec)`: narrows a class to the job's methods (or one
 *   `@Each` row), keeping every lifecycle hook, and reports a spec that
 *   names a method or row the compiled class does not have.
 * - `lunitRunJob(job, loadModule, lunit)`: loads and runs the job's modules
 *   in order inside this VM, attributing a module that fails to load, exports
 *   the wrong class, or whose test run throws, to that module rather than
 *   letting it take the whole worker down.
 * - `lunitEmitBlockSummary(...)`: the closing `@@LUNIT_BLOCK@@` line.
 *
 * Expects `process` (from `@lune/process`) and `lunitRunClass` /
 * `LUNIT_OUTPUT_BUFFER` (luauEmitHelpers.ts) to be in scope.
 */
export function buildLuauBlockHelpers(): string {
	return `local lunitSerde = require("@lune/serde")
local lunitFs = require("@lune/fs")

local LUNIT_MODULES_MARKER = "${MODULES_MARKER}"
local LUNIT_BLOCK_MARKER = "${BLOCK_MARKER}"

local function lunitStringList(value)
	local out = {}
	if type(value) == "table" then
		for _, entry in value do
			if type(entry) == "string" then
				table.insert(out, entry)
			end
		end
	end
	return out
end

local function lunitIsDisabled(metadata)
	return type(metadata) == "table" and type(metadata.disabled) == "table" and metadata.disabled.value == true
end

local function lunitDescribeClass(cls, className)
	local classMetadata = if type(cls["lunit:class"]) == "table" then cls["lunit:class"] else {}
	local methods = {}
	for name, method in cls["lunit:method:test"] or {} do
		local options = if type(method) == "table" and type(method.options) == "table" then method.options else {}
		table.insert(methods, {
			name = tostring(name),
			isTest = options.isTest == true,
			tags = lunitStringList(options.tags),
			displayName = if type(options.displayName) == "string" then options.displayName else nil,
			cases = if type(options.cases) == "table" then #options.cases else nil,
			lifecycles = lunitStringList(options.lifecycles),
			ordered = options.order ~= nil,
			only = options.only == true,
			disabled = lunitIsDisabled(options),
		})
	end
	table.sort(methods, function(a, b)
		return a.name < b.name
	end)
	return {
		className = className,
		tags = lunitStringList(classMetadata.tags),
		displayName = if type(classMetadata.displayName) == "string" then classMetadata.displayName else nil,
		disabled = lunitIsDisabled(classMetadata),
		methods = methods,
	}
end

local function lunitEmitModules(listing)
	print(LUNIT_MODULES_MARKER .. lunitSerde.encode("json", listing))
end

local function lunitReadJob(path)
	if path == nil or path == "" then
		print("[lunit] ERROR: --job needs the path of a job file.")
		process.exit(2)
	end
	local ok, job = pcall(function()
		return lunitSerde.decode("json", lunitFs.readFile(path))
	end)
	if not ok or type(job) ~= "table" or type(job.modules) ~= "table" then
		print("[lunit] ERROR: could not read the job file " .. tostring(path) .. ": " .. tostring(job))
		process.exit(2)
	end
	return job
end

-- Returns nil, or a message when the spec does not match the compiled class.
local function lunitApplyJob(cls, spec)
	if spec == nil or spec.all == true then
		return nil
	end
	local methods = cls["lunit:method:test"]
	if type(methods) ~= "table" then
		return "the class has no test metadata"
	end
	local wanted = if type(spec.methods) == "table" then spec.methods else {}
	for name, keep in wanted do
		local method = methods[name]
		if method == nil or type(method.options) ~= "table" or not method.options.isTest then
			return 'no @Test method named "' .. tostring(name) .. '"'
		end
		if type(keep) == "number" then
			local cases = method.options.cases
			if type(cases) ~= "table" or cases[keep] == nil then
				return '@Test method "' .. tostring(name) .. '" has no @Each row ' .. tostring(keep)
			end
		end
	end
	for name, method in methods do
		local options = method.options
		if type(options) == "table" and options.isTest then
			local keep = wanted[name]
			if keep == nil then
				-- Hooks (isTest false) stay: BeforeEach/AfterEach belong to every case.
				methods[name] = nil
			elseif type(keep) == "number" then
				options.cases = { options.cases[keep] }
			end
		end
	end
	return nil
end

local function lunitRunJob(job, loadModule, lunit)
	local started = os.clock()
	local failed = 0
	local loadFailures = {}
	local function loadFailure(path, message)
		print("[lunit] ERROR: failed to load test module " .. tostring(path) .. ": " .. message)
		table.insert(loadFailures, { path = tostring(path), error = message })
	end
	for _, entry in job.modules do
		local ok, cls = pcall(loadModule, entry.path)
		if not ok then
			loadFailure(entry.path, tostring(cls))
		elseif type(cls) ~= "table" then
			loadFailure(entry.path, "the module did not return a test class (it must 'export =' the class)")
		elseif type(entry.className) == "string" and tostring(cls) ~= entry.className then
			loadFailure(entry.path, 'expected the module to export the class "' .. entry.className .. '" but it exported "' .. tostring(cls) .. '"')
		else
			local specError = lunitApplyJob(cls, entry.spec)
			if specError ~= nil then
				loadFailure(entry.path, "the block's selection does not match the compiled class: " .. specError)
			else
				local ranOk, classFailed, result = pcall(lunitRunClass, lunit, cls, tostring(cls))
				if not ranOk then
					loadFailure(entry.path, "running the test class threw: " .. tostring(classFailed))
				elseif type(result) == "table" and type(result.numTestsFailed) == "number" then
					failed += result.numTestsFailed
				elseif classFailed then
					failed += 1
				end
			end
		end
	end
	return failed, loadFailures, (os.clock() - started) * 1000
end

local function lunitEmitBlockSummary(block, failed, loadFailures, elapsedMs)
	print(LUNIT_BLOCK_MARKER .. lunitSerde.encode("json", {
		block = tostring(block),
		results = #LUNIT_OUTPUT_BUFFER,
		failed = failed,
		loadFailures = loadFailures,
		elapsedMs = math.floor(elapsedMs + 0.5),
	}))
end`;
}
