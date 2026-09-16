-- Second module of the dependency group: passes only when setup.test ran
-- earlier in the same VM (a fresh VM has an empty registry).
local TS = require(game:GetService("ReplicatedStorage"):WaitForChild("rbxts_include"):WaitForChild("RuntimeLib"))
local registry = TS.import(script, game:GetService("ReplicatedStorage"), "Shared", "registry")

local ConsumerTests = setmetatable({}, {
	__tostring = function()
		return "ConsumerTests"
	end,
})

ConsumerTests["lunit:method:test"] = {
	seesTheFixture = { options = { isTest = true } },
}

function ConsumerTests.seesTheFixture()
	assert(registry.names()[1] == "fixture", "setup.test must have run first in this VM")
end

return ConsumerTests
