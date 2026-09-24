-- Compiled with roblox-ts v3.0.0
local TS = require(game:GetService("ReplicatedStorage"):WaitForChild("rbxts_include"):WaitForChild("RuntimeLib"))
local add = TS.import(script, game:GetService("ReplicatedStorage"), "Common", "math").add
local function greet(name, visits)
	return "Hello, " .. name .. "! Visit #" .. tostring(add(visits, 1))
end
return {
	greet = greet,
}
