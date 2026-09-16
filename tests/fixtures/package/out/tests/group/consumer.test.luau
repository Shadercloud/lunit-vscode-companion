-- Compiled with roblox-ts v3.0.0 (written by hand in that shape)
-- Second module of the dependency group: passes only when setup.test ran
-- earlier in the same VM (a fresh VM has an empty registry).
local TS = _G[script]
local _lunit = TS.import(script, TS.getModule(script, "@rbxts", "lunit").out)
local Assert = _lunit.Assert
local Test = _lunit.Test
local registry = TS.import(script, script.Parent.Parent.Parent, "shared", "registry")
local ConsumerTests
do
	ConsumerTests = setmetatable({}, {
		__tostring = function()
			return "ConsumerTests"
		end,
	})
	ConsumerTests.__index = ConsumerTests
	function ConsumerTests.new(...)
		local self = setmetatable({}, ConsumerTests)
		return self:constructor(...) or self
	end
	function ConsumerTests:constructor()
	end
	function ConsumerTests:seesTheFixture()
		Assert:equal(registry.names()[1], "fixture", "setup.test must have run first in this VM")
	end
	local _descriptor = Test(ConsumerTests, "seesTheFixture", {
		value = ConsumerTests.seesTheFixture,
	})
	if _descriptor then
		ConsumerTests.seesTheFixture = _descriptor.value
	end
end
return ConsumerTests
