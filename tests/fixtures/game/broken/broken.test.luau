-- Loads a dependency that errors, so the run reports the chain that reached it.
local TS = require(game:GetService("ReplicatedStorage"):WaitForChild("rbxts_include"):WaitForChild("RuntimeLib"))
local _dep = TS.import(script, game:GetService("ReplicatedStorage"), "Broken", "missingDep")
return {}
