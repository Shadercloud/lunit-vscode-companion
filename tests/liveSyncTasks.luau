-- The live-sync job's task/coroutine shims behave like Roblox's, and a test
-- that never resumes fails on its own at the per-test timeout.
--   args[1]: job built with testTimeoutSeconds = 0.5
-- The job gets a `task` that refuses what Roblox's refuses: deferring or
-- delaying a thread that is not suspended *with arguments* ("cannot defer
-- non-suspended coroutine with arguments"), and spawning a thread that is
-- not suspended. Lune's own task allows both, so without this the harness
-- could not reproduce the Studio failure.
local fs = require('@lune/fs')
local luau = require('@lune/luau')
local roblox = require('@lune/roblox')
local task = require('@lune/task')
local process = require('@lune/process')

local strictTask = table.clone(task)
local function refuse(what, thread, argCount)
	if type(thread) == 'thread' and coroutine.status(thread) ~= 'suspended' and argCount > 0 then
		error('cannot ' .. what .. ' non-suspended coroutine with arguments', 3)
	end
end
strictTask.defer = function(callback, ...)
	refuse('defer', callback, select('#', ...))
	return task.defer(callback, ...)
end
strictTask.delay = function(seconds, callback, ...)
	refuse('delay', callback, select('#', ...))
	return task.delay(seconds, callback, ...)
end
strictTask.spawn = function(callback, ...)
	if type(callback) == 'thread' and coroutine.status(callback) ~= 'suspended' then
		error('cannot spawn non-suspended coroutine', 2)
	end
	return task.spawn(callback, ...)
end

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
node('ModuleScript', 'RuntimeLib', rs, [[
local TS = {}
function TS.import(context, module, ...)
	for i = 1, select('#', ...) do module = module:FindFirstChild((select(i, ...))) end
	return require(module)
end
return TS
]])
-- Like Lunit: runs each test method from the class's metadata, in name
-- order, on the runner's thread (errors become the test's failure), then
-- afterEach, then reports it.
node('ModuleScript', 'lunit', node('Folder', '@rbxts', node('Folder', 'node_modules', rs)), [[
return { TestRunner = { fromClasses = function(self, classes)
	return { run = function(self, options)
		local cls = classes[1]
		local names = {}
		for key, method in cls["lunit:method:test"] do
			if method.options.isTest then table.insert(names, method.name or key) end
		end
		table.sort(names)
		local instance = setmetatable({}, { __index = cls })
		for _, name in names do
			options.reporter:onTestStart(name)
			local ok, err = pcall(function() return cls[name](instance) end)
			if cls.afterEach then cls.afterEach(instance) end
			options.reporter:onTestEnd(name, { passed = ok, label = name, elapsedTimeMs = 0, errorMessage = (not ok) and tostring(err) or nil })
		end
		return { expect = function() return { numTestsFailed = 0 } end }
	end }
end } }
]])
node('ModuleScript', 'tasks.test', rs, [[
local Tasks = {}
local function test(name) return { name = name, options = { isTest = true } } end
Tasks["lunit:method:test"] = {
	a_defer = test("a_defer"), b_delay = test("b_delay"), c_stuck = test("c_stuck"),
	d_shim = test("d_shim"), e_after = test("e_after"),
}
function Tasks.afterEach()
	game:SetAttribute("teardowns", (game:GetAttribute("teardowns") or 0) + 1)
end
-- issue-sink.ts: defer this (still running) thread with the answer, then yield.
function Tasks.a_defer()
	local waiting = coroutine.running()
	local answered = false
	local function answer(result)
		if answered then return end
		answered = true
		task.defer(waiting, result)
	end
	task.spawn(function() answer("sink answered") end)
	task.delay(2, function() answer("timeout") end)
	local result = coroutine.yield()
	assert(result == "sink answered", tostring(result))
end
-- task.delay with the running thread and an argument.
function Tasks.b_delay()
	task.delay(0.05, coroutine.running(), "later")
	local result = coroutine.yield()
	assert(result == "later", tostring(result))
end
-- Yields and is never resumed: must fail at the per-test timeout.
function Tasks.c_stuck()
	coroutine.yield()
end
-- An error inside the bridge's task shim, in a thread of this test: must fail
-- this test at once, not wait out the timeout.
function Tasks.d_shim()
	local dead = coroutine.create(function() end)
	coroutine.resume(dead)
	task.spawn(function() task.spawn(dead) end)
	coroutine.yield()
end
-- Runs after all of that.
function Tasks.e_after() end
return Tasks
]])

