-- The live-sync job must never hang: a module waiting on a child the
-- snapshot lacks, a module too large to copy, a test class that never ends.
-- Each case ends with the run reporting errors, the rest of the run going
-- ahead, and the next run starting cleanly.
--   args[1]: job built with loadTimeoutSeconds = 0.5
--   args[2]: job built with deadlineSeconds = 1 and selectedModules = {hang.test, plain.test}
local fs = require('@lune/fs')
local luau = require('@lune/luau')
local roblox = require('@lune/roblox')
local task = require('@lune/task')
local process = require('@lune/process')

-- Lune's Instance has no WaitForChild. Studio's waits for ever (after an
-- "Infinite yield possible" warning) for a child that never comes; so does this.
roblox.implementMethod('Instance', 'WaitForChild', function(self, name)
	while true do
		local child = self:FindFirstChild(name)
		if child then return child end
		task.wait()
	end
end)

local game = roblox.Instance.new('Folder')
game.Name = 'game'
local function node(class, name, parent, source)
	local inst = roblox.Instance.new(class)
	inst.Name = name
	inst.Parent = parent
	if source then inst.Source = source end
	return inst
end
local rs = node('Folder', 'ReplicatedStorage', game)
-- Like roblox-ts's RuntimeLib: each path part is reached through WaitForChild.
node('ModuleScript', 'RuntimeLib', rs, [[
local TS = {}
function TS.import(context, module, ...)
	for i = 1, select('#', ...) do module = module:WaitForChild((select(i, ...))) end
	return require(module)
end
return TS
]])
node('ModuleScript', 'lunit', node('Folder', '@rbxts', node('Folder', 'node_modules', rs)), [[
return { TestRunner = { fromClasses = function(self, classes)
	return { run = function(self, options)
		classes[1].check()
		options.reporter:onTestEnd('check', {passed = true, label = 'check', elapsedTimeMs = 0})
		return { expect = function() return {numTestsFailed = 0} end }
	end }
end } }
]])
local testsFolder = node('Folder', 'Tests', rs)
local function testModule(name, body)
	return node('ModuleScript', name, testsFolder, 'local TS = require(game.ReplicatedStorage.RuntimeLib)\n' .. body)
end

