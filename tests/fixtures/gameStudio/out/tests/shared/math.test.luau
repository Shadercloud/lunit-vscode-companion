-- Compiled with roblox-ts v3.0.0
local TS = require(game:GetService("ReplicatedStorage"):WaitForChild("rbxts_include"):WaitForChild("RuntimeLib"))
local _lunit = TS.import(script, game:GetService("ReplicatedStorage"), "rbxts_include", "node_modules", "@rbxts", "lunit", "out")
local Test = _lunit.Test
-- tests/shared -> src/shared: up to ReplicatedStorage, then into Common.
local add = TS.import(script, script.Parent.Parent.Parent, "Common", "math").add
local MathTests
do
	MathTests = setmetatable({}, {
		__tostring = function()
			return "MathTests"
		end,
	})
	MathTests.__index = MathTests
	function MathTests.new(...)
		local self = setmetatable({}, MathTests)
		return self:constructor(...) or self
	end
	function MathTests:constructor()
	end
	function MathTests:addsNumbers()
		assert(add(2, 3) == 5, "2 + 3 should be 5")
	end
	MathTests["lunit:method:test"] = {
		addsNumbers = { options = { isTest = true } },
	}
end
return MathTests
