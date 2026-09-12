local fs = require('@lune/fs')
local luau = require('@lune/luau')
local roblox = require('@lune/roblox')
local task = require('@lune/task')
local process = require('@lune/process')
local game = roblox.Instance.new('Folder')
game.Name = 'game'
local function node(class, name, parent, source)
 local inst = roblox.Instance.new(class)
 inst.Name = name
 inst.Parent = parent
 if source then inst.Source = source end
 return inst
end
local debugger = node('Folder', 'PluginDebugService', game)
node('ModuleScript', 'RuntimeLib', debugger, 'error("plugin must not load")')
node('ModuleScript', 'plugin.test', debugger, 'error("plugin must not run")')
local rs = node('Folder', 'ReplicatedStorage', game)
local runtime = node('ModuleScript', 'RuntimeLib', rs, [[
local TS = {}
local registered = {}
function TS.import(context, module, ...)
 for i = 1, select('#', ...) do module = module:FindFirstChild(select(i, ...)) end
 if not registered[module] then
  assert(not _G[module], 'duplicate runtime identity')
  _G[module] = TS
  registered[module] = true
 end
 return require(module)
end
return TS
]])
local packages = node('Folder', 'node_modules', rs)
local scope = node('Folder', '@rbxts', packages)
node('ModuleScript', 'lunit', scope, [[
return { TestRunner = { fromClasses = function(self, classes)
 return { run = function(self, options)
  classes[1].check()
  options.reporter:onTestEnd('check', {passed = true, label = 'check', elapsedTimeMs = 0})
  return { expect = function()
   local waiter = coroutine.running()
   task.defer(function()
    local resumed, err = coroutine.resume(waiter)
    if not resumed then game:SetAttribute('resumeError', tostring(err)) end
    -- Promise finalizers execute AFTER resuming the awaiter synchronously.
    local finalized, failure = pcall(function()
     coroutine.wrap(function() end)()
     task.defer(function() end)
    end)
    if not finalized then game:SetAttribute('finalizeError', tostring(failure)) end
   end)
   coroutine.yield()
   return {numTestsFailed = 0}
  end }
 end }
end } }
]])
local leaf = node('ModuleScript', 'leaf', rs, 'return 1')
local helper = node('ModuleScript', 'helper', rs, [[
_G.helperLoads = (_G.helperLoads or 0) + 1
assert(_G.helperLoads == 1)
return {value = require(script.Parent.leaf), calls = 0}
]])
local types = node('ModuleScript', 'types', rs, [[
_G.typeLoads = (_G.typeLoads or 0) + 1
return nil
]])
local family = node('ModuleScript', 'family', rs, 'return require("@self/child")')
node('ModuleScript', 'child', family, [[
assert(require('../leaf') == require('../../ReplicatedStorage/leaf'))
return require('@game/ReplicatedStorage/leaf')
]])
local testSource = [[
task.delay(1, function() game:SetAttribute('leakedTask', true) end)
local TS = require(game.ReplicatedStorage.RuntimeLib)
local helper = TS.import(script, game.ReplicatedStorage.helper)
assert(helper == require(script.Parent.helper))
assert(helper == require('./helper'))
assert(helper == require('@game/ReplicatedStorage/helper'))
assert(require('./family') == require('./leaf'))
assert(require('./types') == nil)
assert(require(game.ReplicatedStorage.types) == nil)
assert(_G.typeLoads == 1, 'nil export must be cached once per run')
return { check = function()
 helper.calls += 1
 _G.calls = (_G.calls or 0) + 1
 assert(helper.calls == _G.calls)
 _G.seen = _G.seen or {}
 assert(not _G.seen[INDEX])
 _G.seen[INDEX] = true
 assert(helper.value == VERSION)
end }
]]
local tests = {}
for i = 1, 100 do
 tests[i] = node('ModuleScript', tostring(i)..'.test', rs, testSource:gsub('INDEX', tostring(i)):gsub('VERSION', '1'))
end
-- Verify discovery's existing React host-config exclusion.
local forks = node('Folder', 'forks', rs)
node('ModuleScript', 'host.test', forks, "error('must not discover')")
-- Compile the plugin too; its Studio HTTP/plugin APIs require manual validation.
luau.load(fs.readFile(process.args[2]))
local code = fs.readFile(process.args[1])
local environment = {game = game, Instance = roblox.Instance, task = task, print = function() end}
environment.loadstring = function(source, name)
 local ok, result = pcall(luau.load, source, {debugName = name, environment = environment, injectGlobals = true})
 return ok and result or nil, not ok and result or nil
