-- Compiled with roblox-ts v3.0.0 (written by hand in that shape)
-- First module of the dependency group [setup.test, consumer.test]: its test
-- leaves state in the shared registry that consumer.test relies on.
local TS = _G[script]
local _lunit = TS.import(script, TS.getModule(script, "@rbxts", "lunit").out)
local Assert = _lunit.Assert
local Test = _lunit.Test
local registry = TS.import(script, script.Parent.Parent.Parent, "shared", "registry")
local SetupTests
do
	SetupTests = setmetatable({}, {
		__tostring = function()
			return "SetupTests"
		end,
	})
	SetupTests.__index = SetupTests
	function SetupTests.new(...)
		local self = setmetatable({}, SetupTests)
		return self:constructor(...) or self
	end
	function SetupTests:constructor()
	end
	function SetupTests:registersTheFixture()
		registry.register("fixture")
		Assert:equal(#registry.names(), 1)
	end
	local _descriptor = Test(SetupTests, "registersTheFixture", {
		value = SetupTests.registersTheFixture,
	})
	if _descriptor then
		SetupTests.registersTheFixture = _descriptor.value
	end
end
return SetupTests
