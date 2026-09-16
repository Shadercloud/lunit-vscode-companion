-- Compiled with roblox-ts v3.0.0 (written by hand in that shape)
-- @Only inside a @Tag("Parallel") class: only the focused method is
-- scheduled; the other is reported as skipped with the reason.
local TS = _G[script]
local _lunit = TS.import(script, TS.getModule(script, "@rbxts", "lunit").out)
local Tag = _lunit.Tag
local Test = _lunit.Test
local Only = _lunit.Decorators.Only
local FocusedTests
do
	FocusedTests = setmetatable({}, {
		__tostring = function()
			return "FocusedTests"
		end,
	})
	FocusedTests.__index = FocusedTests
	function FocusedTests.new(...)
		local self = setmetatable({}, FocusedTests)
		return self:constructor(...) or self
	end
	function FocusedTests:constructor()
	end
	function FocusedTests:focused()
	end
	function FocusedTests:shadowed()
		error("a test shadowed by @Only must not run")
	end
	local _descriptor = Test(FocusedTests, "focused", {
		value = FocusedTests.focused,
	})
	if _descriptor then
		FocusedTests.focused = _descriptor.value
	end
	local _descriptor_1 = Only(FocusedTests, "focused", {
		value = FocusedTests.focused,
	})
	if _descriptor_1 then
		FocusedTests.focused = _descriptor_1.value
	end
	local _descriptor_2 = Test(FocusedTests, "shadowed", {
		value = FocusedTests.shadowed,
	})
	if _descriptor_2 then
		FocusedTests.shadowed = _descriptor_2.value
	end
	FocusedTests = Tag("Parallel")(FocusedTests) or FocusedTests
end
return FocusedTests
