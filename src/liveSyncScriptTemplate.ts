import { buildLuauEmitHelpers } from './luauEmitHelpers';
import { buildLuauTestFilterHelpers, luauString, SlowTestFilter, TestSelection } from './luauTestFilterTemplate';
import { LIVE_RESULT_MARKER, LIVE_START_MARKER } from './resultProtocol';

export interface LiveSyncJobOptions {
	/** Narrows the run to an explicit Test Explorer request; undefined runs everything. */
	selection?: TestSelection;
	/** Slow tests to leave out unless named explicitly; see luauTestFilterTemplate.ts. */
	slow?: SlowTestFilter;
	/** Whole-run watchdog (the extension's live-sync timeout): no new module starts, and a running class is cancelled, after this. */
	deadlineSeconds?: number;
	/** One test module's load (with its imports) is abandoned after this long. */
	loadTimeoutSeconds?: number;
	/** A test that holds Studio at least this long gets a WARNING line; 0 turns the warning off. */
	slowTestWarningSeconds?: number;
	/**
	 * ModuleScript names (file basenames without extension) holding the
	 * selected tests. Other test modules are never loaded at all. Undefined
	 * loads every test module.
	 */
	selectedModules?: readonly string[];
}

/** The ModuleScript name a test file compiles to: its basename without the source extension. */
export function moduleNameForTestFile(file: string): string {
	const base = file.replace(/\\/g, '/').split('/').pop() ?? file;
	return base.replace(/\.(tsx?|luau|lua)$/i, '');
}

function seconds(value: number | undefined, fallback: number, min: number): number {
	return value !== undefined && Number.isFinite(value) ? Math.max(min, value) : fallback;
}

/**
 * One detached snapshot and one require cache per job. See docs/live-sync.md.
 * Tests tagged @Tag("Lune") are left out; see luauTestFilterTemplate.ts.
 */
