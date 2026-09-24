-- Compiled with roblox-ts v3.0.0
local TS = require(game:GetService("ReplicatedStorage"):WaitForChild("rbxts_include"):WaitForChild("RuntimeLib"))
local _lunit = TS.import(script, game:GetService("ReplicatedStorage"), "rbxts_include", "node_modules", "@rbxts", "lunit", "out")
local Test = _lunit.Test
-- tests/client -> src/client: up to StarterPlayerScripts, then into Common.
local greet = TS.import(script, script.Parent.Parent.Parent, "Common", "greeter").greet
local GreeterTests
do
	GreeterTests = setmetatable({}, {
		__tostring = function()
			return "GreeterTests"
		end,
	})
	GreeterTests.__index = GreeterTests
	function GreeterTests.new(...)
		local self = setmetatable({}, GreeterTests)
		return self:constructor(...) or self
	end
	function GreeterTests:constructor()
	end
	function GreeterTests:greetsByName()
		assert(greet("Ada", 1) == "Hello, Ada! Visit #2", "greeting")
	end
	GreeterTests["lunit:method:test"] = {
		greetsByName = { options = { isTest = true } },
	}
end
return GreeterTests
