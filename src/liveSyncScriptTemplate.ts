import { buildLuauEmitHelpers } from './luauEmitHelpers';

/** One detached snapshot and one require cache per job. See docs/live-sync.md. */
export function buildLiveSyncJobScript(): string {
	return `--!strict
local owner = ...
if owner == nil then
	return "[lunit] ERROR: the loaded Studio bridge is outdated. Run Lunit: Install Roblox Studio Live-Sync Plugin in VS Code, then reload LunitStudioBridge in Studio (PluginDebugService > Save and Reload Plugin)."
end
${buildLuauEmitHelpers()}
local started = os.clock()
local root = Instance.new("Folder")
root.Name = "LunitRun"
owner.root = root
local copies, sources, cache, loading = {}, {}, {}, {}
local globals, sharedGlobals = {}, {}
local closed = false
local threads = {}
local function log(message)
	local line = "[lunit] " .. message
	print(line)
	table.insert(LUNIT_OUTPUT_BUFFER, line)
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
	table.clear(cache)
	table.clear(loading)
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
		copy.Source = instance.Source
		sources[copy] = copy.Source
	elseif instance:IsA("Folder") or parent == game then
		copy = Instance.new("Folder")
	else
		error("isolation: unsupported module ancestor " .. instance:GetFullName() .. " (" .. instance.ClassName .. "); use Folder/ModuleScript module roots")
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
	if sources[module] == nil then error("isolation: import outside snapshot: " .. target:GetFullName()) end
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
	if not ok then value = module:GetFullName() .. ": " .. tostring(value) end
	cache[module] = { ok = ok, value = value }
	if not ok then error(value, 0) end
	return value
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
	for _, instance in originals do
		if instance:IsA("ModuleScript") then snapshot(instance) end
	end
	-- Include empty folders used by package lookup, without Scripts or world assets.
	for _, instance in originals do
		if instance:IsA("Folder") and copies[instance.Parent] then snapshot(instance) end
	end
	log(string.format("live-sync setup %.2f ms (%d tests)", (os.clock() - started) * 1000, #tests))
	local loadStart = os.clock()
	local runtime = isolatedRequire(runtimes[1])
	-- Normalize import contexts/targets BEFORE RuntimeLib touches _G or its
	-- registeredLibraries table, preserving a single identity for absolute imports.
	local import = runtime.import
	runtime.import = function(context, target, ...)
		return import(copies[context] or context, copies[target] or target, ...)
	end
	local framework = frameworks[1]:FindFirstChild("out") or frameworks[1]
	local lunit = runtime.import(copies[runtimes[1]], copies[framework])
	loadSeconds += os.clock() - loadStart
	for _, original in tests do
		loadStart = os.clock()
		local loaded, cls = pcall(runtime.import, copies[runtimes[1]], copies[original])
		loadSeconds += os.clock() - loadStart
		if not loaded then
			log("ERROR: failed to load test module " .. original:GetFullName() .. ": " .. tostring(cls))
		elseif cls ~= nil then
			local executionStart = os.clock()
			local ran, err = pcall(lunitRunClass, lunit, cls, tostring(cls))
			executionSeconds += os.clock() - executionStart
			if not ran then log("ERROR: test runner failed: " .. tostring(err)) end
		end
	end
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