export function buildLiveSyncJobScript(options: LiveSyncJobOptions = {}): string {
	const selected = options.selectedModules
		? `{ ${[...new Set(options.selectedModules)].map((name) => `[${luauString(name)}] = true`).join(', ')} }`
		: 'nil';
	return `--!strict
local owner = ...
-- Protocol 3: the plugin streams owner.output and owner.currentTest in its
-- heartbeats and provides owner.announce (see studioPluginTemplate.ts).
if owner == nil or type(owner.protocol) ~= "number" or owner.protocol < 3 then
	return "[lunit] ERROR: the loaded Studio bridge is outdated. Run Lunit: Install Roblox Studio Live-Sync Plugin in VS Code, then reload LunitStudioBridge in Studio (PluginDebugService > Save and Reload Plugin)."
end
${buildLuauEmitHelpers()}
${buildLuauTestFilterHelpers('Lune', options.selection, options.slow)}
local DEADLINE_SECONDS = ${Math.floor(seconds(options.deadlineSeconds, 30, 0))}
local LOAD_TIMEOUT_SECONDS = ${seconds(options.loadTimeoutSeconds, 10, 0.05)}
local SLOW_TEST_WARNING_SECONDS = ${seconds(options.slowTestWarningSeconds, 5, 0)}
local SELECTED_MODULES = ${selected}
local started = os.clock()
local root = Instance.new("Folder")
root.Name = "LunitRun"
owner.root = root
-- The plugin streams new lines from this buffer with each heartbeat, so a run
-- VS Code has to release still keeps the results that came in before.
owner.output = LUNIT_OUTPUT_BUFFER
-- Reported in heartbeats: "loading" during setup, "tests" once test modules
-- load and run. A silence in "tests" is read as a busy test, not a dead Studio.
owner.phase = "loading"
local copies, sources, cache, loading = {}, {}, {}, {}
-- Modules being loaded, outermost first: names where a timed-out load stalled.
local loadOrder = {}
-- Stand-ins for what the snapshot leaves out, so code that finds a child by
-- name (WaitForChild, TS.import) gets an answer instead of yielding for ever:
-- a stub ModuleScript per skipped module (requiring it fails with the reason)
-- and a Folder per unsupported ancestor such a stub needs.
local stubs, standIns = {}, {}
-- Engine containers that hold project code but are neither Folders nor direct
-- DataModel children. roblox-ts game projects keep all client code (and so all
-- client tests) under StarterPlayer.StarterPlayerScripts. A same-named Folder
-- stands in for them so require-by-path still resolves. Deliberately a closed
-- list: a Model or Script ancestor stays unsupported.
local NESTED_CONTAINERS = {StarterPlayerScripts = true, StarterCharacterScripts = true}
-- Modules left out of the snapshot, by original instance, with the reason.
local skipped, skippedOrder = {}, {}
local SKIPPED_REPORT_LIMIT = 5
local globals, sharedGlobals = {}, {}
local closed = false
local threads = {}
local function log(message)
	local line = "[lunit] " .. message
	print(line)
	table.insert(LUNIT_OUTPUT_BUFFER, line)
end
-- A snapshot instance's path as the place names it (without "LunitRun.").
local function displayName(instance)
	local name = instance:GetFullName()
	if name:sub(1, 9) == "LunitRun." then return name:sub(10) end
	return name
end
-- Runs fn(...) on its own thread and waits for it at most timeout seconds,
-- so nothing it yields on -- a WaitForChild that never returns, an await that
-- never resolves -- can hold this job. Returns "ok" or "error" with the value,
-- or "timeout" with the cancelled thread's traceback.
-- The job thread is woken through the host task.defer, never resumed inside
-- the worker's (or a Promise resolver's) stack, and only once. One watchdog
-- thread, alive only while a wait is pending, enforces every timeout, rather
-- than a timer per call.
local pendingWaits = {}
local watchdogThread = nil
local function watchdog()
	while not closed and next(pendingWaits) ~= nil do
		task.wait(0.05)
		local now = os.clock()
		for state, deadline in pendingWaits do
			if now >= deadline then
				pendingWaits[state] = nil
				state.wake()
			end
		end
	end
	threads[coroutine.running()] = nil
	watchdogThread = nil
end
local function bounded(timeout, fn, ...)
	local args = table.pack(...)
	local waiter = coroutine.running()
	local state = { done = false, ok = false, value = nil, waiting = false, woken = false }
	function state.wake()
		if state.waiting and not state.woken then
			state.woken = true
			task.defer(waiter)
		end
	end
	local thread = coroutine.create(function()
		state.ok, state.value = pcall(fn, table.unpack(args, 1, args.n))
		state.done = true
		state.wake()
	end)
	threads[thread] = true
	task.spawn(thread)
	if not state.done then
		state.waiting = true
		pendingWaits[state] = os.clock() + timeout
		if watchdogThread == nil then
			watchdogThread = coroutine.create(watchdog)
			threads[watchdogThread] = true
			task.spawn(watchdogThread)
		end
		coroutine.yield()
		pendingWaits[state] = nil
	end
	threads[thread] = nil
	if not state.done then
		local trace = debug.traceback(thread)
		pcall(task.cancel, thread)
		return "timeout", trace
	end
	return state.ok and "ok" or "error", state.value
end
-- Names where a cancelled thread stalled: the snapshot module and line its
-- traceback points at, and the child it waits for when that line calls
-- WaitForChild.
local function describeStall(trace)
	local byName = {}
	for copy, source in sources do byName[copy:GetFullName()] = source end
	for line in string.gmatch(tostring(trace or ""), "[^\\n]+") do
		-- Roblox prints "LunitRun.A.b:12"; plain Luau wraps it as [string "..."]:12.
		local chunk, lineNumber = line:match('^%s*%[string "(.-)"%]:(%d+)')
		if not chunk then chunk, lineNumber = line:match("^%s*(.-):(%d+)") end
		local source = chunk and byName[chunk]
		if source then
			local wanted, current, text = tonumber(lineNumber), 0, nil
			for sourceLine in (source .. "\\n"):gmatch("([^\\n]*)\\n") do
				current += 1
				if current == wanted then text = sourceLine break end
			end
			local where = (chunk:sub(1, 9) == "LunitRun." and chunk:sub(10) or chunk) .. ":" .. lineNumber
			local child = text and text:match([=[WaitForChild%(%s*["']([^"']+)["']]=])
			if child then return 'waiting on child "' .. child .. '" at ' .. where end
			return "stalled at " .. where
		end
	end
	if #loadOrder > 0 then return "stalled in " .. displayName(loadOrder[#loadOrder]) end
	return "stalled"
end
-- After a load timed out: every module still mid-load belongs to it (loads
-- run one at a time). Cache them as failed, so another test importing one
-- fails at once instead of waiting out the same timeout again.
local function abandonLoads(message)
	for module in loading do
		cache[module] = { ok = false, value = displayName(module) .. ": " .. message }
	end
	table.clear(loading)
	table.clear(loadOrder)
end
local function cleanup()
	closed = true
	for thread in threads do
		if thread ~= coroutine.running() and coroutine.status(thread) ~= "dead" then
			pcall(task.cancel, thread)
		end
	end
	table.clear(threads)
	root:Destroy()
	owner.root = nil
	table.clear(copies)
	table.clear(sources)
	table.clear(skipped)
	table.clear(skippedOrder)
	table.clear(stubs)
	table.clear(standIns)
	table.clear(cache)
	table.clear(loading)
	table.clear(loadOrder)
	table.clear(pendingWaits)
	watchdogThread = nil
	table.clear(globals)
	table.clear(sharedGlobals)
end
owner.cleanup = cleanup
local isolatedCoroutine = table.clone(coroutine)
isolatedCoroutine.create = function(callback)
	if closed then error("isolation: run has ended") end
	local thread = coroutine.create(callback)
	threads[thread] = true
	return thread
end
isolatedCoroutine.wrap = function(callback)
	local thread = isolatedCoroutine.create(callback)
	return function(...)
		local result = table.pack(coroutine.resume(thread, ...))
		if not result[1] then error(result[2]) end
		return table.unpack(result, 2, result.n)
	end
end
local function snapshot(instance)
	if instance == game then return root end
	if copies[instance] then return copies[instance] end
	local parent = instance.Parent
	if parent == nil then error("isolation: module hierarchy was removed during snapshot") end
	local parentCopy = snapshot(parent)
	local copy
	if instance:IsA("ModuleScript") then
		copy = Instance.new("ModuleScript")
		-- Source is deliberately not copied onto the clone: Roblox refuses large
		-- Source assignments (around 200,000 characters), and the loader compiles
		-- sources[] directly, so the clone never needs it.
		sources[copy] = instance.Source
	elseif instance:IsA("Folder") or parent == game or NESTED_CONTAINERS[instance.ClassName]
		or instance:IsA("LuaSourceContainer") then
		-- A Script/LocalScript holding helper ModuleScripts is ordinary Roblox.
		-- The snapshot never copies or activates one, so a same-named Folder
		-- stand-in preserves the hierarchy require-by-path needs without
		-- changing execution semantics.
		copy = Instance.new("Folder")
	else
		error("isolation: unsupported module ancestor " .. instance:GetFullName() .. " (" .. instance.ClassName .. "); use Folder/ModuleScript module roots", 0)
	end
	copy.Name = instance.Name
	copies[instance] = copy
	for key, value in instance:GetAttributes() do copy:SetAttribute(key, value) end
	copy.Parent = parentCopy
	return copy
end
local isolatedRequire
local base = getfenv()
local isolatedTask = table.clone(task)
for _, name in { "spawn", "defer", "delay" } do
	isolatedTask[name] = function(callback, ...)
		if closed then error("isolation: run has ended") end
		local thread
		if name == "delay" then
			local args = table.pack(...)
			local target = args[1]
			thread = type(target) == "thread" and target or coroutine.create(target)
			threads[thread] = true
			task.delay(callback, thread, table.unpack(args, 2, args.n))
		else
			thread = type(callback) == "thread" and callback or coroutine.create(callback)
			threads[thread] = true
			task[name](thread, ...)
		end
		return thread
	end
end
-- Match Roblox require-by-string paths, resolving only inside the snapshot.
local function resolvePath(context, path)
	local current, rest
	if path:sub(1, 6) == "@self/" then
		current, rest = context, path:sub(7)
	elseif path:sub(1, 6) == "@game/" then
		current, rest = root, path:sub(7)
	elseif path:sub(1, 2) == "./" then
		current, rest = context.Parent, path:sub(3)
	elseif path:sub(1, 3) == "../" then
		current, rest = context.Parent, path
	else
		error("isolation: unsupported require path " .. path, 0)
	end
	for _, part in string.split(rest, "/") do
		if current == nil or part == "" then error("isolation: missing require path " .. path, 0) end
		if part == ".." then
			current = current.Parent
		elseif part ~= "." then
			current = current:FindFirstChild(part)
		end
	end
	if current == nil then error("isolation: missing require path " .. path, 0) end
	return current
end
isolatedRequire = function(target)
	if closed then error("isolation: run has ended") end
	if typeof(target) ~= "Instance" or not target:IsA("ModuleScript") then
		error("isolation: only snapshotted ModuleScript imports are supported (no asset require); received " .. typeof(target) .. " " .. tostring(target), 0)
	end
	-- Absolute game:GetService paths still return real Instances. Canonicalize
	-- their module targets here; never fall back to Roblox's session cache.
	local module = copies[target] or target
	if sources[module] == nil then
		-- A module the pre-pass had to leave out is only an error once something
		-- actually imports it -- report it here, against the importer, with the
		-- reason it was skipped. Its stub is what WaitForChild/TS.import found.
		local reason = skipped[target] or stubs[module]
		if reason ~= nil then error("isolation: " .. displayName(module) .. " is outside the snapshot: " .. reason, 0) end
		error("isolation: import outside snapshot: " .. target:GetFullName())
	end
	while loading[module] do
		if loading[module] == coroutine.running() then error("isolation: circular require: " .. module:GetFullName()) end
		task.wait()
		if closed then error("isolation: run has ended") end
	end
	local entry = cache[module]
	if entry then
		if not entry.ok then error(entry.value, 0) end
		return entry.value
	end
	loading[module] = coroutine.running()
	table.insert(loadOrder, module)
	local ok, value = pcall(function()
		local fn, err = loadstring(sources[module], "=" .. module:GetFullName())
		if not fn then error(err) end
		local env = setmetatable({
			script = module, require = function(target)
				return isolatedRequire(type(target) == "string" and resolvePath(module, target) or target)
			end, _G = globals, shared = sharedGlobals,
			task = isolatedTask, coroutine = isolatedCoroutine,
			spawn = isolatedTask.spawn, delay = isolatedTask.delay,
		}, { __index = base })
		setfenv(fn, env)
		local result = table.pack(fn())
		-- A single nil is a valid cached export (e.g. UI Labs type modules).
		if result.n ~= 1 then error("ModuleScript must return exactly one value; got " .. result.n, 0) end
		return result[1]
	end)
	loading[module] = nil
	local position = table.find(loadOrder, module)
	if position then table.remove(loadOrder, position) end
	if not ok then value = module:GetFullName() .. ": " .. tostring(value) end
	cache[module] = { ok = ok, value = value }
	if not ok then error(value, 0) end
	return value
end
-- Per-test hooks for one class. Before each test (and @Each row) the job
-- yields if it has held Studio past the yield budget, so the plugin can get a
-- heartbeat out, then records the test as owner.currentTest and announces it:
-- VS Code then knows a silence that follows is a busy test, not a dead Studio,
-- and which test it is. After the test it warns when the test took long
-- enough to matter.
-- Both also stream a line (start, and this try's result) into the output the
-- plugin sends with its heartbeats, so VS Code can tick each test off as it
-- finishes. These lines are not printed, and the per-class result lines stay
-- the final word.
local LIVE_START_MARKER = "${LIVE_START_MARKER}"
local LIVE_RESULT_MARKER = "${LIVE_RESULT_MARKER}"
local function testHooks(className)
	local testStarted = os.clock()
	return {
		onTestStart = function(label)
			lunitYieldBetweenClasses()
			owner.currentTest = className .. " > " .. tostring(label)
			table.insert(LUNIT_OUTPUT_BUFFER, LIVE_START_MARKER .. lunitB64Encode(className) .. "\\t" .. lunitB64Encode(label))
			testStarted = os.clock()
			owner.currentTestStarted = testStarted
			if type(owner.announce) == "function" then pcall(owner.announce) end
		end,
		onTestEnd = function(label, testResult)
			local took = os.clock() - testStarted
			owner.currentTest = nil
			if type(testResult) == "table" then
				local status = testResult.skipped and "skipped" or (testResult.passed and "passed" or "failed")
				table.insert(LUNIT_OUTPUT_BUFFER, LIVE_RESULT_MARKER .. table.concat({
					lunitB64Encode(className),
					lunitB64Encode(testResult.label or label),
					status,
					tostring(math.floor((testResult.elapsedTimeMs or 0) + 0.5)),
					testResult.errorMessage ~= nil and lunitB64Encode(testResult.errorMessage) or "",
				}, "\\t"))
			end
			if SLOW_TEST_WARNING_SECONDS > 0 and took >= SLOW_TEST_WARNING_SECONDS then
				log(string.format("WARNING: slow test %s > %s took %.1f s. A test that runs this long without yielding blocks Studio (and the bridge heartbeat); tag it Slow or make it yield. (lunit.studio.slowTestWarningSeconds)",
					className, tostring(label), took))
			end
		end,
	}
end
local loadSeconds, executionSeconds = 0, 0
local ok, failure = xpcall(function()
	log("isolation: Folder/ModuleScript trees; real services remain live. Tests must disconnect service events and dispose external resources in teardown.")
	local tests, runtimes, frameworks = {}, {}, {}
	-- Only original DataModel instances are discovered. The snapshot is detached.
	local originals = {}
	for _, instance in game:GetDescendants() do
		local ancestor = instance
		local projectInstance = true
		while ancestor and ancestor ~= game do
			if ancestor:IsA("Plugin") or (ancestor.Parent == game and ancestor.Name == "PluginDebugService") then
				projectInstance = false
				break
			end
			ancestor = ancestor.Parent
		end
		if projectInstance then table.insert(originals, instance) end
	end
	for _, instance in originals do
		if instance:IsA("ModuleScript") then
			if instance.Name == "RuntimeLib" then table.insert(runtimes, instance) end
			if (instance.Name:match("%.test$") or instance.Name:match("%.spec$"))
				and (instance.Parent == nil or instance.Parent.Name ~= "forks") then
				table.insert(tests, instance)
			end
		end
		if instance.Name == "lunit" and instance.Parent and instance.Parent.Name == "@rbxts" then
			table.insert(frameworks, instance)
		end
	end
	if #runtimes ~= 1 or #frameworks ~= 1 then
		error("isolation: expected exactly one RuntimeLib and @rbxts/lunit; found " .. #runtimes .. " and " .. #frameworks .. "; multiple runtime/package layouts are unsupported")
	end
	if #tests == 0 then error("no *.test / *.spec ModuleScripts found anywhere in this place") end
	-- A selected run loads only the modules holding the selected tests, so a
	-- module elsewhere that cannot load (or hangs loading) cannot touch it. If
	-- no module name matches, load them all rather than run nothing.
	if SELECTED_MODULES ~= nil then
		local narrowed = {}
		for _, test in tests do
			if SELECTED_MODULES[test.Name] then table.insert(narrowed, test) end
		end
		if #narrowed > 0 then
			if #narrowed < #tests then
				log("loading " .. #narrowed .. " of " .. #tests .. " test module(s): the ones holding the selected tests.")
			end
			tests = narrowed
		end
	end
	-- Snapshotting every module in the place is what makes an unrelated tree
	-- able to break a run, so a failure here only takes that module out of the
	-- snapshot. Anything the run actually needs still fails hard below, where
	-- the recorded reason is reported against whatever asked for it.
	for _, instance in originals do
		if instance:IsA("ModuleScript") then
			local snapshotOk, failure = pcall(snapshot, instance)
			if not snapshotOk then
				local lengthOk, length = pcall(function() return #instance.Source end)
				skipped[instance] = tostring(failure) .. (lengthOk and (" [" .. length .. " characters of source]") or "")
				table.insert(skippedOrder, instance)
			end
		end
	end
	-- Include empty folders used by package lookup, without Scripts or world assets.
	for _, instance in originals do
		if instance:IsA("Folder") and copies[instance.Parent] then snapshot(instance) end
	end
	-- A stub stands where each skipped module was, so WaitForChild and
	-- TS.import find it and requiring it fails with the reason. A stub under
	-- an unsupported ancestor gets Folder stand-ins for that ancestry.
	local function standInFor(instance)
		if instance == game then return root end
		local existing = copies[instance] or standIns[instance]
		if existing then return existing end
		local parent = instance.Parent
		if parent == nil then return nil end
		local parentCopy = standInFor(parent)
		if parentCopy == nil then return nil end
		local folder = Instance.new("Folder")
		folder.Name = instance.Name
		folder.Parent = parentCopy
		standIns[instance] = folder
		return folder
	end
	for _, instance in skippedOrder do
		local parentCopy = instance.Parent and standInFor(instance.Parent)
		if parentCopy then
			local stub = Instance.new("ModuleScript")
			stub.Name = instance.Name
			stub.Parent = parentCopy
			stubs[stub] = skipped[instance]
		end
	end
	-- Every other child of a snapshotted container (a LocalScript, Script,
	-- Actor, value object, RemoteEvent, Model...) gets an empty same-class,
	-- same-name placeholder, so code waiting for it by name gets an answer.
	-- Scripts among them are disabled and have no source; nothing is copied
	-- from the world beyond name, attributes and a value object's Value.
	local placeholders = 0
	for _, instance in originals do
		local parentCopy = copies[instance.Parent]
		if parentCopy ~= nil and copies[instance] == nil and standIns[instance] == nil
			and not instance:IsA("ModuleScript") then
			local created, placeholder = pcall(Instance.new, instance.ClassName)
			if not created then placeholder = Instance.new("Folder") end
			pcall(function() if placeholder:IsA("BaseScript") then placeholder.Enabled = false end end)
			pcall(function() if placeholder:IsA("ValueBase") then placeholder.Value = instance.Value end end)
			pcall(function() for key, value in instance:GetAttributes() do placeholder:SetAttribute(key, value) end end)
			placeholder.Name = instance.Name
			placeholder.Parent = parentCopy
			placeholders += 1
		end
	end
	if #skippedOrder > 0 then
		-- One capped line, not one per module: a large place can carry many.
		local names = {}
		for index = 1, math.min(#skippedOrder, SKIPPED_REPORT_LIMIT) do
			local instance = skippedOrder[index]
			table.insert(names, instance:GetFullName() .. " (" .. skipped[instance] .. ")")
		end
		local remaining = #skippedOrder - #names
		log("WARNING: " .. #skippedOrder .. " module(s) skipped: "
			.. table.concat(names, "; ") .. (remaining > 0 and ("; and " .. remaining .. " more") or "")
			.. ". Each is left in the snapshot as a stub; a test that requires one fails with that reason.")
	end
	log(string.format("live-sync setup %.2f ms (%d tests, %d non-module placeholder(s))", (os.clock() - started) * 1000, #tests, placeholders))
	-- Loads one module tree with the load timeout. A load that times out is
	-- cancelled; its modules are cached as failed with where it stalled.
	local function boundedLoad(label, fn, ...)
		local status, value = bounded(LOAD_TIMEOUT_SECONDS, fn, ...)
		if status == "timeout" then
			local message = "timed out after " .. LOAD_TIMEOUT_SECONDS .. " s loading " .. label .. " (" .. describeStall(value) .. ")"
			abandonLoads(message)
			return false, message
		end
		return status == "ok", value
	end
	local framework = frameworks[1]:FindFirstChild("out") or frameworks[1]
	-- The runtime and the framework are needed by every test, so a skip here is
	-- fatal rather than a warning.
	for _, required in { runtimes[1], framework } do
		if copies[required] == nil then
			error("isolation: " .. required:GetFullName() .. " could not be snapshotted: "
				.. tostring(skipped[required] or "it is outside the snapshot"))
		end
	end
	local loadStart = os.clock()
	local runtimeLoaded, runtime = boundedLoad(runtimes[1]:GetFullName(), isolatedRequire, runtimes[1])
	if not runtimeLoaded then error(runtime, 0) end
	-- Normalize import contexts/targets BEFORE RuntimeLib touches _G or its
	-- registeredLibraries table, preserving a single identity for absolute imports.
	-- The path is resolved here too: RuntimeLib reaches each part through
	-- WaitForChild, and nothing is ever added to the snapshot, so a missing
	-- part fails now instead of waiting for ever.
	local import = runtime.import
	runtime.import = function(context, target, ...)
		local resolved = copies[target] or target
		if typeof(resolved) == "Instance" and (resolved == root or resolved:IsDescendantOf(root)) then
			local current = resolved
			for index = 1, select("#", ...) do
				local name = select(index, ...)
				local child = current:FindFirstChild(name)
				if child == nil then
					error('isolation: ' .. displayName(current) .. ' has no child "' .. tostring(name)
						.. '" in the snapshot, so importing it would wait for ever', 0)
				end
				current = child
			end
		end
		return import(copies[context] or context, resolved, ...)
	end
	local lunitLoaded, lunit = boundedLoad("@rbxts/lunit", runtime.import, copies[runtimes[1]], copies[framework])
	if not lunitLoaded then error(lunit, 0) end
	loadSeconds += os.clock() - loadStart
	owner.phase = "tests"
	local classesLeftOut, testsLeftOut, slowLeftOut = 0, 0, 0
	for index, original in tests do
		-- Whole-run watchdog: VS Code stops waiting a little after this, so
		-- stop starting modules by then too.
		if os.clock() - started >= DEADLINE_SECONDS then
			log(string.format("ERROR: stopped after %d s, the live-sync timeout; %d test module(s) not run.",
				DEADLINE_SECONDS, #tests - index + 1))
			break
		end
		loadStart = os.clock()
		-- A test under an unsupported ancestor is reported as that test failing
		-- to load, never quietly dropped from the results.
		local loaded, cls
		local copy = copies[original]
		if copy ~= nil and lunitSourceHasClassTag(sources[copy]) then
			-- Class-level @Tag("Lune"): never loaded.
			classesLeftOut += 1
			loaded, cls = true, nil
		elseif copy == nil then
			loaded, cls = false, tostring(skipped[original] or "isolation: module is outside the snapshot")
		else
			loaded, cls = boundedLoad(original:GetFullName(), runtime.import, copies[runtimes[1]], copy)
		end
		loadSeconds += os.clock() - loadStart
		if not loaded then
			log("ERROR: failed to load test module " .. original:GetFullName() .. ": " .. tostring(cls))
		elseif type(cls) == "table" then
			local className = tostring(cls)
			local run, classLeftOut, methodsLeftOut, slowMethodsLeftOut = lunitFilterClass(cls, className)
			if classLeftOut then classesLeftOut += 1 end
			testsLeftOut += methodsLeftOut
			slowLeftOut += slowMethodsLeftOut
			if run then
				local executionStart = os.clock()
				local remaining = DEADLINE_SECONDS - (os.clock() - started)
				local status, err = bounded(math.max(remaining, 0), lunitRunClass, lunit, cls, className, testHooks(className))
				owner.currentTest = nil
				executionSeconds += os.clock() - executionStart
				if status == "timeout" then
					log(string.format("ERROR: test class %s was still running at the %d s live-sync timeout and was cancelled (%s); %d test module(s) not run.",
						className, DEADLINE_SECONDS, describeStall(err), #tests - index))
					break
				elseif status == "error" then
					log("ERROR: test runner failed: " .. tostring(err))
				end
				-- Host task API: yield to Studio between classes.
				lunitYieldBetweenClasses()
			end
		end
	end
	if classesLeftOut > 0 or testsLeftOut > 0 then
		log("left out " .. classesLeftOut .. " " .. LUNIT_EXCLUDED_TAG .. "-tagged test class(es) and "
			.. testsLeftOut .. " " .. LUNIT_EXCLUDED_TAG .. "-tagged test(s): run them with the Lune profile.")
	end
	if slowLeftOut > 0 then log(lunitSlowLeftOutNote(slowLeftOut)) end
end, debug.traceback)
if not ok then log("ERROR: " .. tostring(failure)) end
local cleanupStart = os.clock()
-- Promise awaiters can resume this job synchronously inside _resolve. Yield
-- out of that resume stack before closing the environment: the resolver still
-- needs to run its finally callbacks and schedule its own thread disposal.
-- Use the host task API, not the run-owned scheduler that cleanup will cancel.
task.wait()
cleanup()
owner.cleanup = nil
log(string.format("live-sync loading %.2f ms; execution %.2f ms; cleanup %.2f ms",
	loadSeconds * 1000, executionSeconds * 1000, (os.clock() - cleanupStart) * 1000))
return table.concat(LUNIT_OUTPUT_BUFFER, "\\n")
`;
}
