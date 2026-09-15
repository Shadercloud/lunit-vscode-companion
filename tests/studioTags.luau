-- Runs one generated Studio-side script (the build+launch bootstrap or the
-- live-sync job) against tests/fixtures/game, rebuilt as a real @lune/roblox
-- DataModel laid out the way game.project.json maps it, and prints everything
-- the script printed or returned. studioTags.cjs decodes and asserts on it.
--
-- Usage: lune run tests/studioTags.luau <fixtureDir> <script> <bootstrap|job>
local fs = require("@lune/fs")
local luau = require("@lune/luau")
local process = require("@lune/process")
local roblox = require("@lune/roblox")
local task = require("@lune/task")

local fixture, scriptPath, kind = process.args[1], process.args[2], process.args[3]

-- The fixture's RuntimeLib stand-in walks the tree with WaitForChild.
roblox.implementMethod("Instance", "WaitForChild", function(instance, name)
	return instance:FindFirstChild(name) or error(name .. " is not a child of " .. instance:GetFullName())
end)

local game = roblox.Instance.new("DataModel")

local function node(className, name, parent, sourceFile)
	local instance = roblox.Instance.new(className)
	instance.Name = name
	if sourceFile then
		instance.Source = fs.readFile(fixture .. "/" .. sourceFile)
	end
	instance.Parent = parent
	return instance
end

local replicatedStorage = game:GetService("ReplicatedStorage")
local include = node("Folder", "rbxts_include", replicatedStorage)
node("ModuleScript", "RuntimeLib", include, "include/RuntimeLib.lua")
local scope = node("Folder", "@rbxts", node("Folder", "node_modules", include))
node("ModuleScript", "out", node("Folder", "lunit", scope), "node_modules/@rbxts/lunit/out/init.luau")
node("ModuleScript", "helper", node("Folder", "Shared", replicatedStorage), "out/shared/helper.luau")

local server = node("Folder", "Server", game:GetService("ServerScriptService"))
for _, name in { "server", "tagged", "luneOnly", "mixedTags", "slow", "slowOnly" } do
	node("ModuleScript", name .. ".test", server, "out/server/" .. name .. ".test.luau")
end
-- A class-level Lune tag visible only in the loaded class's metadata (lower
-- case), so the source match cannot catch it and the metadata check must.
local metadataOnly = node("ModuleScript", "metadataOnly.test", server)
metadataOnly.Source = [[
local MetadataOnlyTests = setmetatable({}, { __tostring = function() return "MetadataOnlyTests" end })
MetadataOnlyTests["lunit:class"] = { tags = { "lune" } }
MetadataOnlyTests["lunit:method:test"] = { mustNotRunInStudio = { options = { isTest = true } } }
function MetadataOnlyTests.mustNotRunInStudio()
	error("a metadata-tagged Lune class must never run in Roblox Studio")
end
return MetadataOnlyTests
]]

local printed = {}
local function capture(...)
	local parts = table.pack(...)
	for i = 1, parts.n do parts[i] = tostring(parts[i]) end
	table.insert(printed, table.concat(parts, "\t", 1, parts.n))
end

local code = fs.readFile(scriptPath)

if kind == "bootstrap" then
	-- Studio's own require, for a plain ModuleScript tree.
	local cache, sharedG = {}, {}
	local function requireModule(module)
		local entry = cache[module]
		if entry == nil then
			local fn = luau.load(module.Source, {
				debugName = module:GetFullName(),
				environment = { script = module, require = requireModule, _G = sharedG, game = game, task = task },
			})
			entry = { value = fn() }
			cache[module] = entry
		end
		return entry.value
	end
	local environment = { game = game, task = task, require = requireModule, print = capture, warn = capture }
	luau.load(code, { environment = environment })()
else
	local environment = { game = game, Instance = roblox.Instance, task = task, print = function() end }
	environment.loadstring = function(source, name)
		local ok, result = pcall(luau.load, source, { debugName = name, environment = environment, injectGlobals = true })
		return ok and result or nil, not ok and result or nil
	end
	local fn = luau.load(code, { environment = environment, injectGlobals = true })
	local finished, ok, output = false, false, nil
	task.spawn(function()
		ok, output = pcall(fn, {})
		finished = true
	end)
	local deadline = os.clock() + 10
	while not finished and os.clock() < deadline do task.wait(0.01) end
	assert(finished, "job did not finish")
	assert(ok, output)
	table.insert(printed, output)
end

print(table.concat(printed, "\n"))
