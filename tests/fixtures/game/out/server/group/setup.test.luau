-- First module of the dependency group [setup.test, consumer.test]: leaves
-- state in the shared registry that consumer.test relies on.
local TS = require(game:GetService("ReplicatedStorage"):WaitForChild("rbxts_include"):WaitForChild("RuntimeLib"))
local registry = TS.import(script, game:GetService("ReplicatedStorage"), "Shared", "registry")

local SetupTests = setmetatable({}, {
	__tostring = function()
		return "SetupTests"
	end,
})

SetupTests["lunit:method:test"] = {
	registersTheFixture = { options = { isTest = true } },
}

function SetupTests.registersTheFixture()
	registry.register("fixture")
	assert(#registry.names() == 1)
end

return SetupTests
