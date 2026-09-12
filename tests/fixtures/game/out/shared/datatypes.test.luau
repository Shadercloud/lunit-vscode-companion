-- Shaped like roblox-ts --type game output: the runtime and every import are
-- reached through absolute DataModel paths.
local TS = require(game:GetService("ReplicatedStorage"):WaitForChild("rbxts_include"):WaitForChild("RuntimeLib"))
local helper = TS.import(script, game:GetService("ReplicatedStorage"), "Shared", "helper")
-- A game project reaches packages by absolute path, not through getModule:
-- node_modules lives under rbxts_include, which is nobody's ancestor here.
local Lunit = TS.import(
	script,
	game:GetService("ReplicatedStorage"),
	"rbxts_include",
	"node_modules",
	"@rbxts",
	"lunit",
	"out"
)

local DatatypeTests = setmetatable({}, {
	__tostring = function()
		return "DatatypeTests"
	end,
})

DatatypeTests["lunit:method:test"] = {
	absoluteImports = { options = { isTest = true } },
	relativeImports = { options = { isTest = true } },
	datatypeIdentity = { options = { isTest = true } },
	datatypePrecision = { options = { isTest = true } },
	jsonModules = { options = { isTest = true } },
	ignoredPaths = { options = { isTest = true } },
	needsEngine = { options = { isTest = true, tags = { "Studio" } } },
}

function DatatypeTests.absoluteImports()
	assert(helper.value == 41, "absolute DataModel import returned the wrong module")
	assert(helper.bump(1) == 2)
	assert(Lunit.TestRunner ~= nil, "package import through getModule failed")
end

function DatatypeTests.relativeImports()
	-- Roblox's require-by-string, resolved against this script's own position.
	assert(require("./helper") == helper, "./helper must be the same module instance")
	assert(require("../Shared/helper") == helper, "../ must resolve through the parent")
end

function DatatypeTests.datatypeIdentity()
	assert(typeof(CFrame.new()) == "CFrame")
	assert(typeof(Vector3.new()) == "Vector3")
	assert(typeof(Vector3int16.new(1, 2, 3)) == "Vector3int16")
	assert(typeof(UDim2.fromScale(1, 1)) == "UDim2")
	assert(typeof(Color3.fromRGB(255, 0, 0)) == "Color3")
	assert(typeof(Enum.Font.SourceSans) == "EnumItem")
	assert((Vector3.new(1, 2, 3) + Vector3.new(1, 1, 1)).Y == 3, "operators must work")
end

function DatatypeTests.datatypePrecision()
	-- Engine Vector3 components are float32, so the double 0.1 does not survive.
	assert(Vector3.new(0.1, 0, 0).X ~= 0.1, "Vector3 components must be float32")
	assert(math.abs(Vector3.new(0.1, 0, 0).X - 0.1) < 1e-7)
	assert(Vector3.new(1, 2, 3).Magnitude ~= math.sqrt(14), "magnitude must be float32")
	assert(Vector3int16.new(7, -2, 3).X == 7, "Vector3int16 keeps integer components")
end

function DatatypeTests.jsonModules()
	assert(require("./data").answer == 42, "a .json file is a ModuleScript returning its contents")
end

function DatatypeTests.ignoredPaths()
	local shared = game:GetService("ReplicatedStorage"):WaitForChild("Shared")
	assert(shared:FindFirstChild("ignored") == nil, "globIgnorePaths must keep the file out of the tree")
	assert(shared:FindFirstChild("helper") ~= nil)
end

function DatatypeTests.needsEngine()
	error("a Studio-tagged test must never run under Lune")
end

return DatatypeTests