end
local expectedTests = 100
local function run(expectError)
 local originalCount = #game:GetDescendants()
 local owner = {}
 local fn = luau.load(code, {environment = environment, injectGlobals = true})
 local finished, succeeded, output = false, false, nil
 task.spawn(function()
  succeeded, output = pcall(fn, owner)
  finished = true
 end)
 local deadline = os.clock() + 5
 while not finished and os.clock() < deadline do task.wait(0.001) end
 assert(finished, 'job did not finish')
 assert(succeeded, output)
 assert(owner.root == nil and owner.cleanup == nil, 'owner leaked')
 task.wait(1.05)
 assert(game:GetAttribute('leakedTask') == nil, 'background task survived cleanup')
 assert(game:GetAttribute('resumeError') == nil, tostring(game:GetAttribute('resumeError')))
 assert(game:GetAttribute('finalizeError') == nil, tostring(game:GetAttribute('finalizeError')))
 assert((output:find('[lunit] ERROR:', 1, true) ~= nil) == expectError, output)
 local count = 0
 for _ in output:gmatch('@@LUNIT_RESULT@@') do count += 1 end
 if not expectError then assert(count == expectedTests, 'wrong test count: '..count) end
 for line in output:gmatch('[^\n]+') do
  if line:find('live%-sync') then print(line) end
 end
 assert(#game:GetDescendants() == originalCount, 'original hierarchy changed')
 return output
end
run(false)
-- Test source, helper and transitive dependency changes in the same VM.
leaf.Source = 'return 2'
helper.Source ..= '\n-- edited helper'
for i, test in tests do test.Source = testSource:gsub('INDEX', tostring(i)):gsub('VERSION', '2') end
run(false)
-- Independently change helper behavior, then verify another fresh run.
helper.Source = 'return {value = require(script.Parent.leaf) + 1, calls = 0}'
for i, test in tests do test.Source = testSource:gsub('INDEX', tostring(i)):gsub('VERSION', '3') end
run(false)
run(false)
for i, test in tests do test.Source = testSource:gsub('INDEX', tostring(i)):gsub('VERSION', '2') end
helper.Source = "error('load failure')"
run(true)
helper.Source = 'return {value = 2, calls = 0}'
tests[1].Source = 'return {check = function() error("test failure") end}'
run(true)
tests[1].Source = testSource:gsub('INDEX', '1'):gsub('VERSION', '2')
run(false)
local bad = node('ModuleScript', 'RuntimeLib', rs, 'return {}')
run(true)
bad:Destroy()
tests[1].Source = 'return require(12345)'
assert(run(true):find('no asset require', 1, true))
tests[1].Source = 'return require("./missing")'
local missing = run(true)
assert(missing:find('1.test', 1, true) and missing:find('missing require path ./missing', 1, true))
types.Source = 'return'
assert(run(true):find('ModuleScript must return exactly one value; got 0', 1, true))
types.Source = 'return nil, 2'
assert(run(true):find('ModuleScript must return exactly one value; got 2', 1, true))
-- Restore the modules earlier failure cases deliberately broke.
types.Source = [[
_G.typeLoads = (_G.typeLoads or 0) + 1
return nil
]]
tests[1].Source = testSource:gsub('INDEX', '1'):gsub('VERSION', '2')
-- roblox-ts game projects keep client code, and so client tests, under
-- StarterPlayer.StarterPlayerScripts rather than under a Folder or a service.
local starterPlayer = node('StarterPlayer', 'StarterPlayer', game)
local clientScripts = node('StarterPlayerScripts', 'StarterPlayerScripts', starterPlayer)
local characterScripts = node('StarterCharacterScripts', 'StarterCharacterScripts', starterPlayer)
node('ModuleScript', 'component', clientScripts, 'return {rendered = true}')
node('ModuleScript', 'motor', characterScripts, 'return {speed = 16}')
node('ModuleScript', 'client.test', clientScripts, [[
local TS = require(game.ReplicatedStorage.RuntimeLib)
-- Absolute service paths yield real Instances; they must map into the snapshot.
local component = TS.import(script, game.StarterPlayer.StarterPlayerScripts.component)
assert(component == require('./component'))
assert(component == require('@game/StarterPlayer/StarterPlayerScripts/component'))
assert(component == require(game.StarterPlayer.StarterPlayerScripts.component))
assert(component.rendered)
assert(require('@game/StarterPlayer/StarterCharacterScripts/motor').speed == 16)
return { check = function() end }
]])
expectedTests = 101
run(false)
-- A ModuleScript parented to a Script is ordinary Roblox, so it is supported
-- outright: the suite runs and nothing is skipped or warned about.
local runnerScript = node('Script', 'RunTests', rs)
node('ModuleScript', 'LunitTags', runnerScript, 'return {tag = true}')
node('ModuleScript', 'runner.test', runnerScript, [[
assert(require('./LunitTags').tag)
assert(require('@game/ReplicatedStorage/RunTests/LunitTags').tag)
assert(script.Parent.Name == 'RunTests')
return { check = function() end }
]])
expectedTests = 102
local scriptAncestor = run(false)
assert(not scriptAncestor:find('skipped', 1, true), scriptAncestor)
-- An unrelated module under a genuinely unsupported ancestor is left out of the
-- snapshot with one warning, rather than aborting a run that never needed it.
local model = node('Model', 'unsupported', rs)
node('ModuleScript', 'nested', model, 'return {}')
local skipWarning = run(false)
assert(skipWarning:find('1 module(s) skipped (unsupported ancestor)', 1, true), skipWarning)
assert(skipWarning:find('ReplicatedStorage.unsupported.nested', 1, true), skipWarning)
model:Destroy()
-- A test whose own ancestor is unsupported is reported as that test failing to
-- load, never quietly dropped from the results.
local world = node('Model', 'world', rs)
node('ModuleScript', 'orphan.test', world, 'return { check = function() end }')
local orphan = run(true)
assert(orphan:find('failed to load test module', 1, true), orphan)
assert(orphan:find('orphan.test', 1, true), orphan)
assert(orphan:find('unsupported module ancestor', 1, true), orphan)
world:Destroy()
-- A test that imports a skipped module fails with the chain that reached it.
local hidden = node('Model', 'hidden', rs)
node('ModuleScript', 'buried', hidden, 'return {}')
tests[1].Source = 'return { dep = require(game.ReplicatedStorage.hidden.buried), check = function() end }'
local chain = run(true)
assert(chain:find('1.test:', 1, true), chain)
assert(chain:find('is outside the snapshot', 1, true), chain)
assert(chain:find('unsupported module ancestor', 1, true), chain)
print('Luau repeated-run regression checks passed')