local environment = { game = game, Instance = roblox.Instance, task = strictTask, print = function() end, warn = function() end }
environment.loadstring = function(source, name)
	local ok, result = pcall(luau.load, source, { debugName = name, environment = environment, injectGlobals = true })
	return ok and result or nil, not ok and result or nil
end

local B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
local function b64decode(data)
	data = data:gsub('[^%w%+/=]', '')
	local out, bits, count = {}, 0, 0
	for i = 1, #data do
		local c = data:sub(i, i)
		if c == '=' then break end
		bits = bits * 64 + (B64:find(c, 1, true) - 1)
		count += 6
		if count >= 8 then
			count -= 8
			table.insert(out, string.char(math.floor(bits / 2 ^ count) % 256))
			bits %= 2 ^ count
		end
	end
	return table.concat(out)
end
local function results(output)
	local byLabel = {}
	for line in output:gmatch('[^\n]+') do
		local payload = line:match('^@@LUNIT_RESULT@@(.*)$')
		if payload then
			local fields = string.split(payload, '\t')
			byLabel[b64decode(fields[2])] = { status = fields[3], message = fields[5] ~= '' and b64decode(fields[5]) or nil }
		end
	end
	return byLabel
end

local function run()
	local owner = { protocol = 3 }
	local fn = luau.load(fs.readFile(process.args[1]), { environment = environment, injectGlobals = true })
	local finished, succeeded, output = false, false, nil
	local begin = os.clock()
	task.spawn(function()
		succeeded, output = pcall(fn, owner)
		finished = true
	end)
	while not finished and os.clock() - begin < 10 do task.wait(0.01) end
	assert(finished, 'the job hung')
	assert(succeeded, output)
	assert(owner.root == nil, 'owner leaked')
	return output, results(output), os.clock() - begin
end

local function check(byLabel, label, status, ...)
	local result = byLabel[label]
	assert(result, 'no result for ' .. label)
	assert(result.status == status, label .. ': expected ' .. status .. ', got ' .. result.status .. ' ' .. tostring(result.message))
	for _, text in { ... } do
		assert(result.message and result.message:find(text, 1, true), label .. ': message lacks "' .. text .. '": ' .. tostring(result.message))
	end
end

for round = 1, 2 do
	game:SetAttribute('teardowns', 0)
	local output, byLabel, elapsed = run()
	check(byLabel, 'a_defer', 'passed')
	check(byLabel, 'b_delay', 'passed')
	check(byLabel, 'c_stuck', 'failed', 'timed out after 0.5 s', 'still yielded at ReplicatedStorage.tasks.test:')
	check(byLabel, 'd_shim', 'failed', 'error in task.spawn (bridge task shim)', 'cannot spawn non-suspended coroutine')
	check(byLabel, 'e_after', 'passed')
	assert(game:GetAttribute('teardowns') == 5, 'afterEach must run for every test, got ' .. tostring(game:GetAttribute('teardowns')))
	-- Only the stuck test waits out the timeout; the shim error fails at once.
	assert(elapsed < 1.6, 'took ' .. elapsed .. ' s')
	assert(not output:find('[lunit] ERROR:', 1, true), 'the run itself must not fail:\n' .. output)
	print(string.format('task shim run %d finished in %.2f s', round, elapsed))
end
print('Luau task shim and per-test timeout checks passed')
-- Cancelled delays keep Lune's process alive until they would have fired.
process.exit(0)
