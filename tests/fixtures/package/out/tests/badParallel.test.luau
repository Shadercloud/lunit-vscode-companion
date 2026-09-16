-- Compiled with roblox-ts v3.0.0 (written by hand in that shape)
-- @Tag("Parallel") on a class with a suite-level hook and an ordered method:
-- the planner must reject it with a diagnostic naming both, not split it.
local TS = _G[script]
local _lunit = TS.import(script, TS.getModule(script, "@rbxts", "lunit").out)
local BeforeAll = _lunit.BeforeAll
local Order = _lunit.Order
local Tag = _lunit.Tag
local Test = _lunit.Test
local BadParallelTests
do
	BadParallelTests = setmetatable({}, {
		__tostring = function()
			return "BadParallelTests"
		end,
	})
	BadParallelTests.__index = BadParallelTests
	function BadParallelTests.new(...)
		local self = setmetatable({}, BadParallelTests)
		return self:constructor(...) or self
	end
	function BadParallelTests:constructor()
	end
	function BadParallelTests:setUpAll()
	end
	function BadParallelTests:first()
	end
	function BadParallelTests:second()
	end
	local _descriptor = BeforeAll(BadParallelTests, "setUpAll", {
		value = BadParallelTests.setUpAll,
	})
	if _descriptor then
		BadParallelTests.setUpAll = _descriptor.value
	end
	local _decorator = Order(1)
	local _descriptor_1 = Test(BadParallelTests, "first", {
		value = BadParallelTests.first,
	})
	if _descriptor_1 then
		BadParallelTests.first = _descriptor_1.value
	end
	local _descriptor_2 = _decorator(BadParallelTests, "first", {
		value = BadParallelTests.first,
	})
	if _descriptor_2 then
		BadParallelTests.first = _descriptor_2.value
	end
	local _descriptor_3 = Test(BadParallelTests, "second", {
		value = BadParallelTests.second,
	})
	if _descriptor_3 then
		BadParallelTests.second = _descriptor_3.value
	end
	BadParallelTests = Tag("Parallel")(BadParallelTests) or BadParallelTests
end
return BadParallelTests
