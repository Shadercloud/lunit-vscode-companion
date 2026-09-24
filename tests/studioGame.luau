-- Runs the generated Studio bootstrap script against a real place file built
-- by `rojo build`, deserialized with @lune/roblox, and prints everything the
-- script printed plus one "@@MODULE@@ <full name>" line per *.test module in
-- the place. studioGame.cjs decodes and asserts on it.
--
-- Usage: lune run tests/studioGame.luau <placeFile> <bootstrapScript>
local fs = require("@lune/fs")
local luau = require("@lune/luau")
local process = require("@lune/process")
local roblox = require("@lune/roblox")
local task = require("@lune/task")

local placeFile, scriptPath = process.args[1], process.args[2]

-- In Studio, WaitForChild on a child that never arrives yields forever
-- ("Infinite yield possible on ..."). Here it is a hard error naming the
-- missing child, so a test module whose imports do not resolve in this tree
-- fails to load with a message instead of hanging.
roblox.implementMethod("Instance", "WaitForChild", function(instance, name)
	return instance:FindFirstChild(name) or error(name .. " is not a child of " .. instance:GetFullName())
end)

local game = roblox.deserializePlace(fs.readFile(placeFile))

local printed = {}
local function capture(...)
	local parts = table.pack(...)
	for i = 1, parts.n do
		parts[i] = tostring(parts[i])
	end
	table.insert(printed, table.concat(parts, "\t", 1, parts.n))
end

-- Studio's own require, for a plain ModuleScript tree: one cache and one _G
-- for the whole run, as in the engine.
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
luau.load(fs.readFile(scriptPath), { debugName = "studio-bootstrap", environment = environment })()

for _, instance in game:GetDescendants() do
	if instance:IsA("ModuleScript") and instance.Name:match("%.test$") ~= nil then
		table.insert(printed, "@@MODULE@@ " .. instance:GetFullName())
	end
end

print(table.concat(printed, "\n"))