-- 1. A 300 KB module. Studio refuses to assign a Source that large, which
-- used to leave the module out of the snapshot; it must load like any other.
local content = node('Folder', 'Content', rs)
local padding = string.rep('-- generated pose data ................................................\n', 4200)
assert(#padding > 300000)
node('ModuleScript', 'big', content, padding .. 'return { size = 1 }')
testModule('big.test', [[
local big = TS.import(script, game.ReplicatedStorage, "Content", "big")
return { check = function() assert(big.size == 1) end }
]])

-- 2. A package module waiting on a LocalScript sibling (smartbone's
-- Dependencies:WaitForChild("Runtime")) and on a value object.
local deps = node('Folder', 'Dependencies', node('Folder', 'smartbone', rs))
node('LocalScript', 'Runtime', deps, 'error("a LocalScript must never run in the snapshot")')
node('StringValue', 'Config', deps).Value = 'configured'
node('ModuleScript', 'bone', deps, [[
local runtime = script.Parent:WaitForChild("Runtime")
return { kind = runtime.ClassName, config = script.Parent:WaitForChild("Config").Value }
]])
testModule('bone.test', [[
local bone = TS.import(script, game.ReplicatedStorage, "smartbone", "Dependencies", "bone")
return { check = function() assert(bone.kind == "LocalScript" and bone.config == "configured", bone.kind) end }
]])

-- 3. A module waiting on a child that never exists: abandoned at the load
-- timeout, cached as failed so a second importer fails at once.
node('ModuleScript', 'waiter', rs, 'local x = 1\nreturn script.Parent:WaitForChild("NeverThere")')
testModule('waits.test', [[
local w = TS.import(script, game.ReplicatedStorage, "waiter")
return { check = function() end }
]])
testModule('waits2.test', [[
local w = TS.import(script, game.ReplicatedStorage, "waiter")
return { check = function() end }
]])

-- 4. TS.import of a path the snapshot does not have fails at once.
testModule('missing.test', [[
local m = TS.import(script, game.ReplicatedStorage, "nope", "deeper")
return { check = function() end }
]])

-- 5. A skipped module (unsupported ancestor) reached through TS.import's
-- WaitForChild finds a stub that fails with the reason.
node('ModuleScript', 'poses', node('Model', 'World', rs), 'return {}')
testModule('poses.test', [[
local p = TS.import(script, game.ReplicatedStorage, "World", "poses")
return { check = function() end }
]])

testModule('plain.test', 'return { check = function() end }')

local environment = {game = game, Instance = roblox.Instance, task = task, print = function() end}
environment.loadstring = function(source, name)
	local ok, result = pcall(luau.load, source, {debugName = name, environment = environment, injectGlobals = true})
	return ok and result or nil, not ok and result or nil
end

local function run(path, limit)
	local code = fs.readFile(path)
	local originalCount = #game:GetDescendants()
	local owner = {protocol = 2}
	local fn = luau.load(code, {environment = environment, injectGlobals = true})
	local finished, succeeded, output = false, false, nil
	local begin = os.clock()
	task.spawn(function()
		succeeded, output = pcall(fn, owner)
		finished = true
	end)
	while not finished and os.clock() - begin < limit do task.wait(0.01) end
	assert(finished, 'job hung past ' .. limit .. ' s')
	assert(succeeded, output)
	assert(owner.root == nil and owner.cleanup == nil, 'owner leaked')
	assert(#game:GetDescendants() == originalCount, 'original hierarchy changed')
	local results = 0
	for _ in output:gmatch('@@LUNIT_RESULT@@') do results += 1 end
	return output, results, os.clock() - begin
end
local function has(output, text)
	if not output:find(text, 1, true) then
		-- Lune shortens long error messages; print the job output in full.
		for line in output:gmatch('[^\n]+') do
			if not line:find('@@LUNIT_RESULT@@', 1, true) then print(line) end
		end
		error('missing "' .. text .. '" in the job output above')
	end
end

local output, results, elapsed = run(process.args[1], 8)
-- Only World.poses (a Model ancestor) is skipped; the 300 KB module is not.
has(output, '1 module(s) skipped: game.ReplicatedStorage.World.poses (')
assert(not output:find('Content.big (', 1, true), 'the large module must not be skipped:\n' .. output)
-- big, bone and plain pass; the four broken modules error and nothing else.
assert(results == 3, 'expected 3 results, got ' .. results .. ':\n' .. output)
has(output, 'failed to load test module game.ReplicatedStorage.Tests.waits.test')
-- Whichever of waits/waits2 loads first waits out the timeout; the other fails from the cache.
has(output, 'timed out after 0.5 s loading game.ReplicatedStorage.Tests.waits')
has(output, 'waiting on child "NeverThere" at ReplicatedStorage.waiter:2')
has(output, 'failed to load test module game.ReplicatedStorage.Tests.waits2.test')
has(output, 'failed to load test module game.ReplicatedStorage.Tests.missing.test')
has(output, 'ReplicatedStorage has no child "nope" in the snapshot')
has(output, 'failed to load test module game.ReplicatedStorage.Tests.poses.test')
has(output, 'is outside the snapshot')
has(output, 'unsupported module ancestor')
assert(elapsed < 2.5, 'only one load may wait out the timeout; took ' .. elapsed .. ' s')
print(string.format('hung-load run finished in %.2f s with %d results', elapsed, results))

-- 6. A test class that never finishes is cancelled by the whole-run watchdog.
-- The selection also proves unselected modules are never loaded: waits.test
-- would otherwise cost another load timeout.
local hang = testModule('hang.test', 'return { check = function() task.wait(5) end }')
output, results, elapsed = run(process.args[2], 5)
has(output, 'loading 2 of 8 test module(s)')
has(output, 'was still running at the 1 s live-sync timeout and was cancelled')
assert(not output:find('waits.test', 1, true), 'unselected modules must not load:\n' .. output)
assert(elapsed < 3, 'watchdog took ' .. elapsed .. ' s')
print(string.format('hung-class run finished in %.2f s', elapsed))
hang:Destroy()

-- The next run after all of that starts cleanly and gives the same verdicts.
output, results = run(process.args[1], 8)
assert(results == 3, 'next run: expected 3 results, got ' .. results .. ':\n' .. output)
print('Luau hang regression checks passed')
