-- Compiled with roblox-ts v3.0.0 (written by hand in that shape)
-- @Tag("Parallel") on a class where one method is both a @Test and an
-- @AfterEach hook: rejected, since a fixture cannot be split from its cases.
local TS = _G[script]
local _lunit = TS.import(script, TS.getModule(script, "@rbxts", "lunit").out)
local AfterEach = _lunit.AfterEach
local Tag = _lunit.Tag
local Test = _lunit.Test
local HookTestTests
do
	HookTestTests = setmetatable({}, {
		__tostring = function()
			return "HookTestTests"
		end,
	})
	HookTestTests.__index = HookTestTests
	function HookTestTests.new(...)
		local self = setmetatable({}, HookTestTests)
		return self:constructor(...) or self
	end
	function HookTestTests:constructor()
	end
	function HookTestTests:both()
	end
	function HookTestTests:plain()
	end
	local _descriptor = Test(HookTestTests, "both", {
		value = HookTestTests.both,
	})
	if _descriptor then
		HookTestTests.both = _descriptor.value
	end
	local _descriptor_1 = AfterEach(HookTestTests, "both", {
		value = HookTestTests.both,
	})
	if _descriptor_1 then
		HookTestTests.both = _descriptor_1.value
	end
	local _descriptor_2 = Test(HookTestTests, "plain", {
		value = HookTestTests.plain,
	})
	if _descriptor_2 then
		HookTestTests.plain = _descriptor_2.value
	end
	HookTestTests = Tag("Parallel")(HookTestTests) or HookTestTests
end
return HookTestTests
